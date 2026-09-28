use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShotState {
    pub bound: bool,
    pub missing: bool,
    pub file_name: String,
    pub modified_ms: u64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub z: Option<f64>,
    pub yaw: Option<f64>,
}

impl ShotState {
    fn empty() -> Self {
        Self {
            bound: false,
            missing: false,
            file_name: String::new(),
            modified_ms: 0,
            x: None,
            y: None,
            z: None,
            yaw: None,
        }
    }
}

static STATE: Mutex<ShotState> = Mutex::new(ShotState {
    bound: false,
    missing: false,
    file_name: String::new(),
    modified_ms: 0,
    x: None,
    y: None,
    z: None,
    yaw: None,
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotSettings {
    #[serde(default = "default_on")]
    pub sync_enabled: bool,
    #[serde(default)]
    pub prune_enabled: bool,
    #[serde(default = "default_keep")]
    pub keep_max: u32,
    #[serde(default = "default_hotkey")]
    pub hotkey: String,
    #[serde(default)]
    pub auto_enabled: bool,
    #[serde(default = "default_auto_secs")]
    pub auto_secs: u32,
    #[serde(default)]
    pub hotkey_from_game: bool,
    #[serde(default)]
    pub game_hotkey: String,
}

fn default_on() -> bool {
    true
}

fn default_keep() -> u32 {
    20
}

fn default_hotkey() -> String {
    "PrintScreen".into()
}

fn default_auto_secs() -> u32 {
    5
}

impl Default for ShotSettings {
    fn default() -> Self {
        Self {
            sync_enabled: true,
            prune_enabled: false,
            keep_max: 20,
            hotkey: default_hotkey(),
            auto_enabled: false,
            auto_secs: 5,
            hotkey_from_game: false,
            game_hotkey: String::new(),
        }
    }
}

static SETTINGS: Mutex<ShotSettings> = Mutex::new(ShotSettings {
    sync_enabled: true,
    prune_enabled: false,
    keep_max: 20,
    hotkey: String::new(),
    auto_enabled: false,
    auto_secs: 5,
    hotkey_from_game: false,
    game_hotkey: String::new(),
});
static CAPTURING: AtomicBool = AtomicBool::new(false);

pub fn state() -> ShotState {
    STATE.lock().expect("shot-watch").clone()
}

pub fn settings(app: &AppHandle) -> ShotSettings {
    let loaded = read_settings(app);
    *SETTINGS.lock().expect("shot-settings") = loaded.clone();
    present(loaded)
}

pub fn set_capturing(on: bool) {
    CAPTURING.store(on, Ordering::Relaxed);
}

pub fn save_settings(app: &AppHandle, mut next: ShotSettings) -> Result<ShotSettings, String> {
    if next.hotkey_from_game {
        next.hotkey = read_settings(app).hotkey;
    }
    let saved = normalize_settings(next);
    let path = settings_file(app)?;
    let text = serde_json::to_string_pretty(&saved).map_err(|err| err.to_string())?;
    fs::write(path, text).map_err(|err| err.to_string())?;
    *SETTINGS.lock().expect("shot-settings") = saved.clone();
    Ok(present(saved))
}

pub fn spawn(app: AppHandle) {
    let loaded = read_settings(&app);
    *SETTINGS.lock().expect("shot-settings") = loaded;
    thread::spawn(move || watch(app));
}

fn watch(app: AppHandle) {
    let mut seen = ShotState::empty();
    let mut held = false;
    let mut sync_was = false;
    let mut last_scan = Instant::now() - Duration::from_secs(2);
    let mut last_tap: Option<Instant> = None;
    let mut boost: Option<Instant> = None;
    let mut game_bind: Option<ShotBind> = None;
    let mut game_mtime: Option<SystemTime> = None;
    let mut game_checked = Instant::now() - Duration::from_secs(2);
    let mut bind_sig = String::new();
    loop {
        let settings = SETTINGS.lock().expect("shot-settings").clone();
        if game_checked.elapsed() >= Duration::from_secs(1) {
            game_checked = Instant::now();
            let path = control_path();
            let mtime = path.as_ref().and_then(|path| fs::metadata(path).and_then(|meta| meta.modified()).ok());
            if path.is_none() || mtime != game_mtime {
                game_mtime = mtime;
                game_bind = path.and_then(|path| fs::read_to_string(path).ok()).and_then(|text| screenshot_bind(&text));
            }
        }
        let bind = game_bind.clone().unwrap_or_else(|| fallback_bind(&settings.hotkey));
        let sig = format!("{}|{}", bind.hotkey, bind.game_name);
        if sig != bind_sig {
            held = false;
            bind_sig = sig;
        }
        if settings.sync_enabled {
            if !sync_was {
                last_scan = Instant::now() - Duration::from_secs(2);
            }
            sync_was = true;
            let poke = hotkey_edge(&mut held, &bind);
            let boost_due = boost.is_some_and(|at| at.elapsed() >= Duration::from_millis(400));
            if poke {
                let _ = app.emit("shot-poke", ());
            }
            if poke || boost_due || last_scan.elapsed() >= Duration::from_secs(1) {
                if boost_due {
                    boost = None;
                }
                last_scan = Instant::now();
                let next = read_state(&app);
                if next != seen {
                    seen = next.clone();
                    *STATE.lock().expect("shot-watch") = next.clone();
                    let _ = app.emit("shot-fix", next);
                }
            }
        } else {
            sync_was = false;
            held = false;
            last_tap = None;
        }
        if settings.sync_enabled && settings.auto_enabled {
            if !crate::logwatch::raid_snapshot().in_raid {
                last_tap = None;
            } else {
                let interval = Duration::from_secs(settings.auto_secs as u64);
                let due = last_tap.is_none_or(|at| at.elapsed() >= interval);
                if due && !CAPTURING.load(Ordering::Relaxed) && game_foreground() {
                    if bind.triggers.is_empty() {
                        last_tap = Some(Instant::now());
                    } else {
                        crate::overlay::suppress_hotkey(true);
                        thread::sleep(Duration::from_millis(45));
                        tap_bind(&bind);
                        thread::sleep(Duration::from_millis(45));
                        crate::overlay::suppress_hotkey(false);
                        last_tap = Some(Instant::now());
                        boost = Some(Instant::now());
                    }
                }
            }
        } else {
            last_tap = None;
        }
        thread::sleep(Duration::from_millis(30));
    }
}

fn read_state(app: &AppHandle) -> ShotState {
    let dir = crate::local::get_paths(app).screenshot_dir;
    let dir = dir.trim();
    if dir.is_empty() {
        return ShotState::empty();
    }
    let path = Path::new(dir);
    if !path.is_dir() {
        let mut missing = ShotState::empty();
        missing.bound = true;
        missing.missing = true;
        return missing;
    }
    let settings = SETTINGS.lock().expect("shot-settings").clone();
    if settings.sync_enabled && settings.prune_enabled {
        prune_old(path, settings.keep_max);
    }
    let Some((name, modified_ms)) = latest_screenshot(path) else {
        let mut empty = ShotState::empty();
        empty.bound = true;
        return empty;
    };
    let parsed = parse_screenshot_name(&name);
    ShotState {
        bound: true,
        missing: false,
        file_name: name,
        modified_ms,
        x: parsed.as_ref().map(|pos| pos.x),
        y: parsed.as_ref().map(|pos| pos.y),
        z: parsed.as_ref().map(|pos| pos.z),
        yaw: parsed.and_then(|pos| pos.yaw),
    }
}

struct Pos {
    x: f64,
    y: f64,
    z: f64,
    yaw: Option<f64>,
}

fn latest_screenshot(dir: &Path) -> Option<(String, u64)> {
    let mut dated: Option<(String, u64)> = None;
    let mut any: Option<(String, u64)> = None;
    for entry in fs::read_dir(dir).ok()? {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_image(&name) {
            continue;
        }
        let modified_ms = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(to_millis)
            .unwrap_or(0);
        if newer(&any, &name, modified_ms) {
            any = Some((name.clone(), modified_ms));
        }
        if is_dated(&name) && newer(&dated, &name, modified_ms) {
            dated = Some((name, modified_ms));
        }
    }
    dated.or(any)
}

fn newer(current: &Option<(String, u64)>, name: &str, modified_ms: u64) -> bool {
    match current {
        None => true,
        Some((cur, at)) => modified_ms > *at || (modified_ms == *at && name > cur.as_str()),
    }
}

fn to_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH).ok().map(|span| span.as_millis() as u64)
}

fn is_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".bmp") || lower.ends_with(".webp")
}

fn is_dated(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 10
        && bytes[0..4].iter().all(|b| b.is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(|b| b.is_ascii_digit())
}

fn parse_screenshot_name(file_name: &str) -> Option<Pos> {
    let base = file_name
        .rsplit_once('.')
        .map(|(stem, ext)| if is_image(&format!(".{ext}")) { stem } else { file_name })
        .unwrap_or(file_name)
        .trim();
    let rest = dated_rest(base)?;
    let rest = rest.trim_end();
    let rest = strip_copy_suffix(rest);
    let mut xyz: Option<[f64; 3]> = None;
    let mut quat: Option<[f64; 4]> = None;
    for part in rest.split('_') {
        let nums = numbers(part);
        if xyz.is_none() && nums.len() >= 3 {
            xyz = Some([nums[0], nums[1], nums[2]]);
            continue;
        }
        if quat.is_none() && nums.len() >= 4 {
            quat = Some([nums[0], nums[1], nums[2], nums[3]]);
        }
    }
    let [x, y, z] = xyz?;
    Some(Pos {
        x,
        y,
        z,
        yaw: quat.map(|q| quaternion_to_yaw(q[0], q[1], q[2], q[3])),
    })
}

fn dated_rest(base: &str) -> Option<&str> {
    let bytes = base.as_bytes();
    if !is_dated(base) || bytes.len() < 12 || bytes[10] != b'[' {
        return None;
    }
    let close = base[11..].find(']')?;
    let after = 12 + close;
    if bytes.get(after) != Some(&b'_') {
        return None;
    }
    Some(&base[after + 1..])
}

fn strip_copy_suffix(rest: &str) -> &str {
    let trimmed = rest.trim_end();
    if !trimmed.ends_with(')') {
        return trimmed;
    }
    let Some(open) = trimmed.rfind(" (") else { return trimmed };
    if trimmed[open + 2..trimmed.len() - 1].chars().all(|ch| ch.is_ascii_digit()) {
        return trimmed[..open].trim_end();
    }
    trimmed
}

fn numbers(part: &str) -> Vec<f64> {
    let mut out = Vec::new();
    let bytes = part.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        if bytes[index] == b'-' || bytes[index] == b'+' {
            index += 1;
        }
        let digits = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index < bytes.len() && bytes[index] == b'.' {
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
        }
        if index > digits {
            if let Ok(value) = part[start..index].parse::<f64>() {
                if value.is_finite() {
                    out.push(value);
                }
            }
        } else {
            index = start + 1;
        }
        while index < bytes.len() && !bytes[index].is_ascii_digit() && bytes[index] != b'-' && bytes[index] != b'+' {
            index += 1;
        }
    }
    out
}

fn quaternion_to_yaw(x: f64, y: f64, z: f64, w: f64) -> f64 {
    let siny = 2.0 * (w * y + x * z);
    let cosy = 1.0 - 2.0 * (y * y + z * z);
    siny.atan2(cosy) * 180.0 / std::f64::consts::PI
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("shot.json"))
}

fn read_settings(app: &AppHandle) -> ShotSettings {
    let Ok(path) = settings_file(app) else { return ShotSettings::default() };
    let loaded = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    normalize_settings(loaded)
}

fn normalize_settings(next: ShotSettings) -> ShotSettings {
    ShotSettings {
        sync_enabled: next.sync_enabled,
        prune_enabled: next.prune_enabled,
        keep_max: clamp_keep(next.keep_max),
        hotkey: normalize_hotkey(&next.hotkey),
        auto_enabled: next.auto_enabled,
        auto_secs: clamp_auto(next.auto_secs),
        hotkey_from_game: false,
        game_hotkey: String::new(),
    }
}

fn present(mut settings: ShotSettings) -> ShotSettings {
    if let Some(bind) = read_game_bind() {
        settings.hotkey = bind.hotkey;
        settings.game_hotkey = bind.game_name;
        settings.hotkey_from_game = true;
    }
    settings
}

#[derive(Clone)]
struct ShotBind {
    modifiers: Vec<i32>,
    triggers: Vec<i32>,
    hotkey: String,
    game_name: String,
}

struct UnityKey {
    vk: i32,
    modifier: bool,
    hotkey: String,
    game_name: String,
}

fn control_path() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let path = PathBuf::from(appdata)
        .join("Battlestate Games")
        .join("Escape from Tarkov")
        .join("Settings")
        .join("Control.ini");
    path.is_file().then_some(path)
}

fn read_game_bind() -> Option<ShotBind> {
    let text = fs::read_to_string(control_path()?).ok()?;
    screenshot_bind(&text)
}

fn screenshot_bind(text: &str) -> Option<ShotBind> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let bindings = value.get("keyBindings")?.as_array()?;
    let entry = bindings.iter().find(|item| item.get("keyName").and_then(|name| name.as_str()) == Some("MakeScreenshot"))?;
    let variants = entry.get("variants")?.as_array()?;
    for variant in variants {
        let codes = variant.get("keyCode")?.as_array()?;
        let names: Vec<&str> = codes.iter().filter_map(|code| code.as_str()).filter(|code| !code.is_empty()).collect();
        if names.is_empty() {
            continue;
        }
        if let Some(bind) = bind_from_codes(&names) {
            return Some(bind);
        }
    }
    None
}

fn bind_from_codes(names: &[&str]) -> Option<ShotBind> {
    let mut pieces = Vec::new();
    for name in names {
        pieces.push(unity_key(name)?);
    }
    let mut modifiers = Vec::new();
    let mut triggers = Vec::new();
    let mut hotkey = String::new();
    for piece in &pieces {
        if piece.modifier {
            modifiers.push(piece.vk);
        } else {
            if hotkey.is_empty() {
                hotkey = piece.hotkey.clone();
            }
            triggers.push(piece.vk);
        }
    }
    if triggers.is_empty() {
        return None;
    }
    let game_name = pieces.iter().map(|piece| piece.game_name.as_str()).collect::<Vec<_>>().join(" + ");
    Some(ShotBind { modifiers, triggers, hotkey, game_name })
}

fn fallback_bind(hotkey: &str) -> ShotBind {
    let hotkey = normalize_hotkey(hotkey);
    ShotBind {
        modifiers: Vec::new(),
        triggers: vk_of(&hotkey).into_iter().collect(),
        game_name: hotkey.clone(),
        hotkey,
    }
}

fn tap_bind(bind: &ShotBind) {
    for vk in &bind.modifiers {
        key_event(*vk, false);
    }
    for vk in &bind.triggers {
        tap_key(*vk);
    }
    for vk in bind.modifiers.iter().rev() {
        key_event(*vk, true);
    }
}

fn key_event(vk: i32, up: bool) {
    let flags = if up { 0x0002 } else { 0 };
    unsafe { keybd_event(vk as u8, 0, flags, 0) };
}

fn unity_key(raw: &str) -> Option<UnityKey> {
    let name = raw.trim();
    if name.is_empty() {
        return None;
    }
    if let Some(rest) = name.strip_prefix("Alpha") {
        if let Ok(digit) = rest.parse::<u8>() {
            if digit <= 9 {
                let ch = char::from(b'0' + digit).to_string();
                return Some(UnityKey { vk: ch.as_bytes()[0] as i32, modifier: false, hotkey: ch.clone(), game_name: ch });
            }
        }
    }
    if let Some(rest) = name.strip_prefix('F') {
        if let Ok(number) = rest.parse::<i32>() {
            if (1..=24).contains(&number) {
                let label = format!("F{number}");
                return Some(UnityKey { vk: 0x70 + number - 1, modifier: false, hotkey: label.clone(), game_name: label });
            }
        }
    }
    if name.len() == 1 {
        let ch = name.chars().next()?;
        if ch.is_ascii_alphabetic() {
            let upper = ch.to_ascii_uppercase().to_string();
            return Some(UnityKey { vk: upper.as_bytes()[0] as i32, modifier: false, hotkey: upper.clone(), game_name: upper });
        }
    }
    let (vk, modifier, hotkey, game_name) = match name {
        // Unity Mouse3/Mouse4 are the side buttons. Mouse4 is the forward button.
        "Mouse0" => (0x01, false, "Mouse0", "Mouse 0"),
        "Mouse1" => (0x02, false, "Mouse1", "Mouse 1"),
        "Mouse2" => (0x04, false, "Mouse2", "Mouse 2"),
        "Mouse3" => (0x05, false, "Mouse4", "Mouse 3"),
        "Mouse4" => (0x06, false, "Mouse5", "Mouse 4"),
        "Print" | "SysReq" => (0x2C, false, "PrintScreen", "Print Screen"),
        "Space" => (0x20, false, "Space", "Space"),
        "Tab" => (0x09, false, "Tab", "Tab"),
        "Escape" => (0x1B, false, "Escape", "Escape"),
        "Return" | "KeypadEnter" => (0x0D, false, "Enter", "Enter"),
        "BackQuote" => (0xC0, false, "BackQuote", "`"),
        "CapsLock" => (0x14, false, "CapsLock", "Caps Lock"),
        "LeftShift" => (0xA0, true, "LeftShift", "Left Shift"),
        "RightShift" => (0xA1, true, "RightShift", "Right Shift"),
        "LeftControl" => (0xA2, true, "LeftControl", "Left Ctrl"),
        "RightControl" => (0xA3, true, "RightControl", "Right Ctrl"),
        "LeftAlt" => (0xA4, true, "LeftAlt", "Left Alt"),
        "RightAlt" => (0xA5, true, "RightAlt", "Right Alt"),
        "Delete" => (0x2E, false, "Delete", "Delete"),
        "Insert" => (0x2D, false, "Insert", "Insert"),
        "Home" => (0x24, false, "Home", "Home"),
        "End" => (0x23, false, "End", "End"),
        "PageUp" => (0x21, false, "PageUp", "Page Up"),
        "PageDown" => (0x22, false, "PageDown", "Page Down"),
        "UpArrow" => (0x26, false, "Up", "Up"),
        "DownArrow" => (0x28, false, "Down", "Down"),
        "LeftArrow" => (0x25, false, "Left", "Left"),
        "RightArrow" => (0x27, false, "Right", "Right"),
        _ => return None,
    };
    Some(UnityKey { vk, modifier, hotkey: hotkey.into(), game_name: game_name.into() })
}

fn clamp_keep(value: u32) -> u32 {
    value.clamp(1, 200)
}

fn clamp_auto(value: u32) -> u32 {
    value.clamp(2, 120)
}

fn game_foreground() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == 0 {
            return false;
        }
        let mut class = [0u16; 64];
        let class_len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        if class_len <= 0 {
            return false;
        }
        let class = String::from_utf16_lossy(&class[..class_len as usize]);
        let mut title = [0u16; 128];
        let title_len = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        let title = if title_len > 0 {
            String::from_utf16_lossy(&title[..title_len as usize])
        } else {
            String::new()
        };
        is_game_window(&class, &title)
    }
}

fn is_game_window(class: &str, title: &str) -> bool {
    class == "UnityWndClass" && (title.to_ascii_lowercase().contains("tarkov") || title.contains("逃离"))
}

fn tap_key(vk: i32) {
    if let Some((down, up, data)) = mouse_click(vk) {
        unsafe {
            mouse_event(down, 0, 0, data, 0);
            thread::sleep(Duration::from_millis(40));
            mouse_event(up, 0, 0, data, 0);
        }
        return;
    }
    let vk = vk as u8;
    let (scan, flags) = if vk == 0x2C { (0x37u8, 0x0001u32) } else { (0, 0) };
    unsafe {
        keybd_event(vk, scan, flags, 0);
        thread::sleep(Duration::from_millis(40));
        keybd_event(vk, scan, flags | 0x0002, 0);
    }
}

fn normalize_hotkey(raw: &str) -> String {
    let key = raw.trim();
    if key.is_empty() {
        return default_hotkey();
    }
    if key.eq_ignore_ascii_case("printscreen") || key.eq_ignore_ascii_case("print screen") || key.eq_ignore_ascii_case("prtsc") {
        return "PrintScreen".into();
    }
    if let Some(name) = mouse_name(key) {
        return name.into();
    }
    let upper = key.to_ascii_uppercase();
    if vk_of(&upper).is_some() { upper } else { default_hotkey() }
}

fn names_to_prune(files: &[(String, u64)], keep_max: u32) -> Vec<String> {
    let mut dated: Vec<&(String, u64)> = files.iter().filter(|(name, _)| is_image(name) && is_dated(name)).collect();
    let cap = clamp_keep(keep_max) as usize;
    if dated.len() <= cap {
        return Vec::new();
    }
    dated.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    dated.into_iter().skip(cap).take(40).map(|(name, _)| name.clone()).collect()
}

fn prune_old(dir: &Path, keep_max: u32) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let files: Vec<(String, u64)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let modified = entry.metadata().ok().and_then(|meta| meta.modified().ok()).and_then(to_millis).unwrap_or(0);
            Some((name, modified))
        })
        .collect();
    for name in names_to_prune(&files, keep_max) {
        let _ = fs::remove_file(dir.join(name));
    }
}

fn mouse_click(vk: i32) -> Option<(u32, u32, u32)> {
    match vk {
        0x01 => Some((0x0002, 0x0004, 0)),
        0x02 => Some((0x0008, 0x0010, 0)),
        0x04 => Some((0x0020, 0x0040, 0)),
        0x05 => Some((0x0080, 0x0100, 0x0001)),
        0x06 => Some((0x0080, 0x0100, 0x0002)),
        _ => None,
    }
}

fn hotkey_edge(held: &mut bool, bind: &ShotBind) -> bool {
    if bind.triggers.is_empty() {
        *held = false;
        return false;
    }
    let down = bind.modifiers.iter().chain(bind.triggers.iter()).all(|vk| unsafe { GetAsyncKeyState(*vk) < 0 });
    let edge = down && !*held;
    *held = down;
    edge
}

fn mouse_vk(name: &str) -> Option<i32> {
    let folded = name.trim().to_ascii_uppercase().replace(' ', "");
    match folded.as_str() {
        "MOUSE4" | "XBUTTON1" => Some(0x05),
        "MOUSE5" | "XBUTTON2" => Some(0x06),
        _ => None,
    }
}

fn mouse_name(name: &str) -> Option<&'static str> {
    match mouse_vk(name) {
        Some(0x05) => Some("Mouse4"),
        Some(0x06) => Some("Mouse5"),
        _ => None,
    }
}

fn vk_of(name: &str) -> Option<i32> {
    let name = name.trim();
    if name.eq_ignore_ascii_case("PrintScreen") {
        return Some(0x2C);
    }
    if let Some(vk) = mouse_vk(name) {
        return Some(vk);
    }
    let name = name.to_ascii_uppercase();
    if let Some(rest) = name.strip_prefix('F') {
        if let Ok(number) = rest.parse::<i32>() {
            if (1..=24).contains(&number) {
                return Some(0x70 + number - 1);
            }
        }
    }
    let mut chars = name.chars();
    let Some(ch) = chars.next() else { return None };
    if chars.next().is_some() {
        return None;
    }
    if ch.is_ascii_alphanumeric() {
        return Some(ch as i32);
    }
    None
}

#[link(name = "user32")]
unsafe extern "system" {
    fn GetAsyncKeyState(key: i32) -> i16;
    fn GetForegroundWindow() -> isize;
    fn GetClassNameW(hwnd: isize, class: *mut u16, max: i32) -> i32;
    fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
    fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
    fn mouse_event(flags: u32, dx: u32, dy: u32, data: u32, extra: usize);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_raid_coordinates() {
        let parsed = parse_screenshot_name(
            "2025-03-30[21-04]_175.30, 1.37, 150.68_-0.01464, 0.98439, -0.14329, -0.10113_9.53 (0).png",
        )
        .expect("coords");
        assert!((parsed.x - 175.30).abs() < 0.001);
        assert!((parsed.y - 1.37).abs() < 0.001);
        assert!((parsed.z - 150.68).abs() < 0.001);
        assert!(parsed.yaw.is_some());
    }

    #[test]
    fn ignores_lobby_shots() {
        assert!(parse_screenshot_name("2026-08-30[21-35]_19.91 (0).png").is_none());
        assert!(parse_screenshot_name("old.png").is_none());
        assert!(parse_screenshot_name("").is_none());
    }

    #[test]
    fn identity_quaternion_faces_zero() {
        assert!(quaternion_to_yaw(0.0, 0.0, 0.0, 1.0).abs() < 0.0001);
    }

    #[test]
    fn prunes_oldest_dated_shots() {
        let files: Vec<(String, u64)> = (1..=5).map(|n| (format!("2026-01-0{n}[12-00]_1, 2, 3.png"), n)).collect();
        let drop = names_to_prune(&files, 2);
        assert_eq!(drop.len(), 3);
        assert!(drop.iter().all(|name| !name.contains("2026-01-04") && !name.contains("2026-01-05")));
    }

    #[test]
    fn keeps_newer_shot_when_name_sorts_earlier() {
        let files = vec![
            ("2026-01-01[12-00]_900, 1, 1.png".to_string(), 10),
            ("2026-01-01[12-00]_100, 1, 1.png".to_string(), 20),
        ];
        assert_eq!(
            names_to_prune(&files, 1),
            vec!["2026-01-01[12-00]_900, 1, 1.png".to_string()]
        );
    }

    #[test]
    fn old_file_keeps_sync_on_and_drops_offline_map() {
        let parsed: ShotSettings = serde_json::from_str(
            r#"{"pruneEnabled":true,"keepMax":12,"hotkey":"PrintScreen","offlineMap":"customs"}"#,
        )
        .expect("settings");
        let saved = normalize_settings(parsed);
        assert!(saved.sync_enabled);
        assert!(saved.prune_enabled);
        assert_eq!(saved.keep_max, 12);
        assert!(!saved.auto_enabled);
        assert_eq!(saved.auto_secs, 5);
        assert_eq!(saved.hotkey, "PrintScreen");
        let paused: ShotSettings = serde_json::from_str(
            r#"{"syncEnabled":false,"pruneEnabled":true,"autoEnabled":true,"autoSecs":1,"hotkey":"F8"}"#,
        )
        .expect("paused");
        let paused = normalize_settings(paused);
        assert!(!paused.sync_enabled);
        assert!(paused.prune_enabled);
        assert!(paused.auto_enabled);
        assert_eq!(paused.auto_secs, 2);
        assert_eq!(paused.hotkey, "F8");
    }

    #[test]
    fn clamps_auto_interval() {
        assert_eq!(clamp_auto(0), 2);
        assert_eq!(clamp_auto(5), 5);
        assert_eq!(clamp_auto(500), 120);
    }

    #[test]
    fn accepts_tarkov_window_titles() {
        assert!(is_game_window("UnityWndClass", "EscapeFromTarkov"));
        assert!(is_game_window("UnityWndClass", "Escape from Tarkov"));
        assert!(is_game_window("UnityWndClass", "逃离塔科夫"));
        assert!(!is_game_window("UnityWndClass", "Notepad"));
        assert!(!is_game_window("Chrome_WidgetWin_1", "Escape from Tarkov"));
    }

    #[test]
    fn reads_game_screenshot_key() {
        let text = r#"{"keyBindings":[{"keyName":"MakeScreenshot","variants":[{"keyCode":["Mouse4"]},{"keyCode":[]}]}]}"#;
        let bind = screenshot_bind(text).expect("bind");
        assert_eq!(bind.triggers, vec![0x06]);
        assert!(bind.modifiers.is_empty());
        assert_eq!(bind.hotkey, "Mouse5");
        assert_eq!(bind.game_name, "Mouse 4");
        let back = screenshot_bind(r#"{"keyBindings":[{"keyName":"MakeScreenshot","variants":[{"keyCode":["Mouse3"]}]}]}"#).expect("back");
        assert_eq!(back.triggers, vec![0x05]);
        assert_eq!(back.hotkey, "Mouse4");
        assert_eq!(back.game_name, "Mouse 3");
        let print = screenshot_bind(r#"{"keyBindings":[{"keyName":"MakeScreenshot","variants":[{"keyCode":["SysReq"]}]}]}"#).expect("print");
        assert_eq!(print.triggers, vec![0x2C]);
        assert_eq!(print.hotkey, "PrintScreen");
        let chord = screenshot_bind(r#"{"keyBindings":[{"keyName":"MakeScreenshot","variants":[{"keyCode":["P","LeftAlt"]}]}]}"#).expect("chord");
        assert_eq!(chord.modifiers, vec![0xA4]);
        assert_eq!(chord.triggers, vec![b'P' as i32]);
        assert_eq!(chord.game_name, "P + Left Alt");
        assert!(screenshot_bind(r#"{"keyBindings":[{"keyName":"MakeScreenshot","variants":[{"keyCode":[]}]}]}"#).is_none());
    }

    #[test]
    fn accepts_mouse_side_buttons() {
        assert_eq!(normalize_hotkey("Mouse4"), "Mouse4");
        assert_eq!(normalize_hotkey("mouse5"), "Mouse5");
        assert_eq!(normalize_hotkey("XButton1"), "Mouse4");
        assert_eq!(normalize_hotkey("xbutton2"), "Mouse5");
        assert_eq!(vk_of("Mouse4"), Some(0x05));
        assert_eq!(vk_of("Mouse5"), Some(0x06));
        assert_eq!(normalize_hotkey("nope"), "PrintScreen");
    }

    #[test]
    fn picks_screenshot_by_mtime() {
        let dir = std::env::temp_dir().join(format!("zhange-shot-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp");
        let older_name = "2026-01-01[12-00]_90, 1, 1_0, 0, 0, 1_75.png";
        let newer_name = "2026-01-01[12-00]_10, 1, 1_0, 0, 0, 1_75.png";
        fs::write(dir.join(older_name), b"old").expect("write");
        fs::write(dir.join(newer_name), b"new").expect("write");
        fs::File::options()
            .write(true)
            .open(dir.join(older_name))
            .expect("open")
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000))
            .expect("mtime");
        fs::File::options()
            .write(true)
            .open(dir.join(newer_name))
            .expect("open")
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(2_000))
            .expect("mtime");
        let picked = latest_screenshot(&dir).expect("latest");
        assert_eq!(picked.0, newer_name);
        let _ = fs::remove_dir_all(&dir);
    }
}

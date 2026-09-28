use std::fs;
use std::path::{Path, PathBuf};
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
    #[serde(default)]
    pub prune_enabled: bool,
    #[serde(default = "default_keep")]
    pub keep_max: u32,
    #[serde(default = "default_hotkey")]
    pub hotkey: String,
    #[serde(default)]
    pub offline_map: String,
}

fn default_keep() -> u32 {
    20
}

fn default_hotkey() -> String {
    "PrintScreen".into()
}

impl Default for ShotSettings {
    fn default() -> Self {
        Self {
            prune_enabled: false,
            keep_max: 20,
            hotkey: default_hotkey(),
            offline_map: String::new(),
        }
    }
}

static SETTINGS: Mutex<ShotSettings> = Mutex::new(ShotSettings {
    prune_enabled: false,
    keep_max: 20,
    hotkey: String::new(),
    offline_map: String::new(),
});

pub fn state() -> ShotState {
    STATE.lock().expect("shot-watch").clone()
}

pub fn settings(app: &AppHandle) -> ShotSettings {
    let loaded = read_settings(app);
    *SETTINGS.lock().expect("shot-settings") = loaded.clone();
    loaded
}

pub fn save_settings(app: &AppHandle, next: ShotSettings) -> Result<ShotSettings, String> {
    let saved = ShotSettings {
        prune_enabled: next.prune_enabled,
        keep_max: clamp_keep(next.keep_max),
        hotkey: normalize_hotkey(&next.hotkey),
        offline_map: next.offline_map.trim().to_string(),
    };
    let path = settings_file(app)?;
    let text = serde_json::to_string_pretty(&saved).map_err(|err| err.to_string())?;
    fs::write(path, text).map_err(|err| err.to_string())?;
    *SETTINGS.lock().expect("shot-settings") = saved.clone();
    Ok(saved)
}

pub fn spawn(app: AppHandle) {
    let loaded = read_settings(&app);
    *SETTINGS.lock().expect("shot-settings") = loaded;
    thread::spawn(move || watch(app));
}

fn watch(app: AppHandle) {
    let mut seen = ShotState::empty();
    let mut held = false;
    let mut last_scan = Instant::now() - Duration::from_secs(2);
    loop {
        let poke = hotkey_edge(&mut held);
        if poke {
            let _ = app.emit("shot-poke", ());
        }
        if poke || last_scan.elapsed() >= Duration::from_secs(1) {
            last_scan = Instant::now();
            let next = read_state(&app);
            if next != seen {
                seen = next.clone();
                *STATE.lock().expect("shot-watch") = next.clone();
                let _ = app.emit("shot-fix", next);
            }
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
    if settings.prune_enabled {
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
    let mut dated: Option<String> = None;
    let mut any: Option<String> = None;
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_image(&name) {
            continue;
        }
        if any.as_ref().map(|cur| name.as_str() > cur.as_str()).unwrap_or(true) {
            any = Some(name.clone());
        }
        if is_dated(&name) && dated.as_ref().map(|cur| name.as_str() > cur.as_str()).unwrap_or(true) {
            dated = Some(name);
        }
    }
    let name = dated.or(any)?;
    let modified_ms = fs::metadata(dir.join(&name))
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(to_millis)
        .unwrap_or(0);
    Some((name, modified_ms))
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
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn clamp_keep(value: u32) -> u32 {
    value.clamp(1, 200)
}

fn normalize_hotkey(raw: &str) -> String {
    let key = raw.trim();
    if key.is_empty() {
        return default_hotkey();
    }
    if key.eq_ignore_ascii_case("printscreen") || key.eq_ignore_ascii_case("print screen") || key.eq_ignore_ascii_case("prtsc") {
        return "PrintScreen".into();
    }
    let upper = key.to_ascii_uppercase();
    if vk_of(&upper).is_some() { upper } else { default_hotkey() }
}

fn names_to_prune(names: &[String], keep_max: u32) -> Vec<String> {
    let mut dated: Vec<&String> = names.iter().filter(|name| is_image(name) && is_dated(name)).collect();
    let cap = clamp_keep(keep_max) as usize;
    if dated.len() <= cap {
        return Vec::new();
    }
    dated.sort_by(|a, b| b.cmp(a));
    dated.into_iter().skip(cap).cloned().take(40).collect()
}

fn prune_old(dir: &Path, keep_max: u32) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    for name in names_to_prune(&names, keep_max) {
        let _ = fs::remove_file(dir.join(name));
    }
}

fn hotkey_edge(held: &mut bool) -> bool {
    let settings = SETTINGS.lock().expect("shot-settings").clone();
    let Some(vk) = vk_of(&settings.hotkey) else {
        *held = false;
        return false;
    };
    let down = unsafe { GetAsyncKeyState(vk) < 0 };
    let edge = down && !*held;
    *held = down;
    edge
}

fn vk_of(name: &str) -> Option<i32> {
    let name = name.trim();
    if name.eq_ignore_ascii_case("PrintScreen") {
        return Some(0x2C);
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
        let names: Vec<String> = (1..=5).map(|n| format!("2026-01-0{n}[12-00]_1, 2, 3.png")).collect();
        let drop = names_to_prune(&names, 2);
        assert_eq!(drop.len(), 3);
        assert!(drop.iter().all(|name| !name.contains("2026-01-04") && !name.contains("2026-01-05")));
    }
}

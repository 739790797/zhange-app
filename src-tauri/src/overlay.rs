use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WindowEvent};

const MAP_LABEL: &str = "map-overlay";
const RAID_LABEL: &str = "raid-hud";
const DEFAULT_WIDTH: u32 = 720;
const DEFAULT_HEIGHT: u32 = 540;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub auto_focus: bool,
    pub lock_aspect: bool,
    pub opacity: u8,
    pub shape: String,
    pub always_on_top: bool,
    pub click_through: bool,
    #[serde(default)]
    pub fullscreen: bool,
    pub raid_hud: bool,
    pub hotkey_enabled: bool,
    pub hotkey: String,
    pub visible: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub aspect: f64,
    pub placed: bool,
    pub map_slug: String,
    #[serde(default = "default_on")]
    pub auto_follow: bool,
    #[serde(default = "default_on")]
    pub raid_chime: bool,
}

fn default_on() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RaidStatus {
    pub in_raid: bool,
    pub elapsed_secs: u64,
    pub server_country: String,
    pub location: String,
}

struct Guard {
    capturing: bool,
    typing: bool,
    live: bool,
}

static FILE: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: Mutex<Option<OverlayState>> = Mutex::new(None);
static GUARD: Mutex<Guard> = Mutex::new(Guard { capturing: false, typing: false, live: false });
static ADJUSTING: Mutex<bool> = Mutex::new(false);
static COUNTRY: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));
static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let _ = FILE.set(dir.join("overlay.json"));
    let _ = APP.set(app.clone());
    let mut state = load();
    state.visible = false;
    state.raid_hud = false;
    store(&state);
    *STATE.lock().expect("overlay") = Some(state.clone());
    spawn_windows(app, &state);
    thread::spawn(hotkeys);
}

pub fn get() -> OverlayState {
    STATE.lock().expect("overlay").clone().unwrap_or_else(defaults)
}

pub fn save(mut state: OverlayState) -> OverlayState {
    normalize(&mut state);
    if state.lock_aspect && !state.fullscreen {
        if let Some(app) = APP.get() {
            if let Some(window) = app.get_webview_window(MAP_LABEL) {
                if let Ok(size) = window.inner_size() {
                    if size.width > 0 && size.height > 0 {
                        state.aspect = size.width as f64 / size.height as f64;
                    }
                }
            }
        }
    }
    store(&state);
    *STATE.lock().expect("overlay") = Some(state.clone());
    if let Some(app) = APP.get() {
        apply(app, &state);
        let _ = app.emit("overlay-changed", state.clone());
    }
    state
}

pub fn toggle() -> OverlayState {
    let mut state = get();
    state.visible = !state.visible;
    save(state)
}

pub fn reset() -> OverlayState {
    let mut state = get();
    state.width = DEFAULT_WIDTH;
    state.height = DEFAULT_HEIGHT;
    state.aspect = DEFAULT_WIDTH as f64 / DEFAULT_HEIGHT as f64;
    state.placed = false;
    state.x = 0;
    state.y = 0;
    state.fullscreen = false;
    save(state)
}

pub fn note_map(slug: String) {
    let slug = slug.trim().to_string();
    if slug.is_empty() {
        return;
    }
    let mut state = get();
    if state.map_slug == slug {
        return;
    }
    state.map_slug = slug;
    store(&state);
    *STATE.lock().expect("overlay") = Some(state);
}

pub fn set_guard(capturing: bool, typing: bool) {
    let mut guard = GUARD.lock().expect("overlay-guard");
    guard.capturing = capturing;
    guard.typing = typing;
}

pub fn set_hotkey_live(live: bool) {
    GUARD.lock().expect("overlay-guard").live = live;
}

pub fn close_with_app(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    for label in [MAP_LABEL, RAID_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
}

pub fn return_focus() {
    if !get().auto_focus {
        return;
    }
    let hwnd = find_game_window();
    if hwnd == 0 {
        return;
    }
    unsafe {
        keybd_event(0x12, 0, 0, 0);
        let _ = SetForegroundWindow(hwnd);
        keybd_event(0x12, 0, 2, 0);
    }
}

pub async fn raid_status(app: &AppHandle) -> RaidStatus {
    let _ = app;
    let watched = crate::logwatch::raid_snapshot();
    let mut status = RaidStatus {
        in_raid: watched.in_raid,
        elapsed_secs: watched.elapsed_secs,
        server_country: watched.server_country,
        location: watched.location,
    };
    if status.in_raid && !status.server_country.is_empty() && looks_like_ip(&status.server_country) {
        let ip = status.server_country.clone();
        status.server_country = country_for(&ip).await;
    }
    status
}

fn defaults() -> OverlayState {
    OverlayState {
        auto_focus: true,
        lock_aspect: false,
        opacity: 100,
        shape: "rect".into(),
        always_on_top: true,
        click_through: false,
        fullscreen: false,
        raid_hud: false,
        hotkey_enabled: true,
        hotkey: "M".into(),
        visible: false,
        x: 0,
        y: 0,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        aspect: DEFAULT_WIDTH as f64 / DEFAULT_HEIGHT as f64,
        placed: false,
        map_slug: String::new(),
        auto_follow: true,
        raid_chime: true,
    }
}

fn normalize(state: &mut OverlayState) {
    state.opacity = state.opacity.min(100);
    if state.shape != "circle" {
        state.shape = "rect".into();
    }
    state.click_through = false;
    let hotkey = state.hotkey.trim().to_ascii_uppercase();
    state.hotkey = if vk_of(&hotkey).is_some() { hotkey } else { "M".into() };
    state.width = state.width.clamp(240, 2400);
    state.height = state.height.clamp(180, 1600);
    if state.aspect < 0.2 || state.aspect > 5.0 {
        state.aspect = state.width as f64 / state.height as f64;
    }
}

fn load() -> OverlayState {
    let Some(path) = FILE.get() else { return defaults() };
    let mut state = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(defaults);
    normalize(&mut state);
    state
}

fn store(state: &OverlayState) {
    let Some(path) = FILE.get() else { return };
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, text);
    }
}

fn spawn_windows(app: &AppHandle, state: &OverlayState) {
    let _ = open_map(app, state);
    let _ = open_raid(app, state);
}

fn open_map(app: &AppHandle, state: &OverlayState) -> Result<(), String> {
    if app.get_webview_window(MAP_LABEL).is_some() {
        apply_map(app, state);
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(app, MAP_LABEL, WebviewUrl::App("index.html?view=overlay".into()))
        .title("地图覆盖层")
        .inner_size(state.width as f64, state.height as f64)
        .min_inner_size(240.0, 180.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(state.always_on_top)
        .skip_taskbar(true)
        .resizable(true)
        .visible(false)
        .focused(false)
        .background_color(tauri::utils::config::Color(0, 0, 0, 0))
        .build()
        .map_err(|err| err.to_string())?;
    let handle = window.clone();
    window.on_window_event(move |event| on_map_event(&handle, event));
    apply_map(app, state);
    Ok(())
}

fn open_raid(app: &AppHandle, state: &OverlayState) -> Result<(), String> {
    if app.get_webview_window(RAID_LABEL).is_some() {
        apply_raid(app, state);
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(app, RAID_LABEL, WebviewUrl::App("index.html?view=raid".into()))
        .title("战局悬浮窗")
        .inner_size(220.0, 132.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .background_color(tauri::utils::config::Color(0, 0, 0, 0))
        .build()
        .map_err(|err| err.to_string())?;
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let _ = handle.hide();
            let mut state = get();
            state.raid_hud = false;
            store(&state);
            *STATE.lock().expect("overlay") = Some(state.clone());
            if let Some(app) = APP.get() {
                let _ = app.emit("overlay-changed", state);
            }
        }
    });
    apply_raid(app, state);
    Ok(())
}

fn apply(app: &AppHandle, state: &OverlayState) {
    let _ = open_map(app, state);
    let _ = open_raid(app, state);
}

fn apply_map(app: &AppHandle, state: &OverlayState) {
    let Some(window) = app.get_webview_window(MAP_LABEL) else { return };
    let _ = window.set_always_on_top(state.always_on_top);
    let _ = window.set_ignore_cursor_events(false);
    apply_shape(&window, state);
    if !state.visible {
        let _ = window.set_fullscreen(false);
        let _ = window.hide();
        return;
    }
    let _ = window.set_fullscreen(state.fullscreen);
    if !state.fullscreen {
        if state.placed {
            let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        }
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    }
    let _ = window.show();
    if !state.placed {
        center_window(&window, state.width, state.height);
    }
    let _ = app.emit("overlay-shown", state.map_slug.clone());
}

fn apply_raid(app: &AppHandle, state: &OverlayState) {
    let Some(window) = app.get_webview_window(RAID_LABEL) else { return };
    let _ = window.set_always_on_top(true);
    if state.raid_hud {
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
}

fn apply_shape(window: &tauri::WebviewWindow, state: &OverlayState) {
    let Ok(hwnd) = window.hwnd() else { return };
    let Ok(size) = window.inner_size() else { return };
    unsafe {
        if state.shape == "circle" {
            let region = CreateEllipticRgn(0, 0, size.width as i32, size.height as i32);
            if region != 0 {
                SetWindowRgn(hwnd.0 as isize, region, 1);
            }
        } else {
            SetWindowRgn(hwnd.0 as isize, 0, 1);
        }
    }
}

fn center_window(window: &tauri::WebviewWindow, width: u32, height: u32) {
    let Ok(Some(monitor)) = window.primary_monitor() else { return };
    let size = monitor.size();
    let pos = monitor.position();
    let x = pos.x + (size.width as i32 - width as i32) / 2;
    let y = pos.y + (size.height as i32 - height as i32) / 2;
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let mut state = get();
    state.x = x;
    state.y = y;
    state.placed = true;
    store(&state);
    *STATE.lock().expect("overlay") = Some(state);
}

fn on_map_event(window: &tauri::WebviewWindow, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let _ = window.hide();
            let mut state = get();
            state.visible = false;
            store(&state);
            *STATE.lock().expect("overlay") = Some(state.clone());
            if let Some(app) = APP.get() {
                let _ = app.emit("overlay-changed", state);
            }
        }
        WindowEvent::Moved(position) => {
            if get().fullscreen || *ADJUSTING.lock().expect("overlay-adjust") {
                return;
            }
            let mut state = get();
            state.x = position.x;
            state.y = position.y;
            state.placed = true;
            store(&state);
            *STATE.lock().expect("overlay") = Some(state);
        }
        WindowEvent::Resized(size) => {
            if size.width < 2 || size.height < 2 {
                return;
            }
            let mut adjusting = ADJUSTING.lock().expect("overlay-adjust");
            if *adjusting {
                return;
            }
            let mut state = get();
            if state.fullscreen {
                drop(adjusting);
                apply_shape(window, &state);
                return;
            }
            let width = size.width;
            let mut height = size.height;
            if state.lock_aspect && state.aspect > 0.0 {
                let target = (width as f64 / state.aspect).round().max(180.0) as u32;
                if (target as i32 - height as i32).abs() > 2 {
                    height = target;
                    drop(adjusting);
                    *ADJUSTING.lock().expect("overlay-adjust") = true;
                    let _ = window.set_size(PhysicalSize::new(width, height));
                    *ADJUSTING.lock().expect("overlay-adjust") = false;
                    adjusting = ADJUSTING.lock().expect("overlay-adjust");
                }
            } else {
                state.aspect = width as f64 / height as f64;
            }
            state.width = width;
            state.height = height;
            store(&state);
            *STATE.lock().expect("overlay") = Some(state.clone());
            drop(adjusting);
            apply_shape(window, &state);
        }
        _ => {}
    }
}

fn hotkeys() {
    let mut held = false;
    loop {
        let state = get();
        let guard = GUARD.lock().expect("overlay-guard");
        let listening = state.hotkey_enabled && guard.live && !guard.capturing && !guard.typing;
        drop(guard);
        let down = listening && vk_of(&state.hotkey).is_some_and(pressed);
        if down && !held {
            let _ = toggle();
        }
        held = down;
        thread::sleep(Duration::from_millis(30));
    }
}


fn vk_of(name: &str) -> Option<i32> {
    let name = name.trim().to_ascii_uppercase();
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

fn pressed(vk: i32) -> bool {
    unsafe { GetAsyncKeyState(vk) < 0 }
}

fn find_game_window() -> isize {
    *FOUND.lock().expect("game-window") = 0;
    unsafe { EnumWindows(Some(enum_game), 0) };
    *FOUND.lock().expect("game-window")
}

static FOUND: Mutex<isize> = Mutex::new(0);

unsafe extern "system" fn enum_game(hwnd: isize, _: isize) -> i32 {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    let mut class = [0u16; 64];
    let length = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
    if length <= 0 {
        return 1;
    }
    let name = String::from_utf16_lossy(&class[..length as usize]);
    if name == "UnityWndClass" {
        let mut title = [0u16; 128];
        let title_len = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        let title = String::from_utf16_lossy(&title[..title_len.max(0) as usize]);
        if title.to_ascii_lowercase().contains("tarkov") || title.contains("逃离") {
            *FOUND.lock().expect("game-window") = hwnd;
            return 0;
        }
    }
    1
}

fn looks_like_ip(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    parts.len() == 4 && parts.iter().all(|part| part.parse::<u8>().is_ok())
}


async fn country_for(ip: &str) -> String {
    {
        let cached = COUNTRY.lock().expect("country");
        if cached.0 == ip && !cached.1.is_empty() {
            return cached.1.clone();
        }
    }
    let url = format!("http://ip-api.com/json/{ip}?fields=status,country&lang=zh-CN");
    let country = match reqwest::Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(client) => match client.get(url).send().await {
            Ok(response) => response.json::<serde_json::Value>().await.ok(),
            Err(_) => None,
        },
        Err(_) => None,
    };
    let name = country
        .filter(|value| value.get("status").and_then(|item| item.as_str()) == Some("success"))
        .and_then(|value| value.get("country").and_then(|item| item.as_str()).map(|item| item.to_string()))
        .unwrap_or_else(|| "未知".into());
    *COUNTRY.lock().expect("country") = (ip.to_string(), name.clone());
    name
}

#[link(name = "user32")]
unsafe extern "system" {
    fn GetAsyncKeyState(key: i32) -> i16;
    fn EnumWindows(proc: Option<unsafe extern "system" fn(isize, isize) -> i32>, data: isize) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn GetClassNameW(hwnd: isize, class: *mut u16, max: i32) -> i32;
    fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32;
    fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateEllipticRgn(left: i32, top: i32, right: i32, bottom: i32) -> isize;
}

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalSize, WebviewUrl, WindowEvent};

const MAP_LABEL: &str = "map-overlay";
const DEFAULT_WIDTH: u32 = 720;
const DEFAULT_HEIGHT: u32 = 540;
const GEOMETRY_SAVE_DEBOUNCE_MS: u64 = 180;

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
}

fn default_on() -> bool {
    true
}

struct Guard {
    capturing: bool,
    typing: bool,
}

static FILE: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: Mutex<Option<OverlayState>> = Mutex::new(None);
static STATE_TRANSACTION: Mutex<()> = Mutex::new(());
static STATE_REVISION: AtomicU64 = AtomicU64::new(0);
static STATE_PUBLICATION: Mutex<()> = Mutex::new(());
static GEOMETRY_UPDATES: OnceLock<SyncSender<()>> = OnceLock::new();
static GUARD: Mutex<Guard> = Mutex::new(Guard {
    capturing: false,
    typing: false,
});
static SUPPRESS: AtomicBool = AtomicBool::new(false);
static ADJUSTING: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

struct AdjustingGuard;

impl AdjustingGuard {
    fn begin() -> Option<Self> {
        ADJUSTING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for AdjustingGuard {
    fn drop(&mut self) {
        ADJUSTING.store(false, Ordering::SeqCst);
    }
}

struct SuppressWindowEvents(bool);

impl SuppressWindowEvents {
    fn begin() -> Self {
        Self(ADJUSTING.swap(true, Ordering::SeqCst))
    }
}

impl Drop for SuppressWindowEvents {
    fn drop(&mut self) {
        ADJUSTING.store(self.0, Ordering::SeqCst);
    }
}

pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let _ = fs::create_dir_all(&dir);
    let _ = FILE.set(dir.join("overlay.json"));
    let _ = APP.set(app.clone());
    let mut state = load();
    state.visible = false;
    {
        let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
        store_runtime(&state);
        set_state_locked(state.clone());
    }
    spawn_geometry_worker();
    spawn_windows(app, &state);
    thread::spawn(hotkeys);
}

fn spawn_geometry_worker() {
    let (sender, receiver) = mpsc::sync_channel(1);
    if GEOMETRY_UPDATES.set(sender).is_ok() {
        thread::spawn(move || geometry_worker(receiver));
    }
}

fn schedule_geometry_save() {
    if let Some(sender) = GEOMETRY_UPDATES.get() {
        let _ = sender.try_send(());
    }
}

fn wait_for_geometry_quiet(receiver: &Receiver<()>, quiet: Duration) -> bool {
    loop {
        match receiver.recv_timeout(quiet) {
            Ok(()) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => return true,
            Err(mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
}

fn flush_geometry_batch<F>(receiver: &Receiver<()>, quiet: Duration, flush: F) -> bool
where
    F: FnOnce(),
{
    if !wait_for_geometry_quiet(receiver, quiet) {
        return false;
    }
    flush();
    true
}

fn geometry_worker(receiver: Receiver<()>) {
    while receiver.recv().is_ok() {
        let quiet = Duration::from_millis(GEOMETRY_SAVE_DEBOUNCE_MS);
        if !flush_geometry_batch(&receiver, quiet, persist_geometry) {
            return;
        }
    }
}

fn persist_geometry() {
    let (state, revision) = {
        let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
        let state = get();
        store_runtime(&state);
        (state, STATE_REVISION.load(Ordering::SeqCst))
    };
    publish_event(&state, revision);
}

pub fn get() -> OverlayState {
    STATE
        .lock()
        .expect("overlay")
        .clone()
        .unwrap_or_else(defaults)
}

fn set_state_locked(state: OverlayState) -> u64 {
    *STATE.lock().expect("overlay") = Some(state);
    STATE_REVISION
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1)
}

pub fn save_preferences(state: OverlayState) -> Result<OverlayState, String> {
    save_inner(state, true)
}

fn save_inner(state: OverlayState, preserve_runtime: bool) -> Result<OverlayState, String> {
    let (saved, revision) = {
        let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
        save_locked(state, preserve_runtime)?
    };
    publish_state(&saved, revision);
    Ok(saved)
}

fn save_locked(
    mut state: OverlayState,
    preserve_runtime: bool,
) -> Result<(OverlayState, u64), String> {
    normalize(&mut state);
    let current = get();
    if preserve_runtime {
        state.x = current.x;
        state.y = current.y;
        state.width = current.width;
        state.height = current.height;
        state.aspect = current.aspect;
        state.placed = current.placed;
        state.map_slug = current.map_slug.clone();
        state.visible = current.visible;
        if !current.fullscreen {
            if let Some(app) = APP.get() {
                if let Some(window) = app.get_webview_window(MAP_LABEL) {
                    if let Ok(position) = window.outer_position() {
                        state.x = position.x;
                        state.y = position.y;
                        state.placed = true;
                    }
                    if let Ok(size) = window.inner_size() {
                        if size.width > 0 && size.height > 0 {
                            state.width = size.width;
                            state.height = size.height;
                        }
                    }
                }
            }
        }
    }
    if preserve_runtime {
        if state.lock_aspect && !state.fullscreen && current.fullscreen {
            state.aspect = state.width as f64 / state.height.max(1) as f64;
        } else if state.lock_aspect && !state.fullscreen {
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
    }
    store(&state)?;
    let revision = set_state_locked(state.clone());
    Ok((state, revision))
}

fn publish_state(state: &OverlayState, revision: u64) {
    let _publication = STATE_PUBLICATION.lock().expect("overlay-publication");
    if STATE_REVISION.load(Ordering::SeqCst) != revision {
        return;
    }
    if let Some(app) = APP.get() {
        let _suppress = SuppressWindowEvents::begin();
        apply(app, state);
        if STATE_REVISION.load(Ordering::SeqCst) == revision {
            let _ = app.emit("overlay-changed", state.clone());
        }
    }
}

fn publish_event(state: &OverlayState, revision: u64) {
    let _publication = STATE_PUBLICATION.lock().expect("overlay-publication");
    if STATE_REVISION.load(Ordering::SeqCst) != revision {
        return;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit("overlay-changed", state.clone());
    }
}

pub fn toggle() -> Result<OverlayState, String> {
    let in_raid = crate::logwatch::raid_snapshot().in_raid;
    let (next, revision) = {
        let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
        let mut state = get();
        if !state.visible && !in_raid {
            return Ok(state);
        }
        state.visible = !state.visible;
        save_locked(state, false)?
    };
    publish_state(&next, revision);
    Ok(next)
}

pub fn reset() -> Result<OverlayState, String> {
    let (next, revision) = {
        let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
        let mut state = get();
        state.width = DEFAULT_WIDTH;
        state.height = DEFAULT_HEIGHT;
        state.aspect = DEFAULT_WIDTH as f64 / DEFAULT_HEIGHT as f64;
        state.placed = false;
        state.x = 0;
        state.y = 0;
        state.fullscreen = false;
        save_locked(state, false)?
    };
    publish_state(&next, revision);
    Ok(next)
}

pub fn note_map(slug: String) -> Result<(), String> {
    let slug = slug.trim().to_string();
    if slug.is_empty() {
        return Ok(());
    }
    let (state, revision) = {
        let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
        let mut state = get();
        if state.map_slug == slug {
            return Ok(());
        }
        state.map_slug = slug;
        store(&state)?;
        let revision = set_state_locked(state.clone());
        (state, revision)
    };
    publish_event(&state, revision);
    Ok(())
}

pub fn set_guard(capturing: bool, typing: bool) {
    let mut guard = GUARD.lock().expect("overlay-guard");
    guard.capturing = capturing;
    guard.typing = typing;
}

pub fn suppress_hotkey(on: bool) {
    SUPPRESS.store(on, Ordering::SeqCst);
}

pub fn hotkey_suppressed() -> bool {
    SUPPRESS.load(Ordering::SeqCst)
}

pub fn set_hotkey_live(_live: bool) {}

pub fn close_with_app(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    persist_geometry();
    if let Some(window) = app.get_webview_window(MAP_LABEL) {
        let _ = window.destroy();
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

fn defaults() -> OverlayState {
    OverlayState {
        auto_focus: true,
        lock_aspect: false,
        opacity: 100,
        shape: "rect".into(),
        always_on_top: true,
        click_through: false,
        fullscreen: false,
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
    }
}

fn normalize(state: &mut OverlayState) {
    state.opacity = state.opacity.min(100);
    if state.shape != "circle" {
        state.shape = "rect".into();
    }
    state.click_through = false;
    let hotkey = state.hotkey.trim().to_ascii_uppercase();
    state.hotkey = if vk_of(&hotkey).is_some() {
        hotkey
    } else {
        "M".into()
    };
    state.width = state.width.clamp(240, 2400);
    state.height = state.height.clamp(180, 1600);
    if state.aspect < 0.2 || state.aspect > 5.0 {
        state.aspect = state.width as f64 / state.height as f64;
    }
}

fn load() -> OverlayState {
    let Some(path) = FILE.get() else {
        return defaults();
    };
    let mut state = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(defaults);
    normalize(&mut state);
    state
}

fn store(state: &OverlayState) -> Result<(), String> {
    let Some(path) = FILE.get() else {
        return Err("覆盖层设置目录不可用".into());
    };
    let text = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    crate::persist::atomic_write(path, text.as_bytes())
}

fn store_runtime(state: &OverlayState) {
    if let Err(error) = store(state) {
        if let Some(app) = APP.get() {
            let _ = app.emit("overlay-persistence-error", error);
        }
    }
}

fn spawn_windows(app: &AppHandle, state: &OverlayState) {
    let _ = open_map(app, state);
}

fn open_map(app: &AppHandle, state: &OverlayState) -> Result<(), String> {
    if app.get_webview_window(MAP_LABEL).is_some() {
        apply_map(app, state);
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(
        app,
        MAP_LABEL,
        WebviewUrl::App("index.html?view=overlay".into()),
    )
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

fn apply(app: &AppHandle, state: &OverlayState) {
    let _ = open_map(app, state);
}

fn apply_map(app: &AppHandle, state: &OverlayState) {
    let Some(window) = app.get_webview_window(MAP_LABEL) else {
        return;
    };
    let _ = window.set_always_on_top(state.always_on_top);
    if !state.visible {
        // 先让点击穿过，再藏起窗口。收起若慢一拍，也不能把主窗口的点击吃掉。
        let _ = window.set_ignore_cursor_events(true);
        conceal_window(&window);
        let _ = window.hide();
        return;
    }
    let _ = window.set_ignore_cursor_events(false);
    let shaped = if state.fullscreen {
        // 系统全屏会先露出原先的小窗，再异步铺满。显示前直接摆到屏幕尺寸。
        if let Some((x, y, width, height)) = monitor_bounds(&window) {
            place_window(&window, x, y, width, height);
            Some((width, height))
        } else {
            None
        }
    } else {
        let (x, y) = windowed_origin(&window, state);
        place_window(&window, x, y, state.width, state.height);
        Some((state.width, state.height))
    };
    apply_shape(&window, state, shaped);
    redraw_window(&window);
    let _ = window.show();
    let _ = app.emit("overlay-shown", state.map_slug.clone());
}

fn apply_shape(window: &tauri::WebviewWindow, state: &OverlayState, size: Option<(u32, u32)>) {
    let Ok(hwnd) = window.hwnd() else { return };
    let Some((width, height)) = size.or_else(|| {
        window
            .inner_size()
            .ok()
            .map(|size| (size.width, size.height))
    }) else {
        return;
    };
    if width < 2 || height < 2 {
        return;
    }
    unsafe {
        if state.shape == "circle" {
            let region = CreateEllipticRgn(0, 0, width as i32, height as i32);
            if region != 0 {
                SetWindowRgn(hwnd.0 as isize, region, 1);
            }
        } else {
            SetWindowRgn(hwnd.0 as isize, 0, 1);
        }
    }
}

fn monitor_bounds(window: &tauri::WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let pos = monitor.position();
    let size = monitor.size();
    Some((pos.x, pos.y, size.width, size.height))
}

fn windowed_origin(window: &tauri::WebviewWindow, state: &OverlayState) -> (i32, i32) {
    if state.placed {
        return (state.x, state.y);
    }
    let Some(monitor) = window.primary_monitor().ok().flatten() else {
        return (state.x, state.y);
    };
    let size = monitor.size();
    let pos = monitor.position();
    let x = pos.x + (size.width as i32 - state.width as i32) / 2;
    let y = pos.y + (size.height as i32 - state.height as i32) / 2;
    (x, y)
}

fn place_window(window: &tauri::WebviewWindow, x: i32, y: i32, width: u32, height: u32) {
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        let _ = SetWindowPos(
            hwnd.0 as isize,
            0,
            x,
            y,
            width as i32,
            height as i32,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

fn redraw_window(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        let _ = RedrawWindow(
            hwnd.0 as isize,
            std::ptr::null(),
            0,
            RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW,
        );
    }
}

fn conceal_window(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        let _ = SetWindowPos(
            hwnd.0 as isize,
            0,
            0,
            0,
            0,
            0,
            SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

fn on_map_event(window: &tauri::WebviewWindow, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let _ = window.hide();
            let (state, revision) = {
                let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
                let mut state = get();
                state.visible = false;
                store_runtime(&state);
                let revision = set_state_locked(state.clone());
                (state, revision)
            };
            publish_event(&state, revision);
        }
        WindowEvent::Moved(position) => {
            if ADJUSTING.load(Ordering::SeqCst) {
                return;
            }
            {
                let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
                if ADJUSTING.load(Ordering::SeqCst) {
                    return;
                }
                let mut state = get();
                if !state.visible || state.fullscreen {
                    return;
                }
                state.x = position.x;
                state.y = position.y;
                state.placed = true;
                set_state_locked(state);
            }
            schedule_geometry_save();
        }
        WindowEvent::Resized(size) => {
            if size.width < 2 || size.height < 2 {
                return;
            }
            let Some(adjusting) = AdjustingGuard::begin() else {
                return;
            };
            let _transaction = STATE_TRANSACTION.lock().expect("overlay-transaction");
            let mut state = get();
            if !state.visible {
                return;
            }
            if state.fullscreen {
                drop(_transaction);
                drop(adjusting);
                apply_shape(window, &state, Some((size.width, size.height)));
                return;
            }
            let width = size.width;
            let mut height = size.height;
            if state.lock_aspect && state.aspect > 0.0 {
                let target = (width as f64 / state.aspect).round().max(180.0) as u32;
                if (target as i32 - height as i32).abs() > 2 {
                    height = target;
                    let _ = window.set_size(PhysicalSize::new(width, height));
                }
            } else {
                state.aspect = width as f64 / height as f64;
            }
            state.width = width;
            state.height = height;
            set_state_locked(state.clone());
            drop(_transaction);
            drop(adjusting);
            apply_shape(window, &state, Some((width, height)));
            schedule_geometry_save();
        }
        _ => {}
    }
}

fn hotkeys() {
    let mut held = false;
    let mut was_raid = false;
    loop {
        let state = get();
        let key_down = vk_of(&state.hotkey).is_some_and(pressed);
        if hotkey_suppressed() {
            held = key_down;
            thread::sleep(Duration::from_millis(30));
            continue;
        }
        let in_raid = crate::logwatch::raid_snapshot().in_raid;
        if !in_raid {
            let _ = hotkey_edge(false, false, key_down, &mut held, &mut was_raid);
            if state.visible {
                let _ = toggle();
            }
            thread::sleep(Duration::from_millis(30));
            continue;
        }
        let listening = {
            let guard = GUARD.lock().expect("overlay-guard");
            state.hotkey_enabled && !guard.capturing && !guard.typing
        };
        let allowed = listening && key_down && focus_allows_hotkey();
        if hotkey_edge(true, allowed, key_down, &mut held, &mut was_raid) {
            let _ = toggle();
        }
        thread::sleep(Duration::from_millis(30));
    }
}

fn hotkey_edge(
    in_raid: bool,
    allowed: bool,
    key_down: bool,
    held: &mut bool,
    was_raid: &mut bool,
) -> bool {
    if !in_raid {
        *held = key_down;
        *was_raid = false;
        return false;
    }
    if !*was_raid {
        *held = key_down;
        *was_raid = true;
        return false;
    }
    let triggered = allowed && key_down && !*held;
    *held = key_down;
    triggered
}

fn focus_allows_hotkey() -> bool {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground == 0 {
        return false;
    }
    if let Some(app) = APP.get() {
        if let Some(window) = app.get_webview_window(MAP_LABEL) {
            if window.hwnd().ok().map(|hwnd| hwnd.0 as isize) == Some(foreground) {
                return true;
            }
        }
    }
    game_window(foreground)
}

pub fn game_is_foreground() -> bool {
    let foreground = unsafe { GetForegroundWindow() };
    foreground != 0 && game_window(foreground)
}

fn game_window(hwnd: isize) -> bool {
    unsafe {
        let mut class = [0u16; 64];
        let class_len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        if class_len <= 0 {
            return false;
        }
        let class = String::from_utf16_lossy(&class[..class_len as usize]);
        if class != "UnityWndClass" {
            return false;
        }
        let mut title = [0u16; 128];
        let title_len = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        let title = String::from_utf16_lossy(&title[..title_len.max(0) as usize]);
        title.to_ascii_lowercase().contains("tarkov") || title.contains("逃离")
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

#[cfg(test)]
mod tests {
    use super::{flush_geometry_batch, hotkey_edge};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, TryRecvError};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn geometry_updates_are_coalesced_until_the_window_is_quiet() {
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.try_send(()).expect("first update");
        receiver.recv().expect("worker receives first update");

        let producer_sender = sender.clone();
        let producer = thread::spawn(move || {
            for _ in 0..3 {
                thread::sleep(Duration::from_millis(5));
                let _ = producer_sender.try_send(());
            }
        });
        let flush_count = Arc::new(AtomicUsize::new(0));
        let count = flush_count.clone();
        assert!(flush_geometry_batch(
            &receiver,
            Duration::from_millis(30),
            move || {
                count.fetch_add(1, Ordering::SeqCst);
            }
        ));
        producer.join().expect("producer");

        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
        drop(sender);
    }

    #[test]
    fn suppressed_or_unfocused_key_holds_do_not_toggle_afterward() {
        let mut held = false;
        let mut was_raid = true;

        assert!(!hotkey_edge(true, false, true, &mut held, &mut was_raid));
        assert!(held);
        assert!(!hotkey_edge(true, true, true, &mut held, &mut was_raid));
    }

    #[test]
    fn a_fresh_key_press_triggers_once_after_release() {
        let mut held = false;
        let mut was_raid = true;

        assert!(hotkey_edge(true, true, true, &mut held, &mut was_raid));
        assert!(!hotkey_edge(true, true, true, &mut held, &mut was_raid));
        assert!(!hotkey_edge(true, false, false, &mut held, &mut was_raid));
        assert!(hotkey_edge(true, true, true, &mut held, &mut was_raid));
    }

    #[test]
    fn entering_a_raid_with_the_key_already_down_does_not_toggle() {
        let mut held = false;
        let mut was_raid = false;

        assert!(!hotkey_edge(true, true, true, &mut held, &mut was_raid));
        assert!(!hotkey_edge(true, true, true, &mut held, &mut was_raid));
    }
}

#[link(name = "user32")]
unsafe extern "system" {
    fn GetAsyncKeyState(key: i32) -> i16;
    fn GetForegroundWindow() -> isize;
    fn EnumWindows(
        proc: Option<unsafe extern "system" fn(isize, isize) -> i32>,
        data: isize,
    ) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn GetClassNameW(hwnd: isize, class: *mut u16, max: i32) -> i32;
    fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32)
        -> i32;
    fn RedrawWindow(hwnd: isize, rect: *const u8, region: isize, flags: u32) -> i32;
    fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
}

const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_HIDEWINDOW: u32 = 0x0080;
const RDW_INVALIDATE: u32 = 0x0001;
const RDW_ERASE: u32 = 0x0004;
const RDW_ALLCHILDREN: u32 = 0x0080;
const RDW_UPDATENOW: u32 = 0x0100;

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateEllipticRgn(left: i32, top: i32, right: i32, bottom: i32) -> isize;
}

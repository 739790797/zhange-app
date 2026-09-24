use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_DELAYS: [u32; 15] = [2500, 1600, 1700, 1800, 1830, 1760, 1800, 1720, 1735, 1655, 1580, 1530, 1543, 1492, 1488];

#[link(name = "user32")]
unsafe extern "system" {
    fn SetDeviceGammaRamp(hdc: isize, ramp: *const u16) -> i32;
    fn GetAsyncKeyState(key: i32) -> i16;
    fn mouse_event(flags: u32, dx: u32, dy: u32, data: u32, extra: usize);
    fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
    fn EnumDisplayMonitors(
        hdc: isize,
        clip: *const i32,
        proc: unsafe extern "system" fn(isize, isize, *mut i32, isize) -> i32,
        data: isize,
    ) -> i32;
    fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfoExW) -> i32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateDCW(driver: *const u16, device: *const u16, port: *const u16, devmode: *const u8) -> isize;
    fn DeleteDC(hdc: isize) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLastError() -> u32;
    fn SetLastError(error: u32);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Visual {
    pub gamma: f64,
    pub brightness: f64,
    pub contrast: f64,
    pub red: f64,
    pub green: f64,
    pub blue: f64,
    pub night: bool,
    pub night_brightness: f64,
    pub night_gray: f64,
    pub night_contrast: f64,
    pub big_map: bool,
    pub hotkey: String,
    pub screen: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scheme {
    pub name: String,
    pub visual: Visual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fitness {
    pub enabled: bool,
    pub hotkey: String,
    pub delays: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiaomiaoState {
    pub schemes: Vec<Scheme>,
    #[serde(default)]
    pub active: usize,
    pub fitness: Fitness,
    #[serde(default = "default_on")]
    pub visual_enabled: bool,
    #[serde(default = "default_screens")]
    pub screens: Vec<u8>,
    pub status: String,
}

static FILE: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: Mutex<Option<MiaomiaoState>> = Mutex::new(None);
static BUSY: Mutex<bool> = Mutex::new(false);

fn neutral() -> Visual {
    Visual {
        gamma: 1.0,
        brightness: 0.0,
        contrast: 0.0,
        red: 128.0,
        green: 128.0,
        blue: 128.0,
        night: false,
        night_brightness: 0.0,
        night_gray: 0.0,
        night_contrast: 0.0,
        big_map: false,
        hotkey: "F2".into(),
        screen: 1,
    }
}

fn default_on() -> bool { true }

fn default_screens() -> Vec<u8> { vec![1] }

fn preset(name: &str, hotkey: &str, gamma: f64, brightness: f64, contrast: f64, mask_base: f64, gamma_fix: f64, contrast_fix: f64) -> Scheme {
    let mut visual = neutral();
    visual.gamma = gamma;
    visual.brightness = brightness;
    visual.contrast = contrast;
    visual.night = mask_base != 0.0 || gamma_fix != 0.0 || contrast_fix != 0.0;
    visual.night_brightness = mask_base;
    visual.night_gray = gamma_fix;
    visual.night_contrast = contrast_fix;
    visual.hotkey = hotkey.into();
    Scheme { name: name.into(), visual }
}

fn defaults() -> MiaomiaoState {
    MiaomiaoState {
        schemes: vec![
            preset("默认", "F2", 1.0, 0.0, 0.0, 0.0, 0.0, 0.0),
            preset("晴天", "F3", 1.3, 6.0, 4.0, 37.0, 30.0, 0.0),
            preset("阴天", "F4", 1.55, 55.0, 21.0, 0.0, 101.0, 54.0),
            preset("夜晚", "F5", 2.4, 55.0, 22.0, 66.0, 48.0, 58.0),
            preset("极致", "F6", 2.9, 100.0, 37.0, 93.0, 46.0, 60.0),
        ],
        active: 0,
        fitness: Fitness {
            enabled: true,
            hotkey: "F9".into(),
            delays: DEFAULT_DELAYS.to_vec(),
        },
        visual_enabled: true,
        screens: default_screens(),
        status: "就绪".into(),
    }
}

pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let _ = FILE.set(dir.join("miaomiao.json"));
    let _ = APP.set(app.clone());
    let state = load();
    *STATE.lock().expect("miaomiao") = Some(state);
    thread::spawn(hotkeys);
}

fn load() -> MiaomiaoState {
    let Some(path) = FILE.get() else { return defaults() };
    let mut state = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(defaults);
    normalize(&mut state);
    state
}

fn normalize(state: &mut MiaomiaoState) {
    let base = defaults();
    if state.schemes.len() != 5 {
        *state = base;
        return;
    }
    if state.screens.is_empty() {
        state.screens = default_screens();
    }
    let replace_numbers = state.schemes.get(1).is_some_and(|item| item.visual.brightness < 1.0 || (item.visual.gamma - 1.1).abs() < 0.02);
    for (index, scheme) in state.schemes.iter_mut().enumerate() {
        let hotkey = scheme.visual.hotkey.clone();
        let screen = scheme.visual.screen;
        scheme.name = base.schemes[index].name.clone();
        if replace_numbers || hotkey.trim().is_empty() || hotkey.eq_ignore_ascii_case("F2") && index > 0 {
            scheme.visual = base.schemes[index].visual.clone();
            if !hotkey.trim().is_empty() && !(hotkey.eq_ignore_ascii_case("F2") && index > 0) {
                scheme.visual.hotkey = hotkey;
            }
            scheme.visual.screen = screen;
        }
    }
}

fn store(state: &MiaomiaoState) {
    let Some(path) = FILE.get() else { return };
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, text);
    }
}

pub fn get() -> MiaomiaoState {
    STATE.lock().expect("miaomiao").clone().unwrap_or_else(defaults)
}

pub fn save(mut state: MiaomiaoState, apply: bool) -> Result<MiaomiaoState, String> {
    if state.schemes.is_empty() {
        state = defaults();
    }
    if state.active >= state.schemes.len() {
        state.active = 0;
    }
    if state.fitness.delays.len() != 15 {
        state.fitness.delays = DEFAULT_DELAYS.to_vec();
    }
    state.screens.retain(|screen| *screen == 1 || *screen == 2);
    state.screens.sort_unstable();
    state.screens.dedup();
    state.status = "就绪".into();
    if apply {
        let visual = state.schemes[state.active].visual.clone();
        match apply_visual(&visual, &state.screens) {
            Ok(()) => state.status = "色彩已激活".into(),
            Err(err) => state.status = err,
        }
    }
    store(&state);
    *STATE.lock().expect("miaomiao") = Some(state.clone());
    Ok(state)
}

pub fn restore_delays() -> MiaomiaoState {
    let mut state = get();
    state.fitness.delays = DEFAULT_DELAYS.to_vec();
    state.status = "已恢复默认延迟".into();
    let _ = save(state, false);
    get()
}

#[repr(C)]
struct MonitorInfoExW {
    cb_size: u32,
    monitor: [i32; 4],
    work: [i32; 4],
    flags: u32,
    device: [u16; 32],
}

static MONITORS: Mutex<Vec<[u16; 32]>> = Mutex::new(Vec::new());

unsafe extern "system" fn collect_monitor(monitor: isize, _hdc: isize, _rect: *mut i32, _data: isize) -> i32 {
    let mut info = std::mem::zeroed::<MonitorInfoExW>();
    info.cb_size = std::mem::size_of::<MonitorInfoExW>() as u32;
    if GetMonitorInfoW(monitor, &mut info) != 0 {
        MONITORS.lock().expect("monitors").push(info.device);
    }
    1
}

fn monitor_names() -> Vec<[u16; 32]> {
    MONITORS.lock().expect("monitors").clear();
    unsafe {
        EnumDisplayMonitors(0, std::ptr::null(), collect_monitor, 0);
    }
    MONITORS.lock().expect("monitors").clone()
}

fn screen_device(index: u8) -> Vec<u16> {
    let monitors = monitor_names();
    if let Some(name) = monitors.get(index as usize) {
        return name.to_vec();
    }
    format!("\\\\.\\DISPLAY{}\0", index as u32 + 1).encode_utf16().collect()
}

fn apply_ramp(ramp: &[u16; 768], screen: u8) -> Result<(), String> {
    let name = screen_device(screen.saturating_sub(1));
    unsafe {
        let hdc = CreateDCW(name.as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null());
        if hdc == 0 {
            return Err(format!("打不开屏幕 {screen}（系统错误 {}）", GetLastError()));
        }
        let mut last_error = 0u32;
        let mut ok = 0;
        for _ in 0..6 {
            SetLastError(0);
            ok = SetDeviceGammaRamp(hdc, ramp.as_ptr());
            if ok != 0 {
                break;
            }
            last_error = GetLastError();
            if last_error != 298 {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        DeleteDC(hdc);
        if ok == 0 {
            return Err(format!("调节屏幕 {screen} 失败（系统错误 {last_error}）"));
        }
    }
    Ok(())
}

fn apply_visual(visual: &Visual, screens: &[u8]) -> Result<(), String> {
    if screens.is_empty() {
        return Err("请至少选择一个屏幕".into());
    }
    let ramp = build_ramp(visual);
    let mut errors = Vec::new();
    for screen in screens {
        if let Err(err) = apply_ramp(&ramp, *screen) {
            errors.push(err);
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("；")) }
}

fn build_ramp(visual: &Visual) -> [u16; 768] {
    let mut ramp = [0u16; 768];
    let gamma = visual.gamma.max(0.01);
    let contrast_factor = ((100.0 + visual.contrast) / 100.0).powi(2);
    let brightness_norm = visual.brightness / 255.0;
    let channels = [visual.red, visual.green, visual.blue];
    for channel in 0..3 {
        let scale = channels[channel] / 128.0;
        for index in 0..256 {
            let x = index as f64 / 255.0;
            let mut value = (x - 0.5) * contrast_factor + 0.5 + brightness_norm;
            value = if value <= 0.0 {
                0.0
            } else {
                value.min(1.0).powf(1.0 / gamma)
            };
            let word = (value * scale * 65535.0).round().clamp(0.0, 65535.0) as u16;
            ramp[channel * 256 + index] = word;
        }
    }
    ramp
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
    if chars.next().is_some() { return None; }
    if ch.is_ascii_alphanumeric() {
        return Some(ch as i32);
    }
    None
}

fn pressed(vk: i32) -> bool {
    unsafe { GetAsyncKeyState(vk) < 0 }
}

fn hotkeys() {
    let mut held = std::collections::HashSet::new();
    loop {
        let state = get();
        if state.visual_enabled {
            for (index, scheme) in state.schemes.iter().enumerate() {
                let Some(vk) = vk_of(&scheme.visual.hotkey) else { continue };
                let down = pressed(vk);
                if down && !held.contains(&vk) {
                    let _ = apply_visual(&scheme.visual, &state.screens);
                    let mut next = get();
                    next.active = index;
                    next.status = format!("已激活 {}", scheme.name);
                    store(&next);
                    *STATE.lock().expect("miaomiao") = Some(next.clone());
                    if let Some(app) = APP.get() {
                        let _ = app.emit("miaomiao-active", next);
                    }
                }
                if down { held.insert(vk); } else { held.remove(&vk); }
            }
        }
        if state.fitness.enabled {
            if let Some(vk) = vk_of(&state.fitness.hotkey) {
                let down = pressed(vk);
                if down && !held.contains(&vk) {
                    run_fitness(state.fitness.delays.clone());
                }
                if down { held.insert(vk); } else { held.remove(&vk); }
            }
        }
        thread::sleep(Duration::from_millis(30));
    }
}

fn run_fitness(delays: Vec<u32>) {
    let mut busy = BUSY.lock().expect("fitness");
    if *busy { return; }
    *busy = true;
    drop(busy);
    thread::spawn(move || {
        tap_key(0x46);
        for delay in delays {
            thread::sleep(Duration::from_millis(delay as u64));
            click();
        }
        *BUSY.lock().expect("fitness") = false;
    });
}

fn tap_key(vk: u8) {
    unsafe {
        keybd_event(vk, 0, 0, 0);
        keybd_event(vk, 0, 0x0002, 0);
    }
}

fn click() {
    unsafe {
        mouse_event(0x0002, 0, 0, 0, 0);
        mouse_event(0x0004, 0, 0, 0, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamma_applies_on_this_machine() {
        let names = monitor_names();
        eprintln!("monitors {}", names.len());
        for (index, name) in names.iter().enumerate() {
            let text = String::from_utf16_lossy(name).trim_end_matches('\0').to_string();
            eprintln!("screen {} = {text}", index + 1);
        }
        let presets = [
            (1.0, 0.0, 0.0),
            (1.3, 6.0, 4.0),
            (1.55, 55.0, 21.0),
            (2.4, 55.0, 22.0),
            (2.9, 100.0, 37.0),
        ];
        for (gamma, brightness, contrast) in presets {
            let mut visual = neutral();
            visual.screen = 1;
            visual.gamma = gamma;
            visual.brightness = brightness;
            visual.contrast = contrast;
            apply_visual(&visual, &[1]).unwrap_or_else(|err| panic!("gamma {gamma}: {err}"));
        }
        apply_visual(&neutral(), &[1]).expect("restore");
    }
}

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_DELAYS: [u32; 15] = [
    2500, 1600, 1700, 1800, 1830, 1760, 1800, 1720, 1735, 1655, 1580, 1530, 1543, 1492, 1488,
];

#[link(name = "user32")]
unsafe extern "system" {
    fn SetDeviceGammaRamp(hdc: isize, ramp: *const u16) -> i32;
    fn GetDeviceGammaRamp(hdc: isize, ramp: *mut u16) -> i32;
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
    fn CreateDCW(
        driver: *const u16,
        device: *const u16,
        port: *const u16,
        devmode: *const u8,
    ) -> isize;
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
static FITNESS_CANCEL: AtomicBool = AtomicBool::new(false);
static FITNESS_CONTROL: Mutex<()> = Mutex::new(());
static VISUAL_CONTROL: Mutex<()> = Mutex::new(());
static HOTKEYS_STOP: AtomicBool = AtomicBool::new(false);
static ORIGINAL_RAMPS: OnceLock<Mutex<HashMap<String, Vec<u16>>>> = OnceLock::new();

fn original_ramps() -> &'static Mutex<HashMap<String, Vec<u16>>> {
    ORIGINAL_RAMPS.get_or_init(|| Mutex::new(HashMap::new()))
}

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

fn default_on() -> bool {
    true
}

fn default_screens() -> Vec<u8> {
    vec![1]
}

fn preset(
    name: &str,
    hotkey: &str,
    gamma: f64,
    brightness: f64,
    contrast: f64,
    mask_base: f64,
    gamma_fix: f64,
    contrast_fix: f64,
) -> Scheme {
    let mut visual = neutral();
    visual.gamma = gamma;
    visual.brightness = brightness;
    visual.contrast = contrast;
    visual.night = mask_base != 0.0 || gamma_fix != 0.0 || contrast_fix != 0.0;
    visual.night_brightness = mask_base;
    visual.night_gray = gamma_fix;
    visual.night_contrast = contrast_fix;
    visual.hotkey = hotkey.into();
    Scheme {
        name: name.into(),
        visual,
    }
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
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let _ = fs::create_dir_all(&dir);
    let _ = FILE.set(dir.join("miaomiao.json"));
    let _ = APP.set(app.clone());
    let state = load();
    *STATE.lock().expect("miaomiao") = Some(state);
    thread::spawn(hotkeys);
}

fn load() -> MiaomiaoState {
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

fn normalize(state: &mut MiaomiaoState) {
    let base = defaults();
    if state.schemes.len() != 5 {
        *state = base;
        return;
    }
    if state.screens.is_empty() {
        state.screens = default_screens();
    }
    normalize_scheme_hotkeys(state);
    normalize_fitness(&mut state.fitness);
}

fn normalize_scheme_hotkeys(state: &mut MiaomiaoState) {
    let base = defaults();
    let replace_numbers = state
        .schemes
        .get(1)
        .is_some_and(|item| item.visual.brightness < 1.0 || (item.visual.gamma - 1.1).abs() < 0.02);
    for (index, scheme) in state.schemes.iter_mut().enumerate() {
        let hotkey = scheme.visual.hotkey.clone();
        let screen = scheme.visual.screen;
        scheme.name = base.schemes[index].name.clone();
        if replace_numbers
            || hotkey.trim().is_empty()
            || hotkey.eq_ignore_ascii_case("F2") && index > 0
        {
            scheme.visual = base.schemes[index].visual.clone();
            if !hotkey.trim().is_empty() && !(hotkey.eq_ignore_ascii_case("F2") && index > 0) {
                scheme.visual.hotkey = hotkey;
            }
            scheme.visual.screen = screen;
        }
        let hotkey = scheme.visual.hotkey.trim().to_ascii_uppercase();
        scheme.visual.hotkey = if vk_of(&hotkey).is_some() {
            hotkey
        } else {
            base.schemes[index].visual.hotkey.clone()
        };
    }
}

fn normalize_fitness(fitness: &mut Fitness) {
    if fitness.delays.len() != 15 {
        fitness.delays = DEFAULT_DELAYS.to_vec();
    }
    for delay in &mut fitness.delays {
        *delay = (*delay).clamp(50, 10_000);
    }
    let hotkey = fitness.hotkey.trim().to_ascii_uppercase();
    fitness.hotkey = if vk_of(&hotkey).is_some() {
        hotkey
    } else {
        "F9".into()
    };
}

fn store(state: &MiaomiaoState) -> Result<(), String> {
    let Some(path) = FILE.get() else {
        return Err("色彩设置目录不可用".into());
    };
    let text = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    crate::persist::atomic_write(path, text.as_bytes())
}

pub fn get() -> MiaomiaoState {
    STATE
        .lock()
        .expect("miaomiao")
        .clone()
        .unwrap_or_else(defaults)
}

pub fn save(mut state: MiaomiaoState, apply: bool) -> Result<MiaomiaoState, String> {
    let _visual_control = VISUAL_CONTROL.lock().expect("visual control");
    let _fitness_control = FITNESS_CONTROL.lock().expect("fitness control");
    if state.schemes.len() != 5 {
        state = defaults();
    }
    if state.active >= state.schemes.len() {
        state.active = 0;
    }
    normalize_scheme_hotkeys(&mut state);
    normalize_fitness(&mut state.fitness);
    state.screens.retain(|screen| *screen == 1 || *screen == 2);
    state.screens.sort_unstable();
    state.screens.dedup();
    if state.visual_enabled && state.screens.is_empty() {
        return Err("请至少选择一个屏幕".into());
    }
    state.status = "就绪".into();
    // Persist the selected configuration before changing system-wide gamma or input state.
    store(&state)?;
    if !state.visual_enabled {
        match restore_original_gamma() {
            Ok(()) => state.status = "色彩增强已关闭".into(),
            Err(err) => state.status = err,
        }
    } else if apply {
        let visual = state.schemes[state.active].visual.clone();
        match apply_visual(&visual, &state.screens) {
            Ok(()) => state.status = "色彩已激活".into(),
            Err(err) => state.status = err,
        }
    }
    if !state.fitness.enabled {
        stop_fitness();
    }
    *STATE.lock().expect("miaomiao") = Some(state.clone());
    Ok(state)
}

pub fn restore_delays() -> Result<MiaomiaoState, String> {
    let mut state = get();
    state.fitness.delays = DEFAULT_DELAYS.to_vec();
    state.status = "已恢复默认延迟".into();
    save(state, false)
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

unsafe extern "system" fn collect_monitor(
    monitor: isize,
    _hdc: isize,
    _rect: *mut i32,
    _data: isize,
) -> i32 {
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

struct ScreenDevice {
    screen: u8,
    wide_name: Vec<u16>,
    name: String,
}

fn screen_devices(screens: &[u8]) -> Vec<ScreenDevice> {
    // Resolve all requested screens from one monitor enumeration so selection,
    // cache keys, and the DC used to apply a ramp refer to the same device.
    let monitors = monitor_names();
    screens
        .iter()
        .map(|screen| {
            let index = screen.saturating_sub(1) as usize;
            let wide_name = monitors
                .get(index)
                .map(|name| name.to_vec())
                .unwrap_or_else(|| {
                    format!("\\\\.\\DISPLAY{}\0", index as u32 + 1)
                        .encode_utf16()
                        .collect()
                });
            let name = String::from_utf16_lossy(&wide_name)
                .trim_end_matches('\0')
                .to_string();
            ScreenDevice {
                screen: *screen,
                wide_name,
                name,
            }
        })
        .collect()
}

fn apply_ramp(ramp: &[u16; 768], target: &ScreenDevice) -> Result<(), String> {
    unsafe {
        let hdc = CreateDCW(
            target.wide_name.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        );
        if hdc == 0 {
            return Err(format!(
                "打不开屏幕 {}（系统错误 {}）",
                target.screen,
                GetLastError()
            ));
        }
        let mut originals = original_ramps().lock().expect("original gamma ramps");
        if !originals.contains_key(&target.name) {
            let mut original = [0u16; 768];
            if GetDeviceGammaRamp(hdc, original.as_mut_ptr()) == 0 {
                DeleteDC(hdc);
                return Err(format!(
                    "读取屏幕 {} 当前色彩失败，未应用增强",
                    target.screen
                ));
            }
            originals.insert(target.name.clone(), original.to_vec());
        }
        drop(originals);
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
            return Err(format!(
                "调节屏幕 {} 失败（系统错误 {last_error}）",
                target.screen
            ));
        }
    }
    Ok(())
}

pub fn restore_original_gamma() -> Result<(), String> {
    restore_gamma_where(None)
}

fn restore_unselected_gamma(devices: &[ScreenDevice]) -> Result<(), String> {
    let selected = devices
        .iter()
        .map(|device| device.name.clone())
        .collect::<HashSet<_>>();
    restore_gamma_where(Some(&selected))
}

fn restore_gamma_where(keep: Option<&HashSet<String>>) -> Result<(), String> {
    let originals = original_ramps()
        .lock()
        .expect("original gamma ramps")
        .clone();
    let mut restored = Vec::new();
    let mut errors = Vec::new();
    for (device, values) in originals {
        if keep.is_some_and(|selected| selected.contains(&device)) {
            continue;
        }
        let Ok(ramp): Result<[u16; 768], _> = values.try_into() else {
            errors.push(format!("屏幕 {device} 的原始色彩数据无效"));
            continue;
        };
        let device_wide = format!("{device}\0").encode_utf16().collect::<Vec<_>>();
        unsafe {
            let hdc = CreateDCW(
                device_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            );
            if hdc == 0 {
                errors.push(format!(
                    "无法恢复屏幕 {device}（系统错误 {}）",
                    GetLastError()
                ));
                continue;
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
                errors.push(format!(
                    "恢复屏幕 {device} 色彩失败（系统错误 {last_error}）"
                ));
            } else {
                restored.push(device);
            }
        }
    }
    let mut originals = original_ramps().lock().expect("original gamma ramps");
    for device in restored {
        originals.remove(&device);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

fn apply_visual(visual: &Visual, screens: &[u8]) -> Result<(), String> {
    if screens.is_empty() {
        return Err("请至少选择一个屏幕".into());
    }
    let devices = screen_devices(screens);
    let ramp = build_ramp(visual);
    let mut errors = Vec::new();
    if let Err(error) = restore_unselected_gamma(&devices) {
        errors.push(error);
    }
    for device in &devices {
        if let Err(err) = apply_ramp(&ramp, device) {
            errors.push(err);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
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

fn hotkeys() {
    let mut held = std::collections::HashSet::new();
    loop {
        if HOTKEYS_STOP.load(Ordering::Acquire) {
            break;
        }
        if crate::overlay::hotkey_suppressed() {
            let state = get();
            if state.visual_enabled {
                for scheme in &state.schemes {
                    let Some(vk) = vk_of(&scheme.visual.hotkey) else {
                        continue;
                    };
                    if pressed(vk) {
                        held.insert(vk);
                    } else {
                        held.remove(&vk);
                    }
                }
            }
            if state.fitness.enabled {
                if let Some(vk) = vk_of(&state.fitness.hotkey) {
                    if pressed(vk) {
                        held.insert(vk);
                    } else {
                        held.remove(&vk);
                    }
                }
            }
            thread::sleep(std::time::Duration::from_millis(30));
            continue;
        }
        let state = get();
        if state.visual_enabled {
            for (index, scheme) in state.schemes.iter().enumerate() {
                let Some(vk) = vk_of(&scheme.visual.hotkey) else {
                    continue;
                };
                let down = pressed(vk);
                if down && !held.contains(&vk) {
                    let _visual_control = VISUAL_CONTROL.lock().expect("visual control");
                    let latest = get();
                    if !HOTKEYS_STOP.load(Ordering::Acquire)
                        && latest.visual_enabled
                        && latest
                            .schemes
                            .get(index)
                            .is_some_and(|item| vk_of(&item.visual.hotkey) == Some(vk))
                    {
                        let scheme = latest.schemes[index].clone();
                        let _ = apply_visual(&scheme.visual, &latest.screens);
                        let mut next = get();
                        next.active = index;
                        next.status = format!("已激活 {}", scheme.name);
                        if let Err(error) = store(&next) {
                            next.status = format!("方案已应用，但保存失败：{error}");
                        }
                        *STATE.lock().expect("miaomiao") = Some(next.clone());
                        if let Some(app) = APP.get() {
                            let _ = app.emit("miaomiao-active", next);
                        }
                    }
                }
                if down {
                    held.insert(vk);
                } else {
                    held.remove(&vk);
                }
            }
        }
        if state.fitness.enabled {
            if let Some(vk) = vk_of(&state.fitness.hotkey) {
                let down = pressed(vk);
                if down && !held.contains(&vk) && crate::overlay::game_is_foreground() {
                    run_fitness(vk);
                }
                if down {
                    held.insert(vk);
                } else {
                    held.remove(&vk);
                }
            }
        }
        thread::sleep(Duration::from_millis(30));
    }
}

fn run_fitness(hotkey: i32) {
    let _fitness_control = FITNESS_CONTROL.lock().expect("fitness control");
    let state = get();
    if HOTKEYS_STOP.load(Ordering::Acquire)
        || !state.fitness.enabled
        || vk_of(&state.fitness.hotkey) != Some(hotkey)
        || !crate::overlay::game_is_foreground()
    {
        return;
    }
    let mut busy = BUSY.lock().expect("fitness");
    if *busy {
        return;
    }
    *busy = true;
    drop(busy);
    FITNESS_CANCEL.store(false, Ordering::Relaxed);
    let delays = state.fitness.delays;
    thread::spawn(move || {
        {
            let _fitness_control = FITNESS_CONTROL.lock().expect("fitness control");
            if FITNESS_CANCEL.load(Ordering::Acquire)
                || HOTKEYS_STOP.load(Ordering::Acquire)
                || !get().fitness.enabled
                || !crate::overlay::game_is_foreground()
            {
                *BUSY.lock().expect("fitness") = false;
                return;
            }
            tap_key(0x46);
        }
        for delay in delays {
            if !wait_while_game_foreground(delay) {
                break;
            }
            let _fitness_control = FITNESS_CONTROL.lock().expect("fitness control");
            if FITNESS_CANCEL.load(Ordering::Acquire)
                || HOTKEYS_STOP.load(Ordering::Acquire)
                || !get().fitness.enabled
                || !crate::overlay::game_is_foreground()
            {
                break;
            }
            click();
        }
        *BUSY.lock().expect("fitness") = false;
    });
}

fn wait_while_game_foreground(delay_ms: u32) -> bool {
    let mut remaining = delay_ms;
    while remaining > 0 {
        if FITNESS_CANCEL.load(Ordering::Acquire)
            || HOTKEYS_STOP.load(Ordering::Acquire)
            || !crate::overlay::game_is_foreground()
        {
            return false;
        }
        let interval = remaining.min(100);
        thread::sleep(Duration::from_millis(interval as u64));
        remaining -= interval;
    }
    !FITNESS_CANCEL.load(Ordering::Acquire)
        && !HOTKEYS_STOP.load(Ordering::Acquire)
        && crate::overlay::game_is_foreground()
}

pub fn stop_fitness() {
    FITNESS_CANCEL.store(true, Ordering::Release);
}

pub fn shutdown() {
    HOTKEYS_STOP.store(true, Ordering::Release);
    stop_fitness();
    let _visual_control = VISUAL_CONTROL.lock().expect("visual control");
    let _fitness_control = FITNESS_CONTROL.lock().expect("fitness control");
    let _ = restore_original_gamma();
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
    fn gamma_ramp_is_monotonic_and_neutral_ramp_is_identity() {
        let neutral_ramp = build_ramp(&neutral());
        for index in 0..256 {
            let expected = (index * 257) as u16;
            for channel in 0..3 {
                assert_eq!(neutral_ramp[channel * 256 + index], expected);
            }
        }

        for (gamma, brightness, contrast) in [
            (1.0, 0.0, 0.0),
            (1.3, 6.0, 4.0),
            (1.55, 55.0, 21.0),
            (2.4, 55.0, 22.0),
            (2.9, 100.0, 37.0),
        ] {
            let mut visual = neutral();
            visual.gamma = gamma;
            visual.brightness = brightness;
            visual.contrast = contrast;
            let ramp = build_ramp(&visual);
            for channel in 0..3 {
                let values = &ramp[channel * 256..(channel + 1) * 256];
                assert!(values.windows(2).all(|pair| pair[0] <= pair[1]));
                assert_eq!(values.first(), Some(&0));
                assert_eq!(values.last(), Some(&u16::MAX));
            }
        }
    }
}

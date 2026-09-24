use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[link(name = "gdi32")]
unsafe extern "system" {
    fn GetDC(hwnd: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn ReleaseDC(hwnd: *mut std::ffi::c_void, hdc: *mut std::ffi::c_void) -> i32;
    fn GetDeviceGammaRamp(hdc: *mut std::ffi::c_void, ramp: *mut std::ffi::c_void) -> i32;
    fn SetDeviceGammaRamp(hdc: *mut std::ffi::c_void, ramp: *const std::ffi::c_void) -> i32;
}

use crate::config::{self, AppConfig};

pub struct DisplayState {
    original: Mutex<Option<[u16; 768]>>,
    active: Mutex<bool>,
}

impl Default for DisplayState {
    fn default() -> Self {
        Self {
            original: Mutex::new(None),
            active: Mutex::new(false),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySnapshot {
    pub gamma: f64,
    pub brightness: f64,
    pub active: bool,
}

fn with_screen_dc<T>(body: impl FnOnce(*mut std::ffi::c_void) -> T) -> T {
    unsafe {
        let hdc = GetDC(std::ptr::null_mut());
        let value = body(hdc);
        if !hdc.is_null() {
            ReleaseDC(std::ptr::null_mut(), hdc);
        }
        value
    }
}

fn read_ramp() -> Result<[u16; 768], String> {
    let mut ramp = [0u16; 768];
    let ok = with_screen_dc(|hdc| {
        if hdc.is_null() {
            return 0;
        }
        unsafe { GetDeviceGammaRamp(hdc, ramp.as_mut_ptr().cast()) }
    });
    if ok == 0 {
        return Err("读不到当前屏幕伽马".into());
    }
    Ok(ramp)
}

fn write_ramp(ramp: &[u16; 768]) -> Result<(), String> {
    let ok = with_screen_dc(|hdc| {
        if hdc.is_null() {
            return 0;
        }
        unsafe { SetDeviceGammaRamp(hdc, ramp.as_ptr().cast()) }
    });
    if ok == 0 {
        return Err("系统没有接受伽马设置。全屏独占或 HDR 打开时可能会失败".into());
    }
    Ok(())
}

fn build_ramp(gamma: f64, brightness: f64) -> [u16; 768] {
    let gamma = gamma.clamp(0.3, 3.0);
    let brightness = brightness.clamp(0.2, 2.0);
    let mut ramp = [0u16; 768];
    for i in 0..256 {
        let x = i as f64 / 255.0;
        let y = (x.powf(1.0 / gamma) * brightness).clamp(0.0, 1.0);
        let value = (y * 65535.0).round() as u16;
        ramp[i] = value;
        ramp[256 + i] = value;
        ramp[512 + i] = value;
    }
    ramp
}

pub fn snapshot(config: &AppConfig, display: &DisplayState) -> DisplaySnapshot {
    DisplaySnapshot {
        gamma: config.gamma,
        brightness: config.brightness,
        active: *display.active.lock().expect("display lock"),
    }
}

pub fn apply(app: &AppHandle, gamma: f64, brightness: f64) -> Result<(), String> {
    let gamma = gamma.clamp(0.3, 3.0);
    let brightness = brightness.clamp(0.2, 2.0);
    let display = app.state::<DisplayState>();
    {
        let mut original = display.original.lock().expect("display lock");
        if original.is_none() {
            *original = Some(read_ramp()?);
        }
    }
    write_ramp(&build_ramp(gamma, brightness))?;
    *display.active.lock().expect("display lock") = true;
    let mut cfg = config::load(app);
    cfg.gamma = gamma;
    cfg.brightness = brightness;
    config::save(app, &cfg)?;
    if let Some(state) = app.try_state::<crate::AppState>() {
        *state.config.lock().expect("config lock") = cfg;
    }
    Ok(())
}

pub fn restore(app: &AppHandle) -> Result<(), String> {
    let display = app.state::<DisplayState>();
    let original = display.original.lock().expect("display lock").clone();
    if let Some(ramp) = original {
        write_ramp(&ramp)?;
    }
    *display.active.lock().expect("display lock") = false;
    Ok(())
}

pub fn toggle(app: &AppHandle) {
    let active = app
        .try_state::<DisplayState>()
        .map(|state| *state.active.lock().expect("display lock"))
        .unwrap_or(false);
    if active {
        let _ = restore(app);
        return;
    }
    let cfg = app
        .try_state::<crate::AppState>()
        .map(|state| state.config.lock().expect("config lock").clone())
        .unwrap_or_else(|| config::load(app));
    let _ = apply(app, cfg.gamma, cfg.brightness);
}

#[tauri::command]
pub fn display_get(app: AppHandle) -> DisplaySnapshot {
    let cfg = app
        .try_state::<crate::AppState>()
        .map(|state| state.config.lock().expect("config lock").clone())
        .unwrap_or_else(|| config::load(&app));
    snapshot(&cfg, app.state::<DisplayState>().inner())
}

#[tauri::command]
pub fn display_apply(
    app: AppHandle,
    gamma: f64,
    brightness: f64,
) -> Result<DisplaySnapshot, String> {
    apply(&app, gamma, brightness)?;
    Ok(display_get(app))
}

#[tauri::command]
pub fn display_restore(app: AppHandle) -> Result<DisplaySnapshot, String> {
    restore(&app)?;
    Ok(display_get(app))
}

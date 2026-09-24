pub(crate) mod local;
mod logwatch;
mod miaomiao;
mod overlay;
mod room_ws;
mod site;

use serde_json::Value;
use tauri::WebviewUrl;

#[tauri::command]
async fn site_login(username: String, password: String) -> Result<site::SiteUser, String> {
    site::login(username, password).await
}

#[tauri::command]
async fn site_logout() -> Result<(), String> {
    room_ws::unwatch();
    site::logout().await
}

#[tauri::command]
fn room_watch(app: tauri::AppHandle, public_id: String) {
    room_ws::watch(app, public_id);
}

#[tauri::command]
fn room_unwatch() {
    room_ws::unwatch();
}

#[tauri::command]
async fn site_session() -> Result<site::SiteUser, String> {
    site::restore().await
}

#[tauri::command]
async fn site_get(path: String) -> Result<Value, String> {
    site::get(path).await
}

#[tauri::command]
async fn site_post(path: String, body: Value) -> Result<Value, String> {
    site::post(path, body).await
}

#[tauri::command]
async fn site_put(path: String, body: Value) -> Result<Value, String> {
    site::put(path, body).await
}

#[tauri::command]
async fn site_delete(path: String) -> Result<Value, String> {
    site::delete(path).await
}

#[tauri::command]
fn site_set_game_mode(mode: String) {
    site::set_game_mode(&mode);
}

#[tauri::command]
fn app_usage() -> local::AppUsage {
    local::usage()
}

#[tauri::command]
fn paths_get(app: tauri::AppHandle) -> local::BoundPaths {
    local::get_paths(&app)
}

#[tauri::command]
fn paths_set(app: tauri::AppHandle, screenshot_dir: String, log_dir: String) -> Result<local::BoundPaths, String> {
    local::set_paths(&app, screenshot_dir, log_dir)
}

#[tauri::command]
fn paths_detect(app: tauri::AppHandle) -> Result<local::DetectResult, String> {
    local::detect_and_save(&app)
}

#[tauri::command]
fn paths_pick(title: String) -> Option<String> {
    local::pick_dir(&title)
}

#[tauri::command]
fn paths_open(path: String) -> Result<(), String> {
    local::open_dir(&path)
}

#[tauri::command]
fn logs_list(app: tauri::AppHandle) -> Result<Vec<local::LogSession>, String> {
    local::list_log_sessions(&app)
}

#[tauri::command]
fn logs_read(app: tauri::AppHandle, folders: Vec<String>) -> Result<Vec<local::LogBundle>, String> {
    local::read_log_sessions(&app, folders)
}

#[tauri::command]
fn miaomiao_get() -> miaomiao::MiaomiaoState {
    miaomiao::get()
}

#[tauri::command]
fn miaomiao_save(state: miaomiao::MiaomiaoState, apply: bool) -> Result<miaomiao::MiaomiaoState, String> {
    miaomiao::save(state, apply)
}

#[tauri::command]
fn miaomiao_restore_delays() -> miaomiao::MiaomiaoState {
    miaomiao::restore_delays()
}

#[tauri::command]
fn overlay_get() -> overlay::OverlayState {
    overlay::get()
}

#[tauri::command]
fn overlay_save(state: overlay::OverlayState) -> overlay::OverlayState {
    overlay::save(state)
}

#[tauri::command]
fn overlay_toggle() -> overlay::OverlayState {
    overlay::toggle()
}

#[tauri::command]
fn overlay_reset() -> overlay::OverlayState {
    overlay::reset()
}

#[tauri::command]
fn overlay_note_map(slug: String) {
    overlay::note_map(slug);
}

#[tauri::command]
fn overlay_set_guard(capturing: bool, typing: bool) {
    overlay::set_guard(capturing, typing);
}

#[tauri::command]
fn overlay_set_hotkey_live(live: bool) {
    overlay::set_hotkey_live(live);
}

#[tauri::command]
fn overlay_return_focus() {
    overlay::return_focus();
}

#[tauri::command]
fn log_state() -> logwatch::WatchState {
    logwatch::state()
}

#[tauri::command]
async fn raid_status(app: tauri::AppHandle) -> overlay::RaidStatus {
    overlay::raid_status(&app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            site_login,
            site_logout,
            site_session,
            site_get,
            site_post,
            site_put,
            site_delete,
            site_set_game_mode,
            room_watch,
            room_unwatch,
            app_usage,
            paths_get,
            paths_set,
            paths_detect,
            paths_pick,
            paths_open,
            logs_list,
            logs_read,
            miaomiao_get,
            miaomiao_save,
            miaomiao_restore_delays,
            overlay_get,
            overlay_save,
            overlay_toggle,
            overlay_reset,
            overlay_note_map,
            overlay_set_guard,
            overlay_set_hotkey_live,
            overlay_return_focus,
            raid_status,
            log_state
        ])
        .setup(|app| {
            site::init(app.handle());
            miaomiao::init(app.handle());
            overlay::init(app.handle());
            logwatch::spawn(app.handle().clone());
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))?;
            let window = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("战鸽助手")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .icon(icon)?
                .build()?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    overlay::close_with_app(&handle);
                }
            });
            window.with_webview(|webview| unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows_core::Interface;
                let Some(settings) = webview
                    .controller()
                    .CoreWebView2()
                    .ok()
                    .and_then(|core| core.Settings().ok())
                else {
                    return;
                };
                if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
                    let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
                }
            })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

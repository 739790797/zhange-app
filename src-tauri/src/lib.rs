mod config;
mod display;
mod tarkov;

use std::sync::Mutex;

use tauri::{Manager, WebviewUrl};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use config::AppConfig;

pub struct AppState {
    pub config: Mutex<AppConfig>,
}

fn bridge_script(cfg: &AppConfig) -> String {
    include_str!("bridge.js")
        .replace(
            "__SCREENSHOTS__",
            &serde_json::to_string(&cfg.screenshots_dir).unwrap_or_else(|_| "null".into()),
        )
        .replace(
            "__LOGS__",
            &serde_json::to_string(&cfg.logs_dir).unwrap_or_else(|_| "null".into()),
        )
}

fn layout_site(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(site) = app.get_webview("site") else {
        return;
    };
    let Ok(physical) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = physical.width as f64 / scale;
    let height = physical.height as f64 / scale;
    let side = 220.0;
    let _ = site.set_position(tauri::LogicalPosition::new(side, 0.0));
    let _ = site.set_size(tauri::LogicalSize::new((width - side).max(1.0), height.max(1.0)));
}

fn open_site(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let cfg = app.state::<AppState>().config.lock().expect("config lock").clone();
    let url = config::page_url(&cfg.site, path)?;
    let parsed = url.parse().map_err(|err: url::ParseError| err.to_string())?;
    let site = app.get_webview("site").ok_or("站点视图还没准备好")?;
    site.navigate(parsed).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> AppConfig {
    app.state::<AppState>()
        .config
        .lock()
        .expect("config lock")
        .clone()
}

#[tauri::command]
fn set_site(app: tauri::AppHandle, site: String) -> Result<AppConfig, String> {
    let site = config::normalize_site(&site)?;
    {
        let state = app.state::<AppState>();
        let mut cfg = state.config.lock().expect("config lock");
        cfg.site = site;
        config::save(&app, &cfg)?;
    }
    open_site(&app, "/app")?;
    Ok(get_config(app))
}

#[tauri::command]
fn navigate(app: tauri::AppHandle, path: String) -> Result<(), String> {
    open_site(&app, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        display::toggle(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let cfg = config::load(app.handle());
            app.manage(AppState {
                config: Mutex::new(cfg.clone()),
            });
            app.manage(display::DisplayState::default());
            app.manage(tarkov::TarkovWatch::default());

            let window = app.get_window("main").expect("main window");
            let start = config::page_url(&cfg.site, "/app").expect("default site");
            let site_url = start.parse().expect("site url");
            window.add_child(
                tauri::webview::WebviewBuilder::new("site", WebviewUrl::External(site_url))
                    .initialization_script(bridge_script(&cfg)),
                tauri::LogicalPosition::new(220.0, 0.0),
                tauri::LogicalSize::new(1060.0, 800.0),
            )?;
            layout_site(app.handle());
            tarkov::arm_saved(app.handle(), &cfg);

            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(_) = event {
                    layout_site(&handle);
                }
            });

            let _ = app.global_shortcut().register("ctrl+alt+g");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_site,
            navigate,
            tarkov::tarkov_list,
            tarkov::tarkov_read_text,
            tarkov::tarkov_read_bytes,
            tarkov::tarkov_remove,
            tarkov::tarkov_rebind,
            display::display_get,
            display::display_apply,
            display::display_restore,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = display::restore(app);
            }
        });
}

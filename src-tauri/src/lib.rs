mod config;

use tauri::WebviewUrl;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let cfg = config::load(app.handle());
            let url = cfg.site.parse().expect("site url");
            tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("战鸽助手")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    // cargo run 用 CreateProcess 拉起进程，无法弹出 UAC，清单若要求管理员会直接失败（os error 740）。
    // 调试构建改为 asInvoker；正式包仍使用清单里的 requireAdministrator。
    let manifest = include_str!("windows-app.manifest.xml");
    let manifest = if std::env::var("PROFILE").as_deref() == Ok("release") {
        manifest.to_string()
    } else {
        manifest.replace("requireAdministrator", "asInvoker")
    };
    let windows = tauri_build::WindowsAttributes::new().app_manifest(manifest);
    let attrs = tauri_build::Attributes::new()
        .windows_attributes(windows)
        .app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "site_login",
            "site_logout",
            "site_session",
            "site_get",
            "site_post",
    "site_put",
    "site_patch",
    "site_delete",
            "site_set_game_mode",
            "room_watch",
            "room_unwatch",
            "room_send",
            "shot_state",
            "shot_settings_get",
            "shot_settings_set",
            "shot_capture_set",
            "app_usage",
            "paths_get",
            "paths_set",
            "paths_detect",
            "paths_pick",
            "paths_open",
            "logs_list",
            "logs_read",
            "miaomiao_get",
            "miaomiao_save",
            "miaomiao_restore_delays",
            "overlay_get",
            "overlay_save",
            "overlay_toggle",
            "overlay_reset",
            "overlay_note_map",
            "overlay_set_guard",
            "overlay_set_hotkey_live",
            "overlay_return_focus",
            "raid_status",
            "log_state",
        ]),
    );
    if let Err(error) = tauri_build::try_build(attrs) {
        println!("{error:#}");
        std::process::exit(1);
    }
}

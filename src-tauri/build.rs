fn main() {
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app.manifest.xml"));
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
            "site_delete",
            "site_set_game_mode",
            "room_watch",
            "room_unwatch",
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

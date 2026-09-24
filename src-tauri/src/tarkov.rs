use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::config::{self, AppConfig};
use crate::AppState;

struct DirWatcher {
    _watcher: RecommendedWatcher,
}

pub struct TarkovWatch {
    screenshots: Mutex<Option<DirWatcher>>,
    logs: Mutex<Option<DirWatcher>>,
}

impl Default for TarkovWatch {
    fn default() -> Self {
        Self {
            screenshots: Mutex::new(None),
            logs: Mutex::new(None),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryOut {
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRead {
    pub text: String,
    pub last_modified: u64,
    pub size: u64,
}

fn kind_dir<'a>(cfg: &'a AppConfig, kind: &str) -> Result<Option<&'a str>, String> {
    match kind {
        "screenshots" => Ok(cfg.screenshots_dir.as_deref()),
        "logs" => Ok(cfg.logs_dir.as_deref()),
        _ => Err("未知目录类型".into()),
    }
}

fn require_root(cfg: &AppConfig, kind: &str) -> Result<PathBuf, String> {
    let path = kind_dir(cfg, kind)?.ok_or("还没有绑定目录")?;
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err("绑定的目录不存在".into());
    }
    root.canonicalize().map_err(|err| err.to_string())
}

fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.replace('\\', "/");
    if relative.split('/').any(|part| part == "..") {
        return Err("路径不能跳出绑定目录".into());
    }
    let relative = relative.trim_matches('/');
    let joined = if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    if joined.exists() {
        let full = joined.canonicalize().map_err(|err| err.to_string())?;
        if !full.starts_with(root) {
            return Err("路径不能跳出绑定目录".into());
        }
        return Ok(full);
    }
    if let Some(parent) = joined.parent() {
        if parent.exists() {
            let parent = parent.canonicalize().map_err(|err| err.to_string())?;
            if !parent.starts_with(root) {
                return Err("路径不能跳出绑定目录".into());
            }
        }
    }
    Ok(joined)
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified().ok().and_then(|time| {
        time.duration_since(UNIX_EPOCH)
            .ok()
            .map(|dur| dur.as_millis() as u64)
    })
}

fn publish(app: &AppHandle, kind: &str, path: Option<&str>) {
    let Some(site) = app.get_webview("site") else {
        return;
    };
    let kind_js = serde_json::to_string(kind).unwrap_or_else(|_| "\"\"".into());
    let path_js = serde_json::to_string(&path).unwrap_or_else(|_| "null".into());
    let _ = site.eval(format!("window.__zhangeSetDir?.({kind_js}, {path_js})"));
}

fn watch_slot<'a>(watch: &'a TarkovWatch, kind: &str) -> Result<&'a Mutex<Option<DirWatcher>>, String> {
    match kind {
        "screenshots" => Ok(&watch.screenshots),
        "logs" => Ok(&watch.logs),
        _ => Err("未知目录类型".into()),
    }
}

pub fn arm_watch(app: &AppHandle, kind: &str, root: &Path) -> Result<(), String> {
    let handle = app.clone();
    let label = kind.to_string();
    let mut last = SystemTime::now();
    let mut watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        let Ok(event) = result else {
            return;
        };
        if !matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        ) {
            return;
        }
        if last.elapsed().unwrap_or_default().as_millis() < 300 {
            return;
        }
        last = SystemTime::now();
        let _ = handle.emit_to(EventTarget::webview("site"), "tarkov-changed", &label);
    })
    .map_err(|err| err.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|err| err.to_string())?;
    let watch = app.state::<TarkovWatch>();
    *watch_slot(&watch, kind)?.lock().expect("watch lock") = Some(DirWatcher { _watcher: watcher });
    Ok(())
}

pub fn arm_saved(app: &AppHandle, cfg: &AppConfig) {
    if let Some(path) = cfg.screenshots_dir.as_deref() {
        let _ = arm_watch(app, "screenshots", Path::new(path));
    }
    if let Some(path) = cfg.logs_dir.as_deref() {
        let _ = arm_watch(app, "logs", Path::new(path));
    }
}

fn cfg_from(app: &AppHandle) -> AppConfig {
    app.try_state::<AppState>()
        .map(|state| state.config.lock().expect("config lock").clone())
        .unwrap_or_else(|| config::load(app))
}

fn update_cfg(app: &AppHandle, mutate: impl FnOnce(&mut AppConfig)) -> Result<AppConfig, String> {
    let state = app.state::<AppState>();
    let mut cfg = state.config.lock().expect("config lock");
    mutate(&mut cfg);
    config::save(app, &cfg)?;
    Ok(cfg.clone())
}

#[tauri::command]
pub fn tarkov_list(
    app: AppHandle,
    kind: String,
    relative_dir: Option<String>,
) -> Result<Vec<DirEntryOut>, String> {
    let cfg = cfg_from(&app);
    let root = require_root(&cfg, &kind)?;
    let dir = resolve(&root, relative_dir.as_deref().unwrap_or(""))?;
    let mut rows = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|item| item.is_dir()).unwrap_or(false);
        rows.push(DirEntryOut {
            kind: if is_dir { "directory" } else { "file" }.into(),
            name,
            last_modified: meta.as_ref().and_then(modified_ms),
            size: meta
                .as_ref()
                .filter(|item| item.is_file())
                .map(|item| item.len()),
        });
    }
    rows.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(rows)
}

#[tauri::command]
pub fn tarkov_read_text(
    app: AppHandle,
    kind: String,
    relative_path: String,
) -> Result<TextRead, String> {
    let cfg = cfg_from(&app);
    let root = require_root(&cfg, &kind)?;
    let path = resolve(&root, &relative_path)?;
    let meta = fs::metadata(&path).map_err(|err| err.to_string())?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("日志文件太大".into());
    }
    let bytes = fs::read(&path).map_err(|err| err.to_string())?;
    Ok(TextRead {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        last_modified: modified_ms(&meta).unwrap_or(0),
        size: meta.len(),
    })
}

#[tauri::command]
pub fn tarkov_read_bytes(
    app: AppHandle,
    kind: String,
    relative_path: String,
) -> Result<String, String> {
    let cfg = cfg_from(&app);
    let root = require_root(&cfg, &kind)?;
    let path = resolve(&root, &relative_path)?;
    let meta = fs::metadata(&path).map_err(|err| err.to_string())?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err("截图文件太大".into());
    }
    let bytes = fs::read(&path).map_err(|err| err.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn tarkov_remove(
    app: AppHandle,
    kind: String,
    relative_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let cfg = cfg_from(&app);
    let root = require_root(&cfg, &kind)?;
    let mut removed = Vec::new();
    for relative in relative_paths {
        let path = resolve(&root, &relative)?;
        if path.is_file() && fs::remove_file(&path).is_ok() {
            removed.push(relative.replace('\\', "/"));
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn tarkov_rebind(app: AppHandle, kind: String) -> Result<String, String> {
    if kind != "screenshots" && kind != "logs" {
        return Err("未知目录类型".into());
    }
    let picked = app
        .dialog()
        .file()
        .set_title(if kind == "screenshots" {
            "选择逃离塔科夫截图目录"
        } else {
            "选择逃离塔科夫日志目录"
        })
        .blocking_pick_folder();
    let Some(file) = picked else {
        return Err("已取消选择".into());
    };
    let path = file.into_path().map_err(|err| err.to_string())?;
    let text = path.to_string_lossy().to_string();
    update_cfg(&app, |cfg| {
        if kind == "screenshots" {
            cfg.screenshots_dir = Some(text.clone());
        } else {
            cfg.logs_dir = Some(text.clone());
        }
    })?;
    let _ = arm_watch(&app, &kind, &path);
    publish(&app, &kind, Some(&text));
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_parent_segments() {
        let root = std::env::temp_dir().join("zhange-app-path-test");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let err = resolve(&root, "../secret").unwrap_err();
        assert!(err.contains("跳出"));
        let _ = fs::remove_dir_all(&root);
    }
}

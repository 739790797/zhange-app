use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

const GAME_EXE: &str = "EscapeFromTarkov.exe";
const GAME_BE_EXE: &str = "EscapeFromTarkov_BE.exe";

static HOST: Mutex<Option<System>> = Mutex::new(None);
static LAST_SAMPLE: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsage {
    pub memory_mb: f64,
    pub total_gb: f64,
    pub cpu_percent: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundPaths {
    pub screenshot_dir: String,
    pub log_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub screenshot_dir: String,
    pub log_dir: String,
    pub message: String,
}

pub fn usage() -> AppUsage {
    let mut host = HOST.lock().expect("usage");
    let system = host.get_or_insert_with(System::new);
    system.refresh_memory();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let pid = Pid::from_u32(std::process::id());
    let process = system.process(pid);
    let memory_mb = process.map(|item| item.memory() as f64 / 1024.0 / 1024.0).unwrap_or(0.0);
    let cpu_percent = process.map(|item| item.cpu_usage()).unwrap_or(0.0);
    let _ = LAST_SAMPLE.lock().map(|mut slot| *slot = Some(Instant::now()));
    AppUsage {
        memory_mb,
        total_gb: system.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0,
        cpu_percent,
    }
}

fn paths_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("paths.json"))
}

pub fn get_paths(app: &AppHandle) -> BoundPaths {
    let Ok(path) = paths_file(app) else {
        return BoundPaths { screenshot_dir: String::new(), log_dir: String::new() };
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(BoundPaths { screenshot_dir: String::new(), log_dir: String::new() })
}

pub fn set_paths(app: &AppHandle, screenshot_dir: String, log_dir: String) -> Result<BoundPaths, String> {
    let paths = BoundPaths {
        screenshot_dir: screenshot_dir.trim().to_string(),
        log_dir: log_dir.trim().to_string(),
    };
    let text = serde_json::to_string_pretty(&paths).map_err(|err| err.to_string())?;
    fs::write(paths_file(app)?, text).map_err(|err| err.to_string())?;
    Ok(paths)
}

pub fn detect_and_save(app: &AppHandle) -> Result<DetectResult, String> {
    let found = detect_paths();
    let mut current = get_paths(app);
    if !found.screenshot_dir.is_empty() {
        current.screenshot_dir = found.screenshot_dir;
    }
    if !found.log_dir.is_empty() {
        current.log_dir = found.log_dir;
    }
    let saved = set_paths(app, current.screenshot_dir, current.log_dir)?;
    Ok(DetectResult {
        screenshot_dir: saved.screenshot_dir,
        log_dir: saved.log_dir,
        message: found.message,
    })
}

pub fn pick_dir(title: &str) -> Option<String> {
    rfd::FileDialog::new()
        .set_title(title)
        .pick_folder()
        .map(|path| path.display().to_string())
}

pub fn open_dir(path: &str) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() || !Path::new(path).is_dir() {
        return Err("目录不存在".into());
    }
    Command::new("explorer").arg(path).spawn().map_err(|err| err.to_string())?;
    Ok(())
}

struct Found {
    screenshot_dir: String,
    log_dir: String,
    message: String,
}

fn detect_paths() -> Found {
    let screenshot = find_screenshot_dir();
    let game = find_game_root();
    let logs = game.as_ref().and_then(|root| find_logs_dir(root));
    let mut notes = Vec::new();
    match &screenshot {
        Some(path) => notes.push(format!("截图目录: {}", path.display())),
        None => notes.push("未找到截图目录，请先在游戏内截过一次图。".into()),
    }
    match (&game, &logs) {
        (_, Some(path)) => notes.push(format!("日志目录: {}", path.display())),
        (Some(_), None) => notes.push("已找到安装目录，但没有找到 Logs 目录。".into()),
        (None, None) => notes.push("未能自动定位游戏安装目录。".into()),
    }
    Found {
        screenshot_dir: screenshot.map(|path| path.display().to_string()).unwrap_or_default(),
        log_dir: logs.map(|path| path.display().to_string()).unwrap_or_default(),
        message: notes.join("\n"),
    }
}

fn find_screenshot_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(docs) = dirs::document_dir() {
        candidates.push(docs.join("Escape from Tarkov").join("Screenshots"));
    }
    candidates.into_iter().find(|path| path.is_dir())
}

fn find_game_root() -> Option<PathBuf> {
    find_game_from_process()
        .or_else(find_game_from_launcher)
        .or_else(find_game_from_registry)
        .or_else(find_game_from_common_locations)
}

fn validate_game_path(path: &Path) -> bool {
    path.is_dir()
        && (path.join(GAME_EXE).is_file()
            || path.join(GAME_BE_EXE).is_file()
            || path.join("build").join(GAME_EXE).is_file())
}

fn find_game_from_process() -> Option<PathBuf> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    for process in system.processes().values() {
        let name = process.name();
        if !name.eq_ignore_ascii_case(GAME_EXE) && !name.eq_ignore_ascii_case(GAME_BE_EXE) {
            continue;
        }
        let exe = process.exe()?;
        let mut cursor = exe.parent()?.to_path_buf();
        for _ in 0..4 {
            if validate_game_path(&cursor) {
                return Some(cursor);
            }
            cursor = cursor.parent()?.to_path_buf();
        }
    }
    None
}

fn find_game_from_launcher() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let path = PathBuf::from(appdata).join("Battlestate Games").join("BsgLauncher").join("settings");
    let text = fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let mut candidates = Vec::new();
    if let Some(dir) = json.get("gameRootDir").and_then(|value| value.as_str()) {
        candidates.push(PathBuf::from(dir));
    }
    if let Some(dir) = json.get("gamesRootDir").and_then(|value| value.as_str()) {
        candidates.push(PathBuf::from(dir).join("Escape from Tarkov"));
    }
    if let Some(temp) = json.get("tempFolder").and_then(|value| value.as_str()) {
        let mut cursor = PathBuf::from(temp);
        for _ in 0..6 {
            if validate_game_path(&cursor) {
                candidates.push(cursor.clone());
                break;
            }
            let Some(parent) = cursor.parent() else { break };
            cursor = parent.to_path_buf();
        }
    }
    candidates.into_iter().find(|path| validate_game_path(path))
}

fn find_game_from_registry() -> Option<PathBuf> {
    let keys = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov",
        r"Software\Battlestate Games\EscapeFromTarkov",
    ];
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let hive = RegKey::predef(root);
        for sub in keys {
            let Ok(key) = hive.open_subkey(sub) else { continue };
            for name in ["InstallLocation", "InstallPath", "Path"] {
                let Ok(value) = key.get_value::<String, _>(name) else { continue };
                let path = PathBuf::from(value.trim());
                if validate_game_path(&path) {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn find_game_from_common_locations() -> Option<PathBuf> {
    let tails = [
        r"SteamLibrary\steamapps\common\Escape from Tarkov",
        r"Program Files (x86)\Steam\steamapps\common\Escape from Tarkov",
        r"Program Files\Steam\steamapps\common\Escape from Tarkov",
        r"Games\steam\steamapps\common\Escape from Tarkov",
        r"Steam\steamapps\common\Escape from Tarkov",
        r"Games\Escape from Tarkov",
        r"Battlestate Games\Escape from Tarkov",
        "EFT",
    ];
    for letter in b'A'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if !Path::new(&drive).exists() {
            continue;
        }
        for tail in tails {
            let path = PathBuf::from(&drive).join(tail);
            if validate_game_path(&path) {
                return Some(path);
            }
        }
    }
    None
}

fn find_logs_dir(game_root: &Path) -> Option<PathBuf> {
    for path in [game_root.join("Logs"), game_root.join("build").join("Logs")] {
        if looks_like_logs(&path) {
            return Some(path);
        }
    }
    fn walk(dir: &Path, depth: usize) -> Option<PathBuf> {
        if depth > 4 {
            return None;
        }
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case("logs") && looks_like_logs(&path) {
                return Some(path);
            }
            if let Some(found) = walk(&path, depth + 1) {
                return Some(found);
            }
        }
        None
    }
    walk(game_root, 0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSession {
    pub folder: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogBundle {
    pub folder: String,
    pub files: Vec<LogFile>,
}

pub fn list_log_sessions(app: &AppHandle) -> Result<Vec<LogSession>, String> {
    let root = log_root(app)?;
    let mut sessions = Vec::new();
    for entry in fs::read_dir(&root).map_err(|err| err.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(started) = session_started(&name) else { continue };
        sessions.push(LogSession { folder: name, started_at: started });
    }
    if sessions.is_empty() && dir_has_quest_logs(&root) {
        sessions.push(LogSession {
            folder: String::new(),
            started_at: String::new(),
        });
    }
    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(sessions)
}

pub fn read_log_sessions(app: &AppHandle, folders: Vec<String>) -> Result<Vec<LogBundle>, String> {
    let root = log_root(app)?.canonicalize().map_err(|err| err.to_string())?;
    let mut bundles = Vec::new();
    for folder in folders {
        let Some(dir) = session_dir(&root, &folder) else { continue };
        let mut files = Vec::new();
        let entries = fs::read_dir(&dir).map_err(|err| err.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_quest_log(&name) {
                continue;
            }
            let text = read_log_text(&path);
            files.push(LogFile { name, text });
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        bundles.push(LogBundle { folder, files });
    }
    Ok(bundles)
}

fn session_dir(root: &Path, folder: &str) -> Option<PathBuf> {
    if folder.is_empty() {
        return Some(root.to_path_buf());
    }
    if folder == "." || folder == ".." || folder.contains(['/', '\\', ':']) {
        return None;
    }
    let dir = root.join(folder).canonicalize().ok()?;
    if dir.starts_with(root) { Some(dir) } else { None }
}

fn log_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_paths(app).log_dir.trim().to_string();
    if dir.is_empty() {
        return Err("请先绑定日志目录".into());
    }
    let path = PathBuf::from(dir);
    if !path.is_dir() {
        return Err("日志目录不存在".into());
    }
    Ok(path)
}

fn session_started(name: &str) -> Option<String> {
    let source = name.rsplit("log_").next().unwrap_or(name);
    let mut parts = source.split(['.', '_', '-']);
    let year = parts.next()?;
    let month = parts.next()?;
    let day = parts.next()?;
    let hour = parts.next()?;
    let minute = parts.next()?;
    let second = parts.next()?;
    let digits = [year, month, day, hour, minute, second];
    if year.len() != 4 || month.len() != 2 || day.len() != 2 || minute.len() != 2 || second.len() != 2 || !(1..=2).contains(&hour.len()) {
        return None;
    }
    if digits.iter().any(|part| part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit())) {
        return None;
    }
    Some(format!("{year}-{month}-{day} {:0>2}:{minute}:{second}", hour))
}

fn is_quest_log(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem = lower.trim_end_matches(".log");
    stem == "application"
        || stem.starts_with("application_")
        || stem == "notifications"
        || stem.starts_with("notifications_")
        || stem == "push-notifications"
        || stem.starts_with("push-notifications_")
}

fn dir_has_quest_logs(path: &Path) -> bool {
    fs::read_dir(path).ok().is_some_and(|read| {
        read.flatten().any(|entry| is_quest_log(&entry.file_name().to_string_lossy()))
    })
}

fn read_log_text(path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    const CAP: u64 = 24 * 1024 * 1024;
    let Ok(meta) = fs::metadata(path) else { return String::new() };
    let Ok(mut file) = fs::File::open(path) else { return String::new() };
    let start = meta.len().saturating_sub(CAP);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.take(CAP).read_to_end(&mut buf).is_err() {
        return String::new();
    }
    if start > 0 {
        if let Some(index) = buf.iter().position(|byte| *byte == b'\n') {
            buf.drain(..=index);
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn looks_like_logs(path: &Path) -> bool {
    path.is_dir()
        && fs::read_dir(path).ok().is_some_and(|read| {
            read.flatten().any(|entry| entry.path().is_dir() || entry.file_name().to_string_lossy().to_lowercase().ends_with(".log"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_build_logs() {
        let root = std::env::temp_dir().join(format!("zhange-logs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("build").join("Logs").join("session")).unwrap();
        let found = find_logs_dir(&root).unwrap();
        assert_eq!(found, root.join("build").join("Logs"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_log_folder_escape() {
        let root = std::env::temp_dir().join(format!("zhange-logs-escape-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let canon = root.canonicalize().unwrap();
        assert!(session_dir(&canon, "..").is_none());
        assert!(session_dir(&canon, r"..\..").is_none());
        assert_eq!(session_dir(&canon, "").unwrap(), canon);
        let _ = fs::remove_dir_all(&root);
    }
}

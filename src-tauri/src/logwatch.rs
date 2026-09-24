use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRaid {
    pub in_raid: bool,
    pub elapsed_secs: u64,
    pub server_country: String,
    pub location: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    kind: String,
    slug: String,
    mode: String,
    quest_kind: String,
    task_id: String,
}

struct Snap {
    in_raid: bool,
    started: Option<i64>,
    server: String,
    location: String,
    slug: String,
    mode: String,
}

struct Tail {
    path: PathBuf,
    offset: u64,
    pending: String,
}

static SNAP: Mutex<Snap> = Mutex::new(Snap {
    in_raid: false,
    started: None,
    server: String::new(),
    location: String::new(),
    slug: String::new(),
    mode: String::new(),
});

pub fn spawn(app: AppHandle) {
    thread::spawn(move || watch(app));
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    pub running: bool,
    pub session: String,
    pub application: String,
    pub notices: String,
    pub backend: String,
    pub slug: String,
    pub mode: String,
    pub in_raid: bool,
    pub server: String,
    pub location: String,
}

struct Live {
    running: bool,
    session: String,
    application: String,
    notices: String,
    backend: String,
}

static LIVE: Mutex<Live> = Mutex::new(Live {
    running: false,
    session: String::new(),
    application: String::new(),
    notices: String::new(),
    backend: String::new(),
});

pub fn state() -> WatchState {
    let snap = SNAP.lock().expect("log-watch");
    let live = LIVE.lock().expect("log-watch-live");
    WatchState {
        running: live.running,
        session: live.session.clone(),
        application: live.application.clone(),
        notices: live.notices.clone(),
        backend: live.backend.clone(),
        slug: snap.slug.clone(),
        mode: snap.mode.clone(),
        in_raid: snap.in_raid,
        server: snap.server.clone(),
        location: snap.location.clone(),
    }
}

fn publish(running: bool, session: &str, application: &Path, notices: &Path, backend: &Path) {
    *LIVE.lock().expect("log-watch-live") = Live {
        running,
        session: session.to_string(),
        application: application.display().to_string(),
        notices: notices.display().to_string(),
        backend: backend.display().to_string(),
    };
}

pub fn raid_snapshot() -> WatchRaid {
    let snap = SNAP.lock().expect("log-watch");
    let elapsed = snap
        .started
        .filter(|_| snap.in_raid)
        .map(|started| local_civil_now().saturating_sub(started).max(0) as u64)
        .unwrap_or(0);
    WatchRaid {
        in_raid: snap.in_raid,
        elapsed_secs: elapsed,
        server_country: snap.server.clone(),
        location: snap.location.clone(),
    }
}

fn watch(app: AppHandle) {
    let mut session = String::new();
    let mut application = Tail::new();
    let mut notices = Tail::new();
    let mut backend = Tail::new();
    let mut primed = false;
    loop {
        if game_running() {
            let root = crate::local::get_paths(&app).log_dir;
            if let Some(dir) = newest_session(Path::new(root.trim())) {
                let key = dir.to_string_lossy().to_string();
                if key != session {
                    session = key;
                    primed = false;
                    application = Tail::new();
                    notices = Tail::new();
                    backend = Tail::new();
                }
                if let Some(path) = newest_log(&dir, "application") {
                    if application.path != path {
                        application = Tail::at_end(&path);
                        primed = false;
                    }
                }
                if let Some(path) = newest_log(&dir, "notification") {
                    if notices.path != path {
                        notices = Tail::at_end(&path);
                    }
                }
                if let Some(path) = newest_log(&dir, "backend") {
                    if backend.path != path {
                        backend = Tail::at_end(&path);
                    }
                }
                if !primed {
                    prime(&app, &application.path);
                    primed = true;
                }
                if let Some(text) = application.read_new() {
                    apply_lines(&app, &text, true);
                }
                if let Some(text) = notices.read_new() {
                    apply_lines(&app, &text, true);
                }
                if let Some(text) = backend.read_new() {
                    apply_lines(&app, &text, true);
                }
            }
            publish(true, &session, &application.path, &notices.path, &backend.path);
        } else if !session.is_empty() {
            session.clear();
            primed = false;
            application = Tail::new();
            notices = Tail::new();
            backend = Tail::new();
            end_raid(&app);
            publish(false, "", &application.path, &notices.path, &backend.path);
        } else {
            publish(false, "", &application.path, &notices.path, &backend.path);
        }
        thread::sleep(Duration::from_millis(700));
    }
}

fn prime(app: &AppHandle, path: &Path) {
    if path.as_os_str().is_empty() {
        return;
    }
    let Some(head) = read_slice(path, 0, 128 * 1024) else { return };
    let len = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let tail_from = len.saturating_sub(512 * 1024);
    apply_lines(app, &head, false);
    if tail_from > 128 * 1024 {
        if let Some(tail) = read_slice(path, tail_from, 512 * 1024) {
            apply_lines(app, &tail, false);
        }
    }
    let (slug, mode) = {
        let snap = SNAP.lock().expect("log-watch");
        (snap.slug.clone(), snap.mode.clone())
    };
    if !slug.is_empty() {
        emit(app, "map", &slug, "", "", "");
    }
    if !mode.is_empty() {
        emit(app, "mode", "", &mode, "", "");
    }
}

fn read_slice(path: &Path, offset: u64, max: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; max as usize];
    let read = file.read(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf[..read]).into_owned())
}

fn apply_lines(app: &AppHandle, text: &str, live: bool) {
    let mut snap = SNAP.lock().expect("log-watch");
    for line in text.lines() {
        if let Some(mode) = session_mode(line) {
            if snap.mode != mode {
                snap.mode = mode.clone();
                if live {
                    drop(snap);
                    emit(app, "mode", "", &mode, "", "");
                    snap = SNAP.lock().expect("log-watch");
                }
            }
        }
        if let Some(slug) = scene_slug(line) {
            if snap.slug != slug {
                let was = snap.in_raid;
                if was {
                    snap.in_raid = false;
                    snap.started = None;
                }
                snap.slug = slug.clone();
                if live {
                    drop(snap);
                    if was {
                        emit(app, "raid-end", &slug, "", "", "");
                    }
                    emit(app, "map", &slug, "", "", "");
                    snap = SNAP.lock().expect("log-watch");
                }
            }
        } else if is_hideout(line) && snap.in_raid {
            snap.in_raid = false;
            snap.started = None;
            if live {
                drop(snap);
                emit(app, "raid-end", "", "", "", "");
                snap = SNAP.lock().expect("log-watch");
            }
        }
        if line.contains("GameStarted:") {
            if let Some(stamp) = line_epoch(line) {
                let fresh = !snap.in_raid || snap.started != Some(stamp);
                snap.in_raid = true;
                snap.started = Some(stamp);
                if live && fresh {
                    drop(snap);
                    emit(app, "raid-start", "", "", "", "");
                    snap = SNAP.lock().expect("log-watch");
                }
            }
        }
        if line.contains("TRACE-NetworkGameCreate profileStatus") {
            let ip = field_value(line, "Ip:");
            let location = field_value(line, "Location:");
            let country = sid_country(line);
            snap.server = if country.is_empty() { ip } else { country };
            if !location.is_empty() {
                snap.location = location.clone();
            }
            if snap.slug.is_empty() {
                if let Some(slug) = location_slug(&location) {
                    snap.slug = slug.clone();
                    if live {
                        drop(snap);
                        emit(app, "map", &slug, "", "", "");
                        snap = SNAP.lock().expect("log-watch");
                    }
                }
            }
        }
    }
    drop(snap);
    if live {
        for (kind, id) in quest_events(text) {
            emit(app, "quest", "", "", &kind, &id);
        }
    }
}

fn end_raid(app: &AppHandle) {
    let mut snap = SNAP.lock().expect("log-watch");
    if !snap.in_raid && snap.started.is_none() {
        snap.slug.clear();
        return;
    }
    snap.in_raid = false;
    snap.started = None;
    snap.slug.clear();
    drop(snap);
    emit(app, "raid-end", "", "", "", "");
}

fn emit(app: &AppHandle, kind: &str, slug: &str, mode: &str, quest_kind: &str, task_id: &str) {
    let _ = app.emit(
        "log-watch",
        LogEvent {
            kind: kind.into(),
            slug: slug.into(),
            mode: mode.into(),
            quest_kind: quest_kind.into(),
            task_id: task_id.into(),
        },
    );
}

impl Tail {
    fn new() -> Self {
        Self { path: PathBuf::new(), offset: 0, pending: String::new() }
    }

    fn at_end(path: &Path) -> Self {
        let offset = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        Self { path: path.to_path_buf(), offset, pending: String::new() }
    }

    fn read_new(&mut self) -> Option<String> {
        if self.path.as_os_str().is_empty() {
            return None;
        }
        let len = fs::metadata(&self.path).ok()?.len();
        if len < self.offset {
            self.offset = 0;
            self.pending.clear();
        }
        if len == self.offset {
            return None;
        }
        let mut file = File::open(&self.path).ok()?;
        file.seek(SeekFrom::Start(self.offset)).ok()?;
        let mut buf = vec![0u8; (len - self.offset).min(1024 * 1024) as usize];
        let read = file.read(&mut buf).ok()?;
        if read == 0 {
            return None;
        }
        self.offset += read as u64;
        let chunk = String::from_utf8_lossy(&buf[..read]);
        self.pending.push_str(&chunk);
        let split = self.pending.rfind('\n')?;
        let done = self.pending[..=split].to_string();
        self.pending = self.pending[split + 1..].to_string();
        if let Some(open) = unclosed_quest(&done) {
            self.pending.insert_str(0, &done[open..]);
            let ready = done[..open].to_string();
            if ready.trim().is_empty() {
                return None;
            }
            return Some(ready);
        }
        Some(done)
    }
}

fn newest_session(root: &Path) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let mut consider = |dir: PathBuf| {
        let stamp = dir_stamp(&dir);
        if best.as_ref().is_none_or(|(time, _)| stamp > *time) {
            best = Some((stamp, dir));
        }
    };
    if newest_log(root, "application").is_some() {
        consider(root.to_path_buf());
    }
    let read = fs::read_dir(root).ok()?;
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() && newest_log(&path, "application").is_some() {
            consider(path);
        }
    }
    best.map(|item| item.1)
}

fn dir_stamp(dir: &Path) -> SystemTime {
    newest_log(dir, "application")
        .and_then(|path| fs::metadata(path).ok())
        .and_then(|meta| meta.modified().ok())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn newest_log(dir: &Path, kind: &str) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let mut consider = |path: PathBuf| {
        if !is_kind(&path, kind) {
            return;
        }
        let Ok(meta) = fs::metadata(&path) else { return };
        let Ok(modified) = meta.modified() else { return };
        if best.as_ref().is_none_or(|(time, _)| modified > *time) {
            best = Some((modified, path));
        }
    };
    let read = fs::read_dir(dir).ok()?;
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_file() {
            consider(path);
        } else if path.is_dir() {
            if let Ok(inner) = fs::read_dir(&path) {
                for file in inner.flatten() {
                    if file.path().is_file() {
                        consider(file.path());
                    }
                }
            }
        }
    }
    best.map(|item| item.1)
}

fn is_kind(path: &Path, kind: &str) -> bool {
    let Some(name) = path.file_name().and_then(|item| item.to_str()) else { return false };
    let lower = name.to_ascii_lowercase();
    if !lower.ends_with(".log") {
        return false;
    }
    match kind {
        "application" => lower.contains("application"),
        "backend" => lower.contains("backend"),
        "notification" => lower.contains("notification"),
        _ => false,
    }
}

fn session_mode(line: &str) -> Option<String> {
    let marker = "Session mode:";
    let index = line.find(marker)?;
    let raw = line[index + marker.len()..].split('|').next().unwrap_or("").trim();
    let key = raw.to_ascii_lowercase();
    if key == "pve" {
        Some("pve".into())
    } else if key == "pvp" || key == "regular" {
        Some("pvp".into())
    } else {
        None
    }
}

fn scene_slug(line: &str) -> Option<String> {
    let marker = "scene preset path:";
    let index = line.find(marker)?;
    let rest = &line[index + marker.len()..];
    let token = rest.split_whitespace().next().unwrap_or("");
    let file = token.rsplit(['/', '\\']).next().unwrap_or(token);
    let stem = file.split("_preset").next().unwrap_or(file).trim_end_matches(".bundle");
    location_slug(stem)
}

fn is_hideout(line: &str) -> bool {
    let marker = "scene preset path:";
    let Some(index) = line.find(marker) else { return false };
    let rest = line[index + marker.len()..].to_ascii_lowercase();
    rest.contains("hideout") || rest.contains("menu") || rest.contains("empty_preset")
}

fn location_slug(raw: &str) -> Option<String> {
    let key = raw.trim().to_ascii_lowercase().replace('-', "_");
    let slug = match key.as_str() {
        "city" | "tarkovstreets" | "streets" | "streets_of_tarkov" => "streets-of-tarkov",
        "rezerv_base" | "rezervbase" | "reserve" => "reserve",
        "shoreline" => "shoreline",
        "woods" | "forest" => "woods",
        "bigmap" | "customs" => "customs",
        "interchange" | "shopping_mall" | "mall" => "interchange",
        "laboratory" | "labs" | "lab" => "the-lab",
        "lighthouse" => "lighthouse",
        "factory" | "factory_day" | "factory4_day" => "factory",
        "factory_night" | "factory4_night" => "night-factory",
        "sandbox" | "sandbox_high" | "ground_zero" | "groundzero" => "ground-zero",
        "labyrinth" | "the_labyrinth" => "the-labyrinth",
        "terminal" => "terminal",
        "icebreaker" | "suburbs" => "icebreaker",
        _ => return None,
    };
    Some(slug.into())
}

fn quest_events(text: &str) -> Vec<(String, String)> {
    let mut events = Vec::new();
    let mut rest = text;
    while let Some(index) = rest.find("ChatMessageReceived") {
        rest = &rest[index + "ChatMessageReceived".len()..];
        let Some(json) = json_object(rest) else { continue };
        if let Some(event) = quest_from_json(json) {
            events.push(event);
        }
    }
    events
}

fn unclosed_quest(text: &str) -> Option<usize> {
    let index = text.rfind("ChatMessageReceived")?;
    if json_object(&text[index..]).is_some() {
        return None;
    }
    if text[index..].contains('{') {
        return Some(index);
    }
    None
}

fn quest_from_json(json: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let message = value.get("message").unwrap_or(&value);
    let type_id = message.get("type").or_else(|| message.get("Type")).and_then(|item| item.as_i64())?;
    let kind = match type_id {
        10 => "started",
        11 => "failed",
        12 => "completed",
        _ => return None,
    };
    let raw = message
        .get("templateId")
        .or_else(|| message.get("TemplateId"))
        .or_else(|| message.get("questId"))
        .and_then(|item| item.as_str())
        .unwrap_or("");
    let id = raw.split_whitespace().next().unwrap_or("").trim().to_ascii_lowercase();
    if id.len() < 20 || !id.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some((kind.into(), id))
}

fn json_object(line: &str) -> Option<&str> {
    let start = line.find('{')?;
    let mut depth = 0;
    let mut in_str = false;
    let mut escape = false;
    for (offset, ch) in line[start..].char_indices() {
        if in_str {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&line[start..start + offset + ch.len_utf8()]);
                }
            }
            _ => {}
        }
    }
    None
}

fn field_value(line: &str, key: &str) -> String {
    let Some(index) = line.find(key) else { return String::new() };
    let rest = line[index + key.len()..].trim();
    rest.split([',', '\'']).next().unwrap_or("").trim().to_string()
}

fn sid_country(line: &str) -> String {
    let Some(index) = line.find("Sid:") else { return String::new() };
    let rest = line[index + 4..].trim();
    let code = rest.split('-').next().unwrap_or("").trim();
    match code {
        "RU" => "俄罗斯".into(),
        "EU" | "DE" | "FI" | "NL" | "FR" | "UK" | "GB" => "欧洲".into(),
        "US" | "NA" => "北美".into(),
        "SA" => "南美".into(),
        "AS" | "HK" | "SG" | "JP" | "KR" | "CN" => "亚洲".into(),
        "OC" | "AU" => "大洋洲".into(),
        "ME" | "TR" => "中东".into(),
        "" => String::new(),
        other => other.to_string(),
    }
}

fn game_running() -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system.processes().values().any(|process| {
        let name = process.name();
        name.eq_ignore_ascii_case("EscapeFromTarkov.exe") || name.eq_ignore_ascii_case("EscapeFromTarkov_BE.exe")
    })
}

fn line_epoch(line: &str) -> Option<i64> {
    let bytes = line.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b' ' {
        return None;
    }
    let year: i32 = line[0..4].parse().ok()?;
    let month: u32 = line[5..7].parse().ok()?;
    let day: u32 = line[8..10].parse().ok()?;
    let hour: u32 = line[11..13].parse().ok()?;
    let minute: u32 = line[14..16].parse().ok()?;
    let second: u32 = line[17..19].parse().ok()?;
    Some(civil_days(year, month, day)? * 86400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64)
}

fn local_civil_now() -> i64 {
    unsafe {
        let mut time = std::mem::zeroed::<LocalTime>();
        GetLocalTime(&mut time);
        civil_days(time.year as i32, time.month as u32, time.day as u32).unwrap_or(0) * 86400
            + time.hour as i64 * 3600
            + time.minute as i64 * 60
            + time.second as i64
    }
}

#[repr(C)]
struct LocalTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

fn civil_days(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || day == 0 || day > 31 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let m = if month <= 2 { month + 9 } else { month - 3 } as i64;
    let d = day as i64;
    Some(365 * y + y / 4 - y / 100 + y / 400 + (m * 153 + 2) / 5 + d - 719469)
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLocalTime(time: *mut LocalTime);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_scene_and_mode() {
        let line = "2026-09-11 23:54:47.158|Info|application|scene preset path:maps/factory_night_preset.bundle rcid:factory_night";
        assert_eq!(scene_slug(line).as_deref(), Some("night-factory"));
        assert_eq!(session_mode("Session mode: Pve").as_deref(), Some("pve"));
        assert_eq!(location_slug("TarkovStreets").as_deref(), Some("streets-of-tarkov"));
    }
}

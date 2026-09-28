use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    phase: String,
    raid_id: String,
}

struct Snap {
    in_raid: bool,
    started: Option<i64>,
    server: String,
    location: String,
    slug: String,
    mode: String,
    phase: String,
    raid_id: String,
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
    phase: String::new(),
    raid_id: String::new(),
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
    pub phase: String,
    pub raid_id: String,
    pub ready: bool,
    pub tail_stamp: String,
}

struct Live {
    running: bool,
    ready: bool,
    session: String,
    application: String,
    notices: String,
    backend: String,
}

static LIVE: Mutex<Live> = Mutex::new(Live {
    running: false,
    ready: false,
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
        phase: snap.phase.clone(),
        raid_id: snap.raid_id.clone(),
        ready: live.ready,
        tail_stamp: tail_stamp(&live),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTails {
    pub application: String,
    pub notices: String,
    pub backend: String,
}

pub fn tails() -> LogTails {
    let (application, notices, backend) = {
        let live = LIVE.lock().expect("log-watch-live");
        (live.application.clone(), live.notices.clone(), live.backend.clone())
    };
    LogTails {
        application: tail_text(Path::new(&application)),
        notices: tail_text(Path::new(&notices)),
        backend: tail_text(Path::new(&backend)),
    }
}

fn tail_text(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        return String::new();
    }
    const CAP: u64 = 128 * 1024;
    let Ok(meta) = fs::metadata(path) else { return String::new() };
    let Ok(mut file) = File::open(path) else { return String::new() };
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

fn file_stamp(path: &str) -> String {
    if path.is_empty() {
        return "0:0".into();
    }
    let Ok(meta) = fs::metadata(path) else { return "0:0".into() };
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis())
        .unwrap_or(0);
    format!("{}:{modified}", meta.len())
}

fn tail_stamp(live: &Live) -> String {
    format!(
        "{}|{}|{}",
        file_stamp(&live.application),
        file_stamp(&live.notices),
        file_stamp(&live.backend)
    )
}

fn publish(running: bool, ready: bool, session: &str, application: &Path, notices: &Path, backend: &Path) {
    *LIVE.lock().expect("log-watch-live") = Live {
        running,
        ready,
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
    let mut was_running = false;
    loop {
        let running = game_running();
        let root = crate::local::get_paths(&app).log_dir;
        if let Some(dir) = newest_session(Path::new(root.trim())) {
            let key = dir.to_string_lossy().to_string();
            if key != session {
                if !session.is_empty() && was_running {
                    end_raid(&app);
                }
                session = key;
                primed = false;
                reset_snap();
                application = Tail::new();
                notices = Tail::new();
                backend = Tail::new();
            }
            if !primed {
                let apps = ordered_logs(&dir, "application");
                let notes = ordered_logs(&dir, "notification");
                let backs = ordered_logs(&dir, "backend");
                publish(
                    running,
                    false,
                    &session,
                    apps.last().map(PathBuf::as_path).unwrap_or(Path::new("")),
                    notes.last().map(PathBuf::as_path).unwrap_or(Path::new("")),
                    backs.last().map(PathBuf::as_path).unwrap_or(Path::new("")),
                );
                replay_mode(&app, &apps);
                application = replay_into(&app, &apps);
                notices = replay_into(&app, &notes);
                backend = replay_into(&app, &backs);
                primed = true;
                if running {
                    catch_up(&app);
                } else {
                    park_offline();
                }
            } else {
                let app_path = newest_log(&dir, "application").unwrap_or_default();
                let note_path = newest_log(&dir, "notification").unwrap_or_default();
                let back_path = newest_log(&dir, "backend").unwrap_or_default();
                follow_file(&mut application, &app_path, &app, running);
                follow_file(&mut notices, &note_path, &app, running);
                follow_file(&mut backend, &back_path, &app, running);
            }
            if was_running && !running {
                end_raid(&app);
            }
            publish(running, true, &session, &application.path, &notices.path, &backend.path);
        } else {
            if was_running {
                end_raid(&app);
            }
            publish(false, true, "", Path::new(""), Path::new(""), Path::new(""));
        }
        was_running = running;
        thread::sleep(Duration::from_millis(700));
    }
}

fn reset_snap() {
    *SNAP.lock().expect("log-watch") = Snap {
        in_raid: false,
        started: None,
        server: String::new(),
        location: String::new(),
        slug: String::new(),
        mode: String::new(),
        phase: String::new(),
        raid_id: String::new(),
    };
}

fn phase_open(phase: &str) -> bool {
    matches!(phase, "map_loading" | "matching" | "match_found" | "raid_starting" | "raid_started")
}

fn clear_place(snap: &mut Snap) {
    snap.slug.clear();
    snap.location.clear();
    snap.server.clear();
    snap.raid_id.clear();
}

fn park_offline() {
    let mut snap = SNAP.lock().expect("log-watch");
    let active = snap.in_raid || snap.started.is_some() || phase_open(&snap.phase);
    snap.in_raid = false;
    snap.started = None;
    clear_place(&mut snap);
    if active {
        snap.phase = "raid_exited".into();
    } else if snap.phase != "raid_exited" && snap.phase != "matching_aborted" {
        snap.phase.clear();
    }
}

fn catch_up(app: &AppHandle) {
    let (slug, mode, phase, raid_id) = {
        let snap = SNAP.lock().expect("log-watch");
        (snap.slug.clone(), snap.mode.clone(), snap.phase.clone(), snap.raid_id.clone())
    };
    if !slug.is_empty() {
        emit(app, "map", &slug, "", "", "");
    }
    if !mode.is_empty() {
        emit(app, "mode", "", &mode, "", "");
    }
    if !phase.is_empty() {
        emit_phase(app, &phase, &slug, &raid_id);
    }
}

fn replay_into(app: &AppHandle, paths: &[PathBuf]) -> Tail {
    let Some(last) = paths.last() else { return Tail::new() };
    let start = paths.len().saturating_sub(2);
    for path in &paths[start..paths.len() - 1] {
        replay_file(app, path);
    }
    let offset = replay_file(app, last);
    Tail { path: last.clone(), offset, pending: String::new() }
}

fn replay_mode(app: &AppHandle, paths: &[PathBuf]) {
    for path in paths.iter().rev() {
        let Ok(len) = fs::metadata(path).map(|meta| meta.len()) else { continue };
        let Some(at) = rfind(path, len, b"Session mode:") else { continue };
        let Some(line) = read_line_at(path, at) else { continue };
        apply_lines(app, &line, false);
        return;
    }
}

fn replay_file(app: &AppHandle, path: &Path) -> u64 {
    let Ok(len) = fs::metadata(path).map(|meta| meta.len()) else { return 0 };
    if len == 0 {
        return 0;
    }
    let start = decisive_start(path, len);
    apply_range(app, path, start, len);
    len
}

fn decisive_start(path: &Path, len: u64) -> u64 {
    const FLOOR: u64 = 512 * 1024;
    if len <= FLOOR {
        return 0;
    }
    let Some((at, open)) = latest_decisive(path, len) else {
        return len.saturating_sub(FLOOR);
    };
    if !open {
        return at.saturating_sub(64 * 1024);
    }
    let region = at.saturating_sub(4 * 1024 * 1024);
    let scene = rfind_in(path, region, at, b"scene preset path:");
    scene.unwrap_or(at).saturating_sub(2048)
}

fn latest_decisive(path: &Path, len: u64) -> Option<(u64, bool)> {
    const CHUNK: u64 = 1024 * 1024;
    const OVERLAP: u64 = 48;
    let exits: [&[u8]; 7] = [
        b"UserMatchOver",
        b"Network game matching aborted",
        b"Network game matching cancelled",
        b"empty_preset",
        b"hideout_preset",
        b"/hideout",
        b"\\hideout",
    ];
    let mut end = len;
    while end > 0 {
        let start = end.saturating_sub(CHUNK);
        let Some(buf) = read_range(path, start, end - start) else { break };
        let mut found: Option<(usize, bool)> = None;
        if let Some(pos) = buf.windows(b"GameStarted:".len()).rposition(|window| window == b"GameStarted:") {
            found = Some((pos, true));
        }
        for needle in exits {
            if let Some(pos) = buf.windows(needle.len()).rposition(|window| window == needle) {
                if found.is_none_or(|(at, _)| pos > at) {
                    found = Some((pos, false));
                }
            }
        }
        if let Some((pos, open)) = found {
            return Some((start + pos as u64, open));
        }
        if start == 0 {
            break;
        }
        end = start + OVERLAP;
    }
    None
}

fn rfind(path: &Path, len: u64, needle: &[u8]) -> Option<u64> {
    const CHUNK: u64 = 1024 * 1024;
    if needle.is_empty() || len == 0 {
        return None;
    }
    let overlap = (needle.len() as u64).saturating_sub(1);
    let mut end = len;
    while end > 0 {
        let start = end.saturating_sub(CHUNK);
        let buf = read_range(path, start, end - start)?;
        if let Some(pos) = buf.windows(needle.len()).rposition(|window| window == needle) {
            return Some(start + pos as u64);
        }
        if start == 0 {
            break;
        }
        end = start + overlap.max(1);
    }
    None
}

fn rfind_in(path: &Path, from: u64, to: u64, needle: &[u8]) -> Option<u64> {
    if needle.is_empty() || to <= from {
        return None;
    }
    let buf = read_range(path, from, to - from)?;
    buf.windows(needle.len())
        .rposition(|window| window == needle)
        .map(|pos| from + pos as u64)
}

fn read_line_at(path: &Path, at: u64) -> Option<String> {
    let start = at.saturating_sub(240);
    let buf = read_range(path, start, 640)?;
    let text = String::from_utf8_lossy(&buf);
    let rel = (at - start) as usize;
    if rel > text.len() {
        return None;
    }
    let before = text[..rel].rfind('\n').map(|index| index + 1).unwrap_or(0);
    let after = text[rel..].find('\n').map(|index| rel + index).unwrap_or(text.len());
    let line = text[before..after].trim();
    if line.is_empty() { None } else { Some(line.to_string()) }
}

fn read_range(path: &Path, start: u64, max: u64) -> Option<Vec<u8>> {
    if max == 0 {
        return Some(Vec::new());
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0u8; max.min(8 * 1024 * 1024) as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    Some(buf)
}

fn apply_range(app: &AppHandle, path: &Path, start: u64, end: u64) {
    if end <= start {
        return;
    }
    let Ok(mut file) = File::open(path) else { return };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut pending = String::new();
    let mut left = end - start;
    let mut buf = vec![0u8; 256 * 1024];
    let mut skipping = start > 0;
    while left > 0 {
        let want = ((left as usize).min(buf.len())).max(1);
        let Ok(read) = file.read(&mut buf[..want]) else { break };
        if read == 0 {
            break;
        }
        left = left.saturating_sub(read as u64);
        pending.push_str(&String::from_utf8_lossy(&buf[..read]));
        if skipping {
            if let Some(index) = pending.find('\n') {
                pending.drain(..=index);
                skipping = false;
            } else {
                pending.clear();
                continue;
            }
        }
        if let Some(split) = pending.rfind('\n') {
            let done = pending[..=split].to_string();
            pending = pending[split + 1..].to_string();
            if !done.is_empty() {
                apply_lines(app, &done, false);
            }
        }
    }
    if !skipping && !pending.is_empty() {
        apply_lines(app, &pending, false);
    }
}

fn follow_file(tail: &mut Tail, path: &Path, app: &AppHandle, live: bool) {
    if path.as_os_str().is_empty() {
        return;
    }
    if tail.path != path {
        if live {
            if let Some(text) = tail.read_new() {
                apply_lines(app, &text, true);
            }
        }
        let offset = replay_file(app, path);
        *tail = Tail { path: path.to_path_buf(), offset, pending: String::new() };
        if live {
            if let Some(text) = tail.read_new() {
                apply_lines(app, &text, true);
            }
        }
        return;
    }
    if !live {
        return;
    }
    let shrunk = fs::metadata(path).map(|meta| meta.len() < tail.offset).unwrap_or(false);
    if shrunk {
        let offset = replay_file(app, path);
        *tail = Tail { path: path.to_path_buf(), offset, pending: String::new() };
        return;
    }
    if let Some(text) = tail.read_new() {
        apply_lines(app, &text, true);
    }
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
                snap.phase = "map_loading".into();
                if live {
                    drop(snap);
                    if was {
                        emit(app, "raid-end", &slug, "", "", "");
                    }
                    emit(app, "map", &slug, "", "", "");
                    emit_phase(app, "map_loading", &slug, "");
                    snap = SNAP.lock().expect("log-watch");
                }
            }
        } else if line.contains("LocationLoaded") && !line.contains("LocationLoadedTime") {
            snap.phase = "matching".into();
            if live {
                drop(snap);
                emit_phase(app, "matching", "", "");
                snap = SNAP.lock().expect("log-watch");
            }
        } else if is_hideout(line) {
            let ended = snap.in_raid;
            let changed = ended || !snap.slug.is_empty() || snap.phase != "raid_exited";
            if changed {
                snap.in_raid = false;
                snap.started = None;
                snap.slug.clear();
                snap.phase = "raid_exited".into();
                if live {
                    drop(snap);
                    if ended {
                        emit(app, "raid-end", "", "", "", "");
                    }
                    emit_phase(app, "raid_exited", "", "");
                    snap = SNAP.lock().expect("log-watch");
                }
            }
        }
        if line.contains("GameStarting") && !line.contains("GameStarted") {
            snap.phase = "raid_starting".into();
            if live {
                let slug = snap.slug.clone();
                drop(snap);
                emit_phase(app, "raid_starting", &slug, "");
                snap = SNAP.lock().expect("log-watch");
            }
        }
        if line.contains("GameStarted:") {
            if let Some(stamp) = line_epoch(line) {
                let fresh = !snap.in_raid || snap.started != Some(stamp);
                snap.in_raid = true;
                snap.started = Some(stamp);
                snap.phase = "raid_started".into();
                if live && fresh {
                    drop(snap);
                    emit(app, "raid-start", "", "", "", "");
                    emit_phase(app, "raid_started", "", "");
                    snap = SNAP.lock().expect("log-watch");
                }
            }
        }
        if line.contains("Network game matching aborted") || line.contains("Network game matching cancelled") {
            snap.phase = "matching_aborted".into();
            if live {
                drop(snap);
                emit_phase(app, "matching_aborted", "", "");
                snap = SNAP.lock().expect("log-watch");
            }
        }
        if line.contains("Got notification | UserMatchOver") || is_local_match_end(line) {
            let ended = snap.in_raid;
            let changed = ended || !snap.slug.is_empty() || snap.phase != "raid_exited";
            if changed {
                snap.in_raid = false;
                snap.started = None;
                snap.slug.clear();
                snap.phase = "raid_exited".into();
                if live {
                    drop(snap);
                    if ended {
                        emit(app, "raid-end", "", "", "", "");
                    }
                    emit_phase(app, "raid_exited", "", "");
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
            let raid_id = short_id(line);
            if !raid_id.is_empty() {
                snap.raid_id = raid_id.clone();
            }
            snap.phase = "match_found".into();
            let slug_now = if snap.slug.is_empty() {
                location_slug(&location).unwrap_or_default()
            } else {
                snap.slug.clone()
            };
            if snap.slug.is_empty() {
                if let Some(slug) = location_slug(&location) {
                    snap.slug = slug;
                }
            }
            if live {
                let slug = slug_now;
                let raid = snap.raid_id.clone();
                drop(snap);
                if !slug.is_empty() {
                    emit(app, "map", &slug, "", "", "");
                }
                emit_phase(app, "match_found", &slug, &raid);
                snap = SNAP.lock().expect("log-watch");
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
    let active = snap.in_raid || snap.started.is_some() || phase_open(&snap.phase);
    snap.in_raid = false;
    snap.started = None;
    clear_place(&mut snap);
    if active {
        snap.phase = "raid_exited".into();
    }
    drop(snap);
    if active {
        emit(app, "raid-end", "", "", "", "");
    }
}

fn short_id(line: &str) -> String {
    let marker = "shortId:";
    let Some(index) = line.find(marker) else { return String::new() };
    line[index + marker.len()..]
        .trim()
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric())
        .take(6)
        .collect()
}

fn emit(app: &AppHandle, kind: &str, slug: &str, mode: &str, quest_kind: &str, task_id: &str) {
    emit_full(app, kind, slug, mode, quest_kind, task_id, "", "");
}

fn emit_phase(app: &AppHandle, phase: &str, slug: &str, raid_id: &str) {
    emit_full(app, "phase", slug, "", "", "", phase, raid_id);
}

fn emit_full(app: &AppHandle, kind: &str, slug: &str, mode: &str, quest_kind: &str, task_id: &str, phase: &str, raid_id: &str) {
    let _ = app.emit(
        "log-watch",
        LogEvent {
            kind: kind.into(),
            slug: slug.into(),
            mode: mode.into(),
            quest_kind: quest_kind.into(),
            task_id: task_id.into(),
            phase: phase.into(),
            raid_id: raid_id.into(),
        },
    );
}

impl Tail {
    fn new() -> Self {
        Self { path: PathBuf::new(), offset: 0, pending: String::new() }
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
        let Some(stamp) = direct_log_stamp(&dir, "application") else { return };
        if best.as_ref().is_none_or(|(time, _)| stamp >= *time) {
            best = Some((stamp, dir));
        }
    };
    consider(root.to_path_buf());
    let Ok(read) = fs::read_dir(root) else {
        return best.map(|item| item.1);
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            consider(path);
        }
    }
    best.map(|item| item.1)
}

fn direct_log_stamp(dir: &Path, kind: &str) -> Option<SystemTime> {
    let mut best: Option<SystemTime> = None;
    let read = fs::read_dir(dir).ok()?;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_kind(&path, kind) {
            continue;
        }
        let Ok(modified) = fs::metadata(&path).and_then(|meta| meta.modified()) else { continue };
        if best.is_none_or(|time| modified > time) {
            best = Some(modified);
        }
    }
    best
}

fn newest_log(dir: &Path, kind: &str) -> Option<PathBuf> {
    collect_logs(dir, kind).into_iter().max_by_key(|(time, _)| *time).map(|item| item.1)
}

fn ordered_logs(dir: &Path, kind: &str) -> Vec<PathBuf> {
    let mut found = collect_logs(dir, kind);
    found.sort_by_key(|(time, _)| *time);
    found.into_iter().map(|item| item.1).collect()
}

fn collect_logs(dir: &Path, kind: &str) -> Vec<(SystemTime, PathBuf)> {
    let mut found = Vec::new();
    let mut consider = |path: PathBuf| {
        if !is_kind(&path, kind) {
            return;
        }
        let Ok(meta) = fs::metadata(&path) else { return };
        let Ok(modified) = meta.modified() else { return };
        found.push((modified, path));
    };
    let Ok(read) = fs::read_dir(dir) else { return found };
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
    found
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

fn is_local_match_end(line: &str) -> bool {
    line.contains("---> Request") && line.contains("/client/match/local/end")
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
    fn local_match_end_is_the_request() {
        let request = "2026-09-28 21:51:44.787|Info|backend|---> Request HTTPS, id [106]: URL: https://gw-pve.escapefromtarkov.ru/client/match/local/end. ";
        let response = "2026-09-28 21:51:45.864|Info|backend|<--- Response HTTPS, id [106]: URL: https://gw-pve.escapefromtarkov.ru/client/match/local/end, DownloadSeconds: 1.062";
        assert!(is_local_match_end(request));
        assert!(!is_local_match_end(response));
        assert!(!is_local_match_end("URL: https://gw-pve.escapefromtarkov.ru/client/match/local/start. "));
    }

    #[test]
    fn reads_scene_and_mode() {
        let line = "2026-09-11 23:54:47.158|Info|application|scene preset path:maps/factory_night_preset.bundle rcid:factory_night";
        assert_eq!(scene_slug(line).as_deref(), Some("night-factory"));
        assert_eq!(session_mode("Session mode: Pve").as_deref(), Some("pve"));
        assert_eq!(location_slug("TarkovStreets").as_deref(), Some("streets-of-tarkov"));
    }

    #[test]
    fn newest_session_is_latest_launch() {
        let root = std::env::temp_dir().join(format!("zhange-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let older = root.join("log_2026.01.01_00.00.00");
        let newer = root.join("log_2026.09.28_20.00.00");
        fs::create_dir_all(&older).unwrap();
        fs::create_dir_all(&newer).unwrap();
        fs::write(older.join("application.log"), "old").unwrap();
        fs::write(newer.join("application.log"), "Session mode: Pve\n").unwrap();
        fs::write(newer.join("backend.log"), "backend").unwrap();
        std::fs::File::options()
            .write(true)
            .open(older.join("application.log"))
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000))
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(newer.join("application.log"))
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_758_000_000))
            .unwrap();
        let found = newest_session(&root).unwrap();
        assert_eq!(found, newer);
        let logs = ordered_logs(&newer, "application");
        assert_eq!(logs.len(), 1);
        assert!(newest_log(&newer, "backend").unwrap().ends_with("backend.log"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tail_keeps_the_end() {
        let root = std::env::temp_dir().join(format!("zhange-tail-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("application.log");
        let mut body = String::new();
        for index in 0..8000 {
            body.push_str(&format!("line-{index:04} padding-padding-padding\n"));
        }
        fs::write(&path, &body).unwrap();
        let text = tail_text(&path);
        assert!(text.contains("line-7999"));
        assert!(!text.contains("line-0000"));
        assert!(text.starts_with("line-"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn decisive_window_keeps_the_open_raid() {
        let root = std::env::temp_dir().join(format!("zhange-decisive-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("application.log");
        let mut body = String::new();
        body.push_str(&"x".repeat(900_000));
        body.push_str("\nGameStarted: old\nUserMatchOver\n");
        body.push_str(&"y".repeat(900_000));
        body.push_str("\nscene preset path:maps/bigmap_preset.bundle rcid:bigmap\nGameStarted: now\n");
        fs::write(&path, &body).unwrap();
        let len = fs::metadata(&path).unwrap().len();
        let start = decisive_start(&path, len);
        let slice = String::from_utf8(read_range(&path, start, len - start).unwrap()).unwrap();
        assert!(slice.contains("GameStarted: now"));
        assert!(slice.contains("bigmap_preset"));
        assert!(!slice.contains("GameStarted: old"));
        let _ = fs::remove_dir_all(&root);
    }
}

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
    FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
};

const MAX_WATCH_ROOT_ENTRIES: usize = 5_000;
const MAX_WATCH_ROOT_LOG_ENTRIES: usize = 20_000;
const MAX_WATCH_SESSION_ENTRIES: usize = 10_000;
const MAX_WATCH_LOG_FILES_PER_KIND: usize = 8;
const MAX_TAIL_CHUNK_BYTES: u64 = 1024 * 1024;
const MAX_PENDING_LINE_BYTES: usize = 256 * 1024;
const TAIL_ANCHOR_BYTES: u64 = 4 * 1024;
const TAIL_ANCHOR_POINTS: u64 = 8;
const MAX_REPLAY_BYTES_PER_SESSION: u64 = 24 * 1024 * 1024;
const MAX_REPLAY_SEARCH_BYTES_PER_SESSION: u64 = 32 * 1024 * 1024;
const MAX_REPLAY_BYTES_PER_FILE: u64 = 8 * 1024 * 1024;
const MAX_DECISIVE_SEARCH_BYTES: u64 = 8 * 1024 * 1024;

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
    identity: Option<FileIdentity>,
    anchors: Vec<TailAnchor>,
    pending: String,
    dropping_oversize_line: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume_serial: u32,
    file_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TailAnchor {
    offset: u64,
    bytes: Vec<u8>,
}

struct ReplayCursor {
    offset: u64,
    identity: Option<FileIdentity>,
    anchors: Vec<TailAnchor>,
}

enum TailRead {
    NoData,
    Reset,
    Text(String),
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
    root: String,
    application: String,
    notices: String,
    backend: String,
}

static LIVE: Mutex<Live> = Mutex::new(Live {
    running: false,
    ready: false,
    session: String::new(),
    root: String::new(),
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
    let (root, application, notices, backend) = {
        let live = LIVE.lock().expect("log-watch-live");
        (
            live.root.clone(),
            live.application.clone(),
            live.notices.clone(),
            live.backend.clone(),
        )
    };
    LogTails {
        application: tail_text(Path::new(&root), Path::new(&application)),
        notices: tail_text(Path::new(&root), Path::new(&notices)),
        backend: tail_text(Path::new(&root), Path::new(&backend)),
    }
}

fn tail_text(root: &Path, path: &Path) -> String {
    if path.as_os_str().is_empty() {
        return String::new();
    }
    const CAP: u64 = 128 * 1024;
    let Some(mut file) = open_bound_file(root, path) else {
        return String::new();
    };
    let Ok(meta) = file.metadata() else {
        return String::new();
    };
    let start = meta.len().saturating_sub(CAP);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if (&mut file).take(CAP).read_to_end(&mut buf).is_err() {
        return String::new();
    }
    if start > 0 {
        if let Some(index) = buf.iter().position(|byte| *byte == b'\n') {
            buf.drain(..=index);
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn file_stamp(root: &Path, path: &str) -> String {
    if path.is_empty() {
        return "0:0".into();
    }
    let Some(file) = open_bound_file(root, Path::new(path)) else {
        return "0:0".into();
    };
    let Ok(meta) = file.metadata() else {
        return "0:0".into();
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis())
        .unwrap_or(0);
    format!("{}:{modified}", meta.len())
}

fn tail_stamp(live: &Live) -> String {
    let root = Path::new(&live.root);
    format!(
        "{}|{}|{}",
        file_stamp(root, &live.application),
        file_stamp(root, &live.notices),
        file_stamp(root, &live.backend)
    )
}

fn publish(
    running: bool,
    ready: bool,
    session: &str,
    root: &Path,
    application: &Path,
    notices: &Path,
    backend: &Path,
) {
    *LIVE.lock().expect("log-watch-live") = Live {
        running,
        ready,
        session: session.to_string(),
        root: root.display().to_string(),
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
    let mut root_setting = String::new();
    let mut bound_root: Option<PathBuf> = None;
    loop {
        let running = game_running();
        let configured_root = crate::local::get_paths(&app).log_dir;
        let configured_root = configured_root.trim().to_string();
        if configured_root != root_setting {
            root_setting = configured_root.clone();
            bound_root = None;
        }
        // Keep the resolved boundary pinned while this setting is unchanged. Re-resolving it
        // every poll could follow a replaced junction and silently widen the trusted root.
        if bound_root.is_none() && !root_setting.is_empty() {
            bound_root = Path::new(&root_setting)
                .canonicalize()
                .ok()
                .filter(|path| path.is_dir());
        }
        let root = bound_root.clone();
        let selected = root
            .as_ref()
            .and_then(|root| newest_session(root).map(|dir| (root.clone(), dir)));
        if let Some((root, dir)) = selected {
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
                let apps = ordered_logs(&root, &dir, "application");
                let notes = ordered_logs(&root, &dir, "notification");
                let backs = ordered_logs(&root, &dir, "backend");
                publish(
                    running,
                    false,
                    &session,
                    &root,
                    apps.last().map(PathBuf::as_path).unwrap_or(Path::new("")),
                    notes.last().map(PathBuf::as_path).unwrap_or(Path::new("")),
                    backs.last().map(PathBuf::as_path).unwrap_or(Path::new("")),
                );
                let mut replay_budget = MAX_REPLAY_BYTES_PER_SESSION;
                let mut search_budget = MAX_REPLAY_SEARCH_BYTES_PER_SESSION;
                replay_mode(&app, &root, &apps, &mut search_budget);
                application =
                    replay_into(&app, &root, &apps, &mut replay_budget, &mut search_budget);
                notices = replay_into(&app, &root, &notes, &mut replay_budget, &mut search_budget);
                backend = replay_into(&app, &root, &backs, &mut replay_budget, &mut search_budget);
                primed = true;
                if running {
                    catch_up(&app);
                } else {
                    park_offline();
                }
            } else {
                let app_path = newest_log(&root, &dir, "application").unwrap_or_default();
                let note_path = newest_log(&root, &dir, "notification").unwrap_or_default();
                let back_path = newest_log(&root, &dir, "backend").unwrap_or_default();
                follow_file(&mut application, &root, &app_path, &app, running);
                follow_file(&mut notices, &root, &note_path, &app, running);
                follow_file(&mut backend, &root, &back_path, &app, running);
            }
            if was_running && !running {
                end_raid(&app);
            }
            publish(
                running,
                true,
                &session,
                &root,
                &application.path,
                &notices.path,
                &backend.path,
            );
        } else {
            if was_running {
                end_raid(&app);
            }
            publish(
                false,
                true,
                "",
                Path::new(""),
                Path::new(""),
                Path::new(""),
                Path::new(""),
            );
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
    matches!(
        phase,
        "map_loading" | "matching" | "match_found" | "raid_starting" | "raid_started"
    )
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
        (
            snap.slug.clone(),
            snap.mode.clone(),
            snap.phase.clone(),
            snap.raid_id.clone(),
        )
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

fn replay_into(
    app: &AppHandle,
    root: &Path,
    paths: &[PathBuf],
    replay_budget: &mut u64,
    search_budget: &mut u64,
) -> Tail {
    let Some(last) = paths.last() else {
        return Tail::new();
    };
    let start = paths.len().saturating_sub(2);
    for path in &paths[start..paths.len() - 1] {
        replay_file(app, root, path, replay_budget, search_budget);
    }
    let cursor = replay_file(app, root, last, replay_budget, search_budget);
    Tail::from_cursor(last.clone(), cursor)
}

fn replay_mode(app: &AppHandle, root: &Path, paths: &[PathBuf], search_budget: &mut u64) {
    for path in paths.iter().rev() {
        let Some(mut file) = open_bound_file(root, path) else {
            continue;
        };
        let Ok(len) = file.metadata().map(|meta| meta.len()) else {
            continue;
        };
        let bytes = len.min(*search_budget);
        if bytes == 0 {
            return;
        }
        *search_budget -= bytes;
        let Some(at) = rfind(&mut file, len - bytes, len, b"Session mode:") else {
            continue;
        };
        let Some(line) = read_line_at(&mut file, at) else {
            continue;
        };
        apply_lines(app, &line, false);
        return;
    }
}

fn replay_file(
    app: &AppHandle,
    root: &Path,
    path: &Path,
    replay_budget: &mut u64,
    search_budget: &mut u64,
) -> ReplayCursor {
    let Some(mut file) = open_bound_file(root, path) else {
        return ReplayCursor::empty();
    };
    let Ok(len) = file.metadata().map(|meta| meta.len()) else {
        return ReplayCursor::empty();
    };
    let identity = file_identity(&file);
    if len == 0 {
        return ReplayCursor {
            offset: 0,
            identity,
            anchors: Vec::new(),
        };
    }
    if *replay_budget == 0 {
        return ReplayCursor {
            offset: len,
            identity,
            anchors: tail_anchors(&mut file, len),
        };
    }
    let start = replay_start(&mut file, len, *replay_budget, search_budget);
    let applied = len.saturating_sub(start).min(*replay_budget);
    *replay_budget = (*replay_budget).saturating_sub(applied);
    apply_range(app, &mut file, start, len);
    ReplayCursor {
        offset: len,
        identity,
        anchors: tail_anchors(&mut file, len),
    }
}

fn replay_start(file: &mut File, len: u64, replay_budget: u64, search_budget: &mut u64) -> u64 {
    if replay_budget == 0 {
        return len;
    }
    decisive_start(file, len, search_budget)
        .max(len.saturating_sub(replay_budget.min(MAX_REPLAY_BYTES_PER_FILE)))
}

fn decisive_start(file: &mut File, len: u64, search_budget: &mut u64) -> u64 {
    const FLOOR: u64 = 512 * 1024;
    if len <= FLOOR {
        return 0;
    }
    let search = len.min(MAX_DECISIVE_SEARCH_BYTES).min(*search_budget);
    if search == 0 {
        return len.saturating_sub(FLOOR);
    }
    *search_budget -= search;
    let search_start = len - search;
    let Some((at, open)) = latest_decisive(file, search_start, len) else {
        return len.saturating_sub(FLOOR);
    };
    if !open {
        return at.saturating_sub(64 * 1024);
    }
    let scene_search = 4 * 1024 * 1024u64;
    let scene_search = scene_search.min(*search_budget);
    *search_budget -= scene_search;
    let region = at.saturating_sub(scene_search).max(search_start);
    let scene = rfind_in(file, region, at, b"scene preset path:");
    scene.unwrap_or(at).saturating_sub(2048)
}

fn latest_decisive(file: &mut File, floor: u64, len: u64) -> Option<(u64, bool)> {
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
    while end > floor {
        let start = end.saturating_sub(CHUNK).max(floor);
        let Some(buf) = read_range(file, start, end - start) else {
            break;
        };
        let mut found: Option<(usize, bool)> = None;
        if let Some(pos) = buf
            .windows(b"GameStarted:".len())
            .rposition(|window| window == b"GameStarted:")
        {
            found = Some((pos, true));
        }
        for needle in exits {
            if let Some(pos) = buf
                .windows(needle.len())
                .rposition(|window| window == needle)
            {
                if found.is_none_or(|(at, _)| pos > at) {
                    found = Some((pos, false));
                }
            }
        }
        if let Some((pos, open)) = found {
            return Some((start + pos as u64, open));
        }
        if start == floor {
            break;
        }
        end = (start + OVERLAP).min(len);
    }
    None
}

fn rfind(file: &mut File, floor: u64, len: u64, needle: &[u8]) -> Option<u64> {
    const CHUNK: u64 = 1024 * 1024;
    if needle.is_empty() || len <= floor {
        return None;
    }
    let overlap = (needle.len() as u64).saturating_sub(1);
    let mut end = len;
    while end > floor {
        let start = end.saturating_sub(CHUNK).max(floor);
        let buf = read_range(file, start, end - start)?;
        if let Some(pos) = buf
            .windows(needle.len())
            .rposition(|window| window == needle)
        {
            return Some(start + pos as u64);
        }
        if start == floor {
            break;
        }
        end = (start + overlap.max(1)).min(len);
    }
    None
}

fn rfind_in(file: &mut File, from: u64, to: u64, needle: &[u8]) -> Option<u64> {
    if needle.is_empty() || to <= from {
        return None;
    }
    let buf = read_range(file, from, to - from)?;
    buf.windows(needle.len())
        .rposition(|window| window == needle)
        .map(|pos| from + pos as u64)
}

fn read_line_at(file: &mut File, at: u64) -> Option<String> {
    let start = at.saturating_sub(240);
    let buf = read_range(file, start, 640)?;
    let rel = (at - start) as usize;
    if rel > buf.len() {
        return None;
    }
    let before = buf[..rel]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let after = buf[rel..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| rel + index)
        .unwrap_or(buf.len());
    let line = String::from_utf8_lossy(&buf[before..after]);
    let line = line.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

fn read_range(file: &mut File, start: u64, max: u64) -> Option<Vec<u8>> {
    if max == 0 {
        return Some(Vec::new());
    }
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

fn tail_anchors(file: &mut File, offset: u64) -> Vec<TailAnchor> {
    if offset == 0 {
        return Vec::new();
    }
    let bytes = offset.min(TAIL_ANCHOR_BYTES);
    let last_start = offset - bytes;
    let mut anchors = Vec::new();
    let mut previous_start = None;
    for point in 0..TAIL_ANCHOR_POINTS {
        let start = if TAIL_ANCHOR_POINTS == 1 {
            last_start
        } else {
            last_start.saturating_mul(point) / (TAIL_ANCHOR_POINTS - 1)
        };
        if previous_start == Some(start) {
            continue;
        }
        previous_start = Some(start);
        let Some(contents) = read_range(file, start, bytes) else {
            return Vec::new();
        };
        anchors.push(TailAnchor {
            offset: start,
            bytes: contents,
        });
    }
    anchors
}

fn anchors_match(file: &mut File, anchors: &[TailAnchor]) -> bool {
    anchors.iter().all(|anchor| {
        read_range(file, anchor.offset, anchor.bytes.len() as u64)
            .is_some_and(|contents| contents == anchor.bytes)
    })
}

fn apply_range(app: &AppHandle, file: &mut File, start: u64, end: u64) {
    if end <= start {
        return;
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut pending = String::new();
    let mut left = end - start;
    let mut buf = vec![0u8; 256 * 1024];
    let mut skipping = start > 0;
    while left > 0 {
        let want = ((left as usize).min(buf.len())).max(1);
        let Ok(read) = file.read(&mut buf[..want]) else {
            break;
        };
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

fn follow_file(tail: &mut Tail, root: &Path, path: &Path, app: &AppHandle, live: bool) {
    if path.as_os_str().is_empty() {
        return;
    }
    if tail.path != path {
        if live {
            if let TailRead::Text(text) = tail.read_new(root) {
                apply_lines(app, &text, true);
            }
        }
        *tail = replay_tail(app, root, path);
        if live {
            poll_tail(tail, root, app);
        }
        return;
    }
    if !live {
        return;
    }
    poll_tail(tail, root, app);
}

fn replay_tail(app: &AppHandle, root: &Path, path: &Path) -> Tail {
    let mut replay_budget = MAX_REPLAY_BYTES_PER_FILE;
    let mut search_budget = MAX_REPLAY_SEARCH_BYTES_PER_SESSION;
    let cursor = replay_file(app, root, path, &mut replay_budget, &mut search_budget);
    Tail::from_cursor(path.to_path_buf(), cursor)
}

fn poll_tail(tail: &mut Tail, root: &Path, app: &AppHandle) {
    match tail.read_new(root) {
        TailRead::NoData => {}
        TailRead::Text(text) => apply_lines(app, &text, true),
        TailRead::Reset => {
            let path = tail.path.clone();
            *tail = replay_tail(app, root, &path);
        }
    }
}

fn apply_lines(app: &AppHandle, text: &str, live: bool) {
    let mut snap = SNAP.lock().expect("log-watch");
    let initial_mode = snap.mode.clone();
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
        if line.contains("Network game matching aborted")
            || line.contains("Network game matching cancelled")
        {
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
        for (kind, id, mode) in quest_events_with_mode(text, &initial_mode) {
            emit(app, "quest", "", &mode, &kind, &id);
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
    let Some(index) = line.find(marker) else {
        return String::new();
    };
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

fn emit_full(
    app: &AppHandle,
    kind: &str,
    slug: &str,
    mode: &str,
    quest_kind: &str,
    task_id: &str,
    phase: &str,
    raid_id: &str,
) {
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
        Self {
            path: PathBuf::new(),
            offset: 0,
            identity: None,
            anchors: Vec::new(),
            pending: String::new(),
            dropping_oversize_line: false,
        }
    }

    fn from_cursor(path: PathBuf, cursor: ReplayCursor) -> Self {
        Self {
            path,
            offset: cursor.offset,
            identity: cursor.identity,
            anchors: cursor.anchors,
            pending: String::new(),
            dropping_oversize_line: false,
        }
    }

    fn read_new(&mut self, root: &Path) -> TailRead {
        if self.path.as_os_str().is_empty() {
            return TailRead::NoData;
        }
        let Some(mut file) = open_bound_file(root, &self.path) else {
            return TailRead::NoData;
        };
        let Ok(len) = file.metadata().map(|meta| meta.len()) else {
            return TailRead::NoData;
        };
        let identity = file_identity(&file);
        if self.identity.is_some() && identity != self.identity {
            return TailRead::Reset;
        }
        if len < self.offset {
            return TailRead::Reset;
        }
        if !anchors_match(&mut file, &self.anchors) {
            return TailRead::Reset;
        }
        if len == self.offset {
            self.identity = identity.or(self.identity);
            return TailRead::NoData;
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return TailRead::NoData;
        }
        let mut buf = vec![0u8; (len - self.offset).min(MAX_TAIL_CHUNK_BYTES) as usize];
        let Ok(read) = file.read(&mut buf) else {
            return TailRead::NoData;
        };
        if read == 0 {
            return TailRead::NoData;
        }
        self.offset += read as u64;
        self.identity = identity.or(self.identity);
        self.anchors = tail_anchors(&mut file, self.offset);
        let chunk = String::from_utf8_lossy(&buf[..read]);
        let chunk = chunk.as_ref();
        let chunk = if self.dropping_oversize_line {
            let Some(end) = chunk.find('\n') else {
                return TailRead::NoData;
            };
            self.dropping_oversize_line = false;
            &chunk[end + 1..]
        } else {
            chunk
        };
        let mut combined = std::mem::take(&mut self.pending);
        combined.push_str(chunk);
        let mut done = String::new();
        for part in combined.split_inclusive('\n') {
            if part.ends_with('\n') {
                if part.len() <= MAX_PENDING_LINE_BYTES {
                    done.push_str(part);
                }
            } else if part.len() <= MAX_PENDING_LINE_BYTES {
                self.pending.push_str(part);
            } else {
                self.dropping_oversize_line = true;
            }
        }
        if let Some(open) = unclosed_quest(&done) {
            let mut carry = done[open..].to_string();
            carry.push_str(&self.pending);
            let ready = done[..open].to_string();
            if carry.len() <= MAX_PENDING_LINE_BYTES {
                self.pending = carry;
            } else {
                self.pending.clear();
                self.dropping_oversize_line = true;
            }
            if ready.trim().is_empty() {
                return TailRead::NoData;
            }
            return TailRead::Text(ready);
        }
        if done.is_empty() {
            TailRead::NoData
        } else {
            TailRead::Text(done)
        }
    }
}

impl ReplayCursor {
    fn empty() -> Self {
        Self {
            offset: 0,
            identity: None,
            anchors: Vec::new(),
        }
    }
}

fn newest_session(root: &Path) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let mut scan_budget = MAX_WATCH_ROOT_LOG_ENTRIES;
    consider_session(root, root.to_path_buf(), &mut scan_budget, &mut best);
    let Ok(read) = fs::read_dir(&root) else {
        return best.map(|item| item.1);
    };
    for (index, entry) in read.enumerate() {
        if index >= MAX_WATCH_ROOT_ENTRIES || scan_budget == 0 {
            break;
        }
        let Ok(entry) = entry else { continue };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        if let Some(path) = canonical_dir_within(&root, &entry.path()) {
            consider_session(&root, path, &mut scan_budget, &mut best);
        }
    }
    best.map(|item| item.1)
}

fn consider_session(
    root: &Path,
    dir: PathBuf,
    scan_budget: &mut usize,
    best: &mut Option<(SystemTime, PathBuf)>,
) {
    let Some(stamp) = direct_log_stamp(root, &dir, "application", scan_budget) else {
        return;
    };
    if best.as_ref().is_none_or(|(time, _)| stamp >= *time) {
        *best = Some((stamp, dir));
    }
}

fn direct_log_stamp(
    root: &Path,
    dir: &Path,
    kind: &str,
    scan_budget: &mut usize,
) -> Option<SystemTime> {
    let mut best: Option<SystemTime> = None;
    let read = fs::read_dir(dir).ok()?;
    for entry in read {
        if *scan_budget == 0 {
            break;
        }
        *scan_budget -= 1;
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() || !is_kind(&path, kind) {
            continue;
        }
        let Ok(canonical_path) = path.canonicalize() else {
            continue;
        };
        if !path_is_within_root(&canonical_path, root) {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        // Actual reads reopen and validate the final path through the same file handle used to read.
        if best.is_none_or(|time| modified > time) {
            best = Some(modified);
        }
    }
    best
}

fn newest_log(root: &Path, dir: &Path, kind: &str) -> Option<PathBuf> {
    collect_logs(root, dir, kind)
        .into_iter()
        .max_by_key(|(time, _)| *time)
        .map(|item| item.1)
}

fn ordered_logs(root: &Path, dir: &Path, kind: &str) -> Vec<PathBuf> {
    let mut found = collect_logs(root, dir, kind);
    found.sort_by_key(|(time, _)| *time);
    found.into_iter().map(|item| item.1).collect()
}

fn collect_logs(root: &Path, dir: &Path, log_kind: &str) -> Vec<(SystemTime, PathBuf)> {
    let mut found = Vec::new();
    if !root.is_dir() {
        return found;
    }
    let Some(dir) = canonical_dir_within(root, dir) else {
        return found;
    };
    let Ok(read) = fs::read_dir(&dir) else {
        return found;
    };
    let mut remaining = MAX_WATCH_SESSION_ENTRIES;
    for entry in read {
        if remaining == 0 {
            break;
        }
        remaining -= 1;
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file() && !file_type.is_symlink() {
            consider_log_entry(root, entry, log_kind, &mut found);
        } else if file_type.is_dir() {
            let Some(child) = canonical_dir_within(root, &path) else {
                continue;
            };
            let Ok(inner) = fs::read_dir(child) else {
                continue;
            };
            for file in inner {
                if remaining == 0 {
                    break;
                }
                remaining -= 1;
                let Ok(file) = file else { continue };
                let Ok(file_kind) = file.file_type() else {
                    continue;
                };
                if file_kind.is_file() && !file_kind.is_symlink() {
                    consider_log_entry(root, file, log_kind, &mut found);
                }
            }
        }
    }
    found.sort_by_key(|(time, _)| *time);
    if found.len() > MAX_WATCH_LOG_FILES_PER_KIND {
        found.drain(..found.len() - MAX_WATCH_LOG_FILES_PER_KIND);
    }
    found
}

fn consider_log_entry(
    root: &Path,
    entry: fs::DirEntry,
    log_kind: &str,
    found: &mut Vec<(SystemTime, PathBuf)>,
) {
    let path = entry.path();
    if !is_kind(&path, log_kind) {
        return;
    }
    let Ok(path) = path.canonicalize() else {
        return;
    };
    if !path_is_within_root(&path, root) {
        return;
    }
    let Ok(meta) = entry.metadata() else { return };
    let Ok(modified) = meta.modified() else {
        return;
    };
    found.push((modified, path));
}

fn canonical_dir_within(root: &Path, path: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    if path.is_dir() && path_is_within_root(&path, &root) {
        Some(path)
    } else {
        None
    }
}

fn open_bound_file(root: &Path, path: &Path) -> Option<File> {
    // root is the canonical path pinned by watch(); validate the final path on this open handle
    // and use this same handle for metadata and reads to close the file-swap race.
    if !root.is_absolute() {
        return None;
    }
    let file = File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let final_path = handle_path(&file).ok()?;
    path_is_within_root(&final_path, &root).then_some(file)
}

fn file_identity(file: &File) -> Option<FileIdentity> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let result = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
    if result == 0 {
        return None;
    }
    Some(FileIdentity {
        volume_serial: info.dwVolumeSerialNumber,
        file_index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    })
}

fn handle_path(file: &File) -> Result<PathBuf, String> {
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as _,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(format!(
            "读取日志文件实际路径失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let raw = std::ffi::OsString::from_wide(&buffer[..length]);
    let text = raw.to_string_lossy().into_owned();
    let normalized = if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
        PathBuf::from(format!("\\\\{unc}"))
    } else if let Some(path) = text.strip_prefix("\\\\?\\") {
        PathBuf::from(path)
    } else {
        PathBuf::from(raw)
    };
    Ok(normalized)
}

fn path_is_within_root(path: &Path, root: &Path) -> bool {
    fn comparable(path: &Path) -> String {
        let text = path.to_string_lossy().replace('/', "\\");
        let text = text
            .strip_prefix("\\\\?\\UNC\\")
            .map(|unc| format!("\\\\{unc}"))
            .or_else(|| text.strip_prefix("\\\\?\\").map(str::to_string))
            .unwrap_or(text);
        text.trim_end_matches('\\').to_lowercase()
    }

    let path = comparable(path);
    let root = comparable(root);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

fn is_kind(path: &Path, kind: &str) -> bool {
    let Some(name) = path.file_name().and_then(|item| item.to_str()) else {
        return false;
    };
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
    let raw = line[index + marker.len()..]
        .split('|')
        .next()
        .unwrap_or("")
        .trim();
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
    let stem = file
        .split("_preset")
        .next()
        .unwrap_or(file)
        .trim_end_matches(".bundle");
    location_slug(stem)
}

fn is_local_match_end(line: &str) -> bool {
    line.contains("---> Request") && line.contains("/client/match/local/end")
}

fn is_hideout(line: &str) -> bool {
    let marker = "scene preset path:";
    let Some(index) = line.find(marker) else {
        return false;
    };
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

fn quest_events_with_mode(text: &str, mode: &str) -> Vec<(String, String, String)> {
    let mut mode_changes = Vec::new();
    let mut line_start = 0;
    for line in text.split_inclusive('\n') {
        if let Some(marker) = line.find("Session mode:") {
            if let Some(next_mode) = session_mode(line) {
                mode_changes.push((line_start + marker, next_mode));
            }
        }
        line_start += line.len();
    }

    let marker = "ChatMessageReceived";
    let mut events = Vec::new();
    let mut cursor = 0;
    let mut mode_cursor = 0;
    let mut current_mode = mode.to_string();
    while let Some(relative) = text[cursor..].find(marker) {
        let event_at = cursor + relative;
        while mode_cursor < mode_changes.len() && mode_changes[mode_cursor].0 <= event_at {
            current_mode = mode_changes[mode_cursor].1.clone();
            mode_cursor += 1;
        }
        let rest_start = event_at + marker.len();
        let rest = &text[rest_start..];
        let Some(json) = json_object(rest) else {
            cursor = rest_start;
            continue;
        };
        if let Some((kind, id)) = quest_from_json(json) {
            events.push((kind, id, current_mode.clone()));
        }
        let json_start = rest.find('{').unwrap_or(0);
        cursor = rest_start + json_start + json.len();
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
    let type_id = message
        .get("type")
        .or_else(|| message.get("Type"))
        .and_then(|item| item.as_i64())?;
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
    let id = raw
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
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
    let Some(index) = line.find(key) else {
        return String::new();
    };
    let rest = line[index + key.len()..].trim();
    rest.split([',', '\''])
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

fn sid_country(line: &str) -> String {
    let Some(index) = line.find("Sid:") else {
        return String::new();
    };
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
        name.eq_ignore_ascii_case("EscapeFromTarkov.exe")
            || name.eq_ignore_ascii_case("EscapeFromTarkov_BE.exe")
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
    Some(
        civil_days(year, month, day)? * 86400
            + hour as i64 * 3600
            + minute as i64 * 60
            + second as i64,
    )
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
    use std::io::Write;

    #[test]
    fn local_match_end_is_the_request() {
        let request = "2026-09-28 21:51:44.787|Info|backend|---> Request HTTPS, id [106]: URL: https://gw-pve.escapefromtarkov.ru/client/match/local/end. ";
        let response = "2026-09-28 21:51:45.864|Info|backend|<--- Response HTTPS, id [106]: URL: https://gw-pve.escapefromtarkov.ru/client/match/local/end, DownloadSeconds: 1.062";
        assert!(is_local_match_end(request));
        assert!(!is_local_match_end(response));
        assert!(!is_local_match_end(
            "URL: https://gw-pve.escapefromtarkov.ru/client/match/local/start. "
        ));
    }

    #[test]
    fn reads_scene_and_mode() {
        let line = "2026-09-11 23:54:47.158|Info|application|scene preset path:maps/factory_night_preset.bundle rcid:factory_night";
        assert_eq!(scene_slug(line).as_deref(), Some("night-factory"));
        assert_eq!(session_mode("Session mode: Pve").as_deref(), Some("pve"));
        assert_eq!(
            location_slug("TarkovStreets").as_deref(),
            Some("streets-of-tarkov")
        );
    }

    #[test]
    fn quest_events_use_the_mode_active_at_each_event() {
        let text = concat!(
            "ChatMessageReceived {\"message\":{\"type\":10,\"templateId\":\"0123456789abcdef0123\"}}\n",
            "Session mode: Pve\n",
            "ChatMessageReceived {\"message\":{\"type\":12,\"templateId\":\"0123456789abcdef0123\"}}\n",
        );
        assert_eq!(
            quest_events_with_mode(text, "pvp"),
            vec![
                (
                    "started".into(),
                    "0123456789abcdef0123".into(),
                    "pvp".into()
                ),
                (
                    "completed".into(),
                    "0123456789abcdef0123".into(),
                    "pve".into()
                ),
            ]
        );
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
            .set_modified(
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000),
            )
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(newer.join("application.log"))
            .unwrap()
            .set_modified(
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_758_000_000),
            )
            .unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let found = newest_session(&canonical_root).unwrap();
        assert_eq!(found, newer.canonicalize().unwrap());
        let logs = ordered_logs(&canonical_root, &found, "application");
        assert_eq!(logs.len(), 1);
        assert!(newest_log(&canonical_root, &found, "backend")
            .unwrap()
            .ends_with("backend.log"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn log_scan_keeps_only_the_newest_bounded_file_set() {
        let root = std::env::temp_dir().join(format!("zhange-watch-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        for index in 0..(MAX_WATCH_LOG_FILES_PER_KIND + 4) {
            let path = root.join(format!("application_{index:02}.log"));
            fs::write(&path, "log").unwrap();
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(
                    SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000 + index as u64),
                )
                .unwrap();
        }
        let canonical_root = root.canonicalize().unwrap();
        let logs = ordered_logs(&canonical_root, &canonical_root, "application");

        assert_eq!(logs.len(), MAX_WATCH_LOG_FILES_PER_KIND);
        assert!(logs[0].ends_with("application_04.log"));
        assert!(logs.last().unwrap().ends_with("application_11.log"));
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
        let text = tail_text(&root.canonicalize().unwrap(), &path);
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
        body.push_str(
            "\nscene preset path:maps/bigmap_preset.bundle rcid:bigmap\nGameStarted: now\n",
        );
        fs::write(&path, &body).unwrap();
        let len = fs::metadata(&path).unwrap().len();
        let mut file = File::open(&path).unwrap();
        let mut search_budget = MAX_REPLAY_SEARCH_BYTES_PER_SESSION;
        let start = decisive_start(&mut file, len, &mut search_budget);
        let slice = String::from_utf8(read_range(&mut file, start, len - start).unwrap()).unwrap();
        assert!(slice.contains("GameStarted: now"));
        assert!(slice.contains("bigmap_preset"));
        assert!(!slice.contains("GameStarted: old"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_utf8_before_mode_marker_does_not_panic_or_misalign() {
        let path =
            std::env::temp_dir().join(format!("zhange-mode-utf8-{}.log", std::process::id()));
        let mut bytes = vec![b'x'; 239];
        bytes.push(0xff);
        let at = bytes.len() as u64;
        bytes.extend_from_slice(b"Session mode: Pve\n");
        fs::write(&path, bytes).unwrap();

        let mut file = File::open(&path).unwrap();
        let line = read_line_at(&mut file, at).expect("mode line");
        assert_eq!(session_mode(&line).as_deref(), Some("pve"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn tail_discards_overlong_lines_without_growing_pending() {
        let root = std::env::temp_dir().join(format!("zhange-tail-cap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("application.log");
        fs::write(&path, vec![b'x'; MAX_PENDING_LINE_BYTES + 1024]).unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let mut tail = Tail {
            path: path.clone(),
            offset: 0,
            identity: None,
            anchors: Vec::new(),
            pending: String::new(),
            dropping_oversize_line: false,
        };

        assert!(matches!(tail.read_new(&canonical_root), TailRead::NoData));
        assert!(tail.pending.len() <= MAX_PENDING_LINE_BYTES);
        assert!(tail.dropping_oversize_line);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"GameStarted: 2026-01-01 00:00:00\nSession mode: Pve\n")
            .unwrap();
        drop(file);
        let TailRead::Text(ready) = tail.read_new(&canonical_root) else {
            panic!("completed line")
        };
        assert!(!ready.contains("GameStarted:"));
        assert!(ready.contains("Session mode: Pve"));
        assert!(tail.pending.len() <= MAX_PENDING_LINE_BYTES);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tail_detects_truncate_and_regrow_at_the_same_path() {
        let root = std::env::temp_dir().join(format!("zhange-tail-rewrite-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("application.log");
        fs::write(&path, vec![b'o'; (MAX_TAIL_CHUNK_BYTES * 2) as usize]).unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let mut tail = Tail::new();
        tail.path = path.clone();
        assert!(matches!(tail.read_new(&canonical_root), TailRead::NoData));
        assert_eq!(tail.offset, MAX_TAIL_CHUNK_BYTES);
        let old_identity = tail.identity;

        let mut file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        file.write_all(&vec![b'n'; (MAX_TAIL_CHUNK_BYTES * 2) as usize])
            .unwrap();
        drop(file);
        let current_identity = file_identity(&File::open(&path).unwrap());
        if let (Some(before), Some(after)) = (old_identity, current_identity) {
            assert_eq!(
                before, after,
                "truncate should preserve the file object identity"
            );
        }

        assert!(matches!(tail.read_new(&canonical_root), TailRead::Reset));
        assert_eq!(tail.offset, MAX_TAIL_CHUNK_BYTES);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn log_reads_reject_paths_outside_the_bound_root() {
        let base =
            std::env::temp_dir().join(format!("zhange-watch-boundary-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("logs");
        fs::create_dir_all(&root).unwrap();
        let outside = base.join("outside.log");
        fs::write(&outside, "Session mode: Pve\n").unwrap();
        let canonical_root = root.canonicalize().unwrap();

        assert!(open_bound_file(&canonical_root, &outside).is_none());
        assert!(tail_text(&canonical_root, &outside).is_empty());

        let link = root.join("application.log");
        if std::os::windows::fs::symlink_file(&outside, &link).is_ok() {
            assert!(open_bound_file(&canonical_root, &link).is_none());
            assert!(collect_logs(&canonical_root, &canonical_root, "application").is_empty());
        }

        let outside_session = base.join("outside-session");
        fs::create_dir_all(&outside_session).unwrap();
        fs::write(outside_session.join("application.log"), "outside").unwrap();
        let directory_link = root.join("linked-session");
        if std::os::windows::fs::symlink_dir(&outside_session, &directory_link).is_ok() {
            assert!(newest_session(&canonical_root).is_none());
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn replay_window_is_bounded_even_when_raid_marker_is_old() {
        let path =
            std::env::temp_dir().join(format!("zhange-replay-cap-{}.log", std::process::id()));
        let mut file = File::create(&path).unwrap();
        file.write_all(b"GameStarted: old\n").unwrap();
        file.set_len(MAX_REPLAY_BYTES_PER_FILE * 4).unwrap();
        let len = file.metadata().unwrap().len();
        let mut search_budget = MAX_REPLAY_SEARCH_BYTES_PER_SESSION;
        let start = replay_start(
            &mut file,
            len,
            MAX_REPLAY_BYTES_PER_SESSION,
            &mut search_budget,
        );

        assert!(start <= len);
        assert!(len - start <= MAX_REPLAY_BYTES_PER_FILE);
        let _ = fs::remove_file(path);
    }
}

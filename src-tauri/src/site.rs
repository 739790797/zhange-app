use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::persist::atomic_write;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

const API: &str = "https://zhange.space/api";
const SESSION_MAGIC: &[u8] = b"ZHANGE-SESSION-DPAPI\x01";
const MAX_SESSION_FILE_BYTES: usize = 1024 * 1024;
const MAX_API_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

static NEXT_SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);
static LOGIN_ATTEMPT: AtomicU64 = AtomicU64::new(0);
static LOGIN_IN_FLIGHT: AtomicU64 = AtomicU64::new(0);

struct LoginInFlight(u64);

impl LoginInFlight {
    fn start(attempt: u64) -> Self {
        LOGIN_IN_FLIGHT.fetch_max(attempt, Ordering::AcqRel);
        Self(attempt)
    }
}

impl Drop for LoginInFlight {
    fn drop(&mut self) {
        let _ = LOGIN_IN_FLIGHT.compare_exchange(self.0, 0, Ordering::AcqRel, Ordering::Acquire);
    }
}

#[derive(Clone)]
struct Session {
    generation: u64,
    credential_revision: u64,
    login_attempt: u64,
    cookies: HashMap<String, String>,
    token: String,
    username: String,
    /// Unix 秒，与网页端 Cookie / JWT 的过期时间一致。
    expires_at: Option<i64>,
}

impl Session {
    fn new() -> Self {
        Self {
            generation: NEXT_SESSION_GENERATION.fetch_add(1, Ordering::Relaxed),
            credential_revision: 0,
            login_attempt: 0,
            cookies: HashMap::new(),
            token: String::new(),
            username: String::new(),
            expires_at: None,
        }
    }
}

#[derive(Clone)]
struct SessionSnapshot {
    generation: u64,
    credential_revision: u64,
    cookies: HashMap<String, String>,
    token: String,
    expires_at: Option<i64>,
}

impl From<&Session> for SessionSnapshot {
    fn from(session: &Session) -> Self {
        Self {
            generation: session.generation,
            credential_revision: session.credential_revision,
            cookies: session.cookies.clone(),
            token: session.token.clone(),
            expires_at: session.expires_at,
        }
    }
}

struct ApiResponse {
    generation: u64,
    credential_revision: u64,
    path: String,
    status: reqwest::StatusCode,
    set_cookies: Vec<String>,
    text: String,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static GAME_MODE: Mutex<String> = Mutex::new(String::new());
static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct SavedSession {
    token: String,
    username: String,
    #[serde(default)]
    cookies: HashMap<String, String>,
    #[serde(default)]
    expires_at: Option<i64>,
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = CONFIG_DIR.set(dir);
    let _ = load_saved();
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteUser {
    pub logged_in: bool,
    pub username: String,
}

fn session_file() -> Option<PathBuf> {
    CONFIG_DIR.get().map(|dir| dir.join("session.json"))
}

fn load_saved() -> Result<(), String> {
    let Some(path) = session_file() else {
        return Err("会话存储目录不可用".into());
    };
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取本地会话失败：{error}")),
    };
    if metadata.len() > MAX_SESSION_FILE_BYTES as u64 {
        return Err("本地会话文件过大，已忽略".into());
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取本地会话失败：{error}"))?;
    if bytes.len() > MAX_SESSION_FILE_BYTES {
        return Err("本地会话文件过大，已忽略".into());
    }
    let (plaintext, needs_migration) = match bytes.strip_prefix(SESSION_MAGIC) {
        Some(ciphertext) => (unprotect_data(ciphertext)?, false),
        None => (bytes, true),
    };
    let saved = serde_json::from_slice::<SavedSession>(&plaintext)
        .map_err(|error| format!("本地会话格式无效：{error}"))?;
    if saved.token.is_empty()
        || saved
            .expires_at
            .is_some_and(|expires| expires <= unix_now())
    {
        remove_session_file(&path)?;
        return Ok(());
    }
    if needs_migration {
        if let Err(error) = persist_saved(&path, &saved) {
            // Do not keep an unencrypted credential file around when migration fails.
            let _ = fs::remove_file(&path);
            return Err(error);
        }
    }
    let mut guard = session();
    let current = guard.as_mut().expect("session");
    current.token = saved.token;
    current.username = saved.username;
    current.cookies = saved.cookies;
    current.expires_at = saved.expires_at;
    Ok(())
}

fn persist(session: &Session) -> Result<(), String> {
    let Some(path) = session_file() else {
        return Err("会话存储目录不可用".into());
    };
    if session.token.is_empty() {
        return remove_session_file(&path);
    }
    let saved = SavedSession {
        token: session.token.clone(),
        username: session.username.clone(),
        cookies: session.cookies.clone(),
        expires_at: session.expires_at,
    };
    persist_saved(&path, &saved)
}

fn persist_saved(path: &Path, saved: &SavedSession) -> Result<(), String> {
    let plaintext = serde_json::to_vec(saved).map_err(|error| error.to_string())?;
    let ciphertext = protect_data(&plaintext)?;
    let mut contents = Vec::with_capacity(SESSION_MAGIC.len() + ciphertext.len());
    contents.extend_from_slice(SESSION_MAGIC);
    contents.extend_from_slice(&ciphertext);
    atomic_write(path, &contents)
}

fn remove_session_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清除本地会话失败：{error}")),
    }
}

fn protect_data(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if plaintext.len() > MAX_SESSION_FILE_BYTES || plaintext.len() > u32::MAX as usize {
        return Err("本地会话数据过大".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows 凭据加密失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let result = if output.cbData == 0 {
        Ok(Vec::new())
    } else if output.pbData.is_null() || output.cbData as usize > MAX_SESSION_FILE_BYTES {
        Err("Windows 凭据加密结果无效".into())
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        Ok(bytes.to_vec())
    };
    if !output.pbData.is_null() {
        unsafe {
            LocalFree(output.pbData.cast());
        }
    }
    result
}

fn unprotect_data(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    if ciphertext.len() > MAX_SESSION_FILE_BYTES || ciphertext.len() > u32::MAX as usize {
        return Err("本地会话数据过大".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows 凭据解密失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let result = if output.cbData == 0 {
        Ok(Vec::new())
    } else if output.pbData.is_null() || output.cbData as usize > MAX_SESSION_FILE_BYTES {
        Err("Windows 凭据解密结果无效".into())
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        Ok(bytes.to_vec())
    };
    if !output.pbData.is_null() {
        unsafe {
            LocalFree(output.pbData.cast());
        }
    }
    result
}

fn session() -> std::sync::MutexGuard<'static, Option<Session>> {
    let mut guard = SESSION.lock().expect("session");
    if guard.is_none() {
        *guard = Some(Session::new());
    }
    guard
}

fn response_matches_snapshot(current: &Session, request: &SessionSnapshot) -> bool {
    current.generation == request.generation
        && current.credential_revision == request.credential_revision
}

fn login_can_commit(
    attempt: u64,
    latest_attempt: u64,
    in_flight_attempt: u64,
    current: &Session,
    starting_generation: u64,
) -> bool {
    latest_attempt == attempt
        && (current.generation == starting_generation
            || in_flight_attempt == attempt
            || (current.login_attempt > 0 && current.login_attempt < attempt))
}

pub fn set_game_mode(mode: &str) {
    let next = if mode.eq_ignore_ascii_case("pve") {
        "pve"
    } else {
        "pvp"
    };
    *GAME_MODE.lock().expect("game mode") = next.to_string();
}

fn game_mode() -> String {
    let guard = GAME_MODE.lock().expect("game mode");
    if *guard == "pve" {
        "pve".to_string()
    } else {
        "pvp".to_string()
    }
}

pub fn access_token() -> String {
    session().as_ref().expect("session").token.clone()
}

fn cookie_header(cookies: &HashMap<String, String>) -> String {
    cookies
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|err| err.to_string())
}

async fn send(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let snapshot = session_snapshot();
    let response = request_raw(method, path, body, snapshot).await?;
    apply_response_effects(&response)?;
    parse_response(&response)
}

fn session_snapshot() -> SessionSnapshot {
    let guard = session();
    SessionSnapshot::from(guard.as_ref().expect("session"))
}

async fn request_raw(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    snapshot: SessionSnapshot,
) -> Result<ApiResponse, String> {
    let path = normalize_path(path)?;
    let url = format!("{API}{path}");
    let cookies = cookie_header(&snapshot.cookies);
    let mut request = client()?
        .request(method.clone(), &url)
        .header(reqwest::header::ACCEPT, "application/json");
    if !snapshot.token.is_empty() {
        request = request.header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", snapshot.token),
        );
    }
    if !cookies.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookies);
    }
    if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
        if let Some(token) = snapshot.cookies.get("zhange_csrf") {
            request = request.header("X-CSRF-Token", token);
        }
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status();
    let set_cookies: Vec<String> = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_API_RESPONSE_BYTES as u64)
    {
        return Err("服务器响应超过 16 MiB，已中止读取".into());
    }
    let capacity = response
        .content_length()
        .unwrap_or_default()
        .min(MAX_API_RESPONSE_BYTES as u64) as usize;
    let mut bytes = Vec::with_capacity(capacity);
    while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
        append_bounded_response_chunk(&mut bytes, &chunk, MAX_API_RESPONSE_BYTES)?;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(ApiResponse {
        generation: snapshot.generation,
        credential_revision: snapshot.credential_revision,
        path,
        status,
        set_cookies,
        text,
    })
}

fn append_bounded_response_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
    limit: usize,
) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > limit {
        return Err(format!(
            "服务器响应超过 {} MiB，已中止读取",
            limit / (1024 * 1024)
        ));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

enum ResponseSessionEffect {
    Ignore,
    Update(Session),
    Invalidate(Session),
}

fn response_session_effect(current: &Session, response: &ApiResponse) -> ResponseSessionEffect {
    if current.generation != response.generation
        || current.credential_revision != response.credential_revision
    {
        return ResponseSessionEffect::Ignore;
    }
    if response.status.as_u16() == 401 && !response.path.contains("/auth/login") {
        return if current.token.is_empty() {
            ResponseSessionEffect::Ignore
        } else {
            ResponseSessionEffect::Invalidate(Session::new())
        };
    }
    let mut updated = current.clone();
    if !apply_set_cookies(&mut updated, &response.set_cookies) {
        return ResponseSessionEffect::Ignore;
    }
    if !current.token.is_empty() && updated.token.is_empty() {
        ResponseSessionEffect::Invalidate(Session::new())
    } else {
        ResponseSessionEffect::Update(updated)
    }
}

fn apply_response_effects(response: &ApiResponse) -> Result<(), String> {
    let mut guard = session();
    let current = guard.as_mut().expect("session");
    match response_session_effect(current, response) {
        ResponseSessionEffect::Ignore => Ok(()),
        ResponseSessionEffect::Update(updated) => {
            let refresh_room_auth = !updated.token.is_empty() && current.token != updated.token;
            persist(&updated)?;
            *current = updated;
            drop(guard);
            if refresh_room_auth {
                if let Some(app) = APP.get() {
                    crate::room_ws::refresh_auth(app.clone());
                }
            }
            Ok(())
        }
        ResponseSessionEffect::Invalidate(fresh) => {
            let persisted = persist(&fresh);
            *current = fresh;
            drop(guard);
            notify_session_invalidated(true);
            persisted
        }
    }
}

fn parse_response(response: &ApiResponse) -> Result<Value, String> {
    if !response.status.is_success() {
        let detail = serde_json::from_str::<Value>(&response.text)
            .ok()
            .and_then(|value| {
                value
                    .get("detail")
                    .or_else(|| value.get("message"))
                    .cloned()
            })
            .map(|detail| match detail {
                Value::String(text) => text,
                other => other.to_string(),
            })
            .unwrap_or_else(|| format!("请求失败 {}", response.status));
        return Err(detail);
    }
    if response.text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&response.text).map_err(|error| error.to_string())
}

pub async fn login(username: String, password: String) -> Result<SiteUser, String> {
    let name = username.trim().to_string();
    if name.is_empty() || password.is_empty() {
        return Err("请填写账号和密码".into());
    }
    let attempt = LOGIN_ATTEMPT
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    let _in_flight = LoginInFlight::start(attempt);
    let snapshot = session_snapshot();
    let response = request_raw(
        reqwest::Method::POST,
        "/auth/login",
        Some(serde_json::json!({ "username": name, "password": password })),
        snapshot.clone(),
    )
    .await?;
    let value = parse_response(&response)?;
    let token = value
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if token.is_empty() {
        return Err("登录成功但没有拿到会话".into());
    }
    let username = value
        .get("username")
        .or_else(|| value.get("display_name"))
        .and_then(Value::as_str)
        .unwrap_or(&name)
        .to_string();
    let mut guard = session();
    let current = guard.as_mut().expect("session");
    if !login_can_commit(
        attempt,
        LOGIN_ATTEMPT.load(Ordering::Relaxed),
        LOGIN_IN_FLIGHT.load(Ordering::Acquire),
        current,
        snapshot.generation,
    ) {
        return Err("登录状态已变化，请重新登录".into());
    }
    let mut next = Session::new();
    apply_set_cookies(&mut next, &response.set_cookies);
    next.login_attempt = attempt;
    next.token = token.clone();
    next.username = username.clone();
    next.cookies.insert("zhange_access".into(), token.clone());
    if next.expires_at.is_none() {
        next.expires_at = jwt_expiry(&token).or_else(|| Some(unix_now() + 60 * 60 * 24));
    }
    persist(&next)?;
    *current = next;
    Ok(SiteUser {
        logged_in: true,
        username,
    })
}

pub async fn logout() -> Result<(), String> {
    LOGIN_ATTEMPT.fetch_add(1, Ordering::Relaxed);
    let (snapshot, persisted, had_session) = {
        let mut guard = session();
        let current = guard.as_mut().expect("session");
        let snapshot = SessionSnapshot::from(&*current);
        let had_session = !current.token.is_empty();
        let fresh = Session::new();
        *current = fresh;
        let persisted = persist(current);
        (snapshot, persisted, had_session)
    };
    notify_session_invalidated(had_session);
    // Notify the service using the old credentials, but never let this response
    // mutate a session created after local logout.
    let _ = request_raw(
        reqwest::Method::POST,
        "/auth/logout",
        Some(serde_json::json!({})),
        snapshot,
    )
    .await;
    persisted.map_err(|error| format!("当前应用已退出，但未能清除本地会话：{error}"))?;
    Ok(())
}

pub async fn restore() -> Result<SiteUser, String> {
    let snapshot = session_snapshot();
    if snapshot.token.is_empty() {
        return Ok(current_user());
    }
    if snapshot
        .expires_at
        .is_some_and(|expires| expires <= unix_now())
    {
        let _ = clear_session_if_snapshot(&snapshot)?;
        return Ok(current_user());
    }
    let response = match request_raw(reqwest::Method::GET, "/auth/me", None, snapshot.clone()).await
    {
        Ok(response) => response,
        Err(_) => {
            let guard = session();
            let current = guard.as_ref().expect("session");
            if !response_matches_snapshot(current, &snapshot) {
                return Ok(site_user(current));
            }
            return Ok(SiteUser {
                logged_in: true,
                username: current.username.clone(),
            });
        }
    };
    let result = parse_response(&response);
    apply_response_effects(&response)?;
    let mut guard = session();
    let current = guard.as_mut().expect("session");
    if !response_matches_snapshot(current, &snapshot) {
        return Ok(site_user(current));
    }
    match result {
        Ok(value) => {
            let username = value
                .get("username")
                .or_else(|| value.get("display_name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !username.is_empty() && current.username != username {
                let mut updated = current.clone();
                updated.username = username;
                persist(&updated)?;
                *current = updated;
            }
            Ok(site_user(current))
        }
        Err(error) if error.contains("未登录") || error.contains("令牌无效") => {
            drop(guard);
            let _ = clear_session_if_snapshot(&snapshot)?;
            Ok(current_user())
        }
        Err(_) => Ok(SiteUser {
            logged_in: true,
            username: current.username.clone(),
        }),
    }
}

fn clear_session_if_snapshot(snapshot: &SessionSnapshot) -> Result<bool, String> {
    let mut guard = session();
    let current = guard.as_mut().expect("session");
    if !response_matches_snapshot(current, snapshot) {
        return Ok(false);
    }
    let had_session = !current.token.is_empty();
    *current = Session::new();
    let persisted = persist(current);
    drop(guard);
    notify_session_invalidated(had_session);
    persisted?;
    Ok(true)
}

fn notify_session_invalidated(had_session: bool) {
    crate::room_ws::unwatch();
    if !had_session {
        return;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit("site-session-invalidated", ());
    }
}

fn current_user() -> SiteUser {
    let guard = session();
    site_user(guard.as_ref().expect("session"))
}

fn site_user(session: &Session) -> SiteUser {
    SiteUser {
        logged_in: !session.token.is_empty(),
        username: if session.token.is_empty() {
            String::new()
        } else {
            session.username.clone()
        },
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn jwt_expiry(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .or_else(|| {
            base64::engine::general_purpose::URL_SAFE
                .decode(payload)
                .ok()
        })?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.get("exp")?.as_i64()
}

fn apply_set_cookies(session: &mut Session, lines: &[String]) -> bool {
    let old_cookies = session.cookies.clone();
    let old_token = session.token.clone();
    let old_expiry = session.expires_at;
    let now = unix_now();
    for line in lines {
        let mut parts = line.split(';');
        let Some(pair) = parts.next() else { continue };
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        };
        let value = value.trim();
        let mut max_age = None;
        for attr in parts {
            let attr = attr.trim();
            if let Some((name, value)) = attr.split_once('=') {
                if name.trim().eq_ignore_ascii_case("max-age") {
                    max_age = value.trim().parse::<i64>().ok();
                }
            }
        }
        let deleting =
            max_age.is_some_and(|age| age <= 0) || (key == "zhange_access" && value.is_empty());
        if deleting {
            session.cookies.remove(key);
        } else {
            session.cookies.insert(key.to_string(), value.to_string());
        }
        if key == "zhange_access" {
            if deleting {
                session.token.clear();
                session.expires_at = None;
            } else {
                let token_changed = session.token != value;
                session.token = value.to_string();
                if let Some(age) = max_age {
                    session.expires_at = Some(now + age);
                } else if let Some(expiry) = jwt_expiry(&session.token) {
                    session.expires_at = Some(expiry);
                } else if token_changed {
                    session.expires_at = None;
                }
            }
        }
    }
    let changed = old_cookies != session.cookies
        || old_token != session.token
        || old_expiry != session.expires_at;
    if changed {
        session.credential_revision = session.credential_revision.saturating_add(1);
    }
    changed
}

pub async fn get(path: String) -> Result<Value, String> {
    send(reqwest::Method::GET, &with_game_mode(&path), None).await
}

pub async fn post(path: String, body: Value) -> Result<Value, String> {
    send(reqwest::Method::POST, &with_game_mode(&path), Some(body)).await
}

pub async fn put(path: String, body: Value) -> Result<Value, String> {
    send(reqwest::Method::PUT, &with_game_mode(&path), Some(body)).await
}

pub async fn patch(path: String, body: Value) -> Result<Value, String> {
    send(reqwest::Method::PATCH, &with_game_mode(&path), Some(body)).await
}

pub async fn delete(path: String) -> Result<Value, String> {
    send(reqwest::Method::DELETE, &with_game_mode(&path), None).await
}

fn normalize_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty()
        || path.contains("://")
        || path.contains('\\')
        || path.contains("..")
        || path.chars().any(char::is_control)
    {
        return Err("请求路径无效".into());
    }
    if path.starts_with('/') {
        Ok(path.to_string())
    } else {
        Ok(format!("/{path}"))
    }
}

fn with_game_mode(path: &str) -> String {
    if !path.contains("/guides/tarkov") || path.contains("game_mode=") {
        return path.to_string();
    }
    if path.contains('?') {
        format!("{path}&game_mode={}", game_mode())
    } else {
        format!("{path}?game_mode={}", game_mode())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api_response(
        session: &Session,
        status: u16,
        path: &str,
        set_cookies: &[&str],
    ) -> ApiResponse {
        ApiResponse {
            generation: session.generation,
            credential_revision: session.credential_revision,
            path: path.into(),
            status: reqwest::StatusCode::from_u16(status).unwrap(),
            set_cookies: set_cookies.iter().map(|cookie| (*cookie).into()).collect(),
            text: String::new(),
        }
    }

    #[test]
    fn api_response_body_limit_rejects_overflow_without_appending() {
        let mut body = Vec::new();
        append_bounded_response_chunk(&mut body, b"four", 4).unwrap();
        assert_eq!(body, b"four");
        assert!(append_bounded_response_chunk(&mut body, b"!", 4).is_err());
        assert_eq!(body, b"four");
    }

    fn test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("zhange-session-{label}-{}", std::process::id()))
    }

    #[test]
    fn persisted_session_is_dpapi_encrypted_and_round_trips() {
        let root = test_dir("encrypted");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.json");
        let saved = SavedSession {
            token: "test-private-token-7231".into(),
            username: "tester".into(),
            cookies: HashMap::from([("zhange_access".into(), "test-private-token-7231".into())]),
            expires_at: Some(unix_now() + 3600),
        };

        persist_saved(&path, &saved).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(SESSION_MAGIC));
        assert!(!bytes
            .windows(saved.token.len())
            .any(|window| window == saved.token.as_bytes()));
        let plaintext = unprotect_data(bytes.strip_prefix(SESSION_MAGIC).unwrap()).unwrap();
        let restored: SavedSession = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(restored.token, saved.token);
        assert_eq!(restored.cookies, saved.cookies);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_session_write_replaces_old_contents() {
        let root = test_dir("atomic");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.json");

        atomic_write(&path, b"old-complete-data").unwrap();
        atomic_write(&path, b"new-complete-data").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new-complete-data");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn newest_login_attempt_can_replace_an_earlier_committed_login() {
        let mut current = Session::new();
        let starting_generation = current.generation;
        assert!(login_can_commit(2, 2, 0, &current, starting_generation));

        current.login_attempt = 1;
        current.generation = NEXT_SESSION_GENERATION.fetch_add(1, Ordering::Relaxed);
        assert!(login_can_commit(2, 2, 0, &current, starting_generation));
        assert!(!login_can_commit(1, 2, 0, &current, starting_generation));

        current.login_attempt = 0;
        assert!(!login_can_commit(2, 2, 0, &current, starting_generation));
    }

    #[test]
    fn authenticated_401_does_not_cancel_a_login_started_from_that_session() {
        let mut current = Session::new();
        current.token = "old-token".into();
        current
            .cookies
            .insert("zhange_access".into(), "old-token".into());
        let starting_generation = current.generation;
        let response = api_response(&current, 401, "/guides/tarkov/maps", &[]);
        let fresh = match response_session_effect(&current, &response) {
            ResponseSessionEffect::Invalidate(fresh) => fresh,
            _ => panic!("authenticated 401 should invalidate the old session"),
        };

        assert!(login_can_commit(3, 3, 3, &fresh, starting_generation));
        assert!(!login_can_commit(3, 3, 0, &fresh, starting_generation));
    }

    #[test]
    fn access_cookie_deletion_invalidates_an_existing_session() {
        let mut current = Session::new();
        current.token = "old-token".into();
        current.username = "tester".into();
        current
            .cookies
            .insert("zhange_access".into(), "old-token".into());
        current.cookies.insert("zhange_csrf".into(), "csrf".into());
        let old_generation = current.generation;
        let response = api_response(
            &current,
            200,
            "/guides/tarkov/raid-rooms",
            &["zhange_access=; Max-Age=0; Path=/"],
        );

        let fresh = match response_session_effect(&current, &response) {
            ResponseSessionEffect::Invalidate(fresh) => fresh,
            _ => panic!("access-cookie deletion should invalidate the session"),
        };
        assert_ne!(fresh.generation, old_generation);
        assert!(fresh.token.is_empty());
        assert!(fresh.username.is_empty());
        assert!(fresh.cookies.is_empty());
    }

    #[test]
    fn anonymous_401_keeps_generation_and_allows_pending_login_to_commit() {
        let current = Session::new();
        let starting_generation = current.generation;
        let response = api_response(&current, 401, "/guides/tarkov/maps", &[]);

        assert!(matches!(
            response_session_effect(&current, &response),
            ResponseSessionEffect::Ignore
        ));
        assert_eq!(current.generation, starting_generation);
        assert!(login_can_commit(1, 1, 0, &current, starting_generation));
    }

    #[test]
    fn access_cookie_rotation_updates_bearer_and_expiry() {
        let mut current = Session::new();
        current.token = "old-token".into();
        current
            .cookies
            .insert("zhange_access".into(), "old-token".into());
        current.expires_at = Some(unix_now() + 120);
        let old_request = SessionSnapshot::from(&current);

        assert!(apply_set_cookies(
            &mut current,
            &["zhange_access=new-token; Max-Age=600; Path=/".into()]
        ));
        assert_eq!(current.token, "new-token");
        assert_eq!(current.cookies.get("zhange_access").unwrap(), "new-token");
        assert!(current.expires_at.unwrap() > unix_now() + 590);
        assert!(!response_matches_snapshot(&current, &old_request));
    }
}

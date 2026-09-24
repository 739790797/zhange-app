use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const API: &str = "https://zhange.space/api";

struct Session {
    cookies: HashMap<String, String>,
    token: String,
    username: String,
    /// Unix 秒，与网页端 Cookie / JWT 的过期时间一致。
    expires_at: Option<i64>,
}

impl Session {
    fn new() -> Self {
        Self {
            cookies: HashMap::new(),
            token: String::new(),
            username: String::new(),
            expires_at: None,
        }
    }
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static GAME_MODE: Mutex<String> = Mutex::new(String::new());
static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

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
    let Ok(dir) = app.path().app_config_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let _ = CONFIG_DIR.set(dir);
    load_saved();
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

fn load_saved() {
    let Some(path) = session_file() else { return };
    let Ok(text) = fs::read_to_string(path) else { return };
    let Ok(saved) = serde_json::from_str::<SavedSession>(&text) else { return };
    if saved.token.is_empty() { return };
    if saved.expires_at.is_some_and(|exp| exp <= unix_now()) { return };
    let mut guard = session();
    let current = guard.as_mut().expect("session");
    current.token = saved.token;
    current.username = saved.username;
    current.cookies = saved.cookies;
    current.expires_at = saved.expires_at;
}

fn persist(session: &Session) {
    let Some(path) = session_file() else { return };
    if session.token.is_empty() {
        let _ = fs::remove_file(path);
        return;
    }
    let saved = SavedSession {
        token: session.token.clone(),
        username: session.username.clone(),
        cookies: session.cookies.clone(),
        expires_at: session.expires_at,
    };
    if let Ok(text) = serde_json::to_string(&saved) {
        let _ = fs::write(path, text);
    }
}

fn session() -> std::sync::MutexGuard<'static, Option<Session>> {
    let mut guard = SESSION.lock().expect("session");
    if guard.is_none() {
        *guard = Some(Session::new());
    }
    guard
}

pub fn set_game_mode(mode: &str) {
    let next = if mode.eq_ignore_ascii_case("pve") { "pve" } else { "pvp" };
    *GAME_MODE.lock().expect("game mode") = next.to_string();
}

fn game_mode() -> String {
    let guard = GAME_MODE.lock().expect("game mode");
    if *guard == "pve" { "pve".to_string() } else { "pvp".to_string() }
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
        .build()
        .map_err(|err| err.to_string())
}

async fn send(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let (cookies, csrf, token) = {
        let guard = session();
        let session = guard.as_ref().expect("session");
        (
            cookie_header(&session.cookies),
            session.cookies.get("zhange_csrf").cloned(),
            session.token.clone(),
        )
    };
    let path = normalize_path(path)?;
    let url = format!("{API}{path}");
    let mut request = client()?
        .request(method.clone(), &url)
        .header(reqwest::header::ACCEPT, "application/json");
    if !token.is_empty() {
        request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if !cookies.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookies);
    }
    if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
        if let Some(token) = csrf {
            request = request.header("X-CSRF-Token", token);
        }
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status();
    let set_cookies: Vec<String> = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();
    let text = response.text().await.map_err(|err| err.to_string())?;
    {
        let mut guard = session();
        let current = guard.as_mut().expect("session");
        apply_set_cookies(current, &set_cookies);
        if status.as_u16() == 401 && !path.contains("/auth/login") {
            *current = Session::new();
            persist(current);
        }
    }
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| value.get("detail").or_else(|| value.get("message")).cloned())
            .map(|detail| match detail {
                Value::String(text) => text,
                other => other.to_string(),
            })
            .unwrap_or_else(|| format!("请求失败 {status}"));
        return Err(detail);
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

pub async fn login(username: String, password: String) -> Result<SiteUser, String> {
    let name = username.trim().to_string();
    if name.is_empty() || password.is_empty() {
        return Err("请填写账号和密码".into());
    }
    let value = send(
        reqwest::Method::POST,
        "/auth/login",
        Some(serde_json::json!({ "username": name, "password": password })),
    )
    .await?;
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
    {
        let mut guard = session();
        let current = guard.as_mut().expect("session");
        current.token = token.clone();
        current.username = username.clone();
        current.cookies.entry("zhange_access".into()).or_insert(token.clone());
        if current.expires_at.is_none() {
            current.expires_at = jwt_expiry(&token).or_else(|| Some(unix_now() + 60 * 60 * 24));
        }
        persist(current);
    }
    Ok(SiteUser {
        logged_in: true,
        username,
    })
}

pub async fn logout() -> Result<(), String> {
    let _ = send(reqwest::Method::POST, "/auth/logout", Some(serde_json::json!({}))).await;
    let fresh = Session::new();
    persist(&fresh);
    *session() = Some(fresh);
    Ok(())
}

pub async fn restore() -> Result<SiteUser, String> {
    if !has_live_session() {
        clear_session();
        return Ok(logged_out());
    }
    match send(reqwest::Method::GET, "/auth/me", None).await {
        Ok(value) => {
            let username = value
                .get("username")
                .or_else(|| value.get("display_name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let mut guard = session();
            let current = guard.as_mut().expect("session");
            if !username.is_empty() {
                current.username = username.clone();
            }
            persist(current);
            Ok(SiteUser { logged_in: true, username: current.username.clone() })
        }
        Err(err) if err.contains("未登录") || err.contains("令牌无效") => Ok(logged_out()),
        Err(_) => {
            let guard = session();
            let current = guard.as_ref().expect("session");
            Ok(SiteUser { logged_in: true, username: current.username.clone() })
        }
    }
}

fn has_live_session() -> bool {
    let guard = session();
    let current = guard.as_ref().expect("session");
    if current.token.is_empty() {
        return false;
    }
    !current.expires_at.is_some_and(|exp| exp <= unix_now())
}

fn clear_session() {
    let fresh = Session::new();
    persist(&fresh);
    *session() = Some(fresh);
}

fn logged_out() -> SiteUser {
    SiteUser { logged_in: false, username: String::new() }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn jwt_expiry(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()
        .or_else(|| base64::engine::general_purpose::URL_SAFE.decode(payload).ok())?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.get("exp")?.as_i64()
}

fn apply_set_cookies(session: &mut Session, lines: &[String]) {
    let now = unix_now();
    for line in lines {
        let mut parts = line.split(';');
        let Some(pair) = parts.next() else { continue };
        let Some((key, value)) = pair.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() { continue };
        session.cookies.insert(key.to_string(), value.trim().to_string());
        let mut max_age = None;
        for attr in parts {
            let attr = attr.trim();
            if let Some(rest) = attr.strip_prefix("Max-Age=").or_else(|| attr.strip_prefix("max-age=")) {
                max_age = rest.parse::<i64>().ok();
            }
        }
        if key == "zhange_access" {
            if session.token.is_empty() {
                session.token = value.trim().to_string();
            }
            if let Some(age) = max_age {
                session.expires_at = Some(now + age);
            }
        }
    }
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

pub async fn delete(path: String) -> Result<Value, String> {
    send(reqwest::Method::DELETE, &with_game_mode(&path), None).await
}

fn normalize_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() || path.contains("://") || path.contains('\\') || path.contains("..") || path.chars().any(char::is_control) {
        return Err("请求路径无效".into());
    }
    if path.starts_with('/') { Ok(path.to_string()) } else { Ok(format!("/{path}")) }
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

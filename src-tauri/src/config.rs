use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

pub const DEFAULT_SITE: &str = "https://zhange.space";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub site: String,
    pub screenshots_dir: Option<String>,
    pub logs_dir: Option<String>,
    pub gamma: f64,
    pub brightness: f64,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            site: DEFAULT_SITE.to_string(),
            screenshots_dir: None,
            logs_dir: None,
            gamma: 1.3,
            brightness: 1.0,
        }
    }
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("config.json"))
}

pub fn load(app: &AppHandle) -> AppConfig {
    let Ok(path) = config_path(app) else {
        return AppConfig::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return AppConfig::default();
    };
    let mut cfg: AppConfig = serde_json::from_str(&text).unwrap_or_default();
    cfg.site = normalize_site(&cfg.site).unwrap_or_else(|_| DEFAULT_SITE.to_string());
    cfg.gamma = cfg.gamma.clamp(0.3, 3.0);
    cfg.brightness = cfg.brightness.clamp(0.2, 2.0);
    cfg
}

pub fn save(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(cfg).map_err(|err| err.to_string())?;
    fs::write(path, text).map_err(|err| err.to_string())
}

pub fn normalize_site(input: &str) -> Result<String, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("请填写站点地址".into());
    }
    let with_scheme = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| "站点地址无效".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("只支持 http 或 https".into());
    }
    let host = url.host_str().ok_or("站点地址缺少主机名")?;
    let origin = match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    };
    Ok(origin)
}

pub fn page_url(site: &str, path: &str) -> Result<String, String> {
    let origin = normalize_site(site)?;
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let mut url = format!("{origin}{path}");
    if url.contains("embed=assistant") {
        return Ok(url);
    }
    if url.contains('?') {
        url.push_str("&embed=assistant");
    } else {
        url.push_str("?embed=assistant");
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_host_becomes_https_origin() {
        assert_eq!(normalize_site("zhange.space").unwrap(), "https://zhange.space");
    }

    #[test]
    fn keeps_port_and_drops_path() {
        assert_eq!(
            normalize_site("http://127.0.0.1:5173/app").unwrap(),
            "http://127.0.0.1:5173"
        );
    }

    #[test]
    fn page_url_adds_embed_once() {
        assert_eq!(
            page_url("https://zhange.space", "/app").unwrap(),
            "https://zhange.space/app?embed=assistant"
        );
        assert_eq!(
            page_url("zhange.space", "/guides/tarkov?pane=search").unwrap(),
            "https://zhange.space/guides/tarkov?pane=search&embed=assistant"
        );
    }
}

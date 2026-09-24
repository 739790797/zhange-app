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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            site: DEFAULT_SITE.to_string(),
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
    let Ok(text) = fs::read_to_string(&path) else {
        let cfg = AppConfig::default();
        let _ = fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap_or_default());
        return cfg;
    };
    let mut cfg: AppConfig = serde_json::from_str(&text).unwrap_or_default();
    cfg.site = normalize_site(&cfg.site).unwrap_or_else(|_| DEFAULT_SITE.to_string());
    cfg
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
    match url.port() {
        Some(port) => Ok(format!("{}://{host}:{port}", url.scheme())),
        None => Ok(format!("{}://{host}", url.scheme())),
    }
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
}

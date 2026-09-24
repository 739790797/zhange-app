use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::site;

struct Slot {
    id: String,
    stop: watch::Sender<bool>,
}

static SLOT: Mutex<Option<Slot>> = Mutex::new(None);

pub fn watch(app: AppHandle, public_id: String) {
    let public_id = public_id.trim().to_string();
    if public_id.is_empty() {
        unwatch();
        return;
    }
    let mut guard = SLOT.lock().expect("room ws");
    if let Some(slot) = guard.as_ref() {
        if slot.id == public_id {
            return;
        }
        let _ = slot.stop.send(true);
    }
    let (stop, rx) = watch::channel(false);
    *guard = Some(Slot {
        id: public_id.clone(),
        stop,
    });
    drop(guard);
    tauri::async_runtime::spawn(async move {
        run(app, public_id, rx).await;
    });
}

pub fn unwatch() {
    if let Some(slot) = SLOT.lock().expect("room ws").take() {
        let _ = slot.stop.send(true);
    }
}

async fn run(app: AppHandle, public_id: String, mut stop: watch::Receiver<bool>) {
    let mut attempt = 0u32;
    loop {
        if *stop.borrow() {
            break;
        }
        let ended = connect(&app, &public_id, &mut stop).await;
        if *stop.borrow() {
            break;
        }
        let _ = app.emit("room-sync", json!({ "event": "closed", "error": ended.err() }));
        attempt = attempt.saturating_add(1);
        let delay = Duration::from_millis((400 * 2u64.pow(attempt.min(4))).min(8_000));
        tokio::select! {
            _ = stop.changed() => break,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

async fn connect(app: &AppHandle, public_id: &str, stop: &mut watch::Receiver<bool>) -> Result<(), String> {
    let token = site::access_token();
    if token.is_empty() {
        return Err("未登录".into());
    }
    let url = format!("wss://zhange.space/api/guides/tarkov/raid-rooms/{public_id}/ws");
    let (socket, _) = connect_async(url).await.map_err(|err| err.to_string())?;
    let (mut write, mut read) = socket.split();
    let auth = json!({ "event": "auth", "token": token }).to_string();
    write.send(Message::Text(auth.into())).await.map_err(|err| err.to_string())?;
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ping.tick().await;
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    let _ = write.send(Message::Close(None)).await;
                    return Ok(());
                }
            }
            _ = ping.tick() => {
                let _ = write.send(Message::Text(r#"{"event":"ping"}"#.into())).await;
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                            let _ = app.emit("room-sync", value);
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = write.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(err)) => return Err(err.to_string()),
                    _ => {}
                }
            }
        }
    }
}

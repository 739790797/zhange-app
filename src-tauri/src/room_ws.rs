use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::site;

const OUTGOING_CAPACITY: usize = 64;
const MAX_OUTGOING_BYTES: usize = 32 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);

async fn write_or_stop<S>(
    sink: &mut S,
    stop: &mut watch::Receiver<bool>,
    message: Message,
) -> Result<bool, String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    tokio::select! {
        changed = stop.changed() => {
            let _ = changed;
            Ok(false)
        }
        result = tokio::time::timeout(CONNECT_TIMEOUT, sink.send(message)) => match result {
            Ok(Ok(())) => Ok(true),
            Ok(Err(err)) => Err(err.to_string()),
            Err(_) => Err("房间消息发送超时".into()),
        }
    }
}

struct Slot {
    id: String,
    generation: u64,
    instance: u64,
    stop: watch::Sender<bool>,
    out: mpsc::Sender<String>,
    active: Arc<AtomicBool>,
}

static SLOT: Mutex<Option<Slot>> = Mutex::new(None);
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);

pub fn watch(app: AppHandle, public_id: String) -> Result<u64, String> {
    let public_id = normalize_public_id(&public_id)?;
    let mut guard = SLOT.lock().expect("room ws");
    if let Some(slot) = guard.as_ref() {
        if slot.id == public_id {
            return Ok(slot.generation);
        }
        let _ = slot.stop.send(true);
    }
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
    let (stop, rx) = watch::channel(false);
    let (out, out_rx) = mpsc::channel(OUTGOING_CAPACITY);
    let active = Arc::new(AtomicBool::new(false));
    *guard = Some(Slot {
        id: public_id.clone(),
        generation,
        instance,
        stop,
        out,
        active: active.clone(),
    });
    drop(guard);
    tauri::async_runtime::spawn(async move {
        run(app, public_id, generation, instance, rx, out_rx, active).await;
    });
    Ok(generation)
}

pub fn refresh_auth(app: AppHandle) {
    let mut guard = SLOT.lock().expect("room ws");
    let Some(current) = guard.as_ref() else {
        return;
    };
    let id = current.id.clone();
    let generation = current.generation;
    let _ = current.stop.send(true);

    let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
    let (stop, rx) = watch::channel(false);
    let (out, out_rx) = mpsc::channel(OUTGOING_CAPACITY);
    let active = Arc::new(AtomicBool::new(false));
    *guard = Some(Slot {
        id: id.clone(),
        generation,
        instance,
        stop,
        out,
        active: active.clone(),
    });
    drop(guard);

    tauri::async_runtime::spawn(async move {
        run(app, id, generation, instance, rx, out_rx, active).await;
    });
}

fn normalize_public_id(value: &str) -> Result<String, String> {
    let id = value.trim().to_ascii_lowercase();
    let legacy = matches!(
        id.as_str(),
        "1" | "2" | "3" | "4" | "5" | "pve-1" | "pve-2" | "pve-3" | "pve-4" | "pve-5"
    );
    let generated = (8..=16).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if legacy || generated {
        Ok(id)
    } else {
        Err("房间编号格式无效".into())
    }
}

fn emit_if_current(app: &AppHandle, generation: u64, instance: u64, mut value: Value) {
    let guard = SLOT.lock().expect("room ws");
    let current = guard.as_ref().map(|slot| (slot.generation, slot.instance));
    if !slot_is_current(current, generation, instance) {
        return;
    }
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.insert("connection_generation".into(), json!(generation));
    let _ = app.emit("room-sync", value);
}

pub fn send(text: String) -> Result<(), String> {
    let guard = SLOT.lock().expect("room ws");
    let Some(slot) = guard.as_ref() else {
        return Err("房间未连接".into());
    };
    if !slot.active.load(Ordering::Acquire) {
        return Err("房间未连接".into());
    }
    let text = validate_outgoing_message(&text)?;
    slot.out.try_send(text).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => "房间消息队列已满".to_string(),
        mpsc::error::TrySendError::Closed(_) => "房间未连接".to_string(),
    })
}

fn validate_outgoing_message(text: &str) -> Result<String, String> {
    if text.len() > MAX_OUTGOING_BYTES {
        return Err("房间消息过大".into());
    }
    let value: Value = serde_json::from_str(text).map_err(|_| "房间消息格式无效".to_string())?;
    let body = value
        .as_object()
        .ok_or_else(|| "房间消息格式无效".to_string())?;
    let event = body
        .get("event")
        .and_then(Value::as_str)
        .ok_or_else(|| "房间消息类型无效".to_string())?;
    let mut clean = Map::new();
    clean.insert("event".into(), Value::String(event.to_string()));

    match event {
        "view_map" => {
            let map_id = checked_map_id(body.get("map_id"))?;
            clean.insert("map_id".into(), Value::String(map_id));
        }
        "player_fix" => {
            for key in ["x", "y", "z"] {
                let number = checked_coordinate(body.get(key))?;
                clean.insert(key.into(), json!(number));
            }
            let yaw = match body.get("yaw") {
                None | Some(Value::Null) => Value::Null,
                Some(value) => json!(checked_finite_number(Some(value))?),
            };
            clean.insert("yaw".into(), yaw);
            let map_id = checked_map_id(body.get("map_id"))?;
            clean.insert("map_id".into(), Value::String(map_id));
            let file_name = body
                .get("file_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if file_name.chars().count() > 200
                || file_name
                    .chars()
                    .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
            {
                return Err("截图文件名无效".into());
            }
            clean.insert("file_name".into(), Value::String(file_name.to_string()));
        }
        "log_phase" => {
            let kind = checked_bounded_string(body.get("kind"), 32, false)?;
            if !matches!(
                kind.as_str(),
                "map_loading"
                    | "matching"
                    | "match_found"
                    | "raid_starting"
                    | "raid_started"
                    | "matching_aborted"
                    | "raid_exited"
            ) {
                return Err("战局阶段无效".into());
            }
            clean.insert("kind".into(), Value::String(kind));
            clean.insert(
                "map_id".into(),
                Value::String(checked_map_id_optional(body.get("map_id"))?),
            );
            clean.insert(
                "map_label".into(),
                Value::String(checked_bounded_string(body.get("map_label"), 32, true)?),
            );
            let raid_id = checked_bounded_string(body.get("raid_id"), 16, true)?;
            if !raid_id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                return Err("战局编号无效".into());
            }
            clean.insert("raid_id".into(), Value::String(raid_id));
            clean.insert(
                "at".into(),
                Value::String(checked_bounded_string(body.get("at"), 32, true)?),
            );
        }
        _ => return Err("不支持的房间消息类型".into()),
    }

    serde_json::to_string(&Value::Object(clean)).map_err(|_| "房间消息格式无效".to_string())
}

fn checked_finite_number(value: Option<&Value>) -> Result<f64, String> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| "房间坐标无效".into())
}

fn checked_coordinate(value: Option<&Value>) -> Result<f64, String> {
    checked_finite_number(value).and_then(|number| {
        if (-20_000.0..=20_000.0).contains(&number) {
            Ok(number)
        } else {
            Err("房间坐标无效".into())
        }
    })
}

fn checked_map_id(value: Option<&Value>) -> Result<String, String> {
    checked_map_id_optional(value).and_then(|map_id| {
        if map_id.is_empty() {
            Err("地图编号无效".into())
        } else {
            Ok(map_id)
        }
    })
}

fn checked_map_id_optional(value: Option<&Value>) -> Result<String, String> {
    let raw = value
        .and_then(Value::as_str)
        .ok_or_else(|| "地图编号无效".to_string())?;
    let map_id = raw.trim().to_ascii_lowercase();
    let bytes = map_id.as_bytes();
    if map_id.is_empty() {
        return Ok(map_id);
    }
    if bytes.len() > 63
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
    {
        return Err("地图编号无效".into());
    }
    Ok(map_id)
}

fn checked_bounded_string(
    value: Option<&Value>,
    max_chars: usize,
    allow_empty: bool,
) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| "房间消息字段无效".to_string())?
        .trim();
    if (!allow_empty && text.is_empty())
        || text.chars().count() > max_chars
        || text.chars().any(char::is_control)
    {
        return Err("房间消息字段无效".into());
    }
    Ok(text.to_string())
}

pub fn unwatch() {
    unwatch_generation(None);
}

pub fn unwatch_generation(generation: Option<u64>) {
    let mut guard = SLOT.lock().expect("room ws");
    if generation.map_or(false, |expected| {
        guard
            .as_ref()
            .map_or(true, |slot| slot.generation != expected)
    }) {
        return;
    }
    let slot = guard.take();
    drop(guard);
    if let Some(slot) = slot {
        let _ = slot.stop.send(true);
    }
}

async fn run(
    app: AppHandle,
    public_id: String,
    generation: u64,
    instance: u64,
    mut stop: watch::Receiver<bool>,
    mut out: mpsc::Receiver<String>,
    active: Arc<AtomicBool>,
) {
    let mut attempt = 0u32;
    loop {
        if *stop.borrow() {
            emit_if_current(
                &app,
                generation,
                instance,
                json!({ "event": "closed", "public_id": public_id.clone() }),
            );
            break;
        }
        let ended = connect(
            &app, &public_id, generation, instance, &mut stop, &mut out, &active,
        )
        .await;
        active.store(false, Ordering::Release);
        while out.try_recv().is_ok() {}
        if *stop.borrow() {
            emit_if_current(
                &app,
                generation,
                instance,
                json!({ "event": "closed", "public_id": public_id.clone() }),
            );
            break;
        }
        emit_if_current(
            &app,
            generation,
            instance,
            json!({ "event": "closed", "public_id": public_id.clone(), "error": ended.err() }),
        );
        attempt = attempt.saturating_add(1);
        let delay = Duration::from_millis((400 * 2u64.pow(attempt.min(4))).min(8_000));
        tokio::select! {
            _ = stop.changed() => break,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

async fn connect(
    app: &AppHandle,
    public_id: &str,
    generation: u64,
    instance: u64,
    stop: &mut watch::Receiver<bool>,
    out: &mut mpsc::Receiver<String>,
    active: &AtomicBool,
) -> Result<(), String> {
    let token = site::access_token();
    if token.is_empty() {
        return Err("未登录".into());
    }
    let url = format!("wss://zhange.space/api/guides/tarkov/raid-rooms/{public_id}/ws");
    let result = tokio::select! {
        _ = stop.changed() => return Ok(()),
        result = tokio::time::timeout(CONNECT_TIMEOUT, connect_async(url)) => result,
    };
    let (socket, _) = match result {
        Ok(Ok(socket)) => socket,
        Ok(Err(err)) => return Err(err.to_string()),
        Err(_) => return Err("房间连接超时".into()),
    };
    let (mut write, mut read) = socket.split();
    let auth = json!({ "event": "auth", "token": token, "client": "desktop" }).to_string();
    if !write_or_stop(&mut write, stop, Message::Text(auth.into())).await? {
        return Ok(());
    }
    active.store(true, Ordering::Release);
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    ping.tick().await;
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    let _ = tokio::time::timeout(Duration::from_millis(200), write.send(Message::Close(None))).await;
                    return Ok(());
                }
            }
            _ = ping.tick() => {
                if !write_or_stop(&mut write, stop, Message::Text(r#"{"event":"ping"}"#.into())).await? {
                    return Ok(());
                }
            }
            outgoing = out.recv() => {
                let Some(text) = outgoing else { return Ok(()) };
                if !write_or_stop(&mut write, stop, Message::Text(text.into())).await? {
                    return Ok(());
                }
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if *stop.borrow() {
                            return Ok(());
                        }
                        if let Ok(mut value) = serde_json::from_str::<Value>(text.as_str()) {
                            if let Some(object) = value.as_object_mut() {
                                object.entry("public_id").or_insert_with(|| Value::String(public_id.to_string()));
                            }
                            emit_if_current(app, generation, instance, value);
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if !write_or_stop(&mut write, stop, Message::Pong(data)).await? {
                            return Ok(());
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(err)) => return Err(err.to_string()),
                    _ => {}
                }
            }
        }
    }
}

fn slot_is_current(slot: Option<(u64, u64)>, generation: u64, instance: u64) -> bool {
    slot.is_some_and(|(current_generation, current_instance)| {
        current_generation == generation && current_instance == instance
    })
}

#[cfg(test)]
mod tests {
    use super::{normalize_public_id, slot_is_current, validate_outgoing_message};
    use serde_json::Value;

    #[test]
    fn accepts_supported_room_id_shapes_and_normalizes_case() {
        for id in [
            "1",
            "5",
            "pve-2",
            "abcdef12",
            "0123456789abcdef",
            "ABCDEF12",
        ] {
            assert!(normalize_public_id(id).is_ok(), "{id}");
        }
    }

    #[test]
    fn rejects_room_ids_that_can_change_the_websocket_path() {
        for id in [
            "",
            "6",
            "pve-6",
            "abcdefg",
            "abcdefghijklmnopq",
            "room/other",
            "room?x=1",
            "room#fragment",
            "../room",
            "房间1234",
        ] {
            assert!(normalize_public_id(id).is_err(), "{id}");
        }
    }

    #[test]
    fn auth_refresh_keeps_room_generation_but_rejects_the_old_socket_instance() {
        assert!(slot_is_current(Some((8, 12)), 8, 12));
        assert!(!slot_is_current(Some((8, 13)), 8, 12));
        assert!(!slot_is_current(Some((9, 12)), 8, 12));
        assert!(!slot_is_current(None, 8, 12));
    }

    #[test]
    fn room_messages_are_reduced_to_the_supported_schema() {
        let clean = validate_outgoing_message(
            r#"{"event":"view_map","map_id":"Customs","token":"secret","path":"C:\\private"}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&clean).unwrap();
        assert_eq!(value["event"], "view_map");
        assert_eq!(value["map_id"], "customs");
        assert!(value.get("token").is_none());
        assert!(value.get("path").is_none());
    }

    #[test]
    fn rejects_unknown_events_invalid_coordinates_and_local_paths() {
        assert!(validate_outgoing_message(r#"{"event":"delete_room"}"#).is_err());
        assert!(validate_outgoing_message(
            r#"{"event":"player_fix","x":20001,"y":2,"z":3,"map_id":"woods"}"#
        )
        .is_err());
        assert!(validate_outgoing_message(
            r#"{"event":"player_fix","x":1,"y":2,"z":3,"map_id":"woods","file_name":"C:\\private\\shot.png"}"#
        )
        .is_err());
    }

    #[test]
    fn accepts_only_known_bounded_log_phases() {
        let clean = validate_outgoing_message(
            r#"{"event":"log_phase","kind":"raid_started","map_id":"customs","map_label":"","raid_id":"ABC123","at":"2026-10-28T10:00:00Z"}"#,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&clean).unwrap();
        assert_eq!(value["kind"], "raid_started");
        assert!(validate_outgoing_message(
            r#"{"event":"log_phase","kind":"unknown","map_id":"customs","map_label":"","raid_id":"","at":""}"#
        )
        .is_err());
    }
}

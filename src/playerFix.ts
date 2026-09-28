import { listen } from "@tauri-apps/api/event";
import { currentMapSlug, onLiveMapReady, setPlayerMarks, setPulseLines, setShotNote, type PlayerMark } from "./liveMap";

const FRESH_MS = 8 * 60_000;
const PULSE_MS = 3_000;
const AUTO_PHASE = new Set(["map_loading", "matching", "match_found", "raid_starting", "raid_started"]);
const COLORS = ["#e8c36a", "#6cb6ff", "#6fbf4a", "#e08a2c", "#d44a4a", "#c77dff", "#4ab8b8", "#f0a3c2"];
const aliases: Record<string, string> = {
  lab: "the-lab",
  streets: "streets-of-tarkov",
  labyrinth: "the-labyrinth",
  "factory-night": "night-factory",
};

type ShotState = {
  bound: boolean;
  missing: boolean;
  fileName: string;
  modifiedMs: number;
  x: number | null;
  y: number | null;
  z: number | null;
  yaw: number | null;
};

type RemoteFix = {
  userId: number;
  x: number;
  y: number;
  z: number;
  yaw: number | null;
  mapId: string;
  fileName: string;
  at: number;
};

type LocalFix = {
  x: number;
  y: number;
  z: number;
  yaw: number | null;
  fileName: string;
  at: number;
};

let started = false;
let selfId = 0;
let selfName = "我";
let roomReady = false;
let logSlug = "";
let phaseKind = "";
let raidId = "";
let syncEnabled = true;
let hotkeyLabel = "Print Screen";
let seated = new Set<number>();
let shot: ShotState | null = null;
let local: LocalFix | null = null;
let sentSig = "";
let followed = "";
let flew = false;
const seenFix = new Map<number, string>();
let pulsePrimed = false;
type Pulse = { key: string; x1: number; z1: number; x2: number; z2: number; color: string; bornAt: number };
let pulses: Pulse[] = [];
let phaseSig = "";
const people = new Map<number, string>();
const remote = new Map<number, RemoteFix>();

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function overlayWindow() {
  const view = new URLSearchParams(location.search).get("view");
  return view === "overlay" || view === "raid";
}

function canon(slug: string) {
  const key = slug.trim();
  return aliases[key] || key;
}

function sameMap(left: string, right: string) {
  if (!left || !right) return false;
  return canon(left) === canon(right) || left === right;
}

function fresh(at: number, now = Date.now()) {
  return at > 0 && now - at <= FRESH_MS;
}

function finite(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function colorFor(userId: number) {
  const index = Math.abs(userId) % COLORS.length;
  return COLORS[index] || COLORS[0];
}

function raidMap() {
  return logSlug;
}

function suppressed() {
  const view = currentMapSlug();
  const logged = raidMap();
  if (!AUTO_PHASE.has(phaseKind) || !logged || !view) return false;
  return !sameMap(logged, view);
}

function localUsable() {
  if (!local || !fresh(local.at)) return false;
  return !suppressed();
}

function paint(follow = false) {
  const view = currentMapSlug();
  const marks: PlayerMark[] = [];
  for (const row of remote.values()) {
    if (!fresh(row.at)) continue;
    if (selfId && row.userId === selfId) continue;
    if (row.mapId && view && !sameMap(row.mapId, view)) continue;
    if (!row.mapId && !view) continue;
    marks.push({
      key: `user:${row.userId}`,
      userId: row.userId,
      name: people.get(row.userId) || "队友",
      color: colorFor(row.userId),
      x: row.x,
      y: row.y,
      z: row.z,
      yaw: row.yaw,
      self: false,
    });
  }
  const mine = localUsable() ? local : null;
  const sig = mine && view ? `${mine.fileName}:${mine.at}:${view}` : "";
  const jump = Boolean(sig && (follow || sig !== followed));
  const first = jump && !flew;
  if (jump) flew = true;
  if (!sig) flew = false;
  if (sig) followed = sig;
  const mode: false | "fly" | "pan" = !jump ? false : first ? "fly" : "pan";
  if (mine) {
    marks.push({
      key: "self",
      userId: selfId,
      name: selfName,
      color: "#7CFF6B",
      x: mine.x,
      y: mine.y,
      z: mine.z,
      yaw: mine.yaw,
      self: true,
    });
  }
  setPlayerMarks(marks, mode);
  notePulse(marks);
  setShotNote(note(Boolean(mine)));
}

function notePulse(marks: PlayerMark[]) {
  const next = new Map<number, string>();
  for (const mark of marks) {
    if (mark.userId > 0) next.set(mark.userId, `${mark.userId}:${mark.x}:${mark.y}:${mark.z}`);
  }
  if (!pulsePrimed) {
    pulsePrimed = true;
    for (const [id, identity] of next) seenFix.set(id, identity);
    return;
  }
  if (seated.size < 2 || selfId <= 0) return;
  const self = marks.find((mark) => mark.userId === selfId);
  if (!self) return;
  const now = Date.now();
  for (const [userId, identity] of next) {
    if (userId === selfId || seenFix.get(userId) === identity) continue;
    seenFix.set(userId, identity);
    const other = marks.find((mark) => mark.userId === userId);
    if (!other) continue;
    pulses = pulses.filter((line) => !line.key.startsWith(`${userId}:`));
    pulses.push({
      key: `${userId}:${now}`,
      x1: self.x,
      z1: self.z,
      x2: other.x,
      z2: other.z,
      color: other.color,
      bornAt: now,
    });
  }
  for (const [id, identity] of next) seenFix.set(id, identity);
}

function note(showing: boolean) {
  if (!shot?.bound) return "先在妙妙工具的目录绑定里设定截图目录";
  if (shot.missing) return "截图目录不存在，请重新绑定";
  if (showing) return roomReady ? "正在把你的位置同步到房间" : "位置已标在这张图上";
  if (!syncEnabled) return "截图同步已关闭";
  if (suppressed()) return "这场战局在另一张图上，位置不会标在这里";
  if (shot.fileName && shot.x == null) return `截图无坐标，请在战局里用 ${hotkeyLabel}`;
  if (shot.fileName && shot.x != null && !fresh(shot.modifiedMs)) return "最近一张截图已过期，请在战局里再截一次";
  return `战局里按 ${hotkeyLabel}，位置会同步到房间`;
}

function applyShot(next: ShotState, follow: boolean) {
  shot = next;
  const x = finite(next.x);
  const y = finite(next.y);
  const z = finite(next.z);
  if (x != null && y != null && z != null && fresh(next.modifiedMs)) {
    const yaw = finite(next.yaw);
    const changed = !local || local.fileName !== next.fileName || local.at !== next.modifiedMs;
    local = { x, y, z, yaw, fileName: next.fileName, at: next.modifiedMs };
    paint(follow && changed);
    if (changed || follow) void publish();
    return;
  }
  if (local && !fresh(local.at)) local = null;
  paint();
}

async function publish() {
  if (overlayWindow() || !roomReady || !localUsable() || !local) return;
  const mapId = raidMap();
  if (!mapId) return;
  const sig = `${local.fileName}:${local.at}:${mapId}`;
  if (sentSig === sig) return;
  sentSig = sig;
  try {
    await invoke("room_send", {
      body: {
        event: "player_fix",
        x: local.x,
        y: local.y,
        z: local.z,
        yaw: local.yaw,
        map_id: mapId,
        file_name: local.fileName,
      },
    });
  } catch {
    sentSig = "";
  }
}

function readFix(raw: Record<string, unknown>, fallbackAt = Date.now()): RemoteFix | null {
  const userId = Number(raw.user_id || raw.userId || 0);
  const x = finite(raw.x);
  const y = finite(raw.y);
  const z = finite(raw.z);
  if (!userId || x == null || y == null || z == null) return null;
  const yawRaw = raw.yaw;
  const yaw = yawRaw == null || yawRaw === "" ? null : finite(yawRaw);
  if (yawRaw != null && yawRaw !== "" && yaw == null) return null;
  const at = Number(raw.at);
  return {
    userId,
    x,
    y,
    z,
    yaw,
    mapId: String(raw.map_id || raw.mapId || "").trim(),
    fileName: String(raw.file_name || raw.fileName || "").trim(),
    at: Number.isFinite(at) && at > 0 ? at : fallbackAt,
  };
}

function takeFix(row: RemoteFix) {
  if (local && row.fileName && row.fileName === local.fileName) selfId = row.userId;
  remote.set(row.userId, row);
}

function takeMembers(raw: unknown) {
  if (!Array.isArray(raw)) return;
  const nextSeated = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const userId = Number(row.user_id || row.userId || 0);
    const name = String(row.display_name || row.displayName || row.name || "").trim();
    if (!userId) continue;
    if (row.in_room !== false && row.inRoom !== false) nextSeated.add(userId);
    if (!name) continue;
    people.set(userId, name);
    if (selfId && userId === selfId) selfName = name;
  }
  if (nextSeated.size) seated = nextSeated;
}

async function publishPhase() {
  if (overlayWindow() || !roomReady || !phaseKind) return;
  const mapId = raidMap();
  const sig = `${phaseKind}:${raidId}:${mapId}`;
  if (phaseSig === sig) return;
  phaseSig = sig;
  try {
    await invoke("room_send", {
      body: {
        event: "log_phase",
        kind: phaseKind,
        map_id: mapId,
        map_label: "",
        raid_id: raidId,
        at: new Date().toISOString(),
      },
    });
  } catch {
    phaseSig = "";
  }
}

function onRoom(payload: Record<string, unknown>) {
  const event = String(payload.event || "");
  if (event === "closed") {
    roomReady = false;
    sentSig = "";
    paint();
    return;
  }
  const snap = payload.snapshot && typeof payload.snapshot === "object"
    ? payload.snapshot as Record<string, unknown>
    : null;
  if (snap) {
    roomReady = true;
    takeMembers(snap.members);
    if (Array.isArray(payload.player_fixes)) {
      for (const row of payload.player_fixes) {
        if (!row || typeof row !== "object") continue;
        const parsed = readFix(row as Record<string, unknown>);
        if (parsed) takeFix(parsed);
      }
    }
    paint();
    void publish();
    return;
  }
  if (event === "player_fix") {
    const parsed = readFix(payload);
    if (!parsed) return;
    takeFix(parsed);
    paint();
  }
}

export function startPlayerSync() {
  if (started) return;
  started = true;
  onLiveMapReady(() => {
    sentSig = "";
    followed = "";
    flew = false;
    paint();
    void publish();
  });
  void listen<ShotState>("shot-fix", (event) => applyShot(event.payload, true)).catch(() => undefined);
  void listen<Record<string, unknown>>("room-sync", (event) => onRoom(event.payload)).catch(() => undefined);
  void listen<{ kind?: string; slug?: string; phase?: string; raidId?: string }>("log-watch", (event) => {
    const kind = event.payload.kind || "";
    if (kind === "map" && event.payload.slug) logSlug = event.payload.slug;
    if (kind === "phase") {
      phaseKind = event.payload.phase || "";
      if (event.payload.slug) logSlug = event.payload.slug;
      if (event.payload.raidId) raidId = event.payload.raidId;
      void publishPhase();
      if (phaseKind === "raid_exited" || phaseKind === "matching_aborted") logSlug = "";
    }
    if (kind === "raid-end") {
      phaseKind = "raid_exited";
      void publishPhase();
      logSlug = "";
    }
    paint();
  }).catch(() => undefined);
  void invoke<ShotState>("shot_state").then((snap) => applyShot(snap, false)).catch(() => undefined);
  void invoke<{ slug?: string; phase?: string; raidId?: string }>("log_state").then((snap) => {
    logSlug = snap.slug || "";
    if (snap.phase) phaseKind = snap.phase;
    if (phaseKind === "raid_exited" || phaseKind === "matching_aborted") logSlug = "";
    if (snap.raidId) raidId = snap.raidId;
    paint();
    void publishPhase();
  }).catch(() => undefined);
  const applySettings = (row: { hotkey?: string; syncEnabled?: boolean }) => {
    hotkeyLabel = row.hotkey === "PrintScreen" || !row.hotkey ? "Print Screen" : row.hotkey;
    syncEnabled = row.syncEnabled !== false;
    paint();
  };
  void invoke<{ hotkey?: string; syncEnabled?: boolean }>("shot_settings_get").then(applySettings).catch(() => undefined);
  window.addEventListener("zhange-shot-settings", (event) => {
    applySettings((event as CustomEvent<{ hotkey?: string; syncEnabled?: boolean }>).detail || {});
  });
  void invoke<{ id?: number; display_name?: string; username?: string }>("site_get", { path: "/auth/me" }).then((me) => {
    selfId = Number(me?.id || 0);
    selfName = me?.display_name || me?.username || selfName;
    paint();
  }).catch(() => undefined);
  window.setInterval(() => {
    if (local && !fresh(local.at)) local = null;
    paint();
  }, 30_000);
  window.setInterval(() => {
    const now = Date.now();
    const live = pulses.filter((line) => now - line.bornAt < PULSE_MS);
    if (live.length === pulses.length && !live.length) return;
    pulses = live;
    setPulseLines(live.map((line) => ({
      x1: line.x1,
      z1: line.z1,
      x2: line.x2,
      z2: line.z2,
      color: line.color,
      opacity: 1 - (now - line.bornAt) / PULSE_MS,
    })));
  }, 100);
}

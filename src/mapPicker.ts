import { invoke } from "./tauriBridge";
import { colorForUserId } from "./questOverlay";
import { goonHint, goonSlug } from "./goon";
import { findMap, mapTitle, sameMap } from "./mapNames";
import { isPending, spin } from "./spinner";
import {
  exponentialBackoffMs,
  roomTaskProgressMode,
  serializeTaskProgress,
  taskProgressPath,
  type TaskGameMode,
} from "./taskProgressQueue";

type MapPick = { slug: string; name: string; thumbLink: string };
type Member = { userId: number; name: string; host: boolean; online: boolean };
type Phase = { userId: number; kind: string; mapId: string };
type Seat = "raid" | "matching" | "watch";
type Person = Member & { seat: Seat };
type Board = { lobby: Member[]; matching: Member[]; maps: { mapId: string; people: Person[] }[] };

let note = "正在读取房间";
let members: Member[] = [];
let phases: Phase[] = [];
let phaseRoomId = "";
let loadedRoomId = "";
let lastOnline: Set<number> | null = null;
let socketLive = false;
let socketDisconnected = false;
let viewerId = 0;
let localKind = "";
let localMapId = "";
let localWatch = "";
let viewByUser = new Map<number, string>();
let ready = false;
let loadFailed = false;
let canPick = true;
let currentSlug = "";
let shownMaps: MapPick[] = [];
let generation = 0;
let inflight: Promise<Record<string, unknown> | null> | null = null;
let activeRoomId = "";
let loadingRoomId = "";
let socketRevision = 0;
let socketEpoch = 0;
let socketSnapshot: {
  roomId: string;
  value: Record<string, unknown>;
  revision: number;
  epoch: number;
} | null = null;
let socketViews: Map<number, string> | null = null;
let socketViewsRevision = 0;
let socketViewsEpoch = 0;
let socketViewEvents = new Map<number, { slug: string; revision: number; epoch: number }>();
let localViewOverrides = new Map<number, string>();
let pendingRoomProgressSync: { roomId: string; generation: number; mode: TaskGameMode } | null =
  null;
let roomProgressSyncRunning = false;
let roomProgressRetryTimer = 0;
let roomProgressRetryAttempt = 0;
let roomProgressSyncFailed = false;
let activeRoomGameMode: TaskGameMode | null = null;

function roomProgressRequestIsCurrent(request: {
  roomId: string;
  generation: number;
  mode: TaskGameMode;
}) {
  return (
    request.generation === generation &&
    activeRoomId === request.roomId &&
    ready &&
    canPick &&
    (activeRoomGameMode ? activeRoomGameMode === request.mode : selectedGameMode() === request.mode)
  );
}

function setRoomProgressSyncFailed(failed: boolean) {
  if (roomProgressSyncFailed === failed) return;
  roomProgressSyncFailed = failed;
  const board = document.querySelector<HTMLElement>(".map-pick");
  if (!board) return;
  let note = board.querySelector<HTMLElement>("[data-room-progress-sync]");
  if (!failed) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement("p");
    note.dataset.roomProgressSync = "true";
    note.className = "map-pick-sync";
    note.setAttribute("role", "status");
    note.textContent = "队伍任务进度同步暂时失败，网络恢复后会自动重试。";
    board.append(note);
  }
}

function clearRoomProgressRetry(resetAttempt = true) {
  window.clearTimeout(roomProgressRetryTimer);
  roomProgressRetryTimer = 0;
  if (resetAttempt) roomProgressRetryAttempt = 0;
}

function esc(value: string) {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch,
  );
}

function rec(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function unwrapRoom(value: unknown): Record<string, unknown> | null {
  const row = rec(value);
  if (!row) return null;
  if (row.public_id || row.publicId) return row;
  const inner = rec(row.item ?? row.room ?? row.mine);
  if (inner && (inner.public_id || inner.publicId)) return inner;
  return null;
}

function memberOf(row: Record<string, unknown>): Member | null {
  const userId = Number(row.user_id || row.userId || 0);
  if (!userId) return null;
  const name =
    String(row.display_name || row.displayName || row.name || "").trim() || `用户${userId}`;
  return {
    userId,
    name,
    host: Boolean(row.is_host || row.isHost),
    online: Boolean(row.online),
  };
}

function peopleOf(raw: Record<string, unknown> | null): Member[] {
  if (!raw) return [];
  const membersRaw = Array.isArray(raw.members) ? raw.members : [];
  const occupants = Array.isArray(raw.occupants) ? raw.occupants : [];
  const inRoom = membersRaw.filter((item) => {
    const row = rec(item);
    return row ? row.in_room !== false && row.inRoom !== false : false;
  });
  const source = inRoom.length ? inRoom : occupants;
  const people = source.flatMap((item) => {
    const row = rec(item);
    return row ? [memberOf(row)].filter((person): person is Member => Boolean(person)) : [];
  });
  const onlineIds = lastOnline;
  if (!onlineIds) return people;
  return people.map((person) => ({ ...person, online: onlineIds.has(person.userId) }));
}

function isMember(raw: Record<string, unknown>) {
  if ("is_member" in raw) return Boolean(raw.is_member);
  if ("isMember" in raw) return Boolean(raw.isMember);
  return true;
}

function viewRows(raw: Record<string, unknown>) {
  return Array.isArray(raw.view_maps)
    ? raw.view_maps
    : Array.isArray(raw.viewMaps)
      ? raw.viewMaps
      : null;
}

function readViews(raw: Record<string, unknown>) {
  const rows = viewRows(raw);
  const next = new Map<number, string>();
  if (!rows) return next;
  for (const item of rows) {
    const row = rec(item);
    if (!row) continue;
    const userId = Number(row.user_id || row.userId || 0);
    const slug = String(row.map_slug || row.mapSlug || "").trim();
    if (userId > 0 && slug) next.set(userId, slug);
  }
  return next;
}

function mergeViewLayers(base: Map<number, string>, afterRevision = 0) {
  const next = new Map(base);
  for (const [userId, event] of socketViewEvents) {
    if (
      event.epoch === socketEpoch &&
      event.revision > socketViewsRevision &&
      event.revision > afterRevision
    )
      next.set(userId, event.slug);
  }
  for (const [userId, slug] of localViewOverrides) {
    const serverSlug = next.get(userId) || "";
    if (serverSlug && sameMap(serverSlug, slug)) {
      localViewOverrides.delete(userId);
    } else {
      next.set(userId, slug);
    }
  }
  viewByUser = next;
}

function takeViews(
  raw: Record<string, unknown>,
  fromSocket = false,
  revision = 0,
  afterRevision = 0,
) {
  const rows = viewRows(raw);
  if (fromSocket && !rows) return;
  const next = rows ? readViews(raw) : new Map(viewByUser);
  if (fromSocket) {
    socketViews = new Map(next);
    socketViewsRevision = revision;
    socketViewsEpoch = socketEpoch;
  }
  const useNewerSocketSnapshot =
    !fromSocket &&
    !socketDisconnected &&
    socketViews &&
    socketViewsEpoch === socketEpoch &&
    socketViewsRevision > afterRevision;
  const base = useNewerSocketSnapshot ? new Map(socketViews) : next;
  mergeViewLayers(base, afterRevision);
}

function parsePhases(raw: unknown): Phase[] {
  if (!Array.isArray(raw)) return [];
  const out: Phase[] = [];
  for (const item of raw) {
    const row = rec(item);
    if (!row) continue;
    const userId = Number(row.user_id ?? row.userId);
    const kind = String(row.kind || "").trim();
    if (!Number.isFinite(userId) || userId <= 0 || !kind) continue;
    out.push({ userId, kind, mapId: String(row.map_id ?? row.mapId ?? "").trim() });
  }
  return out;
}

function activity(kind: string) {
  if (kind === "match_found" || kind === "raid_starting" || kind === "raid_started")
    return "in_raid";
  if (kind === "map_loading" || kind === "matching") return "matching";
  if (kind === "raid_exited" || kind === "matching_aborted") return "lobby";
  return "unknown";
}

function catalogSlug(slug: string, maps: MapPick[]) {
  return findMap(slug, maps)?.slug || "";
}

function group(maps: MapPick[]): Board {
  const phaseBy = new Map(phases.map((phase) => [phase.userId, phase]));
  if (viewerId > 0 && localKind) {
    phaseBy.set(viewerId, { userId: viewerId, kind: localKind, mapId: localMapId });
  }
  const buckets = new Map<string, Person[]>();
  for (const map of maps) {
    if (!buckets.has(map.slug)) buckets.set(map.slug, []);
  }
  const lobby: Member[] = [];
  const matching: Member[] = [];
  for (const member of members) {
    const online = member.online || (socketLive && member.userId === viewerId);
    if (!online) continue;
    const phase = phaseBy.get(member.userId);
    const state = activity(String(phase?.kind || "").trim());
    if (state === "lobby" || state === "unknown") {
      const watched =
        member.userId === viewerId
          ? localWatch
          : catalogSlug(viewByUser.get(member.userId) || "", maps);
      const watchBucket = watched ? buckets.get(watched) : undefined;
      if (watchBucket) {
        watchBucket.push({ ...member, seat: "watch" });
        continue;
      }
      lobby.push(member);
      continue;
    }
    if (state !== "in_raid" && state !== "matching") continue;
    const mapId = catalogSlug(phase?.mapId || "", maps);
    const bucket = mapId ? buckets.get(mapId) : undefined;
    if (state === "matching") {
      if (bucket) bucket.push({ ...member, seat: "matching" });
      else matching.push(member);
      continue;
    }
    if (bucket) bucket.push({ ...member, seat: "raid" });
  }
  return {
    lobby,
    matching,
    maps: [...buckets.entries()].map(([mapId, people]) => ({
      mapId,
      people: [
        ...people.filter((person) => person.seat === "raid"),
        ...people.filter((person) => person.seat === "watch"),
        ...people.filter((person) => person.seat === "matching"),
      ],
    })),
  };
}

export function resetMapBoard() {
  generation += 1;
  socketEpoch += 1;
  clearRoomProgressRetry();
  setRoomProgressSyncFailed(false);
  pendingRoomProgressSync = null;
  inflight = null;
  loadingRoomId = "";
  activeRoomId = "";
  activeRoomGameMode = null;
  socketRevision = 0;
  socketSnapshot = null;
  socketViews = null;
  socketViewsRevision = 0;
  socketViewsEpoch = socketEpoch;
  socketViewEvents = new Map();
  localViewOverrides = new Map();
  ready = false;
  loadFailed = false;
  note = "正在读取房间";
  members = [];
  phases = [];
  phaseRoomId = "";
  loadedRoomId = "";
  lastOnline = null;
  socketLive = false;
  socketDisconnected = false;
  viewByUser = new Map();
  canPick = true;
  currentSlug = "";
  shownMaps = [];
}

export function clearMapPresence() {
  resetMapBoard();
}

export function mapBoardReady() {
  return ready;
}

export function setLocalWatch(slug: string) {
  localWatch = slug.trim();
}

export function setLocalViewMap(userId: number, slug: string) {
  const next = slug.trim();
  if (userId > 0 && next) {
    localViewOverrides.set(userId, next);
    mergeViewLayers(new Map(viewByUser));
  }
  if (userId === viewerId) currentSlug = next;
}

export function noteLocalPhase(input: { kind?: string; mapId?: string }) {
  if (input.kind) {
    localKind = input.kind.trim();
    if (localKind === "raid_exited" || localKind === "matching_aborted") localMapId = "";
  }
  if (input.mapId) localMapId = input.mapId.trim();
}

export function applyRoomSync(payload: Record<string, unknown>, expectedRoomId: string) {
  const expected = expectedRoomId.trim();
  const event = String(payload.event || "");
  const payloadRoomId = String(payload.public_id || payload.publicId || "").trim();
  if (!expected || !payloadRoomId || payloadRoomId !== expected) return false;
  const rawSnap = rec(payload.snapshot);
  const snapId = rawSnap ? String(rawSnap.public_id || rawSnap.publicId || "").trim() : "";
  if (snapId && snapId !== expected) return false;
  if (activeRoomId && activeRoomId !== expected) resetMapBoard();
  if (loadedRoomId && loadedRoomId !== expected) resetMapBoard();
  activeRoomId = expected;
  if (event === "closed") {
    socketLive = false;
    socketRevision += 1;
    socketEpoch += 1;
    socketSnapshot = null;
    socketViews = null;
    socketViewsRevision = 0;
    socketViewsEpoch = socketEpoch;
    socketViewEvents.clear();
    phases = [];
    lastOnline = null;
    members = members.map((person) => ({ ...person, online: false }));
    viewByUser = new Map(localViewOverrides);
    socketDisconnected = true;
    return true;
  }
  if (rawSnap) {
    const snap = snapId ? rawSnap : { ...rawSnap, public_id: expected };
    const revision = ++socketRevision;
    socketSnapshot = { roomId: expected, value: snap, revision, epoch: socketEpoch };
    phaseRoomId = expected;
    takeViews(snap, true, revision);
    const phaseRows = payload.log_phases ?? snap.log_phases;
    if (Array.isArray(phaseRows)) phases = parsePhases(phaseRows);
    if (Array.isArray(payload.online_user_ids))
      lastOnline = new Set(payload.online_user_ids.map((item) => Number(item)));
    socketLive = true;
    socketDisconnected = false;
    if (ready) {
      members = peopleOf(snap);
      const viewed = viewerId ? viewByUser.get(viewerId) || "" : "";
      currentSlug = viewed || String(snap.map_slug || snap.mapSlug || "").trim();
    }
    return true;
  }
  if (event === "log_phase" || event === "view_map") {
    const revision = ++socketRevision;
    if (Array.isArray(payload.log_phases)) phases = parsePhases(payload.log_phases);
    if (Array.isArray(payload.view_maps)) takeViews(payload, true, revision);
    if (event === "view_map") {
      const userId = Number(payload.user_id || payload.userId || 0);
      const slug = String(payload.map_slug || payload.mapSlug || "").trim();
      if (userId > 0 && slug) {
        const eventRevision = ++socketRevision;
        socketViewEvents.set(userId, { slug, revision: eventRevision, epoch: socketEpoch });
        mergeViewLayers(socketViews ? new Map(socketViews) : new Map(viewByUser));
        if (userId === viewerId) currentSlug = viewByUser.get(userId) || slug;
      }
    }
    socketLive = true;
    socketDisconnected = false;
    return true;
  }
  if (event === "presence" && Array.isArray(payload.online_user_ids)) {
    socketRevision += 1;
    socketLive = true;
    socketDisconnected = false;
    lastOnline = new Set(payload.online_user_ids.map((item) => Number(item)));
    members = members.map((person) => ({
      ...person,
      online: lastOnline?.has(person.userId) || false,
    }));
    return true;
  }
  if (event === "pong" || event === "ping") {
    return false;
  }
  return false;
}

export function refreshMapBoard() {
  const node = document.querySelector(".map-pick");
  if (!node || !ready) return;
  node.outerHTML = mapBoardHtml(shownMaps);
}

function idsOf(value: unknown) {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = String(raw || "").trim();
    const key = id.toLowerCase();
    if (!id || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

function selectedGameMode(): TaskGameMode {
  return localStorage.getItem("zhange.guides.tarkov.gameMode") === "pve" ? "pve" : "pvp";
}

async function syncProgress(roomId: string, gen: number, mode: TaskGameMode) {
  const request = { roomId, generation: gen, mode };
  const roomKey = encodeURIComponent(roomId);
  if (!roomKey) return true;
  try {
    await serializeTaskProgress(async () => {
      if (!roomProgressRequestIsCurrent(request)) return;
      const progress = await invoke<Record<string, unknown>>("site_get", {
        path: taskProgressPath(mode),
      });
      if (!roomProgressRequestIsCurrent(request)) return;
      const done = idsOf(progress.task_ids || progress.taskIds);
      const drop = new Set(
        [...done, ...idsOf(progress.failed_ids || progress.failedIds)].map((id) =>
          id.toLowerCase(),
        ),
      );
      const started = idsOf(progress.started_ids || progress.startedIds).filter(
        (id) => !drop.has(id.toLowerCase()),
      );
      await invoke("site_put", {
        path: `/guides/tarkov/raid-rooms/${roomKey}/task-progress`,
        body: { started_ids: started, done_ids: done },
      });
    });
    return true;
  } catch {
    return !roomProgressRequestIsCurrent(request);
  }
}

function scheduleRoomProgressRetry(request: {
  roomId: string;
  generation: number;
  mode: TaskGameMode;
}) {
  if (roomProgressRetryTimer || pendingRoomProgressSync || !roomProgressRequestIsCurrent(request))
    return;
  const delay = exponentialBackoffMs(roomProgressRetryAttempt);
  roomProgressRetryAttempt = Math.min(roomProgressRetryAttempt + 1, 30);
  roomProgressRetryTimer = window.setTimeout(() => {
    roomProgressRetryTimer = 0;
    if (pendingRoomProgressSync || !roomProgressRequestIsCurrent(request)) return;
    requestRoomTaskProgressSync(request.roomId, request.generation, request.mode, true);
  }, delay);
}

async function drainRoomTaskProgressSync() {
  if (roomProgressSyncRunning) return;
  roomProgressSyncRunning = true;
  try {
    while (pendingRoomProgressSync) {
      const request = pendingRoomProgressSync;
      pendingRoomProgressSync = null;
      const succeeded = await syncProgress(request.roomId, request.generation, request.mode);
      if (succeeded) {
        clearRoomProgressRetry();
        setRoomProgressSyncFailed(false);
      } else {
        setRoomProgressSyncFailed(true);
        scheduleRoomProgressRetry(request);
      }
    }
  } finally {
    roomProgressSyncRunning = false;
    if (pendingRoomProgressSync) void drainRoomTaskProgressSync();
  }
}

function requestRoomTaskProgressSync(
  roomId: string,
  gen: number,
  mode: TaskGameMode,
  retry = false,
) {
  if (!roomId) return;
  if (!retry) clearRoomProgressRetry();
  pendingRoomProgressSync = { roomId, generation: gen, mode };
  void drainRoomTaskProgressSync();
}

export function syncMapRoomTaskProgress(mode: TaskGameMode = selectedGameMode()) {
  const roomMode = activeRoomGameMode || selectedGameMode();
  if (!ready || !activeRoomId || !canPick || mode !== roomMode) return;
  requestRoomTaskProgressSync(activeRoomId, generation, roomMode);
}

export async function loadMapBoard(
  input: { roomId: string; viewerId: number; viewerName: string },
  maps: MapPick[],
) {
  const requestedRoomId = input.roomId.trim();
  if (ready && (!requestedRoomId || loadedRoomId === requestedRoomId)) return null;
  if (
    (ready && requestedRoomId && loadedRoomId !== requestedRoomId) ||
    (activeRoomId && requestedRoomId && activeRoomId !== requestedRoomId) ||
    (inflight && loadingRoomId !== requestedRoomId)
  ) {
    resetMapBoard();
  }
  if (loadFailed) return null;
  if (inflight) return inflight;
  if (requestedRoomId) activeRoomId = requestedRoomId;
  loadingRoomId = requestedRoomId;
  const gen = generation;
  const socketRevisionAtStart = socketRevision;
  const mode = selectedGameMode();
  viewerId = input.viewerId;
  shownMaps = maps;
  const current = (async () => {
    let roomRaw: Record<string, unknown> | null = null;
    let failure = "";
    try {
      roomRaw = requestedRoomId
        ? unwrapRoom(
            await invoke("site_get", {
              path: `/guides/tarkov/raid-rooms/${encodeURIComponent(requestedRoomId)}`,
            }),
          )
        : unwrapRoom(await invoke("site_get", { path: "/guides/tarkov/raid-rooms/mine" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      const notFound = /(?:\b404\b|not found|未找到)/i.test(message);
      if (requestedRoomId || !notFound) failure = message;
    }
    if (gen !== generation) return null;
    if (failure) {
      ready = false;
      loadFailed = true;
      note = "房间状态读取失败，检查网络后重试。";
      members = [];
      return null;
    }
    if (requestedRoomId && !roomRaw) {
      ready = false;
      loadFailed = true;
      note = "房间状态响应无效，检查网络后重试。";
      members = [];
      return null;
    }
    let fetchedId = String(roomRaw?.public_id || roomRaw?.publicId || "").trim();
    const newerSocketSnapshot = Boolean(
      socketSnapshot &&
        socketSnapshot.epoch === socketEpoch &&
        !socketDisconnected &&
        socketSnapshot.revision > socketRevisionAtStart,
    );
    if (requestedRoomId && fetchedId !== requestedRoomId) {
      ready = false;
      loadFailed = true;
      note = "房间状态响应与当前房间不匹配，请重试。";
      members = [];
      return null;
    }
    if (!requestedRoomId && activeRoomId && fetchedId && fetchedId !== activeRoomId) {
      if (newerSocketSnapshot && socketSnapshot?.roomId === activeRoomId) {
        roomRaw = { ...(roomRaw || {}), ...socketSnapshot.value };
        fetchedId = activeRoomId;
      } else {
        phases = [];
        lastOnline = null;
        activeRoomId = fetchedId;
      }
    }
    let id = fetchedId || requestedRoomId;
    const snapshotIsNewer = Boolean(
      socketSnapshot &&
        socketSnapshot.epoch === socketEpoch &&
        !socketDisconnected &&
        socketSnapshot.revision > socketRevisionAtStart &&
        (!id || socketSnapshot.roomId === id),
    );
    if (
      !roomRaw &&
      socketSnapshot &&
      !socketDisconnected &&
      (!id || socketSnapshot.roomId === id) &&
      snapshotIsNewer
    ) {
      roomRaw = socketSnapshot.value;
      id = socketSnapshot.roomId;
    } else if (roomRaw && snapshotIsNewer && socketSnapshot?.roomId === id) {
      roomRaw = { ...roomRaw, ...socketSnapshot.value };
    }
    if (activeRoomId && id && activeRoomId !== id) {
      ready = false;
      loadFailed = false;
      note = "正在读取房间";
      return null;
    }
    if (id) activeRoomId = id;
    activeRoomGameMode = roomRaw ? roomTaskProgressMode(roomRaw, mode) : null;
    if (id && phaseRoomId && phaseRoomId !== id) {
      phases = [];
      lastOnline = null;
    }
    loadedRoomId = id;
    if (id) phaseRoomId = id;
    if (roomRaw) takeViews(roomRaw, false, 0, socketRevisionAtStart);
    members = peopleOf(roomRaw);
    canPick = roomRaw ? isMember(roomRaw) : true;
    currentSlug = roomRaw
      ? (viewerId ? viewByUser.get(viewerId) || "" : "") ||
        String(roomRaw.map_slug || roomRaw.mapSlug || "").trim()
      : "";
    note = "";
    ready = true;
    loadFailed = false;
    if (roomRaw && canPick) requestRoomTaskProgressSync(id, gen, activeRoomGameMode || mode);
    return roomRaw;
  })();
  const pending = current.finally(() => {
    if (inflight === pending) {
      inflight = null;
      loadingRoomId = "";
    }
  });
  inflight = pending;
  return pending;
}

export function retryMapBoard(
  input: { roomId: string; viewerId: number; viewerName: string },
  maps: MapPick[],
) {
  if (!loadFailed || inflight) return Promise.resolve(null);
  loadFailed = false;
  note = "正在读取房间";
  return loadMapBoard(input, maps);
}

function chip(person: Member, tag = "") {
  const name = person.name || "成员";
  const title = tag ? `${name} ${tag}` : name;
  return `<span class="map-pick-chip" title="${esc(title)}"><i class="dot" style="background:${esc(colorForUserId(person.userId))}"></i>${person.host ? `<span aria-hidden="true">⭐</span>` : ""}<span class="map-pick-chip-name">${esc(name)}</span>${tag ? `<span class="map-pick-chip-tag">${esc(tag)}</span>` : ""}</span>`;
}

function seatTag(seat: Seat) {
  if (seat === "matching") return "匹配中";
  if (seat === "watch") return "观战中";
  return "";
}

function band(label: string, people: Member[]) {
  if (!people.length) return "";
  return `<div class="map-pick-band"><span class="map-pick-band-label">${label}</span><div class="map-pick-chips">${people.map((person) => chip(person)).join("")}</div></div>`;
}

export function paintMapPickGoon() {
  const slug = goonSlug();
  const hint = goonHint();
  document.querySelectorAll<HTMLElement>(".map-pick-card").forEach((card) => {
    const mapSlug = card.dataset.mapSlug || "";
    const on = Boolean(slug && hint && sameMap(mapSlug, slug));
    card.classList.toggle("is-goon", on);
    let node = card.querySelector<HTMLElement>(".map-goon");
    if (!on) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("span");
      node.className = "map-goon";
      card.querySelector(".map-pick-card-body")?.append(node);
    }
    node.textContent = "三狗出没";
    node.title = hint;
  });
}

export function mapBoardHtml(maps: MapPick[]) {
  shownMaps = maps;
  if (!ready) {
    if (loadFailed) {
      return `<section class="map-pick"><p class="map-pick-sync">${esc(note)}</p><button type="button" data-room-board-retry>重试</button></section>`;
    }
    return `<section class="map-pick">${isPending(note) ? spin(note) : `<p class="map-pick-sync">${esc(note)}</p>`}</section>`;
  }
  const board = group(maps);
  const goon = goonSlug();
  const hint = goonHint();
  const cards = board.maps
    .map((row) => {
      const map = maps.find((item) => item.slug === row.mapId);
      const name = mapTitle(row.mapId, map?.name || "");
      const current = Boolean(currentSlug) && sameMap(row.mapId, currentSlug);
      const onGoon = Boolean(hint) && sameMap(goon, row.mapId);
      const image = map?.thumbLink
        ? `<img class="map-pick-thumb" src="${esc(map.thumbLink)}" alt="" />`
        : `<span class="map-pick-thumb is-empty"></span>`;
      const classes = ["map-pick-card", current ? "is-current" : "", onGoon ? "is-goon" : ""]
        .filter(Boolean)
        .join(" ");
      const label = current ? `继续看${name}` : `切换到${name}`;
      const pick = canPick ? ` data-map="${esc(row.mapId)}"` : " disabled";
      const pressed = current ? ` aria-pressed="true"` : ` aria-pressed="false"`;
      const people = row.people.length
        ? `<div class="map-pick-chips">${row.people.map((person) => chip(person, seatTag(person.seat))).join("")}</div>`
        : "";
      return `<div class="map-pick-cell"><button type="button" class="${classes}" data-map-slug="${esc(row.mapId)}"${pick}${pressed} aria-label="${esc(label)}">${image}<span class="map-pick-card-body"><span class="map-pick-name">${esc(name)}</span>${onGoon ? `<span class="map-goon" title="${esc(hint)}">三狗出没</span>` : ""}</span></button>${people}</div>`;
    })
    .join("");
  const connectionNote = socketDisconnected
    ? `<p class="map-pick-sync">房间同步暂时断开，成员在线状态可能已过期。</p>`
    : "";
  const progressNote = roomProgressSyncFailed
    ? `<p class="map-pick-sync" role="status">队伍任务进度同步暂时失败，网络恢复后会自动重试。</p>`
    : "";
  return `<section class="map-pick">${connectionNote}${progressNote}<p class="map-pick-hint">点一张图，只切换你自己看的地图。方块下面是正在这张图里的人，匹配中、观战中会另外标出。</p>${band("大厅中：", board.lobby)}${band("匹配中：", board.matching)}<p class="map-pick-section">战局中：</p><div class="map-pick-grid">${cards}</div></section>`;
}

import { colorForUserId } from "./questOverlay";
import { goonHint, goonSlug } from "./goon";
import { findMap, mapTitle, sameMap } from "./mapNames";
import { isPending, spin } from "./spinner";

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
let viewerId = 0;
let localKind = "";
let localMapId = "";
let localWatch = "";
let viewByUser = new Map<number, string>();
let ready = false;
let canPick = true;
let currentSlug = "";
let shownMaps: MapPick[] = [];
let generation = 0;
let inflight: Promise<Record<string, unknown> | null> | null = null;

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
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
  const name = String(row.display_name || row.displayName || row.name || "").trim() || `用户${userId}`;
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
  if (!lastOnline) return people;
  return people.map((person) => ({ ...person, online: lastOnline?.has(person.userId) || person.online }));
}

function isMember(raw: Record<string, unknown>) {
  if ("is_member" in raw) return Boolean(raw.is_member);
  if ("isMember" in raw) return Boolean(raw.isMember);
  return true;
}

function viewRows(raw: Record<string, unknown>) {
  return Array.isArray(raw.view_maps) ? raw.view_maps : Array.isArray(raw.viewMaps) ? raw.viewMaps : null;
}

function takeViews(raw: Record<string, unknown>) {
  const rows = viewRows(raw);
  if (!rows) return;
  const next = new Map<number, string>();
  for (const item of rows) {
    const row = rec(item);
    if (!row) continue;
    const userId = Number(row.user_id || row.userId || 0);
    const slug = String(row.map_slug || row.mapSlug || "").trim();
    if (userId > 0 && slug) next.set(userId, slug);
  }
  viewByUser = next;
}

function viewSlug(raw: Record<string, unknown>, userId: number) {
  const rows = viewRows(raw);
  if (!rows) return "";
  for (const item of rows) {
    const row = rec(item);
    if (!row || Number(row.user_id || row.userId || 0) !== userId) continue;
    return String(row.map_slug || row.mapSlug || "").trim();
  }
  return "";
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
  if (kind === "match_found" || kind === "raid_starting" || kind === "raid_started") return "in_raid";
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
      const watched = member.userId === viewerId
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
  ready = false;
  note = "正在读取房间";
  members = [];
  loadedRoomId = "";
  canPick = true;
  currentSlug = "";
  shownMaps = [];
}

export function clearMapPresence() {
  phases = [];
  phaseRoomId = "";
  lastOnline = null;
  socketLive = false;
}

export function mapBoardReady() {
  return ready;
}

export function setLocalWatch(slug: string) {
  localWatch = slug.trim();
}

export function noteLocalPhase(input: { kind?: string; mapId?: string }) {
  if (input.kind) {
    localKind = input.kind.trim();
    if (localKind === "raid_exited" || localKind === "matching_aborted") localMapId = "";
  }
  if (input.mapId) localMapId = input.mapId.trim();
}

export function applyRoomSync(payload: Record<string, unknown>) {
  const event = String(payload.event || "");
  if (event === "closed") {
    socketLive = false;
    return true;
  }
  const snap = rec(payload.snapshot);
  if (snap) {
    const id = String(snap.public_id || snap.publicId || "").trim();
    if (loadedRoomId && id && id !== loadedRoomId) return false;
    if (id) phaseRoomId = id;
    takeViews(snap);
    if (Array.isArray(payload.log_phases)) phases = parsePhases(payload.log_phases);
    if (Array.isArray(payload.online_user_ids)) lastOnline = new Set(payload.online_user_ids.map((item) => Number(item)));
    socketLive = true;
    if (ready && (!loadedRoomId || !id || id === loadedRoomId)) {
      const next = peopleOf(snap);
      if (next.length) members = next;
      const viewed = viewerId ? viewSlug(snap, viewerId) : "";
      currentSlug = viewed || String(snap.map_slug || snap.mapSlug || "").trim();
    }
    return true;
  }
  if (event === "log_phase" || event === "view_map") {
    if (Array.isArray(payload.log_phases)) phases = parsePhases(payload.log_phases);
    if (Array.isArray(payload.view_maps) || event === "view_map") takeViews(payload);
    socketLive = true;
    return true;
  }
  if (event === "presence" && Array.isArray(payload.online_user_ids)) {
    socketLive = true;
    lastOnline = new Set(payload.online_user_ids.map((item) => Number(item)));
    members = members.map((person) => ({ ...person, online: lastOnline?.has(person.userId) || false }));
    return true;
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

function syncProgress(roomRaw: Record<string, unknown>, gen: number) {
  const roomKey = encodeURIComponent(String(roomRaw.public_id || roomRaw.publicId || ""));
  if (!roomKey || !isMember(roomRaw)) return;
  void (async () => {
    const progress = await invoke<Record<string, unknown>>("site_get", { path: "/guides/tarkov/task-dones" }).catch(() => null);
    if (!progress || gen !== generation) return;
    const done = idsOf(progress.task_ids || progress.taskIds);
    const drop = new Set([...done, ...idsOf(progress.failed_ids || progress.failedIds)].map((id) => id.toLowerCase()));
    const started = idsOf(progress.started_ids || progress.startedIds).filter((id) => !drop.has(id.toLowerCase()));
    await invoke("site_put", {
      path: `/guides/tarkov/raid-rooms/${roomKey}/task-progress`,
      body: { started_ids: started, done_ids: done },
    }).catch(() => undefined);
  })();
}

export async function loadMapBoard(input: { roomId: string; viewerId: number; viewerName: string }, maps: MapPick[]) {
  if (ready) return null;
  if (inflight) return inflight;
  const gen = generation;
  viewerId = input.viewerId;
  shownMaps = maps;
  const current = (async () => {
    let roomRaw: Record<string, unknown> | null = null;
    try {
      roomRaw = input.roomId
        ? unwrapRoom(await invoke("site_get", { path: `/guides/tarkov/raid-rooms/${input.roomId}` }))
        : unwrapRoom(await invoke("site_get", { path: "/guides/tarkov/raid-rooms/mine" }));
    } catch {
      roomRaw = null;
    }
    if (gen !== generation) return null;
    const id = String(roomRaw?.public_id || roomRaw?.publicId || "").trim();
    if (id && phaseRoomId && phaseRoomId !== id) {
      phases = [];
      lastOnline = null;
    }
    loadedRoomId = id;
    if (id) phaseRoomId = id;
    if (roomRaw) takeViews(roomRaw);
    members = peopleOf(roomRaw);
    canPick = roomRaw ? isMember(roomRaw) : true;
    currentSlug = roomRaw ? (viewerId ? viewSlug(roomRaw, viewerId) : "") || String(roomRaw.map_slug || roomRaw.mapSlug || "").trim() : "";
    note = "";
    ready = true;
    if (roomRaw) syncProgress(roomRaw, gen);
    return roomRaw;
  })();
  inflight = current.finally(() => {
    if (inflight === current) inflight = null;
  });
  return inflight;
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
    return `<section class="map-pick">${isPending(note) ? spin(note) : `<p class="map-pick-sync">${esc(note)}</p>`}</section>`;
  }
  const board = group(maps);
  const goon = goonSlug();
  const hint = goonHint();
  const cards = board.maps.map((row) => {
    const map = maps.find((item) => item.slug === row.mapId);
    const name = mapTitle(row.mapId, map?.name || "");
    const current = Boolean(currentSlug) && sameMap(row.mapId, currentSlug);
    const onGoon = Boolean(hint) && sameMap(goon, row.mapId);
    const image = map?.thumbLink
      ? `<img class="map-pick-thumb" src="${esc(map.thumbLink)}" alt="" />`
      : `<span class="map-pick-thumb is-empty"></span>`;
    const classes = ["map-pick-card", current ? "is-current" : "", onGoon ? "is-goon" : ""].filter(Boolean).join(" ");
    const label = current ? `继续看${name}` : `切换到${name}`;
    const pick = canPick ? ` data-map="${esc(row.mapId)}"` : " disabled";
    const pressed = current ? ` aria-pressed="true"` : ` aria-pressed="false"`;
    const people = row.people.length
      ? `<div class="map-pick-chips">${row.people.map((person) => chip(person, seatTag(person.seat))).join("")}</div>`
      : "";
    return `<div class="map-pick-cell"><button type="button" class="${classes}" data-map-slug="${esc(row.mapId)}"${pick}${pressed} aria-label="${esc(label)}">${image}<span class="map-pick-card-body"><span class="map-pick-name">${esc(name)}</span>${onGoon ? `<span class="map-goon" title="${esc(hint)}">三狗出没</span>` : ""}</span></button>${people}</div>`;
  }).join("");
  return `<section class="map-pick"><p class="map-pick-hint">点一张图，只切换你自己看的地图。方块下面是正在这张图里的人，匹配中、观战中会另外标出。</p>${band("大厅中：", board.lobby)}${band("匹配中：", board.matching)}<p class="map-pick-section">战局中：</p><div class="map-pick-grid">${cards}</div></section>`;
}

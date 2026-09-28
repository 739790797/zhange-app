import { colorForUserId } from "./questOverlay";
import { goonHint, goonSlug } from "./goon";
import { mapTitle, sameMap } from "./mapNames";
import { isPending, spin } from "./spinner";

type MapPick = { slug: string; name: string; thumbLink: string };
type Member = { userId: number; name: string };
type Cell = { userId: number; count: number; uploaded: boolean };
type TaskHit = { id: string; name: string; traderSlug: string; userIds: number[] };
type Row = { mapSlug: string; withTasks: number; cells: Cell[]; tasks: TaskHit[] };

let note = "正在读取任务数量";
let members: Member[] = [];
let rows: Row[] = [];
let unsynced: string[] = [];
let catalogGap = false;
let ready = false;
let pickHost = true;
let currentSlug = "";
let overlapOrder: string[] = [];
let previewSlug = "";
let previewTouched = false;
let generation = 0;
let inflight: Promise<Record<string, unknown> | null> | null = null;
let cachedRoom: Record<string, unknown> | null = null;

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

function keySet(ids: string[]) {
  return new Set(ids.map((id) => id.toLowerCase()));
}

function canon(slug: string, known: Set<string>) {
  const key = slug.trim().toLowerCase();
  if (!key) return "";
  if (known.has(key)) return key;
  for (const item of known) {
    if (sameMap(item, key)) return item;
  }
  return key;
}

function peopleOf(raw: Record<string, unknown> | null, viewerId: number, viewerName: string): Member[] {
  const occupants = Array.isArray(raw?.occupants) ? raw.occupants : [];
  const membersRaw = Array.isArray(raw?.members) ? raw.members : [];
  const source = occupants.length
    ? occupants
    : membersRaw.filter((item) => {
      const row = rec(item);
      return row ? row.in_room !== false && row.inRoom !== false : false;
    });
  const people = source.flatMap((item) => {
    const row = rec(item);
    if (!row) return [];
    const userId = Number(row.user_id || row.userId || 0);
    if (!userId) return [];
    const name = String(row.display_name || row.displayName || row.name || "").trim() || `用户${userId}`;
    return [{ userId, name }];
  });
  if (people.length) return people;
  return [{ userId: viewerId, name: viewerName || "你" }];
}

function parseCells(raw: unknown): Cell[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const row = rec(item);
    if (!row) return [];
    const userId = Number(row.user_id || row.userId || 0);
    if (!userId) return [];
    return [{ userId, count: Math.max(0, Number(row.count || 0) || 0), uploaded: Boolean(row.uploaded) }];
  });
}

function parseTasks(raw: unknown): TaskHit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const row = rec(item);
    if (!row) return [];
    const id = String(row.id || "").trim();
    if (!id) return [];
    const userIds = (Array.isArray(row.user_ids) ? row.user_ids : Array.isArray(row.userIds) ? row.userIds : [])
      .map((userId) => Number(userId))
      .filter((userId) => userId > 0);
    return [{
      id,
      name: String(row.name || id),
      traderSlug: String(row.trader_slug || row.traderSlug || "").trim().toLowerCase(),
      userIds,
    }];
  });
}

function parseOverlap(raw: unknown): Row[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const row = rec(item);
    if (!row) return [];
    const mapSlug = String(row.map_slug || row.mapSlug || "").trim();
    if (!mapSlug) return [];
    const cells = parseCells(row.cells);
    const withTasks = Number(row.with_tasks_count ?? row.withTasksCount);
    return [{
      mapSlug,
      withTasks: Number.isFinite(withTasks) ? withTasks : cells.filter((cell) => cell.uploaded && cell.count > 0).length,
      cells,
      tasks: parseTasks(row.tasks),
    }];
  });
}

function parseUploaded(raw: unknown) {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((item) => {
    const row = rec(item);
    if (!row) return [];
    const userId = Number(row.user_id || row.userId || 0);
    if (!userId) return [];
    return [{ userId, uploaded: Boolean(row.uploaded) }];
  });
}

function align(maps: MapPick[], squad: Member[], overlap: Row[], filled: boolean): Row[] {
  const by = new Map(overlap.map((row) => [row.mapSlug, row]));
  const order = new Map(maps.map((map, index) => [map.slug, index]));
  const rows = maps.map((map) => {
    const found = by.get(map.slug);
    const cells = squad.map((member) => {
      const cell = found?.cells.find((item) => item.userId === member.userId);
      if (cell) return cell;
      return { userId: member.userId, count: 0, uploaded: filled };
    });
    const withTasks = found
      ? found.withTasks
      : cells.filter((cell) => cell.uploaded && cell.count > 0).length;
    return { mapSlug: map.slug, withTasks, cells, tasks: found?.tasks || [] };
  });
  const sum = (row: Row) => row.cells.reduce((total, cell) => total + (cell.uploaded ? cell.count : 0), 0);
  return rows.sort((left, right) => right.withTasks - left.withTasks || sum(right) - sum(left) || (order.get(left.mapSlug) ?? 99) - (order.get(right.mapSlug) ?? 99));
}

async function localRows(maps: MapPick[], viewerId: number, progress: Record<string, unknown>) {
  const catalog = await invoke<{ items?: Record<string, unknown>[] }>("site_get", { path: "/guides/tarkov/tasks?layout=all" });
  const known = new Set(maps.map((map) => map.slug));
  const done = keySet(idsOf(progress.task_ids || progress.taskIds));
  const failed = keySet(idsOf(progress.failed_ids || progress.failedIds));
  const started = idsOf(progress.started_ids || progress.startedIds).filter((id) => !done.has(id.toLowerCase()) && !failed.has(id.toLowerCase()));
  const active = new Set(started.map((id) => id.toLowerCase()));
  const grouped = new Map<string, TaskHit[]>();
  for (const item of catalog.items || []) {
    const id = String(item.id || "").trim();
    if (!id || !active.has(id.toLowerCase())) continue;
    const mapSlug = canon(String(item.map_slug || item.mapSlug || ""), known);
    if (!known.has(mapSlug)) continue;
    const list = grouped.get(mapSlug) || [];
    list.push({
      id,
      name: String(item.name || id),
      traderSlug: String(item.trader_slug || item.traderSlug || "").trim().toLowerCase(),
      userIds: viewerId ? [viewerId] : [],
    });
    grouped.set(mapSlug, list);
  }
  return [...grouped.entries()].map(([mapSlug, tasks]) => ({
    mapSlug,
    withTasks: tasks.length ? 1 : 0,
    cells: [{ userId: viewerId, count: tasks.length, uploaded: true }],
    tasks,
  }));
}

export function resetMapBoard() {
  generation += 1;
  ready = false;
  note = "正在读取任务数量";
  members = [];
  rows = [];
  unsynced = [];
  catalogGap = false;
  cachedRoom = null;
  pickHost = true;
  currentSlug = "";
  overlapOrder = [];
  previewSlug = "";
  previewTouched = false;
}

export function mapBoardReady() {
  return ready;
}

export async function loadMapBoard(input: { roomId: string; viewerId: number; viewerName: string }, maps: MapPick[]) {
  if (ready) return cachedRoom;
  if (inflight) return inflight;
  const gen = generation;
  const current = (async () => {
    const viewerName = input.viewerName.trim() || "你";
    let progress: Record<string, unknown> | null = null;
    let progressError = "";
    try {
      progress = await invoke<Record<string, unknown>>("site_get", { path: "/guides/tarkov/task-dones" });
    } catch (error) {
      progressError = error instanceof Error ? error.message : "任务进度读取失败";
    }
    let roomRaw: Record<string, unknown> | null = null;
    if (input.roomId) {
      roomRaw = unwrapRoom(await invoke("site_get", { path: `/guides/tarkov/raid-rooms/${input.roomId}` }).catch(() => null));
    } else {
      roomRaw = unwrapRoom(await invoke("site_get", { path: "/guides/tarkov/raid-rooms/mine" }).catch(() => null));
    }
    let synced = roomRaw;
    if (roomRaw && progress) {
      const done = idsOf(progress.task_ids || progress.taskIds);
      const drop = keySet([...done, ...idsOf(progress.failed_ids || progress.failedIds)]);
      const started = idsOf(progress.started_ids || progress.startedIds).filter((id) => !drop.has(id.toLowerCase()));
      const roomKey = encodeURIComponent(String(roomRaw.public_id || roomRaw.publicId));
      synced = unwrapRoom(await invoke("site_put", {
        path: `/guides/tarkov/raid-rooms/${roomKey}/task-progress`,
        body: { started_ids: started, done_ids: done },
      }).catch(() => null)) || roomRaw;
    }
    if (gen !== generation) return null;
    pickHost = synced ? Boolean(synced.is_host || synced.isHost) : true;
    currentSlug = String(synced?.map_slug || synced?.mapSlug || "").trim();
    const squad = peopleOf(synced, input.viewerId, viewerName);
    const overlapRaw = synced?.map_overlap ?? synced?.mapOverlap;
    const hasOverlap = Array.isArray(overlapRaw);
    let overlap = hasOverlap ? parseOverlap(overlapRaw) : [];
    let filled = false;
    catalogGap = hasOverlap && overlap.length === 0;
    if (!hasOverlap) {
      if (!progress) {
        note = progressError || "任务进度读取失败";
        members = squad;
        rows = align(maps, squad, [], false);
        unsynced = [];
        cachedRoom = synced;
        ready = true;
        return synced;
      }
      try {
        overlap = await localRows(maps, input.viewerId, progress);
        filled = true;
        catalogGap = false;
      } catch (error) {
        note = error instanceof Error ? error.message : "任务目录读取失败";
        members = squad;
        rows = align(maps, squad, [], false);
        unsynced = [];
        catalogGap = true;
        cachedRoom = synced;
        ready = true;
        return synced;
      }
    }
    const uploaded = parseUploaded(synced?.task_progress ?? synced?.taskProgress);
    overlapOrder = overlap.map((row) => row.mapSlug);
    members = squad;
    rows = align(maps, squad, overlap, filled);
    unsynced = uploaded
      ? squad.filter((member) => !uploaded.find((item) => item.userId === member.userId)?.uploaded).map((member) => member.name)
      : [];
    note = "";
    cachedRoom = synced;
    ready = true;
    return synced;
  })();
  inflight = current.finally(() => {
    if (inflight === current) inflight = null;
  });
  return inflight;
}

function memberTasks(row: Row, userId: number) {
  return row.tasks.filter((task) => task.userIds.includes(userId));
}

function tipHtml(row: Row, userId: number, uploaded: boolean) {
  if (!uploaded) return `<span class="map-pick-tip app-hover">未同步</span>`;
  const tasks = memberTasks(row, userId);
  if (!tasks.length) return `<span class="map-pick-tip app-hover">没有进行中的本图任务</span>`;
  const items = tasks.map((task) => {
    const icon = task.traderSlug ? `<img src="https://tarkov.dev/images/traders/${encodeURIComponent(task.traderSlug)}-icon.jpg" alt="" />` : `<i></i>`;
    return `<li>${icon}<span>${esc(task.name)}</span></li>`;
  }).join("");
  return `<span class="map-pick-tip app-hover"><ul>${items}</ul></span>`;
}

function resolvePreview(maps: MapPick[]) {
  const known = new Set(maps.map((map) => map.slug));
  const pick = (slug: string) => {
    if (!slug || !known.size) return "";
    const next = canon(slug, known);
    return known.has(next) ? next : "";
  };
  if (previewTouched) {
    const touched = pick(previewSlug);
    if (touched) return touched;
  }
  const goon = pick(goonSlug());
  if (goon) return goon;
  for (const slug of overlapOrder) {
    const next = pick(slug);
    if (next) return next;
  }
  const current = pick(currentSlug);
  if (current) return current;
  return maps[0]?.slug || "";
}

export function setMapPreview(slug: string) {
  previewTouched = true;
  previewSlug = slug;
}

export function paintMapPickGoon() {
  const slug = goonSlug();
  const hint = goonHint();
  if (!previewTouched && slug) previewSlug = slug;
  document.querySelectorAll<HTMLElement>(".map-pick-row").forEach((row) => {
    const mapSlug = row.dataset.mapSlug || "";
    const on = Boolean(slug && hint && sameMap(mapSlug, slug));
    row.classList.toggle("is-goon", on);
    row.classList.toggle("is-preview", sameMap(mapSlug, previewSlug));
    let node = row.querySelector<HTMLElement>(".map-goon");
    if (!on) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("span");
      node.className = "map-goon";
      row.querySelector(".map-text")?.append(node);
    }
    node.textContent = hint;
    node.title = hint;
  });
}

export function mapBoardHtml(maps: MapPick[]) {
  if (!ready) {
    return `<section class="map-pick">${isPending(note) ? spin(note) : `<p class="map-pick-sync">${esc(note)}</p>`}</section>`;
  }
  const preview = resolvePreview(maps);
  previewSlug = preview;
  const goon = goonSlug();
  const hint = goonHint();
  const head = members.map((member) => `<th class="user"><span class="user-head"><i class="dot" style="background:${esc(colorForUserId(member.userId))}"></i>${esc(member.name)}</span></th>`).join("");
  const body = rows.map((row) => {
    const map = maps.find((item) => item.slug === row.mapSlug);
    const name = mapTitle(row.mapSlug, map?.name || "");
    const image = map?.thumbLink ? `<img class="thumb" src="${esc(map.thumbLink)}" alt="" />` : `<i class="thumb"></i>`;
    const onGoon = Boolean(hint) && sameMap(goon, row.mapSlug);
    const classes = [
      "map-pick-row",
      sameMap(row.mapSlug, preview) ? "is-preview" : "",
      sameMap(row.mapSlug, currentSlug) ? "is-current" : "",
      onGoon ? "is-goon" : "",
    ].filter(Boolean).join(" ");
    const cells = members.map((member) => {
      const cell = row.cells.find((item) => item.userId === member.userId);
      const uploaded = Boolean(cell?.uploaded);
      const hit = uploaded && (cell?.count || 0) > 0;
      const text = uploaded ? String(cell?.count || 0) : "—";
      return `<td class="user"><span class="count-wrap"><span class="count${hit ? " hit" : uploaded ? "" : " muted"}">${esc(text)}</span>${tipHtml(row, member.userId, uploaded)}</span></td>`;
    }).join("");
    const action = pickHost
      ? `<td><button type="button" class="map-pick-btn" data-map="${esc(row.mapSlug)}">${sameMap(row.mapSlug, currentSlug) ? "继续这张图" : "选这张图"}</button></td>`
      : "";
    return `<tr class="${classes}" data-map-slug="${esc(row.mapSlug)}" data-map-name="${esc(name)}" data-map-preview="${esc(row.mapSlug)}"><th><div class="map-cell">${image}<span class="map-text"><span class="map-name">${esc(name)}</span>${onGoon ? `<span class="map-goon" title="${esc(hint)}">${esc(hint)}</span>` : ""}</span></div></th>${cells}<td class="people">${row.withTasks}人</td>${action}</tr>`;
  }).join("");
  const gap = catalogGap ? `<p class="map-pick-sync">任务目录尚未同步，数字暂不可用。</p>` : "";
  const missing = unsynced.length ? `<p class="map-pick-sync">未同步：${esc(unsynced.join("、"))}</p>` : "";
  const pickHead = pickHost ? `<th></th>` : "";
  return `<section class="map-pick">${gap}${missing}<div class="map-pick-wrap"><table class="map-pick-table"><thead><tr><th>地图</th>${head}<th class="people">有任务人数</th>${pickHead}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

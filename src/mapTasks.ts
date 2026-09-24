import { colorForTaskId, colorForUserId, questColor } from "./questOverlay";

type MapObjective = {
  id: string;
  text: string;
  mapName: string;
  onMap: boolean;
};

type MapFail = { label: string; text: string };

type MapTask = {
  id: string;
  name: string;
  trader: string;
  traderSlug: string;
  onMap: boolean;
  mapName: string;
  hasMarkers: boolean;
  objectives: MapObjective[];
  fails: MapFail[];
};

type Status = "todo" | "active" | "done" | "failed";

const STATUS_LABEL: Record<Status, string> = {
  todo: "未完成",
  active: "进行中",
  done: "已完成",
  failed: "失败",
};

let slug = "";
let tasks: MapTask[] = [];
let done = new Set<string>();
let started = new Set<string>();
let failed = new Set<string>();
let objectives: { task_id: string; objective_id: string }[] = [];
let query = "";
let scope: "map" | "all" = "map";
let note = "正在读取任务…";
let saving = false;
let hoverId = "";
let hoverTimer = 0;
let hoverBound = false;
let hoverAnchor: HTMLElement | null = null;
let progressWatch: (() => void) | null = null;
let locateWatch: ((id: string) => void) | null = null;
let claimWatch: ((id: string, on: boolean) => void) | null = null;
let objectiveWatch: ((taskId: string, objectiveId: string, done: boolean) => void) | null = null;
let myClaims = new Set<string>();
let claimOrder: string[] = [];
let claimPeople = new Map<string, { name: string; userId: number }[]>();
let highlightId = "";
let guideId = "";
const detailReady = new Set<string>();
const detailLoading = new Set<string>();
const detailFailed = new Set<string>();

const FAIL_LABEL: Record<string, string> = {
  taskStatus: "任务冲突",
  extract: "撤离失败",
  useItem: "禁止使用",
  traderStanding: "商人声望",
  shoot: "禁止击杀",
};

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function traderSlugOf(slug: string, name: string) {
  const known = slug.trim().toLowerCase();
  if (known) return known;
  return name.split(/[（(]/)[0].trim().toLowerCase().replace(/\s+/g, "");
}

function traderIcon(slug: string) {
  if (!slug) return "";
  return `https://tarkov.dev/images/traders/${encodeURIComponent(slug)}-icon.jpg`;
}

function humanName(value: string) {
  const text = value.trim();
  if (!text) return "";
  if (/^[a-f0-9]{24}$/i.test(text)) return "";
  if (/^(boss|follower|infected|any)[A-Z0-9]/i.test(text)) return "";
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(text) && /[A-Z]/.test(text.slice(1))) return "";
  return text;
}

function named(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  return humanName(String(row.name || ""));
}

const MAP_EQUIV = [
  ["streets", "streets-of-tarkov"],
  ["lab", "the-lab"],
  ["labyrinth", "the-labyrinth"],
  ["night-factory", "factory-night"],
  ["ground-zero", "ground-zero-21", "ground-zero-tutorial"],
  ["customs", "bigmap"],
];

const OBJECTIVE_LABEL: Record<string, string> = {
  findItem: "找到",
  findQuestItem: "找到",
  giveItem: "上交",
  giveQuestItem: "上交",
  plantItem: "藏匿",
  mark: "标记",
  useItem: "使用",
  shoot: "击杀",
  visit: "到访",
  extract: "撤离",
  experience: "经验",
  skill: "技能",
  traderLevel: "商人等级",
  traderStanding: "商人声望",
  buildWeapon: "改装武器",
};

function mapKeys(slug: string) {
  const key = slug.trim().toLowerCase();
  const keys = new Set(key ? [key] : []);
  for (const group of MAP_EQUIV) {
    if (group.includes(key)) group.forEach((item) => keys.add(item));
  }
  return keys;
}

function placeSlug(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  return String(row.slug || row.map_slug || row.mapSlug || "").trim().toLowerCase();
}

function readObjectives(raw: unknown, mapSlug: string, _taskOnMap: boolean): MapObjective[] {
  if (!Array.isArray(raw)) return [];
  const keys = mapKeys(mapSlug);
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id || "").trim();
    if (!id) return [];
    const type = String(row.type || "").trim();
    const desc = String(row.description || "").trim();
    const zones = Array.isArray(row.zone_names) ? row.zone_names.map((name) => humanName(String(name || ""))).filter(Boolean) : [];
    const targets = Array.isArray(row.target_names) ? row.target_names.map((name) => humanName(String(name || ""))).filter(Boolean) : [];
    const exitName = humanName(String(row.exit_name || ""));
    const extra = [...targets, ...zones, exitName].filter((name) => name && name !== desc && !desc.includes(name));
    let text = [desc || OBJECTIVE_LABEL[type] || "目标", ...extra]
      .flatMap((part) => part.split(" · "))
      .map((part) => part.trim())
      .filter((part, index) => part && (index === 0 || humanName(part) === part))
      .filter((part, index, list) => list.indexOf(part) === index)
      .join(" · ")
      .replace(/上交战局中找到物品/g, "上交在战局中找到的物品");
    const count = Number(row.count || 0);
    if (count > 1) text += ` ×${count}`;
    if (row.optional) text += "（可选）";
    const maps = Array.isArray(row.maps) ? row.maps : [];
    const zonePlaces = Array.isArray(row.zones) ? row.zones : [];
    const locations = Array.isArray(row.possible_locations) ? row.possible_locations : [];
    const slugs = [...maps, ...zonePlaces, ...locations].map(placeSlug).filter(Boolean);
    const located = maps.length > 0 || zonePlaces.length > 0 || locations.length > 0;
    const onMap = !located || slugs.some((item) => keys.has(item));
    const mapName = maps.map(named).filter(Boolean).join("、");
    return [{ id, text, mapName, onMap }];
  });
}

function readFails(raw: unknown): MapFail[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const label = FAIL_LABEL[String(row.type || "").trim()] || "";
    const text = String(row.description || "").trim();
    if (!label || !text) return [];
    return [{ label, text }];
  });
}

function objectiveDone(taskId: string, objectiveId: string) {
  const task = taskId.trim().toLowerCase();
  const objective = objectiveId.trim().toLowerCase();
  return objectives.some((item) => item.task_id.trim().toLowerCase() === task && item.objective_id.trim().toLowerCase() === objective);
}

function has(pool: Set<string>, id: string) {
  const want = id.trim().toLowerCase();
  for (const item of pool) if (item.trim().toLowerCase() === want) return true;
  return false;
}

function drop(pool: Set<string>, id: string) {
  const want = id.trim().toLowerCase();
  for (const item of [...pool]) if (item.trim().toLowerCase() === want) pool.delete(item);
}

function statusOf(task: MapTask): Status {
  if (has(done, task.id)) return "done";
  if (has(failed, task.id)) return "failed";
  if (has(started, task.id)) return "active";
  return "todo";
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function paint() {
  const host = document.querySelector("#task-body");
  if (!host) return;
  const visible = tasks.filter((task) => {
    if (scope === "map" && !task.onMap) return false;
    if (query && !task.name.includes(query) && !task.trader.includes(query)) return false;
    return true;
  });
  const order: Status[] = ["active", "todo", "done", "failed"];
  const row = (task: MapTask) => {
    const status = statusOf(task);
    const trader = traderSlugOf(task.traderSlug, task.trader);
    const icon = traderIcon(trader);
    const claimed = myClaims.has(task.id);
    const color = claimed ? questColor(Math.max(0, claimOrder.indexOf(task.id))) : "";
    const options: Status[] = status === "failed" ? ["todo", "active", "done", "failed"] : ["todo", "active", "done"];
    const canLocate = task.hasMarkers && status !== "done";
    const claimLocked = status === "done" && !claimed;
    return `<article class="map-task status-${status}${claimed ? " claimed" : ""}${highlightId === task.id ? " focused" : ""}" data-map-task-row="${esc(task.id)}">
      <label class="map-task-check"><input type="checkbox" data-map-task-claim="${esc(task.id)}" ${claimed ? "checked" : ""} ${claimLocked ? "disabled" : ""} aria-label="选择 ${esc(task.name)}" /></label>
      <i class="map-task-swatch"${color ? ` style="background:${color}"` : " data-empty"}></i>
      ${icon ? `<img src="${esc(icon)}" alt="" />` : `<i class="map-task-icon"></i>`}
      <strong data-map-task-title="${esc(task.id)}" title="${esc(task.onMap ? task.name : task.mapName || task.name)}">${esc(task.name)}</strong>
      <select data-map-task="${esc(task.id)}" data-status="${status}" aria-label="${esc(task.name)} 状态">
        ${options.map((item) => `<option value="${item}"${item === status ? " selected" : ""}>${STATUS_LABEL[item]}</option>`).join("")}
      </select>
      ${canLocate ? `<button type="button" class="map-task-locate" data-map-task-locate="${esc(task.id)}" title="定位到地图点位" aria-label="定位到地图点位">⌖</button>` : `<span class="map-task-locate"></span>`}
    </article>`;
  };
  const pin = (group: MapTask[]) => [...group.filter((task) => myClaims.has(task.id)), ...group.filter((task) => !myClaims.has(task.id))];
  const blocks = order.map((status) => {
    const group = pin(visible.filter((task) => statusOf(task) === status));
    if (!group.length) return "";
    if (status !== "active") {
      return `<p class="map-task-label">${STATUS_LABEL[status]} ${group.length}</p>${group.map(row).join("")}`;
    }
    const here = group.filter((task) => task.onMap);
    const elsewhere = group.filter((task) => !task.onMap);
    return `<p class="map-task-label">${STATUS_LABEL.active} ${group.length}</p>
      ${here.length ? `<p class="map-task-sub">本地图任务 ${here.length}</p>${here.map(row).join("")}` : ""}
      ${elsewhere.length ? `<p class="map-task-sub">非本地图任务 ${elsewhere.length}</p>${elsewhere.map(row).join("")}` : ""}`;
  }).join("");
  host.innerHTML = `
    <div class="map-task-tools">
      <input data-map-task-query value="${esc(query)}" placeholder="搜任务" />
      <div>
        <button type="button" data-map-task-scope="map" class="${scope === "map" ? "on" : ""}">本图</button>
        <button type="button" data-map-task-scope="all" class="${scope === "all" ? "on" : ""}">全部</button>
      </div>
    </div>
    ${tasks.length ? "" : `<p>${esc(note)}</p>`}
    ${blocks}
    ${tasks.length && !visible.length ? `<p>没有匹配的任务。</p>` : ""}`;
  const panel = host.closest("#task-panel");
  let badge = panel?.querySelector<HTMLElement>("#map-task-saving");
  if (!saving) {
    badge?.remove();
  } else if (panel) {
    if (!badge) {
      badge = document.createElement("p");
      badge.id = "map-task-saving";
      badge.className = "map-task-saving";
      panel.append(badge);
    }
    badge.textContent = "正在保存…";
  }
}

function floatNode() {
  let node = document.querySelector<HTMLElement>("#map-task-float");
  if (!node) {
    node = document.createElement("div");
    node.id = "map-task-float";
    node.className = "map-task-float";
    node.hidden = true;
    document.body.append(node);
  }
  return node;
}

function hideFloat() {
  hoverId = "";
  hoverAnchor = null;
  const node = document.querySelector<HTMLElement>("#map-task-float");
  if (node) node.hidden = true;
}

async function ensureDetail(task: MapTask) {
  if (detailReady.has(task.id) || detailLoading.has(task.id) || !slug) return;
  detailFailed.delete(task.id);
  detailLoading.add(task.id);
  try {
    const data = await invoke<{ items?: Record<string, unknown>[] }>("site_get", {
      path: `/guides/tarkov/raid-prep?map=${encodeURIComponent(slug)}&geometry=true&ids=${encodeURIComponent(task.id)}`,
    });
    const source = (data.items || []).find((item) => String(item.id || "") === task.id);
    task.objectives = readObjectives(source?.objectives, slug, task.onMap);
    task.fails = readFails(source?.fail_conditions);
    detailReady.add(task.id);
  } catch {
    detailFailed.add(task.id);
  } finally {
    detailLoading.delete(task.id);
    if (hoverId === task.id && hoverAnchor) showFloat(task, hoverAnchor, false);
    if (guideId === task.id) paintGuide();
  }
}

function showFloat(task: MapTask, anchor: HTMLElement, fetch = true) {
  hoverId = task.id;
  hoverAnchor = anchor;
  if (fetch && !detailReady.has(task.id)) void ensureDetail(task);
  const doneTask = statusOf(task) === "done";
  const here = task.objectives.filter((item) => item.onMap);
  const elsewhere = task.objectives.filter((item) => !item.onMap);
  const groups = new Map<string, MapObjective[]>();
  for (const item of elsewhere) {
    const key = item.mapName || "其他地图";
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  const line = (item: MapObjective, onMap: boolean) => {
    const checked = doneTask || objectiveDone(task.id, item.id);
    return `<label class="map-task-obj${checked ? " done" : ""}${onMap ? "" : " other"}">
      <input type="checkbox" data-map-obj="${esc(item.id)}" data-map-obj-task="${esc(task.id)}" ${checked ? "checked" : ""} />
      <span>${esc(item.text)}</span>
    </label>`;
  };
  const icon = traderIcon(traderSlugOf(task.traderSlug, task.trader));
  const ready = detailReady.has(task.id);
  const body = !ready
    ? `<p class="map-task-float-loading">${detailFailed.has(task.id) ? "加载失败" : "正在加载…"}</p>`
    : `${here.length ? `<div class="map-task-float-here">${here.map((item) => line(item, true)).join("")}</div>` : ""}
    ${[...groups.entries()].map(([name, items]) => `<div class="map-task-float-else"><p>${esc(name)}</p>${items.map((item) => line(item, false)).join("")}</div>`).join("")}
    ${!task.objectives.length && !task.fails.length ? `<p class="map-task-float-empty">无目标数据</p>` : ""}
    ${task.fails.length ? `<div class="map-task-float-fails">${task.fails.map((item) => `<p><b>${esc(item.label)}</b><span>${esc(item.text)}</span></p>`).join("")}</div>` : ""}`;
  const node = floatNode();
  node.innerHTML = `
    <div class="map-task-float-head">
      ${icon ? `<img src="${esc(icon)}" alt="" />` : ""}
      <strong>${esc(task.name)}</strong>
    </div>
    ${body}`;
  node.hidden = false;
  const row = anchor.getBoundingClientRect();
  const panel = document.querySelector("#task-panel")?.getBoundingClientRect();
  const edge = panel?.left ?? row.left;
  node.style.left = "0px";
  node.style.top = "0px";
  const box = node.getBoundingClientRect();
  let left = edge - box.width - 10;
  if (left < 8) left = row.right + 10;
  let top = row.top;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - box.height);
  node.style.left = `${Math.max(8, left)}px`;
  node.style.top = `${top}px`;
}

function taskFromRow(row: Element | null) {
  const id = row?.getAttribute("data-map-task-row") || "";
  return tasks.find((item) => item.id === id) || null;
}

function bindHover() {
  if (hoverBound) return;
  hoverBound = true;
  document.addEventListener("pointerover", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#map-task-float")) {
      window.clearTimeout(hoverTimer);
      return;
    }
    const row = target.closest<HTMLElement>("[data-map-task-row]");
    if (!row || target.closest("select")) return;
    const task = taskFromRow(row);
    if (!task) return;
    window.clearTimeout(hoverTimer);
    showFloat(task, row);
  });
  document.addEventListener("pointerout", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const next = event.relatedTarget;
    const inside = next instanceof Element && (next.closest("[data-map-task-row]") || next.closest("#map-task-float"));
    if (inside) return;
    if (!target.closest("[data-map-task-row]") && !target.closest("#map-task-float")) return;
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(hideFloat, 180);
  });
  document.addEventListener("scroll", hideFloat, true);
}

export function patchLoggedQuest(kind: "started" | "failed" | "completed", taskId: string) {
  if (!tasks.length) return;
  const known = tasks.find((item) => item.id.trim().toLowerCase() === taskId.trim().toLowerCase());
  const id = known?.id || taskId;
  drop(done, id);
  drop(started, id);
  drop(failed, id);
  if (kind === "completed") done.add(id);
  else if (kind === "failed") failed.add(id);
  else started.add(id);
  paint();
  progressWatch?.();
}

export function clearMapTasks() {
  slug = "";
  tasks = [];
}

export async function mountMapTasks(next: string) {
  bindHover();
  if (!document.querySelector("#task-body")) return;
  if (slug === next && tasks.length) {
    paint();
    return;
  }
  slug = next;
  note = "正在读取任务…";
  tasks = [];
  detailReady.clear();
  detailLoading.clear();
  detailFailed.clear();
  hideFloat();
  paint();
  try {
    const [list, progress] = await Promise.all([
      invoke<{ items?: Record<string, unknown>[] }>("site_get", { path: `/guides/tarkov/raid-prep?map=${encodeURIComponent(next)}` }),
      invoke<Record<string, unknown>>("site_get", { path: "/guides/tarkov/task-dones" }),
    ]);
    if (slug !== next) return;
    tasks = (list.items || []).map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || item.normalized_name || item.id || ""),
      trader: String(item.trader_name || item.traderName || ""),
      traderSlug: String(item.trader_slug || item.traderSlug || ""),
      onMap: Boolean(item.on_this_map ?? item.onThisMap),
      mapName: String(item.map_name || item.mapName || ""),
      hasMarkers: Boolean(item.has_map_markers ?? item.hasMapMarkers),
      objectives: [],
      fails: [],
    })).filter((item) => item.id);
    for (const task of tasks) {
      const source = (list.items || []).find((item) => String(item.id || "") === task.id);
      task.objectives = readObjectives(source?.objectives, next, task.onMap);
      task.fails = readFails(source?.fail_conditions);
    }
    done = new Set((Array.isArray(progress.task_ids) ? progress.task_ids : []).map(String));
    started = new Set((Array.isArray(progress.started_ids) ? progress.started_ids : []).map(String));
    failed = new Set((Array.isArray(progress.failed_ids) ? progress.failed_ids : []).map(String));
    objectives = Array.isArray(progress.objective_dones) ? progress.objective_dones as { task_id: string; objective_id: string }[] : [];
    note = tasks.length ? "" : "这张图没有任务";
  } catch (error) {
    if (slug !== next) return;
    note = error instanceof Error ? error.message : "任务读取失败";
    tasks = [];
  }
  paint();
  progressWatch?.();
}

export function watchMapTasks(onProgress: () => void, onClaim: (id: string, on: boolean) => void, onLocate: (id: string) => void, onObjective: (taskId: string, objectiveId: string, done: boolean) => void) {
  progressWatch = onProgress;
  claimWatch = onClaim;
  locateWatch = onLocate;
  objectiveWatch = onObjective;
}

export function applyRoomClaims(claims: { taskId: string; userId: number; name: string }[], selfId: number) {
  const mine = new Set<string>();
  const order: string[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    if (!seen.has(claim.taskId)) {
      seen.add(claim.taskId);
      order.push(claim.taskId);
    }
    if (selfId > 0 && claim.userId === selfId) mine.add(claim.taskId);
  }
  myClaims = mine;
  claimOrder = order;
  const people = new Map<string, { name: string; userId: number }[]>();
  for (const claim of claims) {
    const list = people.get(claim.taskId) || [];
    if (!list.some((item) => item.userId === claim.userId)) list.push({ name: claim.name || `用户${claim.userId}`, userId: claim.userId });
    people.set(claim.taskId, list);
  }
  claimPeople = people;
  paint();
  if (guideId) paintGuide();
}

export function setMapHighlight(id: string) {
  highlightId = id;
  paint();
  document.querySelector(`[data-map-task-row="${id}"]`)?.scrollIntoView({ block: "nearest" });
}

export function mapQuestProgress() {
  return {
    started: [...started],
    done: [...done],
    objectives: objectives.map((item) => ({ taskId: item.task_id, objectiveId: item.objective_id })),
    onMapIds: tasks.filter((task) => task.onMap).map((task) => task.id),
  };
}

function guideUrl(id: string) {
  return /^[a-f0-9]{24}$/i.test(id) ? `https://www.eftarkov.com/news/id/${encodeURIComponent(id)}.html` : "";
}

function guideTasks() {
  const picked = claimOrder.map((id) => tasks.find((task) => task.id === id)).filter((task): task is MapTask => Boolean(task));
  const current = tasks.find((task) => task.id === guideId);
  if (current && !picked.some((task) => task.id === current.id)) return [current, ...picked];
  return picked.length ? picked : current ? [current] : [];
}

function paintGuide() {
  let node = document.querySelector<HTMLElement>("#map-guide");
  if (!guideId) {
    node?.remove();
    return;
  }
  if (!node) {
    node = document.createElement("div");
    node.id = "map-guide";
    node.className = "map-guide";
    document.body.append(node);
  }
  const rows = guideTasks();
  const active = rows.find((task) => task.id === guideId) || rows[0];
  if (active && !detailReady.has(active.id)) void ensureDetail(active);
  const people = (id: string) => (claimPeople.get(id) || []).map((person) => `<span class="map-guide-person"><i style="background:${colorForUserId(person.userId)}"></i>${esc(person.name)}</span>`).join("") || `<span class="map-guide-none">—</span>`;
  const side = rows.map((task) => {
    const on = task.id === guideId;
    const doneTask = statusOf(task) === "done";
    const icon = traderIcon(traderSlugOf(task.traderSlug, task.trader));
    return `<button type="button" class="map-guide-row${on ? " on" : ""}" data-map-guide-task="${esc(task.id)}">
      <span class="map-guide-people">${people(task.id)}</span>
      <span class="map-guide-task"><i style="background:${colorForTaskId(task.id)}"></i>${icon ? `<img src="${esc(icon)}" alt="" />` : ""}<span class="${doneTask ? "done" : ""}">${esc(task.name)}</span></span>
    </button>`;
  }).join("");
  const progress = active
    ? `<div class="map-guide-progress"><p>任务进度</p>${active.objectives.length ? active.objectives.map((item) => {
        const checked = statusOf(active) === "done" || objectiveDone(active.id, item.id);
        return `<label class="map-task-obj${checked ? " done" : ""}"><input type="checkbox" data-map-obj="${esc(item.id)}" data-map-obj-task="${esc(active.id)}" ${checked ? "checked" : ""} /><span>${esc(item.text)}</span></label>`;
      }).join("") : `<p class="map-guide-none">${detailReady.has(active.id) ? "无目标数据" : "正在加载…"}</p>`}</div>`
    : "";
  const url = active ? guideUrl(active.id) : "";
  node.innerHTML = `<div class="map-guide-card">
    <header><strong>任务攻略总览</strong><button type="button" data-map-guide-close>关闭</button></header>
    <div class="map-guide-body">
      <aside>${progress}<div class="map-guide-list">${side || `<p class="map-guide-none">勾选任务后查看中文图文攻略</p>`}</div></aside>
      <div class="map-guide-main">
        <p>攻略内嵌自 <a href="https://www.eftarkov.com" target="_blank" rel="noreferrer">eftarkov.com</a>${url ? ` · <a href="${esc(url)}" target="_blank" rel="noreferrer">新标签打开</a>` : ""}</p>
        ${url ? `<iframe src="${esc(url)}" title="任务攻略"></iframe>` : `<p class="map-guide-none">这个任务没有对应攻略页</p>`}
      </div>
    </div>
  </div>`;
}

export function openMapGuide(id: string) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  guideId = id;
  hideFloat();
  paintGuide();
}

export function closeMapGuide() {
  guideId = "";
  paintGuide();
}

export function revealMapTask(id: string) {
  const task = tasks.find((item) => item.id === id);
  const row = document.querySelector<HTMLElement>(`[data-map-task-row="${id}"]`);
  if (!task || !row) return;
  row.scrollIntoView({ block: "nearest" });
  showFloat(task, row, true);
}

export function setMapObjective(taskId: string, objectiveId: string, nextDone: boolean) {
  objectives = objectives.filter((item) => !(item.task_id.trim().toLowerCase() === taskId.trim().toLowerCase() && item.objective_id.trim().toLowerCase() === objectiveId.trim().toLowerCase()));
  if (nextDone) objectives.push({ task_id: taskId, objective_id: objectiveId });
  if (!nextDone && has(done, taskId)) {
    drop(done, taskId);
    started.add(taskId);
  }
  const host = document.querySelector<HTMLElement>("#map-task-float");
  if (host && hoverId === taskId) {
    const task = tasks.find((item) => item.id === taskId);
    if (task) showFloat(task, hoverAnchor || host, false);
  }
  void save();
  if (guideId) paintGuide();
}

async function save() {
  saving = true;
  paint();
  try {
    await invoke("site_put", {
      path: "/guides/tarkov/task-dones",
      body: {
        task_ids: [...done],
        started_ids: [...started],
        failed_ids: [...failed],
        objective_dones: objectives,
        replace: true,
      },
    });
  } catch (error) {
    note = error instanceof Error ? error.message : "保存失败";
  } finally {
    saving = false;
    paint();
    progressWatch?.();
  }
}

const SUMMARY_LABEL: Record<string, string> = {
  findItem: "找到",
  findQuestItem: "找到",
  giveItem: "上交",
  giveQuestItem: "上交",
  plantItem: "藏匿",
  mark: "标记",
  useItem: "使用",
  shoot: "击杀",
};
const COLUMN_TYPE: Record<string, string> = {
  findQuestItem: "findItem",
  giveQuestItem: "giveItem",
};
const BRING_TYPES = ["plantItem", "mark", "useItem"];
const REST_TYPES = ["findItem", "giveItem"];

type SummaryNeed = { id: string; name: string; count: number; icon: string; fir: boolean; type: string };
type SummaryRow = {
  id: string;
  name: string;
  traderSlug: string;
  keys: SummaryNeed[];
  bring: SummaryNeed[];
  columns: Record<string, SummaryNeed[]>;
  shoot: { text: string; count: number }[];
};

function itemThumb(icon: string, id: string) {
  const url = icon.trim();
  if (url) return url.replace(/-(?:icon|grid-image|base-image|512|8x|image)\.webp/i, "-icon.webp");
  return /^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-icon.webp` : "";
}

function readNeeds(raw: unknown, count: number, fir: boolean, type: string): SummaryNeed[] {
  if (!Array.isArray(raw)) return [];
  const out: SummaryNeed[] = [];
  const walk = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    const id = String(row.id || "").trim();
    const name = String(row.name || row.shortName || row.short_name || "").trim();
    if (!name && !id) return;
    const key = id || name;
    const found = out.find((entry) => entry.id === key);
    if (found) {
      found.count += count;
      return;
    }
    out.push({
      id: key,
      name: name || "未知物品",
      count,
      icon: String(row.icon_link || row.iconLink || "").trim(),
      fir,
      type,
    });
  };
  walk(raw);
  return out;
}

function pushNeed(list: SummaryNeed[], item: SummaryNeed) {
  const found = list.find((entry) => entry.id === item.id);
  if (found) found.count += item.count;
  else list.push({ ...item });
}

function summaryRows(items: Record<string, unknown>[]): SummaryRow[] {
  const picked = tasks.filter((task) => statusOf(task) === "active" && task.onMap);
  const byId = new Map(items.map((item) => [String(item.id || ""), item]));
  return picked.map((task) => {
    const source = byId.get(task.id);
    const objectives = Array.isArray(source?.objectives) ? source.objectives : [];
    const row: SummaryRow = { id: task.id, name: task.name, traderSlug: traderSlugOf(task.traderSlug, task.trader), keys: [], bring: [], columns: {}, shoot: [] };
    for (const raw of objectives) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      const id = String(obj.id || "");
      if (id && objectiveDone(task.id, id)) continue;
      const rawType = String(obj.type || "");
      const type = COLUMN_TYPE[rawType] || rawType;
      const count = Math.max(1, Number(obj.count || 1));
      const fir = Boolean(obj.found_in_raid ?? obj.foundInRaid);
      const needs = readNeeds(obj.items, count, fir, type);
      if (BRING_TYPES.includes(type)) {
        if (needs.length) needs.forEach((item) => pushNeed(row.bring, item));
        else if (String(obj.description || "").trim()) pushNeed(row.bring, { id: String(obj.description), name: String(obj.description).trim(), count: 1, icon: "", fir: false, type });
      } else if (type === "shoot") {
        const text = String(obj.description || "").trim();
        if (text) row.shoot.push({ text, count });
      } else if (REST_TYPES.includes(type)) {
        const bucket = row.columns[type] || [];
        if (needs.length) needs.forEach((item) => pushNeed(bucket, item));
        else if (String(obj.description || "").trim()) pushNeed(bucket, { id: String(obj.description), name: String(obj.description).trim(), count: 1, icon: "", fir, type });
        if (bucket.length) row.columns[type] = bucket;
      }
      for (const key of readNeeds(obj.required_keys || obj.requiredKeys, 1, false, "key")) {
        if (!row.keys.some((item) => item.id === key.id)) row.keys.push(key);
      }
    }
    return row;
  });
}

function taskColor(id: string) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${Math.abs(hash) % 360} 58% 52%)`;
}

function typeChip(type: string, label = SUMMARY_LABEL[type] || type) {
  return `<span class="sum-type" data-tone="${esc(type)}">${esc(label)}</span>`;
}

function chip(item: SummaryNeed) {
  const src = itemThumb(item.icon, item.id);
  const meta = [item.fir ? "战局内" : "", item.type === "key" ? "" : ""].filter(Boolean);
  return `<span class="sum-need">
    ${src ? `<span class="sum-need-icon"><img src="${esc(src)}" alt="" /></span>` : ""}
    <span class="sum-need-body">
      <span class="sum-need-name">${esc(item.name)}${item.count > 1 && item.type !== "key" ? ` ×${item.count}` : ""}</span>
      ${meta.length ? `<span class="sum-need-meta">${esc(meta.join(" · "))}</span>` : ""}
    </span>
  </span>`;
}

function lineCount(row: SummaryRow) {
  const sizes = [row.keys.length, row.bring.length, row.shoot.length, ...REST_TYPES.map((type) => row.columns[type]?.length || 0)];
  return Math.max(1, ...sizes);
}

function blank(index: number, first: string) {
  return index === 0 ? first : `<span class="sum-none">—</span>`;
}

export function closeMapSummary() {
  const modal = document.querySelector<HTMLElement>("#map-summary-modal");
  if (modal) modal.hidden = true;
}

export async function openMapSummary() {
  const modal = document.querySelector<HTMLElement>("#map-summary-modal");
  const body = document.querySelector("#map-summary-body");
  if (!modal || !body) return;
  modal.hidden = false;
  const picked = tasks.filter((task) => statusOf(task) === "active" && task.onMap);
  if (!picked.length) {
    body.innerHTML = `<p class="map-summary-empty">还没有进行中的本地图任务</p>`;
    return;
  }
  body.innerHTML = `<p class="map-summary-empty">正在加载…</p>`;
  try {
    const ids = picked.map((task) => task.id).slice(0, 40).join(",");
    const data = await invoke<{ items?: Record<string, unknown>[] }>("site_get", {
      path: `/guides/tarkov/raid-prep?map=${encodeURIComponent(slug)}&geometry=true&ids=${encodeURIComponent(ids)}`,
    });
    const rows = summaryRows(data.items || []);
    const extra = REST_TYPES.filter((type) => rows.some((row) => row.columns[type]?.length));
    const showBring = rows.some((row) => row.bring.length);
    const showShoot = rows.some((row) => row.shoot.length);
    const bringSpan = 1 + (showBring ? 1 : 0);
    const columnCount = 2 + bringSpan + extra.length + (showShoot ? 1 : 0) + 1;
    const kit = new Map<string, SummaryNeed>();
    for (const row of rows) {
      for (const item of row.bring) {
        const found = kit.get(item.id);
        if (found) found.count += item.count;
        else kit.set(item.id, { ...item });
      }
    }
    const kitHtml = kit.size
      ? `<div class="map-summary-kit-list">${[...kit.values()].map((item) => chip(item)).join("")}</div>`
      : `<span class="map-summary-kit-empty">没有要带进战局的藏匿 / 标记 / 使用物</span>`;
    const bodyRows = rows.flatMap((row) => {
      const total = lineCount(row);
      const icon = traderIcon(row.traderSlug);
      return Array.from({ length: total }, (_, index) => {
        const key = row.keys[index];
        const bring = row.bring[index];
        const shoot = row.shoot[index];
        const continued = index < total - 1 ? " sum-cont" : "";
        return `<tr class="sum-mine${continued}">
          <td>${index === 0 ? `<span class="sum-person"><i></i>你</span>` : ""}</td>
          <td>${index === 0 ? `<div class="map-summary-task"><i class="sum-swatch" style="background:${taskColor(row.id)}"></i>${icon ? `<img src="${esc(icon)}" alt="" />` : ""}<strong>${esc(row.name)}</strong></div>` : ""}</td>
          <td class="sum-col sum-col-first${showBring ? "" : " sum-col-last"}">${key ? chip(key) : blank(index, "无所需钥匙")}</td>
          ${showBring ? `<td class="sum-col sum-col-last">${bring ? `<span class="sum-bring-item">${typeChip(bring.type)}${chip(bring)}</span>` : blank(index, "—")}</td>` : ""}
          ${extra.map((type) => {
            const item = row.columns[type]?.[index];
            return `<td>${item ? chip(item) : blank(index, "—")}</td>`;
          }).join("")}
          ${showShoot ? `<td class="sum-shoot">${shoot ? `<span class="sum-shoot-text">${esc(shoot.text)}${shoot.count > 1 ? `<b>×${shoot.count}</b>` : ""}</span>` : blank(index, "—")}</td>` : ""}
          <td></td>
        </tr>`;
      });
    }).join("");
    body.innerHTML = `
      <div class="map-summary-kit"><span class="map-summary-kit-label">你要准备的东西：</span>${kitHtml}</div>
      <div class="map-summary-scroll">
        <table>
          <colgroup>${Array.from({ length: columnCount }, () => `<col />`).join("")}</colgroup>
          <thead>
            <tr>
              <th rowspan="2">参与人员</th>
              <th rowspan="2">任务名称</th>
              <th class="sum-group" colspan="${bringSpan}" title="钥匙、藏匿物、标记物、使用物：从保险箱带进战局">进局携带</th>
              ${extra.map((type) => `<th rowspan="2">${typeChip(type)}</th>`).join("")}
              ${showShoot ? `<th rowspan="2">${typeChip("shoot")}</th>` : ""}
              <th rowspan="2" title="必做步骤全部勾完的人">已完成</th>
            </tr>
            <tr>
              <th class="sum-sub sum-col sum-col-first${showBring ? "" : " sum-col-last"}">${typeChip("key", "钥匙")}</th>
              ${showBring ? `<th class="sum-sub sum-col sum-col-last">${["plantItem", "mark", "useItem"].map((type, index) => `${index ? `<span class="sum-slash">/</span>` : ""}${typeChip(type)}`).join("")}</th>` : ""}
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>`;
  } catch (error) {
    body.innerHTML = `<p class="map-summary-empty">${esc(error instanceof Error ? error.message : "总结加载失败")}</p>`;
  }
}

export function onMapObjectiveChange(target: EventTarget | null) {
  if (!(target instanceof HTMLInputElement) || !target.dataset.mapObj) return false;
  const taskId = target.dataset.mapObjTask || "";
  const objectiveId = target.dataset.mapObj;
  if (objectiveWatch) objectiveWatch(taskId, objectiveId, target.checked);
  else setMapObjective(taskId, objectiveId, target.checked);
  return true;
}

export function onMapTaskChange(target: EventTarget | null) {
  if (!(target instanceof HTMLSelectElement) || !target.dataset.mapTask) return false;
  const id = target.dataset.mapTask;
  const next = target.value as Status;
  drop(done, id);
  drop(started, id);
  drop(failed, id);
  if (next === "done") {
    done.add(id);
    const task = tasks.find((item) => item.id === id);
    const ids = (task?.objectives || []).map((objective) => objective.id);
    for (const objectiveId of ids) {
      if (!objectiveDone(id, objectiveId)) objectives.push({ task_id: id, objective_id: objectiveId });
    }
    for (const objectiveId of ids) objectiveWatch?.(id, objectiveId, true);
  } else if (next === "active") started.add(id);
  else if (next === "failed") failed.add(id);
  void save();
  return true;
}

export function onMapTaskInput(target: EventTarget | null) {
  if (!(target instanceof HTMLInputElement) || !target.matches("[data-map-task-query]")) return false;
  query = target.value.trim();
  paint();
  const input = document.querySelector<HTMLInputElement>("[data-map-task-query]");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  return true;
}

export function onMapTaskClick(target: Element) {
  if (target.closest("[data-map-guide-close]")) {
    closeMapGuide();
    return true;
  }
  const guideTask = target.closest<HTMLElement>("[data-map-guide-task]");
  if (guideTask?.dataset.mapGuideTask) {
    openMapGuide(guideTask.dataset.mapGuideTask);
    return true;
  }
  const claim = target.closest<HTMLInputElement>("[data-map-task-claim]");
  if (claim?.dataset.mapTaskClaim) {
    claimWatch?.(claim.dataset.mapTaskClaim, claim.checked);
    return true;
  }
  const title = target.closest<HTMLElement>("[data-map-task-title]");
  if (title?.dataset.mapTaskTitle) {
    highlightId = title.dataset.mapTaskTitle;
    paint();
    openMapGuide(title.dataset.mapTaskTitle);
    return true;
  }
  const name = target.closest<HTMLElement>("[data-map-task-locate]");
  if (name?.dataset.mapTaskLocate) {
    locateWatch?.(name.dataset.mapTaskLocate);
    return true;
  }
  const button = target.closest<HTMLButtonElement>("[data-map-task-scope]");
  if (!button?.dataset.mapTaskScope) return false;
  scope = button.dataset.mapTaskScope === "all" ? "all" : "map";
  paint();
  return true;
}

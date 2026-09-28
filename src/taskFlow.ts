import { mapTitle } from "./mapNames";
import { fadeIn, fadeOut } from "./motion";
import { isPending, spin } from "./spinner";

type Quest = {
  id: string;
  name: string;
  traderSlug: string;
  traderName: string;
  level: number;
  loyalty: number;
  prereq: string[];
  mutex: string[];
  blocked: string[];
  failPrereq: string[];
  failOr: string[];
  faction: string;
  mapSlug: string;
  mapName: string;
  objectives: string[];
  normalized: string;
  lineHint: string;
};

type Status = "todo" | "active" | "done" | "failed" | "unreachable";
type View = "list" | "tree";
type FlowNode = { task: Quest; extra: string[]; matched: boolean; children: FlowChild[] };
type FlowChild = { kind: "task"; node: FlowNode } | { kind: "choice"; options: FlowNode[] };
type Counts = { done: number; active: number; todo: number; failed: number; unreachable: number };

const STATUS_LABEL: Record<Status, string> = {
  todo: "未完成",
  active: "进行中",
  done: "已完成",
  failed: "失败",
  unreachable: "无法完成",
};
const STATUSES: Status[] = ["todo", "active", "done", "failed", "unreachable"];
const WRITABLE = new Set<Status>(["todo", "active", "done", "failed"]);
const VIEW_KEY = "zhange.guides.tarkov.taskProgressView.v1";
const DONES_KEY = "zhange.guides.tarkov.taskDones.v1";
const FACTION_KEY = "zhange.guides.tarkov.pmcFaction.v1";
const SYNC_FALLBACK = "zhange.app.taskSyncAt";
const TYPE_CANON: Record<string, string> = {
  findQuestItem: "findItem",
  giveQuestItem: "giveItem",
  plantQuestItem: "plantItem",
};
const TYPE_LABEL: Record<string, string> = {
  shoot: "击杀",
  findItem: "找到",
  giveItem: "上交",
  plantItem: "藏匿",
  mark: "标记",
  visit: "前往",
  extract: "撤离",
  useItem: "使用",
  buildWeapon: "改装",
  sellItem: "出售",
  haveItem: "持有",
  skill: "技能",
  traderLevel: "忠诚",
  traderStanding: "声望",
  playerLevel: "等级",
  hideoutStation: "藏身",
  taskStatus: "关联",
  experience: "状态",
  dialogue: "对话",
  globalVariable: "限制",
};
const TYPE_ORDER = Object.keys(TYPE_LABEL);
const RIBBON_COLOR = { prereq: "#7a7c70", blocked: "#c8932a", conflict: "#c45c4a" };

let quests: Quest[] = [];
let done = new Set<string>();
let started = new Set<string>();
let failed = new Set<string>();
let objectives: { task_id: string; objective_id: string }[] = [];
let traderSlug = "";
let visibleTrader = "";
let keyword = "";
let view: View = loadView();
let note = "正在读取任务进度…";
let saving = false;
let shellReady = false;
let railSig = "";
let flashTrader = "";
let flashTask = "";
let flashTimer = 0;
let popAnchor: HTMLElement | null = null;
let popTimer = 0;
let visibleById = new Map<string, Quest>();

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function key(id: string) {
  return id.trim().toLowerCase();
}

function has(pool: Set<string>, id: string) {
  return pool.has(key(id));
}

function hits(list: string[], pool: Set<string>) {
  return list.some((id) => has(pool, id));
}

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

function gameMode(): "pvp" | "pve" {
  return localStorage.getItem("zhange.guides.tarkov.gameMode") === "pve" ? "pve" : "pvp";
}

function factionChoice() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FACTION_KEY) || "null") as unknown;
    const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[gameMode()]
      : parsed;
    const name = String(raw || "").trim().toLowerCase();
    return name === "bear" || name === "usec" ? name : "";
  } catch {
    return "";
  }
}

function nowStamp() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

function readSyncAt() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DONES_KEY) || "null") as { v?: number; syncedAt?: Record<string, string> } | null;
    const fromWeb = parsed?.v === 1 ? String(parsed.syncedAt?.[gameMode()] || "").trim() : "";
    if (fromWeb) return fromWeb;
  } catch {
    /* 网页端进度缓存缺失时用本机记录 */
  }
  return sessionStorage.getItem(`${SYNC_FALLBACK}.${gameMode()}`) || "";
}

function stampSync(writeNote: boolean) {
  const at = nowStamp();
  sessionStorage.setItem(`${SYNC_FALLBACK}.${gameMode()}`, at);
  try {
    const raw = localStorage.getItem(DONES_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.v === 1) {
      const synced = parsed.syncedAt && typeof parsed.syncedAt === "object" ? parsed.syncedAt as Record<string, string> : {};
      parsed.syncedAt = { ...synced, [gameMode()]: at };
      localStorage.setItem(DONES_KEY, JSON.stringify(parsed));
    }
  } catch {
    /* 不新建网页端进度缓存，避免写坏结构 */
  }
  if (!writeNote) return;
  const node = document.querySelector("#path-note");
  if (node) node.textContent = `上次同步时间：${at}`;
}

export function noteTaskSynced() {
  stampSync(false);
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function traderLabel(name: string) {
  return name.split(/[（(]/)[0].trim() || name || "其他";
}

function displayName(task: Quest) {
  const name = task.name.trim() || task.id;
  const faction = task.faction.trim();
  const suffix = faction && faction !== "Any" ? ` (${faction})` : "";
  const hint = task.lineHint.trim();
  const hintSuffix = hint && hint !== faction ? `（${hint}）` : "";
  return `${name}${suffix}${hintSuffix}`;
}

function factionOk(task: Quest) {
  const selected = factionChoice();
  if (!selected) return true;
  const name = task.faction.trim().toLowerCase();
  if (!name || name === "any") return true;
  return name === selected;
}

function visibleQuests() {
  return quests.filter(factionOk);
}

function matches(task: Quest, query: string) {
  const needle = query.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!needle) return true;
  const hay = `${task.name} ${task.id} ${task.normalized} ${task.lineHint}`.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
  return hay.includes(needle) || hay.replace(/ /g, "").includes(needle.replace(/ /g, ""));
}

function mapLabel(task: Quest) {
  const title = mapTitle(task.mapSlug, task.mapName, "");
  return title.split(/[（(]/)[0].trim() || title;
}

function canonType(type: string) {
  const text = type.trim();
  return TYPE_CANON[text] || text;
}

function orderTypes(types: string[]) {
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const raw of types) {
    const next = canonType(raw);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    uniq.push(next);
  }
  return uniq.sort((left, right) => {
    const rankLeft = TYPE_ORDER.indexOf(left);
    const rankRight = TYPE_ORDER.indexOf(right);
    const a = rankLeft < 0 ? TYPE_ORDER.length : rankLeft;
    const b = rankRight < 0 ? TYPE_ORDER.length : rankRight;
    if (a !== b) return a - b;
    return left.localeCompare(right);
  });
}

function typeLabel(type: string) {
  return TYPE_LABEL[type] || type;
}

function statusOf(task: Quest, closed?: Set<string>): Status {
  const id = key(task.id);
  if (done.has(id)) return "done";
  if (failed.has(id) || hits(task.mutex, done)) return "failed";
  if (hits(task.blocked, done) || hits(task.blocked, started)) return "unreachable";
  if (id && closed?.has(id)) return "unreachable";
  if (hits(task.failPrereq, done)) return "unreachable";
  if (started.has(id)) return "active";
  return "todo";
}

function collectClosed(items: Quest[]) {
  const byId = new Map<string, Quest>();
  for (const item of items) byId.set(key(item.id), item);
  const closed = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, item] of byId) {
      if (done.has(id) || closed.has(id)) continue;
      const status = statusOf(item);
      if (status === "failed" || status === "unreachable") {
        closed.add(id);
        grew = true;
        continue;
      }
      if (item.prereq.some((raw) => closed.has(key(raw)))) {
        closed.add(id);
        grew = true;
        continue;
      }
      const failLocked = item.failPrereq.some((raw) => {
        const pid = key(raw);
        return Boolean(pid) && (done.has(pid) || (closed.has(pid) && !failed.has(pid)));
      });
      if (failLocked) {
        closed.add(id);
        grew = true;
        continue;
      }
      if (item.failOr.some((raw) => {
        const pid = key(raw);
        return Boolean(pid) && !done.has(pid) && !failed.has(pid) && closed.has(pid);
      })) {
        closed.add(id);
        grew = true;
      }
    }
  }
  return closed;
}

function available(task: Quest, closed: Set<string>) {
  if (statusOf(task, closed) !== "todo") return false;
  return task.prereq.every((id) => has(done, id))
    && task.failPrereq.every((id) => has(failed, id))
    && task.failOr.every((id) => has(done, id) || has(failed, id));
}

function derived(task: Quest, closed: Set<string>) {
  const status = statusOf(task, closed);
  if (status === "unreachable") return true;
  return status === "failed" && !failed.has(key(task.id));
}

function summary(items: Quest[]): Counts {
  const closed = collectClosed(items);
  const count: Counts = { done: 0, active: 0, todo: 0, failed: 0, unreachable: 0 };
  for (const task of items) count[statusOf(task, closed)] += 1;
  return count;
}

function rank(task: Quest, closed: Set<string>) {
  const status = statusOf(task, closed);
  if (status === "active") return 0;
  if (status === "todo") return available(task, closed) ? 1 : 2;
  if (status === "failed") return 3;
  if (status === "unreachable") return 4;
  return 5;
}

function traderGroups(items: Quest[]) {
  const grouped = new Map<string, Quest[]>();
  const order: string[] = [];
  for (const task of items) {
    const slug = task.traderSlug || "other";
    if (!grouped.has(slug)) order.push(slug);
    const list = grouped.get(slug) || [];
    list.push(task);
    grouped.set(slug, list);
  }
  return order.map((slug) => ({
    slug,
    name: traderLabel(grouped.get(slug)?.[0]?.traderName || slug),
    items: grouped.get(slug) || [],
  }));
}

function asIdList(values: Iterable<string>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const id = key(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function pushEdge(map: Map<string, string[]>, from: string, to: string) {
  if (!from || !to || from === to) return;
  const row = map.get(from) || [];
  if (!row.includes(to)) row.push(to);
  map.set(from, row);
}

function lineIndex(items: Quest[]) {
  const prereqById = new Map<string, string[]>();
  const childrenById = new Map<string, string[]>();
  const blockedById = new Map<string, string[]>();
  const mutexById = new Map<string, string[]>();
  for (const item of items) {
    const id = key(item.id);
    if (!id) continue;
    for (const raw of item.prereq) pushEdge(prereqById, id, key(raw));
    for (const raw of item.prereq) pushEdge(childrenById, key(raw), id);
    for (const raw of item.blocked) pushEdge(blockedById, id, key(raw));
    for (const raw of item.mutex) {
      const other = key(raw);
      pushEdge(mutexById, id, other);
      pushEdge(mutexById, other, id);
    }
  }
  return { prereqById, childrenById, blockedById, mutexById };
}

function descendants(taskId: string, childrenById: Map<string, string[]>) {
  const root = key(taskId);
  const out: string[] = [];
  const seen = new Set<string>([root]);
  const stack = [...(childrenById.get(root) || [])];
  while (stack.length && seen.size < 256) {
    const cur = key(stack.pop() || "");
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    stack.push(...(childrenById.get(cur) || []));
  }
  return out;
}

function applyMutex(doneIds: string[], startedIds: string[], failedIds: string[], mutexById: Map<string, string[]>, prefer: string[]) {
  const doneList = asIdList(doneIds);
  const doneSet = new Set(doneList);
  const drop = new Set<string>();
  for (const id of doneList) {
    if (drop.has(id)) continue;
    const clique: string[] = [];
    const seen = new Set<string>();
    for (const raw of [id, ...(mutexById.get(id) || [])]) {
      if (!raw || seen.has(raw) || !doneSet.has(raw) || drop.has(raw)) continue;
      seen.add(raw);
      clique.push(raw);
    }
    if (clique.length <= 1) continue;
    let winner = "";
    let bestPrefer = -1;
    for (const item of clique) {
      const index = prefer.lastIndexOf(item);
      if (index > bestPrefer) {
        winner = item;
        bestPrefer = index;
      }
    }
    if (!winner) {
      let bestDone = -1;
      for (const item of clique) {
        const index = doneList.lastIndexOf(item);
        if (index >= bestDone) {
          winner = item;
          bestDone = index;
        }
      }
    }
    for (const other of clique) if (other !== winner) drop.add(other);
  }
  const nextDone = doneList.filter((id) => !drop.has(id));
  const keep = new Set(nextDone);
  const extraFail = new Set(drop);
  const startedSet = new Set(asIdList(startedIds));
  for (const id of nextDone) {
    for (const other of mutexById.get(id) || []) {
      if (!other || keep.has(other)) continue;
      if (startedSet.has(other)) extraFail.add(other);
    }
  }
  const nextFailed = asIdList([...failedIds, ...extraFail]).filter((id) => !keep.has(id));
  const failedSet = new Set(nextFailed);
  const nextStarted = asIdList(startedIds).filter((id) => !keep.has(id) && !failedSet.has(id));
  return { done: nextDone, started: nextStarted, failed: nextFailed };
}

function dropBlocked(doneIds: string[], startedIds: string[], failedIds: string[], blockedById: Map<string, string[]>) {
  const doneList = asIdList(doneIds);
  const startedList = asIdList(startedIds);
  const failedList = asIdList(failedIds);
  const doneSet = new Set(doneList);
  const startedSet = new Set(startedList);
  const drop = new Set<string>();
  for (const [id, blockers] of blockedById) {
    if (blockers.some((blocker) => doneSet.has(blocker) || startedSet.has(blocker))) drop.add(id);
  }
  if (!drop.size) return { done: doneList, started: startedList, failed: failedList };
  return {
    done: doneList.filter((id) => !drop.has(id)),
    started: startedList.filter((id) => !drop.has(id)),
    failed: failedList.filter((id) => !drop.has(id)),
  };
}

function applyLine(doneIds: string[], startedIds: string[], failedIds: string[], index: ReturnType<typeof lineIndex>, prefer: string[]) {
  const mutexed = applyMutex(doneIds, startedIds, failedIds, index.mutexById, prefer);
  return dropBlocked(mutexed.done, mutexed.started, mutexed.failed, index.blockedById);
}

function walkComplete(startId: string, pools: { done: Set<string>; started: Set<string>; failed: Set<string> }, prereqById: Map<string, string[]>, skipRoot: boolean) {
  const walking = new Set<string>();
  const visit = (id: string) => {
    if (!id || walking.has(id) || walking.size > 32) return;
    walking.add(id);
    pools.done.add(id);
    pools.started.delete(id);
    pools.failed.delete(id);
    for (const parent of prereqById.get(id) || []) visit(parent);
  };
  if (skipRoot) {
    walking.add(startId);
    for (const parent of prereqById.get(startId) || []) visit(parent);
    return;
  }
  visit(startId);
}

function setLineStatus(taskId: string, status: Status) {
  const index = lineIndex(quests);
  const ident = key(taskId);
  const pools = {
    done: new Set(asIdList(done)),
    started: new Set(asIdList(started).filter((id) => !done.has(id) && !failed.has(id))),
    failed: new Set(asIdList(failed).filter((id) => !done.has(id))),
  };
  const dropSelf = () => {
    pools.done.delete(ident);
    pools.started.delete(ident);
    pools.failed.delete(ident);
  };
  const dropKids = () => {
    for (const child of descendants(ident, index.childrenById)) {
      pools.done.delete(child);
      pools.started.delete(child);
    }
  };
  if (status === "done") walkComplete(ident, pools, index.prereqById, false);
  else if (status === "active") {
    walkComplete(ident, pools, index.prereqById, true);
    dropSelf();
    dropKids();
    pools.started.add(ident);
  } else if (status === "failed") {
    dropSelf();
    pools.failed.add(ident);
    dropKids();
  } else {
    dropSelf();
    dropKids();
  }
  return applyLine([...pools.done], [...pools.started], [...pools.failed], index, status === "done" ? [ident] : []);
}

function ancestorSet(taskId: string, catalog: Map<string, Quest>) {
  const out = new Set<string>();
  const stack = [...(catalog.get(taskId)?.prereq || [])].filter((id) => catalog.has(id));
  let guard = 0;
  while (stack.length && guard < 512) {
    guard += 1;
    const cur = stack.pop();
    if (!cur || out.has(cur)) continue;
    out.add(cur);
    for (const next of catalog.get(cur)?.prereq || []) if (catalog.has(next)) stack.push(next);
  }
  return out;
}

function primaryParent(task: Quest, catalog: Map<string, Quest>) {
  const parents = task.prereq.filter((id) => catalog.has(id));
  if (!parents.length) return "";
  const latest = parents.filter((left) => !parents.some((right) => right !== left && ancestorSet(right, catalog).has(left)));
  latest.sort();
  return latest[0] || parents[0];
}

function dropCycles(parentOf: Map<string, string>) {
  const visiting = new Set<string>();
  const finished = new Set<string>();
  const walk = (id: string) => {
    if (finished.has(id)) return;
    if (visiting.has(id)) {
      parentOf.delete(id);
      return;
    }
    visiting.add(id);
    const parent = parentOf.get(id);
    if (parent) walk(parent);
    visiting.delete(id);
    finished.add(id);
  };
  for (const id of [...parentOf.keys()]) walk(id);
}

function mutexPair(left: Quest, right: Quest) {
  return left.id !== right.id && left.mutex.includes(right.id) && right.mutex.includes(left.id);
}

function groupNodes(nodes: FlowNode[]): FlowChild[] {
  const remaining = [...nodes].sort((a, b) => a.task.name.localeCompare(b.task.name, "zh-CN"));
  const out: FlowChild[] = [];
  while (remaining.length) {
    const head = remaining.shift();
    if (!head) break;
    const clique = [head];
    let grew = true;
    while (grew) {
      grew = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const cand = remaining[index];
        if (clique.every((row) => mutexPair(row.task, cand.task))) {
          clique.push(cand);
          remaining.splice(index, 1);
          grew = true;
        }
      }
    }
    if (clique.length >= 2) out.push({ kind: "choice", options: clique.sort((a, b) => a.task.name.localeCompare(b.task.name, "zh-CN")) });
    else out.push({ kind: "task", node: head });
  }
  return out;
}

function buildForest(items: Quest[]): FlowChild[] {
  const catalog = new Map<string, Quest>();
  for (const task of items) if (task.id && !catalog.has(task.id)) catalog.set(task.id, task);
  const parentOf = new Map<string, string>();
  for (const task of catalog.values()) {
    const parent = primaryParent(task, catalog);
    if (parent && parent !== task.id) parentOf.set(task.id, parent);
  }
  dropCycles(parentOf);
  const kids = new Map<string, Quest[]>();
  for (const [child, parent] of parentOf) {
    const task = catalog.get(child);
    if (!task) continue;
    const list = kids.get(parent) || [];
    list.push(task);
    kids.set(parent, list);
  }
  const visiting = new Set<string>();
  const toNode = (task: Quest): FlowNode => {
    if (visiting.has(task.id)) return { task, extra: [], matched: true, children: [] };
    visiting.add(task.id);
    const primary = parentOf.get(task.id) || "";
    const extra = task.prereq.filter((id) => id !== primary && id !== task.id);
    const children = groupNodes((kids.get(task.id) || []).map(toNode));
    visiting.delete(task.id);
    return { task, extra, matched: true, children };
  };
  return groupNodes([...catalog.values()].filter((task) => !parentOf.has(task.id)).map(toNode));
}

function closureOf(native: Quest[], catalog: Map<string, Quest>) {
  const out = new Map<string, Quest>();
  const stack = [...native];
  while (stack.length) {
    const task = stack.pop();
    if (!task || out.has(task.id)) continue;
    out.set(task.id, task);
    for (const id of task.prereq) {
      const parent = catalog.get(id);
      if (parent && !out.has(parent.id)) stack.push(parent);
    }
  }
  return [...out.values()];
}

function pruneNode(node: FlowNode, native: Set<string>): FlowNode | null {
  const children = pruneForest(node.children, native);
  if (!native.has(node.task.id) && !children.length) return null;
  return { ...node, children };
}

function pruneForest(children: FlowChild[], native: Set<string>): FlowChild[] {
  const out: FlowChild[] = [];
  for (const child of children) {
    if (child.kind === "choice") {
      const options = child.options.map((node) => pruneNode(node, native)).filter((node): node is FlowNode => Boolean(node));
      if (options.length >= 2) out.push({ kind: "choice", options });
      else if (options.length === 1) out.push({ kind: "task", node: options[0] });
      continue;
    }
    const node = pruneNode(child.node, native);
    if (node) out.push({ kind: "task", node });
  }
  return out;
}

function traderForest(native: Quest[], catalog: Map<string, Quest>) {
  const ids = new Set(native.map((task) => task.id));
  return pruneForest(buildForest(closureOf(native, catalog)), ids);
}

function filterNode(node: FlowNode, keep: (task: Quest) => boolean): FlowNode | null {
  const children = filterForest(node.children, keep);
  const matched = keep(node.task);
  if (!matched && !children.length) return null;
  return { ...node, matched, children };
}

function filterForest(children: FlowChild[], keep: (task: Quest) => boolean): FlowChild[] {
  const out: FlowChild[] = [];
  for (const child of children) {
    if (child.kind === "choice") {
      const options = child.options.map((node) => filterNode(node, keep)).filter((node): node is FlowNode => Boolean(node));
      if (options.length >= 2) out.push({ kind: "choice", options });
      else if (options.length === 1) out.push({ kind: "task", node: options[0] });
      continue;
    }
    const node = filterNode(child.node, keep);
    if (node) out.push({ kind: "task", node });
  }
  return out;
}

function nodeDepth(node: FlowNode): number {
  return 1 + Math.max(0, ...node.children.map(childDepth));
}

function childDepth(child: FlowChild): number {
  if (child.kind === "choice") return Math.max(0, ...child.options.map(nodeDepth));
  return nodeDepth(child.node);
}

function childName(child: FlowChild) {
  if (child.kind === "choice") return child.options.map((row) => row.task.name || row.task.id).join(",");
  return child.node.task.name || child.node.task.id;
}

function splitForest(forest: FlowChild[]) {
  const chains: FlowChild[] = [];
  const isolates: FlowChild[] = [];
  for (const child of forest) {
    const sequenced = child.kind === "choice" || child.node.children.length > 0 || child.node.extra.length > 0;
    (sequenced ? chains : isolates).push(child);
  }
  chains.sort((left, right) => childDepth(right) - childDepth(left) || childName(left).localeCompare(childName(right), "zh-CN"));
  isolates.sort((left, right) => childName(left).localeCompare(childName(right), "zh-CN"));
  return { chains, isolates };
}

function countNodes(children: FlowChild[]): number {
  let total = 0;
  for (const child of children) {
    if (child.kind === "choice") {
      for (const option of child.options) total += 1 + countNodes(option.children);
    } else total += 1 + countNodes(child.node.children);
  }
  return total;
}

function lookup(list: string[], skip: Set<string>) {
  const out: Quest[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const id = raw.trim();
    if (!id || skip.has(id) || seen.has(id)) continue;
    seen.add(id);
    const task = visibleById.get(id);
    if (task) out.push(task);
  }
  return out;
}

function relations(node: FlowNode) {
  const skip = new Set([node.task.id]);
  const prereqs = lookup(node.extra, skip);
  const prereqIds = new Set(prereqs.map((task) => task.id));
  const conflicts = lookup(node.task.mutex, new Set([...skip, ...prereqIds]));
  const conflictIds = new Set(conflicts.map((task) => task.id));
  const blocked = lookup(node.task.blocked, new Set([...skip, ...prereqIds, ...conflictIds]));
  const kinds: Array<keyof typeof RIBBON_COLOR> = [];
  if (prereqs.length) kinds.push("prereq");
  if (blocked.length) kinds.push("blocked");
  if (conflicts.length) kinds.push("conflict");
  return { prereqs, blocked, conflicts, kinds };
}

function ribbonGradient(kinds: Array<keyof typeof RIBBON_COLOR>) {
  if (kinds.length === 1) return RIBBON_COLOR[kinds[0]];
  const slice = 100 / kinds.length;
  return `linear-gradient(to bottom, ${kinds.map((kind, index) => {
    const color = RIBBON_COLOR[kind];
    return `${color} ${index * slice}% ${(index + 1) * slice}%`;
  }).join(", ")})`;
}

function traderIcon(slug: string) {
  const icon = slug.trim().toLowerCase();
  return icon ? `https://tarkov.dev/images/traders/${encodeURIComponent(icon)}-icon.jpg` : "";
}

function loyaltyMark(level: number) {
  const rank = level <= 1 ? 1 : level >= 4 ? 4 : Math.trunc(level);
  if (rank >= 4) {
    return `<svg class="loy-icon" viewBox="0 0 24 24" aria-label="商人好感 4"><path fill="currentColor" d="M4 17.2 6.4 8.5l3.7 4.2L12 6l1.9 6.7 3.7-4.2L20 17.2H4Zm0 1.6h16V21H4v-2.2Z"/></svg>`;
  }
  const roman = rank === 1 ? "I" : rank === 2 ? "II" : "III";
  return `<span class="loy-roman" aria-label="商人好感 ${rank}">${roman}</span>`;
}

function statusSelect(task: Quest, closed: Set<string>) {
  const status = statusOf(task, closed);
  const lock = derived(task, closed);
  const options = STATUSES.map((item) => {
    const disabled = !WRITABLE.has(item) && item !== status;
    return `<option value="${item}"${item === status ? " selected" : ""}${disabled ? " disabled" : ""}>${STATUS_LABEL[item]}</option>`;
  }).join("");
  const tone = status === "done" ? " status-done" : status === "active" ? " status-active" : status === "failed" ? " status-failed" : status === "unreachable" ? " status-unreachable" : "";
  return `<select class="task-status${tone}" data-task-status="${esc(task.id)}" aria-label="${esc(displayName(task))} 状态"${lock ? " disabled" : ""}>${options}</select>`;
}

function flowCard(node: FlowNode, closed: Set<string>, lane: string, showTrader: boolean, jump: boolean) {
  const task = node.task;
  const status = statusOf(task, closed);
  const rel = jump ? { prereqs: [], blocked: [], conflicts: [], kinds: [] as Array<keyof typeof RIBBON_COLOR> } : relations(node);
  const tone = status === "done" ? " card-done" : status === "failed" ? " card-failed" : status === "unreachable" ? " card-unreachable" : "";
  const native = (task.traderSlug || "") === (lane || "");
  const domId = jump ? "" : native ? `tarkov-flow-task-${task.id}` : `tarkov-flow-task-${task.id}-in-${lane || "none"}`;
  const icon = showTrader ? traderIcon(task.traderSlug) : "";
  const ribbon = rel.kinds.length
    ? ` data-flow-ribbon="1" data-prereq="${esc(rel.prereqs.map((item) => item.id).join(","))}" data-blocked="${esc(rel.blocked.map((item) => item.id).join(","))}" data-conflict="${esc(rel.conflicts.map((item) => item.id).join(","))}"`
    : "";
  return `<article class="flow-card${tone}${rel.kinds.length ? " has-ribbon" : ""}${node.matched ? "" : " card-dim"}${flashTask === task.id ? " card-flash" : ""}${jump ? " flow-jump" : ""}"${domId ? ` id="${esc(domId)}"` : ""}${jump ? ` data-flow-jump="${esc(task.id)}"` : ""}${ribbon}>
    ${rel.kinds.length ? `<span class="flow-ribbon" style="background:${ribbonGradient(rel.kinds)}"></span>` : ""}
    <div class="flow-card-head">
      ${icon ? `<img class="card-trader" src="${esc(icon)}" alt="" />` : ""}
      <button type="button" class="flow-name" data-wiki="task" data-wiki-id="${esc(task.id)}" title="${esc(displayName(task))}">${esc(displayName(task))}</button>
    </div>
    <div class="flow-meta">
      <div class="flow-req">
        <span>等级要求：</span><b>${task.level > 0 ? task.level : "—"}</b>
        <span>商人好感：</span>${loyaltyMark(task.loyalty)}
      </div>
      ${statusSelect(task, closed)}
    </div>
  </article>`;
}

function choiceLabel(count: number) {
  if (count === 2) return "二选一";
  if (count === 3) return "三选一";
  return `${count} 选 1`;
}

function column(node: FlowNode, closed: Set<string>, lane: string, showTrader: boolean): string {
  const next = node.children.length
    ? `<span class="flow-link" aria-hidden="true"><i></i><b></b></span>${branch(node.children, closed, lane, showTrader)}`
    : "";
  return `<div class="flow-col">${flowCard(node, closed, lane, showTrader, false)}${next}</div>`;
}

function branch(children: FlowChild[], closed: Set<string>, lane: string, showTrader: boolean, root = false): string {
  if (!children.length) return "";
  const one = root || children.length === 1;
  return `<div class="flow-branch${one ? " one" : ""}${root ? " root" : ""}">${children.map((child) => child.kind === "choice"
    ? `<div class="flow-choice"><span>${choiceLabel(child.options.length)}</span><div class="flow-choice-row">${child.options.map((node) => column(node, closed, lane, showTrader)).join("")}</div></div>`
    : column(child.node, closed, lane, showTrader)).join("")}</div>`;
}

function formatMeta(count: Counts, visible: number) {
  const bits = [`显示 ${visible}`];
  if (count.active) bits.push(`进行中 ${count.active}`);
  if (count.failed) bits.push(`失败 ${count.failed}`);
  if (count.unreachable) bits.push(`无法完成 ${count.unreachable}`);
  if (count.done) bits.push(`已完成 ${count.done}`);
  return bits.join(" · ");
}

function statsHtml(items: Quest[]) {
  const count = summary(items);
  const rows = (
    [
      ["done", "已完成", count.done],
      ["active", "进行中", count.active],
      ["todo", "未完成", count.todo],
      ["failed", "失败", count.failed],
      ["unreachable", "无法完成", count.unreachable],
    ] as const
  ).filter((row) => row[2] > 0);
  const shown = rows.length ? rows : [["todo", "未完成", 0] as const];
  return `<div class="task-stats">${shown.map(([tone, label, value]) => `<div class="task-stat ${tone}"><span class="task-stat-label">${label}</span><span class="task-stat-value">${value}</span></div>`).join("")}</div>
    <div class="task-meter" aria-hidden>${shown.map(([tone, , value]) => `<i class="${tone}" style="flex-grow:${value || 1}"></i>`).join("")}</div>`;
}

function listHtml(groups: ReturnType<typeof traderGroups>, closed: Set<string>) {
  const scoped = traderSlug ? groups.filter((group) => group.slug === traderSlug) : groups;
  const typeColumns = orderTypes(scoped.flatMap((group) => group.items.flatMap((task) => task.objectives)));
  const blocks = scoped.map((group) => {
    const rows = group.items.filter((task) => matches(task, keyword)).sort((left, right) => {
      const diff = rank(left, closed) - rank(right, closed);
      return diff || displayName(left).localeCompare(displayName(right), "zh-CN");
    });
    if (!rows.length) return "";
    const count = summary(group.items);
    const icon = traderIcon(group.slug);
    return `<section class="task-group">
      <h3 class="flow-head">
        <span class="flow-head-title">${icon ? `<img src="${esc(icon)}" alt="" />` : ""}<span>${esc(group.name)}</span></span>
        <span class="flow-head-meta">${esc(formatMeta(count, rows.length))}</span>
      </h3>
      <div class="task-table-wrap"><table class="task-table">
        <thead><tr>
          <th>任务</th><th>状态</th><th>地点</th>
          ${typeColumns.map((type) => `<th class="cell-type" title="${esc(type)}">${esc(typeLabel(type))}</th>`).join("")}
        </tr></thead>
        <tbody>${rows.map((task) => {
          const status = statusOf(task, closed);
          const types = new Set(orderTypes(task.objectives));
          const place = mapLabel(task);
          const rowTone = status === "done" ? " row-done" : status === "active" ? " row-active" : status === "failed" ? " row-failed" : status === "unreachable" ? " row-unreachable" : "";
          return `<tr class="${rowTone.trim()}">
            <td class="cell-name"><button type="button" class="task-name" data-wiki="task" data-wiki-id="${esc(task.id)}">${esc(displayName(task))}</button></td>
            <td class="cell-status">${statusSelect(task, closed)}</td>
            <td class="cell-map">${place ? `<span class="task-map">${esc(place)}</span>` : ""}</td>
            ${typeColumns.map((type) => `<td class="cell-type">${types.has(type) ? `<span class="task-type-dot" data-tone="${esc(type)}" title="${esc(typeLabel(type))}"></span>` : ""}</td>`).join("")}
          </tr>`;
        }).join("")}</tbody>
      </table></div>
    </section>`;
  }).filter(Boolean);
  return blocks.join("") || `<p class="task-empty">当前筛选下无任务</p>`;
}

function flowHtml(groups: ReturnType<typeof traderGroups>, catalog: Map<string, Quest>, closed: Set<string>) {
  const lanes = groups.map((group) => {
    const built = traderForest(group.items, catalog);
    const forest = keyword.trim() ? filterForest(built, (task) => matches(task, keyword)) : built;
    return { group, forest, visible: countNodes(forest) };
  }).filter((lane) => lane.visible > 0);
  if (!lanes.length) return `<p class="task-empty">当前筛选下无任务</p>`;
  return `<div class="flow-stack">${lanes.map(({ group, forest, visible }) => {
    const parts = splitForest(forest);
    const count = summary(group.items);
    const icon = traderIcon(group.slug);
    return `<section class="flow-lane${flashTrader === group.slug ? " lane-flash" : ""}" id="tarkov-flow-trader-${esc(group.slug)}" data-flow-trader="${esc(group.slug)}">
      <h3 class="flow-head">
        <span class="flow-head-title">${icon ? `<img src="${esc(icon)}" alt="" />` : ""}<span>${esc(group.name)}</span></span>
        <span class="flow-head-meta">${esc(formatMeta(count, visible))}</span>
      </h3>
      ${parts.chains.length ? `<div class="flow-canvas"><p class="flow-legend">有序任务</p>${branch(parts.chains, closed, group.slug, true, true)}</div>` : ""}
      ${parts.isolates.length ? `<section class="flow-isolates"><p class="flow-legend">无序任务 · ${parts.isolates.length}</p><div class="flow-grid">${parts.isolates.map((child) => child.kind === "task" ? column(child.node, closed, group.slug, false) : "").join("")}</div></section>` : ""}
    </section>`;
  }).join("")}</div>`;
}

function railHtml(groups: ReturnType<typeof traderGroups>, selected: string) {
  const allOn = !selected;
  return `<button type="button" data-trader="" role="radio" aria-checked="${allOn ? "true" : "false"}" class="trader-all${allOn ? " on" : ""}">全部</button>
    ${groups.map((group) => {
      const count = summary(group.items);
      const icon = traderIcon(group.slug);
      const pct = count.done + count.active + count.todo + count.failed + count.unreachable
        ? (count.done / (count.done + count.active + count.todo + count.failed + count.unreachable)) * 100
        : 0;
      const on = selected === group.slug;
      return `<button type="button" data-trader="${esc(group.slug)}" role="radio" aria-checked="${on ? "true" : "false"}" class="${on ? "on" : ""}" title="${esc(group.name)}">
        ${icon ? `<img src="${esc(icon)}" alt="" />` : "<i></i>"}
        <span class="trader-cap">
          <strong>${esc(group.name)}</strong>
          <span class="trader-meta"><em class="${count.done && pct === 100 ? "full" : ""}">${count.done}</em><b><s style="width:${pct}%"></s></b></span>
        </span>
      </button>`;
    }).join("")}`;
}

function selectedTrader(groups: ReturnType<typeof traderGroups>) {
  if (view === "tree") return visibleTrader || traderSlug;
  return groups.some((group) => group.slug === traderSlug) ? traderSlug : "";
}

function paint(options: { keepScroll?: boolean; locate?: string } = {}) {
  hidePop();
  const board = document.querySelector("#task-board");
  const overview = document.querySelector("#task-overview");
  const rail = document.querySelector("#task-traders");
  if (!board || !overview || !rail) return;
  const items = visibleQuests();
  visibleById = new Map(items.map((task) => [task.id, task]));
  const groups = traderGroups(items);
  const closed = collectClosed(items);
  const scoped = view === "list" && traderSlug ? groups.find((group) => group.slug === traderSlug)?.items || [] : items;
  overview.innerHTML = statsHtml(view === "tree" ? items : scoped);
  const selected = selectedTrader(groups);
  const sig = groups.map((group) => {
    const count = summary(group.items);
    return `${group.slug}:${count.done}:${CountsTotal(count)}`;
  }).join(",");
  if (sig !== railSig) {
    railSig = sig;
    const top = rail.scrollTop;
    rail.innerHTML = railHtml(groups, selected);
    rail.scrollTop = top;
  } else {
    rail.querySelectorAll<HTMLButtonElement>("[data-trader]").forEach((button) => {
      const on = (button.dataset.trader || "") === selected;
      button.classList.toggle("on", on);
      button.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  const canvasLeft = new Map<string, number>();
  if (options.keepScroll) {
    board.querySelectorAll<HTMLElement>(".flow-canvas").forEach((node) => {
      const slug = node.closest("[data-flow-trader]")?.getAttribute("data-flow-trader") || "";
      canvasLeft.set(slug, node.scrollLeft);
    });
  }
  const top = board.scrollTop;
  board.innerHTML = view === "tree"
    ? flowHtml(groups, visibleById, closed)
    : listHtml(groups, closed);
  if (options.keepScroll) {
    board.scrollTop = top;
    board.querySelectorAll<HTMLElement>(".flow-canvas").forEach((node) => {
      const slug = node.closest("[data-flow-trader]")?.getAttribute("data-flow-trader") || "";
      node.scrollLeft = canvasLeft.get(slug) || 0;
    });
  }
  document.querySelectorAll<HTMLButtonElement>("[data-task-view]").forEach((button) => {
    const on = button.dataset.taskView === view;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const save = document.querySelector<HTMLButtonElement>("#task-save");
  if (save) {
    save.textContent = saving ? "正在保存…" : "保存进度";
    save.disabled = saving;
  }
  const input = document.querySelector<HTMLInputElement>("#task-search");
  if (input && document.activeElement !== input && input.value !== keyword) input.value = keyword;
  if (options.locate !== undefined) {
    if (!options.locate) board.scrollTo({ top: 0, behavior: "smooth" });
    else document.getElementById(`tarkov-flow-trader-${options.locate}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderShell() {
  const host = document.querySelector("#task-page");
  if (!host) return;
  const synced = readSyncAt();
  host.innerHTML = `
    <header class="task-overview" id="task-overview"></header>
    <div class="task-work">
      <aside class="task-side">
        <div class="task-filters">
          <input id="task-search" class="task-search" type="text" placeholder="搜索任务名" aria-label="搜索任务" value="${esc(keyword)}" />
          <table class="task-filter-table"><tbody>
            <tr>
              <td><button type="button" data-task-view="list" class="${view === "list" ? "on" : ""}" aria-pressed="${view === "list" ? "true" : "false"}">列表</button></td>
              <td><button type="button" data-task-view="tree" class="${view === "tree" ? "on" : ""}" aria-pressed="${view === "tree" ? "true" : "false"}">流程图</button></td>
            </tr>
            <tr>
              <td><button type="button" id="task-save" data-task-save>保存进度</button></td>
              <td><button type="button" id="log-sync" title="本机解析日志，只把任务状态回填到账号，不会上传原文。">历史任务同步</button></td>
            </tr>
          </tbody></table>
          <p id="path-note" class="task-sync-hint">上次同步时间：${esc(synced || "—")}</p>
          <div id="log-sync-box" class="log-sync" hidden>
            <p>选择要回填的启动记录范围。默认读取全部。</p>
            <div>
              <button type="button" data-sync="all" class="on">全部</button>
              <button type="button" data-sync="wipe">本赛季</button>
              <button type="button" data-sync="7d">近 7 天</button>
              <button type="button" data-sync="30d">近 30 天</button>
            </div>
            <div class="log-sync-actions">
              <button type="button" id="log-sync-go">开始同步</button>
              <button type="button" id="log-sync-cancel">取消</button>
            </div>
          </div>
        </div>
        <div class="task-traders" id="task-traders" role="radiogroup" aria-label="按商人筛选"></div>
      </aside>
      <div class="task-board" id="task-board"></div>
    </div>
    <div id="task-pop" class="task-pop" hidden></div>`;
  shellReady = true;
  railSig = "";
  bindShell();
}

function bindShell() {
  const search = document.querySelector<HTMLInputElement>("#task-search");
  search?.addEventListener("input", () => {
    keyword = search.value;
    paint({ keepScroll: true });
  });
  const board = document.querySelector("#task-board");
  board?.addEventListener("scroll", () => {
    hidePop();
    if (view === "tree") syncVisible();
  }, { passive: true });
  const page = document.querySelector("#task-page");
  page?.addEventListener("mouseover", (event) => {
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-flow-ribbon]") : null;
    if (!card || card === popAnchor) return;
    window.clearTimeout(popTimer);
    showPop(card);
  });
  page?.addEventListener("mouseout", onPopOut);
  const pop = document.querySelector("#task-pop");
  pop?.addEventListener("mouseover", () => window.clearTimeout(popTimer));
  pop?.addEventListener("mouseout", onPopOut);
}

function onPopOut(event: Event) {
  const next = event instanceof MouseEvent ? event.relatedTarget : null;
  const pop = document.querySelector("#task-pop");
  if (next instanceof Node && (pop?.contains(next) || popAnchor?.contains(next))) return;
  window.clearTimeout(popTimer);
  popTimer = window.setTimeout(hidePop, 220);
}

function hidePop() {
  window.clearTimeout(popTimer);
  const pop = document.querySelector<HTMLElement>("#task-pop");
  popAnchor = null;
  if (!pop || pop.hidden) return;
  void fadeOut(pop).then(() => {
    if (pop.hidden) pop.innerHTML = "";
  });
}

function peekColumn(title: string, hint: string, tone: string, tasks: Quest[], closed: Set<string>) {
  if (!tasks.length) return "";
  return `<div class="pop-col"><div class="pop-head ${tone}"><strong>${title}</strong><span>${hint}</span></div>${tasks.map((task) => flowCard({ task, extra: [], matched: true, children: [] }, closed, "", true, true)).join("")}</div>`;
}

function showPop(card: HTMLElement) {
  const pop = document.querySelector<HTMLElement>("#task-pop");
  if (!pop) return;
  const closed = collectClosed(visibleQuests());
  const read = (name: string) => (card.dataset[name] || "").split(",").map((id) => id.trim()).filter(Boolean);
  const prereqs = lookup(read("prereq"), new Set());
  const blocked = lookup(read("blocked"), new Set());
  const conflicts = lookup(read("conflict"), new Set());
  pop.innerHTML = [
    peekColumn("前置", "你需要先完成下列任务", "pop-prereq", prereqs, closed),
    peekColumn("阻断", "完成以下任务，将会使本任务失败/无法接取", "pop-blocked", blocked, closed),
    peekColumn("冲突", "完成本任务，将会使下列任务失败/无法接取", "pop-conflict", conflicts, closed),
  ].join("");
  fadeIn(pop);
  popAnchor = card;
  pop.style.left = "0px";
  pop.style.top = "0px";
  const rect = card.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  let left = rect.left - box.width - 8;
  if (left < 8) left = Math.min(rect.right + 8, window.innerWidth - box.width - 8);
  let top = rect.top;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - box.height - 8);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${top}px`;
}

function syncVisible() {
  const board = document.querySelector("#task-board");
  if (!board) return;
  const edge = board.getBoundingClientRect().top + 28;
  let next = "";
  board.querySelectorAll<HTMLElement>("[data-flow-trader]").forEach((lane) => {
    const rect = lane.getBoundingClientRect();
    if (rect.top <= edge && rect.bottom > edge) next = lane.dataset.flowTrader || "";
  });
  if (!next || next === visibleTrader) return;
  visibleTrader = next;
  const selected = visibleTrader || traderSlug;
  document.querySelectorAll<HTMLButtonElement>("#task-traders [data-trader]").forEach((button) => {
    const on = (button.dataset.trader || "") === selected;
    button.classList.toggle("on", on);
    button.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function locateTrader(slug: string) {
  traderSlug = slug;
  if (!slug) visibleTrader = "";
  if (view === "list") {
    visibleTrader = "";
    paint();
    return;
  }
  flashTrader = slug;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashTrader = "";
    paint({ keepScroll: true });
  }, 1600);
  paint({ keepScroll: true, locate: slug });
}

function jumpTask(taskId: string) {
  hidePop();
  if (view !== "tree") {
    view = "tree";
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* 视图偏好写不进时仍跳过去 */ }
  }
  flashTask = taskId;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashTask = "";
    paint({ keepScroll: true });
  }, 1600);
  paint({ keepScroll: true });
  const exact = document.getElementById(`tarkov-flow-task-${taskId}`);
  const node = exact || document.querySelector<HTMLElement>(`[id^="tarkov-flow-task-${CSS.escape(taskId)}-in-"]`);
  if (node) node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  else {
    const task = quests.find((item) => item.id === taskId);
    if (task) locateTrader(task.traderSlug);
  }
}

function shellHtml() {
  return `<section class="task-page" id="task-page">${spin("正在读取任务进度")}</section>`;
}

export function taskPageShell() {
  return shellHtml();
}

function showNote(host: Element) {
  host.innerHTML = isPending(note) ? spin(note) : `<p class="task-note">${esc(note)}</p>`;
  shellReady = false;
}

export async function mountTaskPage() {
  const host = document.querySelector("#task-page");
  if (!host) return;
  shellReady = false;
  showNote(host);
  try {
    const [catalog, progress] = await Promise.all([
      invoke<{ items?: Record<string, unknown>[] }>("site_get", { path: "/guides/tarkov/tasks?layout=all" }),
      invoke<Record<string, unknown>>("site_get", { path: "/guides/tarkov/task-dones" }),
    ]);
    quests = (catalog.items || []).map(readQuest).filter((item): item is Quest => Boolean(item));
    done = new Set(ids(progress.task_ids || progress.taskIds).map(key));
    started = new Set(ids(progress.started_ids || progress.startedIds).map(key));
    failed = new Set(ids(progress.failed_ids || progress.failedIds).map(key));
    objectives = Array.isArray(progress.objective_dones) ? progress.objective_dones as { task_id: string; objective_id: string }[] : [];
    note = quests.length ? "" : "没有读到任务";
  } catch (error) {
    note = error instanceof Error ? error.message : "任务进度读取失败";
    quests = [];
  }
  if (!quests.length || !document.querySelector("#task-page")) {
    const next = document.querySelector("#task-page");
    if (next) showNote(next);
    return;
  }
  renderShell();
  paint();
}

export async function reloadTaskProgress() {
  if (!document.querySelector("#task-board")) return;
  try {
    const progress = await invoke<Record<string, unknown>>("site_get", { path: "/guides/tarkov/task-dones" });
    done = new Set(ids(progress.task_ids || progress.taskIds).map(key));
    started = new Set(ids(progress.started_ids || progress.startedIds).map(key));
    failed = new Set(ids(progress.failed_ids || progress.failedIds).map(key));
    objectives = Array.isArray(progress.objective_dones) ? progress.objective_dones as { task_id: string; objective_id: string }[] : [];
    paint({ keepScroll: true });
  } catch {
    /* 同步后的刷新失败时保留屏幕上的进度 */
  }
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function readQuest(value: Record<string, unknown>): Quest | null {
  const id = String(value.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: String(value.name || id),
    traderSlug: String(value.trader_slug || value.traderSlug || "other"),
    traderName: String(value.trader_name || value.traderName || ""),
    level: Number(value.min_player_level || value.minPlayerLevel || 0),
    loyalty: Number(value.min_trader_level || value.minTraderLevel || 1),
    prereq: ids(value.prereq_ids || value.prereqIds),
    mutex: ids(value.mutex_ids || value.mutexIds),
    blocked: ids(value.blocked_by || value.blockedBy),
    failPrereq: ids(value.fail_prereq_ids || value.failPrereqIds),
    failOr: ids(value.fail_or_complete_ids || value.failOrCompleteIds),
    faction: String(value.faction_name || value.factionName || ""),
    mapSlug: String(value.map_slug || value.mapSlug || ""),
    mapName: String(value.map_name || value.mapName || ""),
    objectives: ids(value.objective_types || value.objectiveTypes),
    normalized: String(value.normalized_name || value.normalizedName || ""),
    lineHint: String(value.line_hint || value.lineHint || ""),
  };
}

let questQueue: Promise<void> = Promise.resolve();

export function applyLoggedQuest(kind: "started" | "failed" | "completed", taskId: string) {
  const id = taskId.trim().toLowerCase();
  if (!id) return questQueue;
  questQueue = questQueue.then(() => writeLoggedQuest(kind, id)).catch(() => undefined);
  return questQueue;
}

async function writeLoggedQuest(kind: "started" | "failed" | "completed", id: string) {
  const progress = await invoke<Record<string, unknown>>("site_get", { path: "/guides/tarkov/task-dones" });
  const nextDone = new Set(ids(progress.task_ids || progress.taskIds).map(key));
  const nextStarted = new Set(ids(progress.started_ids || progress.startedIds).map(key));
  const nextFailed = new Set(ids(progress.failed_ids || progress.failedIds).map(key));
  nextDone.delete(id);
  nextStarted.delete(id);
  nextFailed.delete(id);
  if (kind === "completed") {
    nextDone.add(id);
    const quest = quests.find((item) => key(item.id) === id);
    for (const parent of quest?.prereq || []) nextDone.add(key(parent));
    for (const other of quest?.mutex || []) {
      const otherId = key(other);
      if (!nextDone.has(otherId)) nextFailed.add(otherId);
    }
  } else if (kind === "failed") nextFailed.add(id);
  else nextStarted.add(id);
  for (const item of nextDone) {
    nextStarted.delete(item);
    nextFailed.delete(item);
  }
  await invoke("site_put", {
    path: "/guides/tarkov/task-dones",
    body: {
      task_ids: [...nextDone],
      started_ids: [...nextStarted],
      failed_ids: [...nextFailed],
      objective_dones: Array.isArray(progress.objective_dones) ? progress.objective_dones : [],
      replace: true,
    },
  });
  if (quests.length) {
    done = nextDone;
    started = nextStarted;
    failed = nextFailed;
    if (shellReady) paint({ keepScroll: true });
  }
}

async function saveProgress(stamp: boolean) {
  if (saving) return;
  saving = true;
  if (shellReady) paint({ keepScroll: true });
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
    if (stamp) stampSync(true);
  } catch (error) {
    const node = document.querySelector("#path-note");
    if (node) node.textContent = error instanceof Error ? error.message : "保存任务进度失败";
  } finally {
    saving = false;
    if (shellReady) paint({ keepScroll: true });
  }
}

export function onTaskEvent(target: Element) {
  if (!document.querySelector("#task-page")?.contains(target) && !target.closest("#task-pop")) return false;
  if (target.closest("#log-sync, #log-sync-box, [data-sync], #log-sync-go, #log-sync-cancel")) return false;
  if (target.closest("[data-wiki], select, option")) return false;
  const jump = target.closest<HTMLElement>("[data-flow-jump]");
  if (jump?.dataset.flowJump) {
    jumpTask(jump.dataset.flowJump);
    return true;
  }
  const ribbon = target.closest<HTMLElement>("[data-flow-ribbon]");
  if (ribbon) {
    if (popAnchor === ribbon) hidePop();
    else showPop(ribbon);
    return true;
  }
  if (!target.closest("#task-pop")) hidePop();
  const mode = target.closest<HTMLButtonElement>("[data-task-view]");
  if (mode?.dataset.taskView === "list" || mode?.dataset.taskView === "tree") {
    view = mode.dataset.taskView;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* 忽略 */ }
    paint();
    return true;
  }
  if (target.closest("[data-task-save]")) {
    void saveProgress(true);
    return true;
  }
  const trader = target.closest<HTMLButtonElement>("#task-traders [data-trader]");
  if (trader) {
    locateTrader(trader.dataset.trader || "");
    return true;
  }
  return false;
}

export function onTaskChange(target: EventTarget | null) {
  if (!(target instanceof HTMLSelectElement) || !target.dataset.taskStatus) return false;
  const id = target.dataset.taskStatus;
  const next = target.value as Status;
  if (!WRITABLE.has(next)) {
    if (shellReady) paint({ keepScroll: true });
    return true;
  }
  const task = quests.find((item) => item.id === id);
  const closed = collectClosed(visibleQuests());
  if (!task || derived(task, closed) || statusOf(task, closed) === next) {
    if (shellReady) paint({ keepScroll: true });
    return true;
  }
  const updated = setLineStatus(id, next);
  done = new Set(updated.done);
  started = new Set(updated.started);
  failed = new Set(updated.failed);
  void saveProgress(false);
  return true;
}

function CountsTotal(count: Counts) {
  return count.done + count.active + count.todo + count.failed + count.unreachable;
}

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
};

type Status = "todo" | "active" | "done" | "failed" | "unreachable";
type Node = { task: Quest; children: Child[] };
type Child = { kind: "task"; node: Node } | { kind: "choice"; options: Node[] };

const STATUS_LABEL: Record<Status, string> = {
  todo: "未完成",
  active: "进行中",
  done: "已完成",
  failed: "失败",
  unreachable: "无法完成",
};

let quests: Quest[] = [];
let done = new Set<string>();
let started = new Set<string>();
let failed = new Set<string>();
let objectives: { task_id: string; objective_id: string }[] = [];
let traderSlug = "";
let note = "正在读取任务进度…";
let saving = false;

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
  const want = key(id);
  for (const item of pool) if (key(item) === want) return true;
  return false;
}

function drop(pool: Set<string>, id: string) {
  for (const item of [...pool]) if (key(item) === key(id)) pool.delete(item);
}

function hits(list: string[], pool: Set<string>) {
  return list.some((id) => has(pool, id));
}

function statusOf(task: Quest): Status {
  const id = task.id;
  if (has(done, id)) return "done";
  if (has(failed, id) || hits(task.mutex, done)) return "failed";
  if (hits(task.blocked, done) || hits(task.blocked, started) || hits(task.failPrereq, done)) return "unreachable";
  if (has(started, id)) return "active";
  return "todo";
}

function available(task: Quest) {
  if (statusOf(task) !== "todo") return false;
  return task.prereq.every((id) => has(done, id)) && task.failPrereq.every((id) => has(failed, id));
}

function derived(task: Quest) {
  const status = statusOf(task);
  if (status === "unreachable") return true;
  return status === "failed" && !has(failed, task.id);
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function traderLabel(name: string) {
  return name.split(/[（(]/)[0].trim() || name || "其他";
}

function byTrader() {
  const groups = new Map<string, Quest[]>();
  for (const task of quests) {
    const slug = task.traderSlug || "other";
    const list = groups.get(slug) || [];
    list.push(task);
    groups.set(slug, list);
  }
  return [...groups.entries()].map(([slug, items]) => ({
    slug,
    name: traderLabel(items[0]?.traderName || slug),
    items,
  }));
}

function ancestorSet(id: string, catalog: Map<string, Quest>) {
  const out = new Set<string>();
  const stack = [...(catalog.get(id)?.prereq || [])].filter((item) => catalog.has(item));
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || out.has(cur)) continue;
    out.add(cur);
    for (const next of catalog.get(cur)?.prereq || []) {
      if (catalog.has(next)) stack.push(next);
    }
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

function mutexPair(left: Quest, right: Quest) {
  return left.mutex.includes(right.id) && right.mutex.includes(left.id);
}

function buildForest(items: Quest[]): Child[] {
  const catalog = new Map(items.map((task) => [task.id, task]));
  const parentOf = new Map<string, string>();
  for (const task of catalog.values()) {
    const parent = primaryParent(task, catalog);
    if (parent && parent !== task.id) parentOf.set(task.id, parent);
  }
  const kids = new Map<string, Quest[]>();
  for (const [child, parent] of parentOf) {
    const task = catalog.get(child);
    if (!task) continue;
    const list = kids.get(parent) || [];
    list.push(task);
    kids.set(parent, list);
  }
  const toNode = (task: Quest): Node => ({
    task,
    children: group( (kids.get(task.id) || []).map(toNode) ),
  });
  const roots = [...catalog.values()].filter((task) => !parentOf.has(task.id)).map(toNode);
  return group(roots);
}

function group(nodes: Node[]): Child[] {
  const remaining = [...nodes].sort((a, b) => a.task.name.localeCompare(b.task.name, "zh-CN"));
  const out: Child[] = [];
  while (remaining.length) {
    const head = remaining.shift();
    if (!head) break;
    const clique = [head];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const cand = remaining[i];
        if (clique.every((row) => mutexPair(row.task, cand.task))) {
          clique.push(cand);
          remaining.splice(i, 1);
          grew = true;
        }
      }
    }
    if (clique.length >= 2) out.push({ kind: "choice", options: clique.sort((a, b) => a.task.name.localeCompare(b.task.name, "zh-CN")) });
    else out.push({ kind: "task", node: head });
  }
  return out;
}

function keepNode(node: Node, keep: (task: Quest) => boolean): Node | null {
  const children = keepForest(node.children, keep);
  if (!keep(node.task) && !children.length) return null;
  return { ...node, children };
}

function keepForest(children: Child[], keep: (task: Quest) => boolean): Child[] {
  const out: Child[] = [];
  for (const child of children) {
    if (child.kind === "choice") {
      const options = child.options.map((node) => keepNode(node, keep)).filter((node): node is Node => Boolean(node));
      if (options.length >= 2) out.push({ kind: "choice", options });
      else if (options.length === 1) out.push({ kind: "task", node: options[0] });
      continue;
    }
    const node = keepNode(child.node, keep);
    if (node) out.push({ kind: "task", node });
  }
  return out;
}

function depth(child: Child): number {
  if (child.kind === "choice") return Math.max(0, ...child.options.map((node) => 1 + Math.max(0, ...node.children.map(depth))));
  return 1 + Math.max(0, ...child.node.children.map(depth));
}

function split(forest: Child[]) {
  const chains: Child[] = [];
  const isolates: Child[] = [];
  for (const child of forest) {
    const sequenced = child.kind === "choice" || child.node.children.length > 0;
    (sequenced ? chains : isolates).push(child);
  }
  chains.sort((a, b) => depth(b) - depth(a));
  return { chains, isolates };
}

function traderIcon(slug: string) {
  const key = slug.trim().toLowerCase();
  if (!key) return "";
  return `https://tarkov.dev/images/traders/${encodeURIComponent(key)}-icon.jpg`;
}

function card(task: Quest) {
  const status = statusOf(task);
  const locked = status === "todo" && !available(task);
  const roman = ["", "I", "II", "III", "IV"][Math.min(4, Math.max(1, task.loyalty))] || "I";
  return `<article class="flow-card status-${status}${locked ? " locked" : ""}">
    <strong title="${esc(task.name)}">${esc(task.name)}</strong>
    <div class="flow-meta">
      <div class="flow-req">
        <span>等级要求：</span><b>${task.level || "—"}</b>
        <span>商人好感：</span><b class="loy">${roman}</b>
      </div>
      <select data-task-status="${esc(task.id)}" ${derived(task) ? "disabled" : ""} aria-label="${esc(task.name)} 状态">
        ${(["todo", "active", "done", "failed"] as Status[]).map((item) => `<option value="${item}"${item === status ? " selected" : ""}>${STATUS_LABEL[item]}</option>`).join("")}
        ${status === "unreachable" ? `<option value="unreachable" selected>${STATUS_LABEL.unreachable}</option>` : ""}
      </select>
    </div>
  </article>`;
}

function branch(children: Child[], root = false): string {
  if (!children.length) return "";
  const one = root || children.length === 1;
  return `<div class="flow-branch${one ? " one" : ""}${root ? " root" : ""}">${children.map((child) => child.kind === "choice"
    ? `<div class="flow-choice"><span>${child.options.length} 选 1</span><div class="flow-choice-row">${child.options.map(column).join("")}</div></div>`
    : column(child.node)).join("")}</div>`;
}

function column(node: Node): string {
  const next = node.children.length
    ? `<span class="flow-link" aria-hidden="true"></span>${branch(node.children)}`
    : "";
  return `<div class="flow-col">${card(node.task)}${next}</div>`;
}

function summary(items: Quest[]) {
  const count = { done: 0, active: 0, todo: 0, failed: 0, unreachable: 0 };
  for (const task of items) count[statusOf(task)] += 1;
  const total = items.length || 1;
  return { count, total: items.length, widths: {
    done: (count.done / total) * 100,
    active: (count.active / total) * 100,
    todo: (count.todo / total) * 100,
    failed: (count.failed / total) * 100,
    unreachable: (count.unreachable / total) * 100,
  } };
}

export function taskPageShell() {
  return `<section class="task-page" id="task-page"><p class="task-note">正在读取任务进度…</p></section>`;
}

function paintBoard() {
  const host = document.querySelector("#task-page");
  if (!host) return;
  if (!quests.length) {
    host.innerHTML = `<p class="task-note">${esc(note)}</p>`;
    return;
  }
  const groups = byTrader();
  if (traderSlug && !groups.some((group) => group.slug === traderSlug)) traderSlug = groups[0]?.slug || "";
  const all = summary(quests);
  const lanes = traderSlug ? groups.filter((group) => group.slug === traderSlug) : groups;
  const laneHtml = lanes.map((group) => {
    const native = new Set(group.items.map((task) => task.id));
    const catalog = new Map(quests.map((task) => [task.id, task]));
    const closure: Quest[] = [];
    const seen = new Set<string>();
    const stack = [...group.items];
    while (stack.length) {
      const task = stack.pop();
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      closure.push(task);
      for (const id of task.prereq) {
        const parent = catalog.get(id);
        if (parent) stack.push(parent);
      }
    }
    const forest = keepForest(buildForest(closure), () => true).filter((child) => {
      const node = child.kind === "task" ? child.node : null;
      return !node || native.has(node.task.id) || node.children.length > 0;
    });
    const parts = split(forest);
    const icon = traderIcon(group.slug);
    if (!parts.chains.length && !parts.isolates.length) return "";
    return `<section class="flow-lane" id="trader-${esc(group.slug)}">
      <h2>${icon ? `<img src="${esc(icon)}" alt="" />` : ""}${esc(group.name)}</h2>
      ${parts.chains.length ? `<p class="flow-legend">有序任务</p><div class="flow-canvas">${branch(parts.chains, true)}</div>` : ""}
      ${parts.isolates.length ? `<section class="flow-isolates"><p class="flow-legend">无序任务 · ${parts.isolates.length}</p><div class="flow-grid">${parts.isolates.map((child) => child.kind === "task" ? card(child.node.task) : "").join("")}</div></section>` : ""}
    </section>`;
  }).join("");
  host.innerHTML = `
    <header class="task-overview">
      <div class="task-stats">
        <span class="done"><i>已完成</i><b>${all.count.done}</b></span>
        <span class="active"><i>进行中</i><b>${all.count.active}</b></span>
        <span class="todo"><i>未完成</i><b>${all.count.todo}</b></span>
        <span class="failed"><i>失败</i><b>${all.count.failed}</b></span>
        <span class="unreachable"><i>无法完成</i><b>${all.count.unreachable}</b></span>
        ${saving ? `<span class="task-visible">正在保存…</span>` : ""}
      </div>
      <div class="task-bar">
        <i class="done" style="width:${all.widths.done}%"></i>
        <i class="active" style="width:${all.widths.active}%"></i>
        <i class="todo" style="width:${all.widths.todo}%"></i>
        <i class="failed" style="width:${all.widths.failed}%"></i>
        <i class="unreachable" style="width:${all.widths.unreachable}%"></i>
      </div>
    </header>
    <div class="task-work">
      <aside class="task-traders">
        <button type="button" data-trader="" class="trader-all ${traderSlug ? "" : "on"}">全部</button>
        ${groups.map((group) => {
          const stat = summary(group.items);
          const icon = traderIcon(group.slug);
          const pct = stat.total ? (stat.count.done / stat.total) * 100 : 0;
          return `<button type="button" data-trader="${esc(group.slug)}" class="${group.slug === traderSlug ? "on" : ""}">
            ${icon ? `<img src="${esc(icon)}" alt="" />` : "<i></i>"}
            <span class="trader-cap">
              <strong>${esc(group.name)}</strong>
              <span class="trader-meta"><em class="${stat.count.done === stat.total && stat.total ? "full" : ""}">${stat.count.done}</em><b><s style="width:${pct}%"></s></b></span>
            </span>
          </button>`;
        }).join("")}
      </aside>
      <div class="task-main">
        <div class="task-board">
          ${laneHtml || `<p class="task-note">这个筛选下没有任务。</p>`}
        </div>
      </div>
    </div>`;
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
  const nextDone = new Set(ids(progress.task_ids || progress.taskIds).map((item) => item.toLowerCase()));
  const nextStarted = new Set(ids(progress.started_ids || progress.startedIds).map((item) => item.toLowerCase()));
  const nextFailed = new Set(ids(progress.failed_ids || progress.failedIds).map((item) => item.toLowerCase()));
  nextDone.delete(id);
  nextStarted.delete(id);
  nextFailed.delete(id);
  if (kind === "completed") {
    nextDone.add(id);
    const quest = quests.find((item) => item.id.toLowerCase() === id);
    for (const parent of quest?.prereq || []) nextDone.add(parent.toLowerCase());
    for (const other of quest?.mutex || []) {
      const key = other.toLowerCase();
      if (!nextDone.has(key)) nextFailed.add(key);
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
    paintBoard();
  }
}

export async function mountTaskPage() {
  paintBoard();
  try {
    const [catalog, progress] = await Promise.all([
      invoke<{ items?: Record<string, unknown>[] }>("site_get", { path: "/guides/tarkov/tasks?layout=all" }),
      invoke<Record<string, unknown>>("site_get", { path: "/guides/tarkov/task-dones" }),
    ]);
    quests = (catalog.items || []).map(readQuest).filter((item): item is Quest => Boolean(item));
    done = new Set(ids(progress.task_ids || progress.taskIds));
    started = new Set(ids(progress.started_ids || progress.startedIds));
    failed = new Set(ids(progress.failed_ids || progress.failedIds));
    objectives = Array.isArray(progress.objective_dones) ? progress.objective_dones as { task_id: string; objective_id: string }[] : [];
    note = quests.length ? "" : "没有读到任务";
  } catch (error) {
    note = error instanceof Error ? error.message : "任务进度读取失败";
    quests = [];
  }
  paintBoard();
}

async function saveProgress() {
  saving = true;
  paintBoard();
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
    note = error instanceof Error ? error.message : "保存任务进度失败";
  } finally {
    saving = false;
    paintBoard();
  }
}

export function onTaskEvent(target: Element) {
  const trader = target.closest<HTMLButtonElement>("[data-trader]");
  if (trader) {
    traderSlug = trader.dataset.trader || "";
    paintBoard();
    return true;
  }
  return false;
}

export function onTaskChange(target: EventTarget | null) {
  if (!(target instanceof HTMLSelectElement) && !(target instanceof HTMLInputElement)) return false;
  if (target instanceof HTMLSelectElement && target.dataset.taskStatus) {
    const id = target.dataset.taskStatus;
    const next = target.value as Status;
    drop(done, id);
    drop(started, id);
    drop(failed, id);
    if (next === "done") {
      done.add(id);
      const task = quests.find((item) => item.id === id);
      for (const other of task?.mutex || []) {
        if (!has(done, other)) failed.add(other);
      }
    } else if (next === "active") started.add(id);
    else if (next === "failed") failed.add(id);
    void saveProgress();
    return true;
  }
  return false;
}

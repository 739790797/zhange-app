type GunCard = { id: string; name: string; short: string; caliber: string };
type Part = { id: string; name: string; icon: string };
type Slot = { id: string; name: string; required: boolean; depth: number; installed: Part | null };
type Pair = { slot_id: string; item_id: string };
type Stats = {
  ergonomics?: number;
  recoil_vertical?: number;
  recoil_horizontal?: number;
  overswing?: number;
  weight?: number;
  mag_capacity?: number;
  sighting_range?: number;
  conflicts?: string[];
};

type SmithItem = { id: string; name: string };
type SmithTask = {
  id: string;
  taskId: string;
  objectiveId: string;
  taskName: string;
  trader: string;
  weaponId: string;
  weaponName: string;
  loadable: boolean;
  constraints: Record<string, number>;
  requiredItems: SmithItem[];
  categoryGroups: SmithItem[][];
};
type CommunityBuild = {
  id: string;
  name: string;
  author: string;
  featured: boolean;
  loadable: boolean;
  dropped: number;
  ergonomics: number | null;
  recoilV: number | null;
  recoilH: number | null;
  price: number | null;
  pairs: Pair[];
  ammoId: string;
};

const CONSTRAINT_LABEL: Record<string, string> = {
  min_ergonomics: "人机",
  max_recoil_sum: "后坐和",
  max_weight: "重量",
  min_mag_capacity: "弹匣容量",
  max_mag_capacity: "弹匣容量",
  min_sighting_range: "瞄准距离",
  min_durability: "耐久",
  max_width: "格仓宽",
  max_height: "格仓高",
  min_width: "格仓宽",
  min_height: "格仓高",
};
const CONSTRAINT_ORDER = ["min_durability", "min_ergonomics", "max_recoil_sum", "max_weight", "min_mag_capacity", "max_mag_capacity", "min_sighting_range", "max_width", "max_height"];

let seq = 0;
let guns: GunCard[] = [];
let gunQuery = "";
let slots: Slot[] = [];
let pairs: Pair[] = [];
let stats: Stats | null = null;
let ammoId = "";
let activeSlot = "";
let allowed: Part[] = [];
let partQuery = "";
let note = "";
let smithTasks: SmithTask[] = [];
let smithReady = false;
let smithOpen = false;
let smithQuery = "";
let picked: SmithTask | null = null;
let community: CommunityBuild[] = [];
let communityGun = "";
let communityOpen = false;

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function rec(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function iconOf(icon: string, id: string) {
  if (icon) return icon;
  return /^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-icon.webp` : "";
}

function partOf(value: unknown): Part | null {
  const row = rec(value);
  if (!row) return null;
  const id = str(row.id);
  const name = str(row.name || row.short_name || row.shortName) || id;
  if (!id || !name) return null;
  return { id, name, icon: iconOf(str(row.icon_link || row.iconLink), id) };
}

function walk(nodes: unknown, depth: number, out: Slot[]) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const row = rec(node);
    if (!row) continue;
    const id = str(row.id);
    if (id) {
      out.push({
        id,
        name: str(row.name || row.label) || "槽位",
        required: row.required === true || row.mandatory === true,
        depth,
        installed: partOf(row.installed),
      });
    }
    if (Array.isArray(row.children)) walk(row.children, depth + 1, out);
  }
}

function pairsFrom(list: Slot[]) {
  return list.flatMap((slot) => slot.installed ? [{ slot_id: slot.id, item_id: slot.installed.id }] : []);
}

function statText(value: number | null) {
  if (value == null) return "—";
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

function money(value: number | null) {
  if (value == null) return "—";
  return `${Math.round(value).toLocaleString("zh-CN")} ₽`;
}

function pairsOf(value: unknown) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const row = rec(item);
    const slotId = str(row?.slot_id);
    const itemId = str(row?.item_id);
    return slotId && itemId ? [{ slot_id: slotId, item_id: itemId }] : [];
  });
}

function namedItems(value: unknown) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const row = rec(item);
    const id = str(row?.id);
    const name = str(row?.name || row?.short_name) || id;
    return id || name ? [{ id, name }] : [];
  });
}

function readSmith(row: Record<string, unknown>): SmithTask | null {
  const taskId = str(row.task_id);
  const objectiveId = str(row.objective_id);
  const id = str(row.id) || `${taskId}:${objectiveId}`;
  const taskName = str(row.task_name) || taskId;
  if (!id || !taskName) return null;
  const constraints: Record<string, number> = {};
  const raw = rec(row.constraints);
  if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      const parsed = num(value);
      if (parsed != null) constraints[key] = parsed;
    }
  }
  const groups = Array.isArray(row.required_category_groups) ? row.required_category_groups : [];
  return {
    id,
    taskId,
    objectiveId,
    taskName,
    trader: str(row.trader_name),
    weaponId: str(row.weapon_id),
    weaponName: str(row.weapon_name),
    loadable: row.loadable !== false,
    constraints,
    requiredItems: namedItems(row.required_items),
    categoryGroups: groups.map((group) => namedItems(group)),
  };
}

function readBuild(row: Record<string, unknown>): CommunityBuild | null {
  const id = str(row.id);
  const name = str(row.name) || "方案";
  if (!id) return null;
  const preview = rec(row.preview);
  return {
    id,
    name,
    author: str(row.author) || "匿名",
    featured: row.featured === true,
    loadable: row.loadable !== false,
    dropped: Number(row.dropped_pair_count) || 0,
    ergonomics: preview ? num(preview.ergonomics) : null,
    recoilV: preview ? num(preview.recoil_vertical) : null,
    recoilH: preview ? num(preview.recoil_horizontal) : null,
    price: preview ? num(preview.price_rub) : null,
    pairs: pairsOf(row.pairs),
    ammoId: str(row.ammo_id),
  };
}

function constraintText(key: string, value: number) {
  const label = CONSTRAINT_LABEL[key] || key;
  const shown = key === "min_durability" ? `${value}%` : String(value);
  if (key.startsWith("min_")) return `${label} ≥ ${shown}`;
  if (key.startsWith("max_")) return `${label} ≤ ${shown}`;
  return `${label} ${shown}`;
}

function orderedConstraints(task: SmithTask) {
  return Object.entries(task.constraints).sort((a, b) => {
    const left = CONSTRAINT_ORDER.indexOf(a[0]);
    const right = CONSTRAINT_ORDER.indexOf(b[0]);
    if (left < 0 && right < 0) return a[0].localeCompare(b[0]);
    if (left < 0) return 1;
    if (right < 0) return -1;
    return left - right;
  });
}

function statChecked(key: string) {
  return key === "min_ergonomics" || key === "max_recoil_sum" || key === "max_weight" || key === "min_mag_capacity" || key === "max_mag_capacity" || key === "min_sighting_range";
}

function unmetConstraints(task: SmithTask) {
  if (!stats) return [];
  const rules = task.constraints;
  const missed: string[] = [];
  const ergo = num(stats.ergonomics) || 0;
  const recoil = (num(stats.recoil_vertical) || 0) + (num(stats.recoil_horizontal) || 0);
  const weight = num(stats.weight) || 0;
  const mag = num(stats.mag_capacity) || 0;
  const sight = num(stats.sighting_range) || 0;
  if (rules.min_ergonomics != null && ergo < rules.min_ergonomics) missed.push("min_ergonomics");
  if (rules.max_recoil_sum != null && recoil > rules.max_recoil_sum) missed.push("max_recoil_sum");
  if (rules.max_weight != null && weight > rules.max_weight) missed.push("max_weight");
  if (rules.min_mag_capacity != null && mag < rules.min_mag_capacity) missed.push("min_mag_capacity");
  if (rules.max_mag_capacity != null && (mag <= 0 || mag > rules.max_mag_capacity)) missed.push("max_mag_capacity");
  if (rules.min_sighting_range != null && sight < rules.min_sighting_range) missed.push("min_sighting_range");
  return missed;
}

function smithChecks(task: SmithTask) {
  const missed = new Set(unmetConstraints(task));
  const installed = new Set(slots.flatMap((slot) => slot.installed ? [slot.installed.id] : []));
  const lines = orderedConstraints(task).map(([key, value]) => {
    const checked = statChecked(key) && stats != null;
    const fail = checked && missed.has(key);
    const mark = checked ? (fail ? "×" : "✓") : "·";
    const extra = key === "min_durability" ? "（上交时）" : key === "max_width" || key === "max_height" ? "（工作台暂不按折叠对照）" : "";
    return `<li class="${fail ? "bad" : checked ? "ok" : ""}">${mark} ${esc(constraintText(key, value))}${extra}</li>`;
  });
  for (const item of task.requiredItems) {
    const fail = Boolean(item.id) && !installed.has(item.id);
    lines.push(`<li class="${fail ? "bad" : "ok"}">${fail ? "×" : "✓"} 必装 ${esc(item.name || item.id)}</li>`);
  }
  for (const group of task.categoryGroups) {
    const label = group.map((item) => item.name || item.id).filter(Boolean).join(" / ");
    if (label) lines.push(`<li>· 配件分类：${esc(label)}</li>`);
  }
  return lines.join("");
}

function smithPanel(gunId: string) {
  if (!gunId || !smithOpen) return "";
  const needle = smithQuery.trim().toLowerCase();
  const matched = smithTasks.filter((task) => {
    const text = `${task.taskName} ${task.weaponName} ${task.trader} ${task.taskId}`.toLowerCase();
    if (needle) return text.includes(needle);
    return task.weaponId === gunId;
  });
  const rows = matched.map((task) => {
    const meta = [task.trader, task.weaponName].filter(Boolean).join(" · ");
    const extra = task.loadable ? "" : " · 图鉴没有这把枪";
    const body = `<span><strong>${esc(task.taskName)}</strong><em>${esc(meta)}${extra}</em></span>`;
    if (!task.loadable || !task.weaponId) return `<button type="button" class="work-slot" disabled>${body}</button>`;
    return `<a class="work-slot" href="/主菜单/逃离塔科夫/工作台/${encodeURIComponent(task.weaponId)}" data-link data-smith="${esc(task.id)}">${body}</a>`;
  }).join("");
  const empty = smithQuery.trim() ? "没有匹配的枪匠任务" : "这把枪没有枪匠任务";
  return `<section class="wiki-block"><h2>枪匠任务</h2><form id="work-smith-find" class="wiki-tools"><input name="q" value="${esc(smithQuery)}" placeholder="搜索任务 / 枪名" aria-label="搜索枪匠任务" /><button type="submit">搜索</button></form><div class="work-slots">${rows || `<p class="wiki-note">${empty}</p>`}</div></section>`;
}

function communityPanel() {
  if (!communityOpen) return "";
  const rows = community.map((build) => {
    const meta = [build.featured ? "精选" : "", build.author, `人机 ${statText(build.ergonomics)}`, `垂 ${statText(build.recoilV)}`, `平 ${statText(build.recoilH)}`, money(build.price)].filter(Boolean).join(" · ");
    const dropped = build.dropped ? ` · 省略 ${build.dropped} 件` : "";
    return `<button type="button" class="work-slot" data-work-build="${esc(build.id)}" ${build.loadable ? "" : "disabled"}><span><strong>${esc(build.name)}</strong><em>${esc(meta)}${dropped}</em></span></button>`;
  }).join("");
  return `<section class="wiki-block"><h2>社区方案</h2><p class="wiki-note">列表来自公开方案，按本站图鉴装入。</p><div class="work-slots">${rows || `<p class="wiki-note">这把枪还没有公开方案。</p>`}</div></section>`;
}

function pickedPanel() {
  if (!picked) return "";
  const meta = [picked.trader, picked.weaponName].filter(Boolean).join(" · ");
  const checks = smithChecks(picked);
  return `<section class="wiki-block"><div class="wiki-tools"><strong>枪匠任务</strong><button type="button" data-work-solve ${picked.loadable ? "" : "disabled"}>求解</button><button type="button" data-work-smith-clear>退出</button></div><h2>${esc(picked.taskName)}</h2>${meta ? `<p class="wiki-note">${esc(meta)}</p>` : ""}${checks ? `<ul class="work-checks">${checks}</ul>` : ""}</section>`;
}

export function workbenchShell() {
  return `<section class="workbench" id="workbench"><p class="wiki-note">正在读取枪械…</p></section>`;
}

function render(gunId: string) {
  const needle = gunQuery.trim().toLowerCase();
  const listed = guns.filter((gun) => !needle || `${gun.name} ${gun.short} ${gun.caliber}`.toLowerCase().includes(needle));
    const side = listed.map((gun) => `<a class="work-gun${gun.id === gunId ? " on" : ""}" href="/主菜单/逃离塔科夫/工作台/${esc(gun.id)}" data-link><strong>${esc(gun.short || gun.name)}</strong><span>${esc(gun.caliber || gun.name)}</span></a>`).join("");
  const conflict = new Set(stats?.conflicts || []);
  const slotRows = slots.map((slot) => {
    const bad = slot.installed && conflict.has(slot.installed.id);
    const image = slot.installed?.icon ? `<img src="${esc(slot.installed.icon)}" alt="" />` : "";
    return `<button type="button" class="work-slot${activeSlot === slot.id ? " on" : ""}${bad ? " bad" : ""}" data-work-slot="${esc(slot.id)}" style="padding-left:${12 + slot.depth * 16}px"><span>${esc(slot.name)}${slot.required ? " · 必装" : ""}</span><strong>${image}${esc(slot.installed?.name || "空")}</strong></button>`;
  }).join("");
  const choices = allowed.filter((item) => {
    const query = partQuery.trim().toLowerCase();
    return !query || item.name.toLowerCase().includes(query);
  }).slice(0, 40).map((item) => `<button type="button" data-work-install="${esc(item.id)}">${item.icon ? `<img src="${esc(item.icon)}" alt="" />` : ""}${esc(item.name)}</button>`).join("");
  const open = slots.find((slot) => slot.id === activeSlot);
  return `
    <div class="work-layout">
      <aside class="work-side">
        <form id="work-find" class="wiki-tools"><input name="q" value="${esc(gunQuery)}" placeholder="搜枪" aria-label="搜索枪械" /><button type="submit">搜索</button></form>
        ${side || `<p class="wiki-note">没有匹配的枪。</p>`}
      </aside>
      <div class="work-main">
        ${gunId ? "" : `<p class="wiki-note">选一把枪，查看槽位、配件冲突和人机、后坐。</p>`}
        ${stats ? `<dl class="wiki-facts">
          <div><dt>人机</dt><dd>${statText(num(stats.ergonomics))}</dd></div>
          <div><dt>垂直后坐</dt><dd>${statText(num(stats.recoil_vertical))}</dd></div>
          <div><dt>水平后坐</dt><dd>${statText(num(stats.recoil_horizontal))}</dd></div>
          <div><dt>过摆</dt><dd>${statText(num(stats.overswing))}</dd></div>
          <div><dt>重量</dt><dd>${statText(num(stats.weight))}</dd></div>
          <div><dt>冲突</dt><dd>${conflict.size ? `${conflict.size} 件` : "无"}</dd></div>
        </dl>` : ""}
        ${gunId ? `<div class="wiki-tools"><button type="button" data-work-smith class="${smithOpen ? "on" : ""}">枪匠任务</button><button type="button" data-work-community class="${communityOpen ? "on" : ""}">社区方案</button></div>` : ""}
        ${smithPanel(gunId)}
        ${communityPanel()}
        ${pickedPanel()}
        ${note ? `<p class="wiki-note">${esc(note)}</p>` : ""}
        ${slotRows ? `<div class="work-slots">${slotRows}</div>` : ""}
        ${open ? `<section class="wiki-block"><h2>${esc(open.name)}</h2><form id="work-part" class="wiki-tools"><input name="q" value="${esc(partQuery)}" placeholder="搜配件" aria-label="搜索配件" /><button type="submit">筛选</button>${open.installed && !open.required ? `<button type="button" data-work-clear>卸下</button>` : ""}</form><div class="work-parts">${choices || `<p class="wiki-note">这个槽位没有可选配件。</p>`}</div></section>` : ""}
      </div>
    </div>`;
}

function bind(gunId: string) {
  const host = document.querySelector<HTMLElement>("#workbench");
  if (!host) return;
  host.querySelector("#work-find")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLInputElement>("#work-find [name=q]");
    gunQuery = input?.value.trim() || "";
    paint(gunId);
  });
  host.querySelector("#work-part")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLInputElement>("#work-part [name=q]");
    partQuery = input?.value.trim() || "";
    paint(gunId);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-work-slot]").forEach((button) => {
    button.addEventListener("click", () => {
      activeSlot = button.dataset.workSlot || "";
      partQuery = "";
      void loadAllowed(gunId);
    });
  });
  host.querySelector("[data-work-clear]")?.addEventListener("click", () => {
    if (activeSlot) void applyPair(gunId, activeSlot, "");
  });
  host.querySelectorAll<HTMLButtonElement>("[data-work-install]").forEach((button) => {
    button.addEventListener("click", () => {
      if (activeSlot) void applyPair(gunId, activeSlot, button.dataset.workInstall || "");
    });
  });
  host.querySelector("[data-work-smith]")?.addEventListener("click", () => {
    void toggleSmith(gunId);
  });
  host.querySelector("[data-work-community]")?.addEventListener("click", () => {
    void toggleCommunity(gunId);
  });
  host.querySelector("#work-smith-find")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLInputElement>("#work-smith-find [name=q]");
    smithQuery = input?.value.trim() || "";
    paint(gunId);
  });
  host.querySelectorAll<HTMLAnchorElement>("[data-smith]").forEach((link) => {
    link.addEventListener("click", () => {
      picked = smithTasks.find((task) => task.id === link.dataset.smith) || null;
      smithOpen = false;
    });
  });
  host.querySelector("[data-work-smith-clear]")?.addEventListener("click", () => {
    picked = null;
    paint(gunId);
  });
  host.querySelector("[data-work-solve]")?.addEventListener("click", () => {
    void solveSmith(gunId);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-work-build]").forEach((button) => {
    button.addEventListener("click", () => {
      const build = community.find((item) => item.id === button.dataset.workBuild);
      if (build) void applyBuild(gunId, build);
    });
  });
}

function paint(gunId: string) {
  const host = document.querySelector<HTMLElement>("#workbench");
  if (!host) return;
  host.innerHTML = render(gunId);
  bind(gunId);
}

function takeBuild(data: Record<string, unknown>) {
  const next: Slot[] = [];
  walk(data.slots, 0, next);
  slots = next;
  const given = Array.isArray(data.factory_pairs) ? data.factory_pairs : null;
  pairs = given ? given.flatMap((item) => {
    const row = rec(item);
    const slotId = str(row?.slot_id);
    const itemId = str(row?.item_id);
    return slotId && itemId ? [{ slot_id: slotId, item_id: itemId }] : [];
  }) : pairsFrom(slots);
  const nextStats = rec(data.stats);
  stats = nextStats ? nextStats as Stats : stats;
  ammoId = str(data.default_ammo_id || data.ammo_id || nextStats?.ammo_id) || ammoId;
}

async function loadAllowed(gunId: string) {
  note = "";
  if (!activeSlot) {
    allowed = [];
    paint(gunId);
    return;
  }
  try {
    const data = await invoke<{ slots?: Record<string, unknown[]> }>("site_post", {
      path: "/guides/tarkov/workbench/slots/allowed-items",
      body: { slot_ids: [activeSlot] },
    });
    allowed = (data.slots?.[activeSlot] || []).flatMap((item) => {
      const part = partOf(item);
      return part ? [part] : [];
    });
  } catch (error) {
    allowed = [];
    note = error instanceof Error ? error.message : "配件读取失败";
  }
  paint(gunId);
}

async function installPairs(gunId: string, next: Pair[], nextAmmo: string) {
  const data = await invoke<Record<string, unknown>>("site_post", {
    path: "/guides/tarkov/workbench/calculate",
    body: { gun_id: gunId, pairs: next, ammo_id: nextAmmo || null },
  });
  takeBuild(data);
  pairs = next;
  if (nextAmmo) ammoId = nextAmmo;
}

async function toggleSmith(gunId: string) {
  if (smithOpen) {
    smithOpen = false;
    paint(gunId);
    return;
  }
  communityOpen = false;
  smithOpen = true;
  if (smithReady) {
    paint(gunId);
    return;
  }
  note = "正在读取枪匠任务…";
  paint(gunId);
  try {
    const data = await invoke<{ items?: Record<string, unknown>[] } | Record<string, unknown>[]>("site_get", { path: "/guides/tarkov/workbench/gunsmith-tasks" });
    const list = Array.isArray(data) ? data : data.items || [];
    smithTasks = list.flatMap((item) => {
      const row = rec(item);
      const task = row ? readSmith(row) : null;
      return task ? [task] : [];
    });
    smithReady = true;
    note = "";
  } catch (error) {
    note = error instanceof Error ? error.message : "枪匠任务读取失败";
  }
  paint(gunId);
}

async function toggleCommunity(gunId: string) {
  if (communityOpen) {
    communityOpen = false;
    paint(gunId);
    return;
  }
  smithOpen = false;
  communityOpen = true;
  if (communityGun === gunId) {
    paint(gunId);
    return;
  }
  note = "正在读取社区方案…";
  paint(gunId);
  try {
    const data = await invoke<{ builds?: Record<string, unknown>[]; items?: Record<string, unknown>[] } | Record<string, unknown>[]>("site_get", {
      path: `/guides/tarkov/workbench/community-builds?gun_id=${encodeURIComponent(gunId)}`,
    });
    const list = Array.isArray(data) ? data : data.builds || data.items || [];
    community = list.flatMap((item) => {
      const row = rec(item);
      const build = row ? readBuild(row) : null;
      return build ? [build] : [];
    });
    communityGun = gunId;
    note = "";
  } catch (error) {
    community = [];
    note = error instanceof Error ? error.message : "社区方案读取失败";
  }
  paint(gunId);
}

async function solveSmith(gunId: string) {
  if (!picked || !gunId) return;
  note = "正在求解…";
  paint(gunId);
  try {
    const data = await invoke<Record<string, unknown>>("site_post", {
      path: "/guides/tarkov/workbench/gunsmith-solve",
      body: { task_id: picked.taskId, objective_id: picked.objectiveId || null, ammo_id: ammoId || null },
    });
    const next = pairsOf(data.pairs);
    const nextAmmo = str(data.ammo_id) || ammoId;
    if (next.length) await installPairs(gunId, next, nextAmmo);
    const status = str(data.status);
    note = status === "optimal" ? "已满足枪匠要求" : str(data.reason) || "当前改装未完全满足要求";
  } catch (error) {
    note = error instanceof Error ? error.message : "枪匠求解失败";
  }
  paint(gunId);
}

async function applyBuild(gunId: string, build: CommunityBuild) {
  if (!build.loadable) return;
  note = "正在装入方案…";
  communityOpen = false;
  paint(gunId);
  try {
    await installPairs(gunId, build.pairs, build.ammoId || ammoId);
    note = build.dropped ? `已装入「${build.name}」，省略了 ${build.dropped} 件本站没有的配件` : `已装入「${build.name}」`;
  } catch (error) {
    note = error instanceof Error ? error.message : "方案装入失败";
  }
  paint(gunId);
}

async function applyPair(gunId: string, slotId: string, itemId: string) {
  const next = pairs.filter((pair) => pair.slot_id !== slotId);
  if (itemId) next.push({ slot_id: slotId, item_id: itemId });
  note = "正在计算…";
  paint(gunId);
  try {
    const data = await invoke<Record<string, unknown>>("site_post", {
      path: "/guides/tarkov/workbench/calculate",
      body: { gun_id: gunId, pairs: next, ammo_id: ammoId || null },
    });
    takeBuild(data);
    pairs = next;
    note = "";
  } catch (error) {
    note = error instanceof Error ? error.message : "属性计算失败";
  }
  paint(gunId);
}

export async function mountWorkbench(gunId: string) {
  const token = ++seq;
  const host = document.querySelector<HTMLElement>("#workbench");
  if (!host) return;
  host.innerHTML = `<p class="wiki-note">正在读取枪械…</p>`;
  try {
    if (!guns.length) {
      const data = await invoke<{ items?: Record<string, unknown>[] } | Record<string, unknown>[]>("site_get", { path: "/guides/tarkov/guns" });
      const list = Array.isArray(data) ? data : data.items || [];
      guns = list.flatMap((item) => {
        const row = rec(item);
        if (!row) return [];
        const id = str(row.id);
        const name = str(row.name || row.short_name) || id;
        if (!id || !name) return [];
        return [{ id, name, short: str(row.short_name || row.shortName), caliber: str(row.caliber) }];
      }).sort((a, b) => (a.short || a.name).localeCompare(b.short || b.name, "zh"));
    }
    if (token !== seq) return;
    if (gunId) {
      const data = await invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/workbench/guns/${encodeURIComponent(gunId)}` });
      if (token !== seq) return;
      activeSlot = "";
      allowed = [];
      partQuery = "";
      note = "";
      if (picked && picked.weaponId && picked.weaponId !== gunId) picked = null;
      if (communityGun && communityGun !== gunId) {
        community = [];
        communityGun = "";
        communityOpen = false;
      }
      takeBuild(data);
    } else {
      slots = [];
      stats = null;
      pairs = [];
    }
    paint(gunId);
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#workbench");
    if (!live) return;
    const message = error instanceof Error ? error.message : "工作台读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

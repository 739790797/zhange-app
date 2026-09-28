import { bindListSearch, listBusy, listFail, listFrame, listIcon, listItem, listShell, repaintList } from "./listFrame";
import { spin } from "./spinner";
import { mapPhrase, mapTitle } from "./mapNames";

type Boss = {
  id: string;
  slug: string;
  name: string;
  image: string;
  kind: string;
  parents: string[];
};

type HealthPart = { name: string; max: number };
type GearChild = {
  id: string;
  name: string;
  short: string;
  icon: string;
  count: number;
  kind: string;
  damage: number | null;
  pen: number | null;
  armorDmg: number | null;
  armorClass: number | null;
};
type GearItem = GearChild & { contains: GearChild[] };
type GearSlot = { key: string; label: string; items: GearItem[] };
type SpawnMap = { slug: string; name: string; chance: string };
type SpawnLoc = { name: string; chance: number };
type SpawnEscort = { slug: string; name: string; count: number; chance: number };
type SpawnGroup = {
  maps: SpawnMap[];
  shared: string;
  land: string;
  locations: SpawnLoc[];
  escorts: SpawnEscort[];
  showChance: boolean;
};
type Detail = {
  id: string;
  slug: string;
  name: string;
  parents: string[];
  behaviorZh: string;
  mapsLabel: string;
  spawnLabel: string;
  healthTotal: number;
  health: HealthPart[];
  portrait: string;
  poster: string;
  wiki: string;
  bio: string;
  description: string;
  groups: SpawnGroup[];
  slots: GearSlot[];
};

const GEAR_GROUPS = [
  { id: "wear", label: "穿着", keys: ["headwear", "face", "eyewear", "earpiece", "armor", "rig", "backpack"] },
  { id: "arms", label: "武装", keys: ["gun", "pistol", "melee", "grenade"] },
  { id: "carry", label: "携带", keys: ["ammo", "meds", "provisions", "keys", "special", "container", "other"] },
];
const EFFECT = ["无效", "勉强", "扫射", "略好", "有效", "很好", "无视"];
const EFFECT_BG = ["#6d1010", "#8f2a14", "#a34818", "#a35f16", "#6b7024", "#3d7a2a", "#2f9b32"];

let seq = 0;
let bosses: Boss[] = [];
let pickedBoss = "";
let bossQuery = "";
let detailSlug = "";
let detail: Detail | null = null;
let detailLoading = false;
let detailError = "";

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
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNum(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ids(value: unknown) {
  return Array.isArray(value) ? value.map((item) => str(item)).filter(Boolean) : [];
}

function isBossId(id: string) {
  return id.trim().toLowerCase().startsWith("boss");
}

function isFollowerId(id: string) {
  return id.trim().toLowerCase().startsWith("follower");
}

function namedParent(parents: string[]) {
  return parents.find((id) => isBossId(id)) || "";
}

function isTopBoss(boss: Boss) {
  if (namedParent(boss.parents)) return false;
  if (isFollowerId(boss.id)) return false;
  return isBossId(boss.id) || boss.kind === "boss";
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function readBoss(row: Record<string, unknown>): Boss | null {
  const id = str(row.id) || str(row.slug);
  const slug = str(row.slug) || id;
  const name = str(row.name) || slug;
  if (!slug || !name) return null;
  return {
    id,
    slug,
    name,
    image: str(row.portrait_link || row.image_link || row.icon_link),
    kind: str(row.kind).toLowerCase(),
    parents: ids(row.parent_ids || row.parentIds),
  };
}

function readGearChild(value: unknown): GearChild | null {
  const row = rec(value);
  if (!row) return null;
  const id = str(row.item_id || row.itemId);
  const name = str(row.name) || str(row.short_name) || id;
  if (!id || !name) return null;
  return {
    id,
    name,
    short: str(row.short_name || row.shortName),
    icon: str(row.icon_link || row.iconLink),
    count: Math.max(1, num(row.count) || 1),
    kind: str(row.kind).toLowerCase(),
    damage: optionalNum(row.damage),
    pen: optionalNum(row.penetration),
    armorDmg: optionalNum(row.armor_damage ?? row.armorDamage),
    armorClass: optionalNum(row.armor_class ?? row.armorClass),
  };
}

function bodyName(value: string) {
  const text = value.trim();
  if (!text || /[\u4e00-\u9fff]/.test(text)) return text;
  const key = text.toLowerCase().replace(/[\s_-]+/g, "");
  const label: Record<string, string> = {
    head: "头部", thorax: "胸部", stomach: "腹部",
    leftarm: "左臂", rightarm: "右臂", leftleg: "左腿", rightleg: "右腿",
  };
  return label[key] || text;
}

function readDetail(row: Record<string, unknown>): Detail {
  const groups = (Array.isArray(row.spawn_groups) ? row.spawn_groups : []).flatMap((item) => {
    const group = rec(item);
    if (!group) return [];
    const maps = (Array.isArray(group.maps) ? group.maps : []).flatMap((map) => {
      const cell = rec(map);
      if (!cell) return [];
      const slug = str(cell.slug);
      const name = mapTitle(slug, str(cell.name));
      if (!name) return [];
      return [{ slug, name, chance: str(cell.spawn_chance || cell.spawnChance) }];
    });
    const locations = (Array.isArray(group.locations) ? group.locations : []).flatMap((loc) => {
      const cell = rec(loc);
      const name = str(cell?.name);
      if (!name) return [];
      return [{ name, chance: num(cell?.chance) }];
    });
    const escorts = (Array.isArray(group.escorts) ? group.escorts : []).flatMap((escort) => {
      const cell = rec(escort);
      if (!cell) return [];
      const name = str(cell.name) || str(cell.slug);
      if (!name) return [];
      return [{ slug: str(cell.slug), name, count: num(cell.count), chance: num(cell.chance) }];
    });
    return [{
      maps,
      shared: str(group.shared_spawn_chance || group.sharedSpawnChance),
      land: str(group.land_label || group.landLabel),
      locations,
      escorts,
      showChance: group.show_location_chance === true || group.showLocationChance === true,
    }];
  });
  const slots = (Array.isArray(row.equipment_slots) ? row.equipment_slots : []).flatMap((item) => {
    const slot = rec(item);
    if (!slot) return [];
    const items = (Array.isArray(slot.items) ? slot.items : []).flatMap((gear) => {
      const parsed = readGearChild(gear);
      if (!parsed) return [];
      const source = rec(gear);
      const contains = (Array.isArray(source?.contains) ? source.contains : []).flatMap((child) => {
        const parsedChild = readGearChild(child);
        return parsedChild ? [parsedChild] : [];
      });
      return [{ ...parsed, contains }];
    });
    if (!items.length) return [];
    return [{ key: str(slot.key), label: str(slot.label) || "装备", items }];
  });
  return {
    id: str(row.id) || str(row.slug),
    slug: str(row.slug) || str(row.id),
    name: str(row.name) || str(row.slug),
    parents: ids(row.parent_ids || row.parentIds),
    behaviorZh: str(row.behavior_zh || row.behaviorZh),
    mapsLabel: mapPhrase(str(row.maps_label || row.mapsLabel)),
    spawnLabel: str(row.spawn_label || row.spawnLabel),
    healthTotal: num(row.health_total ?? row.healthTotal),
    health: (Array.isArray(row.health) ? row.health : []).flatMap((item) => {
      const part = rec(item);
      const name = bodyName(str(part?.name));
      if (!name) return [];
      return [{ name, max: num(part?.max) }];
    }),
    portrait: str(row.portrait_link || row.portraitLink),
    poster: str(row.poster_link || row.posterLink),
    wiki: str(row.wiki_link || row.wikiLink),
    bio: str(row.bio),
    description: str(row.description),
    groups,
    slots,
  };
}

function matches(boss: Boss, needle: string) {
  if (!needle) return true;
  return boss.name.toLowerCase().includes(needle) || boss.slug.toLowerCase().includes(needle);
}

function catalog() {
  const tops = bosses.filter(isTopBoss);
  const topIds = new Set(tops.map((boss) => boss.id));
  const nested = new Set<string>();
  const trees = tops.map((parent) => {
    const children = bosses.filter((boss) => {
      if (boss.slug === parent.slug || nested.has(boss.slug)) return false;
      if (namedParent(boss.parents) !== parent.id) return false;
      if (!isFollowerId(boss.id) && !isBossId(boss.id)) return false;
      nested.add(boss.slug);
      return true;
    });
    return { boss: parent, children };
  });
  const others = bosses.filter((boss) => !topIds.has(boss.id) && !nested.has(boss.slug));
  return { trees, others };
}

function listed() {
  const needle = bossQuery.trim().toLowerCase();
  const { trees, others } = catalog();
  const shownTrees = trees.flatMap((tree) => {
    const parentHit = matches(tree.boss, needle);
    const children = tree.children.filter((child) => parentHit || matches(child, needle) || child.slug === pickedBoss);
    if (!parentHit && !children.length && tree.boss.slug !== pickedBoss) return [];
    return [{ boss: tree.boss, children: parentHit || tree.boss.slug === pickedBoss ? tree.children : children }];
  });
  const shownOthers = others.filter((boss) => matches(boss, needle) || boss.slug === pickedBoss);
  return { trees: shownTrees, others: shownOthers };
}

function sideItem(boss: Boss, nested = false) {
  const row = listItem(esc(boss.name), boss.slug === pickedBoss, `data-boss-pick="${esc(boss.slug)}"`, listIcon(boss.image));
  return nested ? `<div class="boss-nest">${row}</div>` : row;
}

function sideHead(label: string, count: number) {
  return `<div class="boss-side-head">${label}<span>${count}</span></div>`;
}

function escortLabel(row: SpawnEscort) {
  const qty = row.count > 0 ? `×${row.count}` : "";
  const chance = row.chance > 0 && row.chance < 0.995 ? `（${Math.round(row.chance * 100)}%）` : "";
  return `${row.name} ${qty}${chance}`.trim();
}

function portraitOf(slug: string) {
  const key = slug.trim().toLowerCase();
  return bosses.find((boss) => boss.slug.toLowerCase() === key || boss.id.toLowerCase() === key)?.image || "";
}

function armorLevel(pen: number, armorClass: number, armorDamage: number) {
  const resist = (121 - 5000 / (45 + 200)) * armorClass * 0.1;
  const gap = pen - resist;
  const first = gap >= 0 ? Math.min(0.99, 0.9 + Math.min(0.09, gap * 0.01)) : gap <= -15 ? 0 : Math.min(1, Math.max(0, 0.004 * (15 + gap) ** 2));
  if (first >= 0.8) return 6;
  const loss = Math.max(1, pen * (armorDamage / 100) * 0.45 * (0.7 + 0.05 * armorClass));
  const shots = Math.min(30, (60 / loss) * (1 - first));
  if (shots < 3) return 5;
  if (shots < 5) return 4;
  if (shots < 9) return 3;
  if (shots < 13) return 2;
  return shots < 20 ? 1 : 0;
}

function itemLabel(item: GearChild, compact = false) {
  const name = compact && item.short ? item.short : item.name;
  return item.count > 1 ? `${name} ×${item.count}` : name;
}

function gearButton(item: GearChild, className: string) {
  const icon = item.icon ? `<img src="${esc(item.icon)}" alt="" />` : "";
  return `<button type="button" class="${className}" data-wiki="item" data-wiki-id="${esc(item.id)}" title="${esc(item.name)}">${icon}<span>${esc(itemLabel(item, className !== "boss-gear-main"))}</span></button>`;
}

function gearCard(item: GearItem) {
  const magazines = item.contains.filter((child) => child.kind === "magazine");
  const ammo = item.contains.filter((child) => child.kind === "ammo");
  const plates = item.contains.filter((child) => child.kind === "plate");
  const other = item.contains.filter((child) => !["magazine", "ammo", "plate"].includes(child.kind));
  const klass = item.armorClass ? `<em>${item.armorClass} 级</em>` : "";
  const block = (label: string, body: string) => body ? `<div class="boss-stow"><b>${label}</b><div>${body}</div></div>` : "";
  const ammoRows = ammo.map((child) => {
    const effects = child.pen != null && child.armorDmg != null
      ? `<span class="boss-ammo-armor">${[1, 2, 3, 4, 5, 6].map((level) => {
        const rank = armorLevel(child.pen || 0, level, child.armorDmg || 0);
        return `<i style="background:${EFFECT_BG[rank]}" title="${level}级 ${EFFECT[rank]}">${level}</i>`;
      }).join("")}</span>`
      : "";
    return `<div class="boss-ammo">${gearButton(child, "boss-gear-mini")}<span>${child.damage ?? "—"} / ${child.pen ?? "—"}</span>${effects}</div>`;
  }).join("");
  return `<article class="boss-gear">
    <div class="boss-gear-line">${gearButton(item, "boss-gear-main")}${klass}</div>
    ${block("弹匣", magazines.map((child) => gearButton(child, "boss-gear-mini")).join(""))}
    ${block("子弹", ammoRows)}
    ${block("插板", plates.map((child) => gearButton(child, "boss-gear-mini")).join(""))}
    ${other.length ? `<div class="boss-gear-other">${other.map((child) => gearButton(child, "boss-gear-mini")).join("")}</div>` : ""}
  </article>`;
}

function gearHtml(slots: GearSlot[]) {
  const plates = slots.filter((slot) => slot.key === "armorPlate").flatMap((slot) => slot.items);
  const merged = slots.flatMap((slot) => {
    if (slot.key === "armorPlate") return [];
    if (slot.key === "armor" && plates.length) return [{ ...slot, label: slot.label || "身体护甲", items: [...slot.items, ...plates] }];
    return [slot];
  });
  if (plates.length && !merged.some((slot) => slot.key === "armor")) merged.unshift({ key: "armor", label: "身体护甲", items: plates });
  const used = new Set<string>();
  const groups = GEAR_GROUPS.map((group) => {
    const rows = merged.filter((slot) => group.keys.includes(slot.key));
    rows.forEach((slot) => used.add(slot.key));
    return { ...group, slots: rows };
  }).filter((group) => group.slots.length);
  const rest = merged.filter((slot) => !used.has(slot.key));
  if (rest.length) groups.push({ id: "rest", label: "其他", keys: [], slots: rest });
  if (!groups.length) return "";
  return `<section class="boss-section"><h3><span>◆</span>配装</h3>${groups.map((group) => `<div class="boss-gear-group"><h4>${group.label}</h4>${group.slots.map((slot) => `<div class="boss-slot"><div class="boss-slot-meta"><b>${esc(slot.label)}</b><span>${slot.items.length} 件</span></div><div class="boss-gear-grid${slot.key === "gun" || slot.key === "pistol" ? " armed" : ""}">${slot.items.map(gearCard).join("")}</div></div>`).join("")}</div>`).join("")}</section>`;
}

function spawnHtml(detailRow: Detail) {
  if (!detailRow.groups.length) return "";
  const body = detailRow.groups.map((group) => {
    const maps = group.maps.map((map) => {
      const chance = map.chance || group.shared;
      const label = `${esc(map.name)}${chance ? `（${esc(chance)}）` : ""}`;
      return map.slug
        ? `<button type="button" data-map="${esc(map.slug)}">${label}</button>`
        : `<span>${label}</span>`;
    }).join("") || "—";
    const locations = group.locations.map((loc) => {
      const chance = group.showChance && loc.chance > 0 ? ` ${Math.round(loc.chance * 100)}%` : "";
      return `<span>${esc(loc.name)}${chance}</span>`;
    }).join("") || "—";
    const escorts = group.escorts.map((escort) => {
      const image = portraitOf(escort.slug);
      const face = image ? `<img src="${esc(image)}" alt="" />` : "";
      const attrs = escort.slug ? ` data-boss-pick="${esc(escort.slug)}"` : "";
      return `<button type="button" class="boss-escort"${attrs}>${face}<span>${esc(escortLabel(escort))}</span></button>`;
    }).join("") || "—";
    return `<tr><td>${maps}</td><td>${esc(group.land || "—")}</td><td class="boss-locs">${locations}</td><td class="boss-escorts">${escorts}</td></tr>`;
  }).join("");
  return `<section class="boss-section"><h3>刷新</h3><div class="boss-spawn-wrap"><table class="boss-spawn"><thead><tr><th>地图</th><th>落地</th><th>区域</th><th>随从</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function detailHtml(row: Detail) {
  const known = bosses.find((boss) => boss.slug === row.slug);
  const badge = known && isTopBoss(known) ? `<span class="boss-badge">Boss</span>` : "";
  const wiki = row.wiki ? `<a class="boss-wiki" href="${esc(row.wiki)}" target="_blank" rel="noreferrer">Wiki</a>` : "";
  const health = row.health.length ? `<div class="boss-health-parts">${row.health.map((part) => `${esc(part.name)} ${part.max}`).join(" · ")}</div>` : "";
  const poster = row.poster || row.portrait;
  return `<div class="boss-detail">
    <section class="boss-hero">
      <div class="boss-hero-copy">
        <div class="boss-head">${badge}<h2>${esc(row.name)}</h2>${wiki}</div>
        ${row.bio ? `<p class="boss-bio">${esc(row.bio)}</p>` : ""}
        ${row.description ? `<span class="boss-kicker">行为</span><p class="boss-desc">${esc(row.description)}</p>` : ""}
        <div class="boss-stats">
          <div><span>行为</span><b>${esc(row.behaviorZh || "—")}</b></div>
          <div><span>地图</span><b>${esc(row.mapsLabel || "—")}</b></div>
          <div><span>刷新概率</span><b>${esc(row.spawnLabel || "—")}</b></div>
          <div><span>生命值</span><b>${row.healthTotal || "—"}</b>${health}</div>
        </div>
      </div>
      <div class="boss-poster">${poster ? `<img src="${esc(poster)}" alt="" />` : ""}</div>
    </section>
    ${spawnHtml(row)}
    ${gearHtml(row.slots)}
  </div>`;
}

function panelHtml() {
  if (!pickedBoss) return `<p class="tarkov-list-empty">从左侧选择一个角色。</p>`;
  if (detailLoading && detailSlug === pickedBoss && !detail) return spin("正在读取详情");
  if (detailError && detailSlug === pickedBoss) return `<p class="tarkov-list-empty">${esc(detailError)}</p>`;
  if (detail && detailSlug === pickedBoss) return detailHtml(detail);
  return spin("正在读取详情");
}

function render() {
  const { trees, others } = listed();
  const current = bosses.find((boss) => boss.slug === pickedBoss);
  const side = [
    trees.length ? sideHead("Boss", trees.reduce((count, tree) => count + 1 + tree.children.length, 0)) : "",
    ...trees.flatMap((tree) => [sideItem(tree.boss), ...tree.children.map((child) => sideItem(child, true))]),
    others.length ? sideHead("非 Boss", others.length) : "",
    ...others.map((boss) => sideItem(boss)),
  ].join("");
  return listFrame({
    side: side || `<p class="tarkov-list-empty">没有匹配的角色。</p>`,
    meta: `${current ? esc(current.name) : `Boss ${catalog().trees.length} · 非 Boss ${catalog().others.length}`}`,
    search: { id: "boss-find", value: bossQuery, placeholder: "搜索名称", label: "搜索 Boss" },
    panel: panelHtml(),
  });
}

async function ensureDetail(slug: string) {
  if (!slug || (detailSlug === slug && (detail || detailLoading || detailError))) return;
  detailSlug = slug;
  detail = null;
  detailError = "";
  detailLoading = true;
  paint();
  try {
    const data = await invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/bosses/${encodeURIComponent(slug)}` });
    if (detailSlug !== slug) return;
    detail = readDetail(data.boss && typeof data.boss === "object" ? data.boss as Record<string, unknown> : data);
  } catch (error) {
    if (detailSlug !== slug) return;
    detailError = error instanceof Error ? error.message : "Boss 详情读取失败";
  } finally {
    if (detailSlug === slug) {
      detailLoading = false;
      paint();
    }
  }
}

function paint() {
  const host = document.querySelector<HTMLElement>("#boss-list");
  if (!host) return;
  repaintList(host, "boss-find", () => {
    host.innerHTML = bosses.length ? render() : `<p class="tarkov-list-empty">没有读到 Boss</p>`;
  });
  bindListSearch(host, "boss-find", (value) => {
    bossQuery = value;
    paint();
  });
  host.querySelectorAll<HTMLButtonElement>("[data-boss-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      const slug = button.dataset.bossPick || "";
      if (!slug || slug === pickedBoss) return;
      pickedBoss = slug;
      void ensureDetail(slug);
    });
  });
  if (pickedBoss && detailSlug !== pickedBoss && !detailLoading) void ensureDetail(pickedBoss);
}

export function bossShell() {
  return listShell("boss-list", "正在读取 Boss");
}

export async function mountBosses() {
  const token = ++seq;
  const host = document.querySelector<HTMLElement>("#boss-list");
  if (!host) return;
  listBusy(host, "正在读取 Boss");
  try {
    const data = await invoke<{ items?: Record<string, unknown>[] }>("site_get", { path: "/guides/tarkov/bosses" });
    if (token !== seq || !document.querySelector("#boss-list")) return;
    bosses = (data.items || []).flatMap((item) => {
      const row = rec(item);
      const boss = row ? readBoss(row) : null;
      return boss ? [boss] : [];
    });
    const { trees, others } = catalog();
    if (!bosses.some((boss) => boss.slug === pickedBoss)) {
      pickedBoss = trees[0]?.boss.slug || others[0]?.slug || "";
      detail = null;
      detailSlug = "";
      detailError = "";
    }
    paint();
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector<HTMLElement>("#boss-list");
    if (!live) return;
    listFail(live, error instanceof Error ? error.message : "Boss 读取失败");
  }
}

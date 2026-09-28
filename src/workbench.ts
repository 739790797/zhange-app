import { fadeIn, fadeOut } from "./motion";
import { pushNav, replaceNav } from "./navHistory";
import { spin } from "./spinner";

type Pair = { slot_id: string; item_id: string };
type Part = {
  id: string;
  name: string;
  short: string;
  icon: string;
  ergo: number;
  recoil: number;
  weight: number;
  price: number | null;
  conflicts: string[];
  categories: string[];
};
type SlotNode = {
  id: string;
  name: string;
  nameId: string;
  required: boolean;
  installed: Part | null;
  children: SlotNode[];
};
type Stats = {
  ergonomics: number;
  recoilV: number;
  recoilH: number;
  weight: number;
  sighting: number | null;
  mag: number | null;
  price: number | null;
  conflicts: string[];
  accuracy: number | null;
  muzzle: number | null;
  ammoId: string;
};
type GunCard = {
  id: string;
  name: string;
  short: string;
  caliber: string;
  weaponClass: string;
  icon: string;
};
type LoadedGun = {
  id: string;
  name: string;
  short: string;
  image: string;
  preset: string;
  ammo: { id: string; name: string }[];
};
type Named = { id: string; name: string };
type SmithTask = {
  id: string;
  taskId: string;
  objectiveId: string;
  taskName: string;
  trader: string;
  faction: string;
  weaponId: string;
  weaponName: string;
  weaponImage: string;
  loadable: boolean;
  constraints: Record<string, number>;
  requiredItems: Named[];
  categoryGroups: Named[][];
};
type CommunityBuild = {
  id: string;
  name: string;
  author: string;
  featured: boolean;
  loadable: boolean;
  dropped: number;
  published: string;
  loads: number;
  hasPreview: boolean;
  ergo: number | null;
  evo: number | null;
  recoilV: number | null;
  recoilH: number | null;
  overswing: boolean;
  price: number | null;
  pairs: Pair[];
  ammoId: string;
};
type PartSortKey = "name" | "ergonomics" | "recoil" | "weight" | "price";
type CommunitySortKey = "published" | "loads" | "ergo" | "evo" | "recoilV" | "recoilH" | "overswing" | "price";
type SortDir = "asc" | "desc";
type SlotFamily =
  | "muzzle" | "barrel" | "gas" | "handguard" | "catch" | "receiver" | "stock"
  | "charge" | "front_sight" | "rear_sight" | "scope" | "mount" | "magazine"
  | "pistol_grip" | "foregrip" | "bipod" | "tactical" | "ubgl" | "grip"
  | "shroud" | "trigger" | "chamber" | "hammer" | "unknown";
type GridSlot = {
  slotId: string;
  family: SlotFamily;
  slotName: string;
  itemId: string;
  icon: string;
  shortName: string;
  required: boolean;
  empty: boolean;
  parentSlotId: string | null;
  parentFamily: SlotFamily | null;
  isBase: boolean;
};
type LaidCell = GridSlot & { col: number | null; row: number | null; extras: boolean };

const BASE = "/主菜单/逃离塔科夫/枪匠工作台";
const STRENGTH_KEY = "zhange.guides.tarkov.workbench.strengthLevel";
const EQUIP_KEY = "zhange.guides.tarkov.workbench.equipErgoPenalty";
const FACTION_KEY = "zhange.guides.tarkov.pmcFaction.v1";
const STRENGTH_MIN = 0;
const STRENGTH_MAX = 51;
const STRENGTH_DEFAULT = 10;
const EQUIP_MIN = 0;
const EQUIP_MAX = 100;
const GRID_COLS = 10;
const GUN_COL = 7;
const GUN_SPAN = 3;
const STOCK_COL = 10;
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
const LIVE_CONSTRAINTS = new Set(["min_ergonomics", "max_recoil_sum", "max_weight", "min_mag_capacity", "max_mag_capacity", "min_sighting_range"]);
const WEAPON_CLASS: Record<string, string> = {
  "assault-rifle": "突击步枪",
  handgun: "手枪",
  shotgun: "霰弹枪",
  "sniper-rifle": "狙击步枪",
  "assault-carbine": "卡宾枪",
  "marksman-rifle": "精确射手步枪",
  smg: "冲锋枪",
  machinegun: "机枪",
  "grenade-launcher": "榴弹发射器",
  revolver: "左轮",
  "rocket-launcher": "火箭筒",
};
const CALIBER_LABEL: Record<string, string> = {
  "1143x23acp": ".45 ACP",
  "9x18pm": "9x18mm",
  "9x18pmm": "9x18mm PMM",
  "9x18mmpmm": "9x18mm PMM",
  "9x19para": "9x19mm",
  "9x21": "9x21mm",
  "9x33r": ".357 Magnum",
  "7.62x25tt": "7.62x25mm",
  "46x30": "4.6x30mm",
  "57x28": "5.7x28mm",
  "5.45x39": "5.45x39mm",
  "5.56x45nato": "5.56x45mm",
  "58x42": "5.8x42mm",
  "68x51": "6.8x51mm",
  "7.62x35": ".300 Blackout",
  "7.62x39": "7.62x39mm",
  "7.62x51": "7.62x51mm",
  "7.62x54r": "7.62x54mm R",
  "784x49": ".308 Marlin Express",
  "9x39": "9x39mm",
  "93x64": "9.3x64mm",
  "366tkm": ".366 TKM",
  "127x33": ".50 AE",
  "127x55": "12.7x55mm",
  "127x99": ".50 BMG",
  "86x70": ".338 Lapua",
  "12g": "12/70",
  "20g": "20/70",
  "20x1mm": "20x1mm",
  "23x75": "23x75mm",
  "26x75": "26x75mm",
  "40x46": "40x46mm",
  "40mmru": "40mm RU",
  "127x108": "12.7x108mm",
  "30x29": "30x29mm",
  "725": "72.5mm",
};
const EED_HINT = "与纸面人机不同，Evo人机工效将装备重量一并纳入计算。两把Evo人机相同的枪操纵性理论上完全一致（过摆行为与开镜速度均相同，除去技能等级等变量影响）。人物重量会影响开镜速度，但不影响过摆。请设置装备人机工效修正以获得准确结果。";
const OVERSWING_HINT = "表示开镜后准星是否会摆过中心点。当EED为负时发生。预计偏差 ±2 EED。";
const STRENGTH_HINT = "影响站立时手臂耐力耗尽所需秒数，预计偏差 ±0.5s";
const EQUIP_HINT = "所佩戴装备（头盔、防弹衣、背包、战术背心、面罩、护目镜）的人机工效惩罚总和。请根据游戏中的实际装备进行设置。";
const LEFT_ORDER: SlotFamily[] = ["receiver", "handguard", "catch", "barrel", "gas", "muzzle"];
const TOP_COL: Partial<Record<SlotFamily, number>> = { scope: GUN_COL + 1, mount: GUN_COL + 1, rear_sight: GUN_COL + 2 };
const BOTTOM_COL: Partial<Record<SlotFamily, number>> = { magazine: GUN_COL + 1, pistol_grip: GUN_COL + 2 };
const BOTTOM_LEFT = new Set<SlotFamily>(["bipod", "foregrip", "ubgl"]);
const EXTRAS = new Set<SlotFamily>(["grip", "shroud", "trigger", "chamber", "hammer"]);

let seq = 0;
let calcEpoch = 0;
let allowedEpoch = 0;
let cacheMode = "";
let routeGun = "";
let taskId = "";
let objectiveId = "";
let guns: GunCard[] = [];
let gunsReady = false;
let gunsError = "";
let gunsLoading = false;
let gun: LoadedGun | null = null;
let loadedGunId = "";
let gunError = "";
let factoryPairs: Pair[] = [];
let defaultAmmo = "";
let slots: SlotNode[] = [];
let pairs: Pair[] = [];
let stats: Stats | null = null;
let ammoId = "";
let activeSlot = "";
let allowedMap: Record<string, Part[]> = {};
let allowedKey = "";
let allowedLoading = false;
let partQuery = "";
let partSort: { key: PartSortKey; dir: SortDir } = { key: "ergonomics", dir: "desc" };
let note = "";
let noteBad = false;
let pending = false;
let pickOpen = false;
let gunQuery = "";
let caliberFilter = "";
let classFilter = "";
let smithTasks: SmithTask[] = [];
let smithReady = false;
let smithMode = "";
let smithError = "";
let smithLoading = false;
let smithOpen = false;
let smithQuery = "";
let community: CommunityBuild[] = [];
let communityGun = "";
let communityMode = "";
let communityError = "";
let communityLoading = false;
let communityOpen = false;
let communitySort: { key: CommunitySortKey; dir: SortDir } | null = null;
let page = 1;
let pageSize = 50;
let strength = loadStrength();
let equipPenalty = loadEquip();
let keyBound = false;

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

function strings(value: unknown) {
  return (Array.isArray(value) ? value : []).map((item) => str(item)).filter(Boolean);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number) {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function gameMode() {
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

function factionOk(name: string) {
  const selected = factionChoice();
  if (!selected) return true;
  const faction = name.trim().toLowerCase();
  if (!faction || faction === "any") return true;
  return faction === selected;
}

function loadStrength() {
  try {
    return clampInt(localStorage.getItem(STRENGTH_KEY), STRENGTH_MIN, STRENGTH_MAX, STRENGTH_DEFAULT);
  } catch {
    return STRENGTH_DEFAULT;
  }
}

function loadEquip() {
  try {
    return clampInt(localStorage.getItem(EQUIP_KEY), EQUIP_MIN, EQUIP_MAX, 0);
  } catch {
    return 0;
  }
}

function saveStrength(value: number) {
  strength = clampInt(value, STRENGTH_MIN, STRENGTH_MAX, STRENGTH_DEFAULT);
  try { localStorage.setItem(STRENGTH_KEY, String(strength)); } catch { /* 配额不足时只留在当前页 */ }
}

function saveEquip(value: number) {
  equipPenalty = clampInt(value, EQUIP_MIN, EQUIP_MAX, 0);
  try { localStorage.setItem(EQUIP_KEY, String(equipPenalty)); } catch { /* 配额不足时只留在当前页 */ }
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function iconOf(icon: string, id: string) {
  const url = icon.trim().replace(/-(?:icon|grid-image|base-image|512|8x|image)\.webp(\?.*)?$/i, "-icon.webp$1");
  if (url) return url;
  return /^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-icon.webp` : "";
}

function hdOf(src: string) {
  const url = src.trim();
  if (!url) return "";
  return url.replace(/-(?:icon|grid-image|base-image|512|8x|image)\.webp(\?.*)?$/i, "-512.webp$1");
}

function caliberLabel(value: string) {
  const raw = value.trim();
  if (!raw) return "—";
  const key = raw.toLowerCase().replace(/\s+/g, "").replace(/^caliber/, "");
  return CALIBER_LABEL[key] || (/^caliber/i.test(raw) ? key || raw : raw);
}

function classLabel(value: string) {
  const key = value.trim();
  if (!key) return "—";
  return WEAPON_CLASS[key] || key;
}

function formatSigned(value: number) {
  if (!Number.isFinite(value) || value === 0) return "0";
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

function formatWeight(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 1000) / 1000} kg`;
}

function formatMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value).toLocaleString("zh-CN")} ₽`;
}

function formatErgo(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value - Math.round(value)) < 0.001) return String(Math.round(value));
  return String(Math.round(value * 10) / 10);
}

function formatEed(value: number) {
  const text = value.toFixed(1);
  return value > 0 ? `+${text}` : text;
}

function formatEvo(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = Math.round(value * 10) / 10;
  const text = n.toFixed(1);
  return n >= 0 ? `+${text}` : text;
}

function equipModifier() {
  return -equipPenalty / 100;
}

function weightCap(ergo: number, equip = equipModifier()) {
  const adjusted = ergo * (1 + equip);
  return 0.0007556 * adjusted * adjusted + 0.02736 * adjusted + 2.9159;
}

function eedRaw(ergo: number, weight: number, equip = equipModifier()) {
  return -15 * (weight - weightCap(ergo, equip));
}

function eedOf(ergo: number, weight: number) {
  return Math.round(eedRaw(ergo, weight) * 10) / 10;
}

function overswingOf(ergo: number, weight: number) {
  return eedRaw(ergo, weight) < 0;
}

function armSeconds(weight: number, ergo: number) {
  const safeWeight = weight > 0 ? weight : 0;
  const bonus = 1 + equipModifier() / 2;
  return Math.round(((85.5 / (safeWeight + 0.65) + 9.15 + 0.06477 * ergo * bonus) / 1.04) * (1 + strength * 0.004) * 10) / 10;
}

function readPart(value: unknown): Part | null {
  const row = rec(value);
  if (!row) return null;
  const id = str(row.id);
  const name = str(row.name || row.short_name || row.shortName) || id;
  if (!id || !name) return null;
  return {
    id,
    name,
    short: str(row.short_name || row.shortName),
    icon: iconOf(str(row.icon_link || row.iconLink), id),
    ergo: num(row.ergonomics) || 0,
    recoil: num(row.recoil_modifier ?? row.recoilModifier) || 0,
    weight: num(row.weight) || 0,
    price: row.price_rub == null && row.priceRub == null ? null : num(row.price_rub ?? row.priceRub),
    conflicts: strings(row.conflicting_ids || row.conflictingIds),
    categories: strings(row.category_ids || row.categoryIds),
  };
}

function readSlots(value: unknown): SlotNode[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const row = rec(item);
    if (!row) return [];
    const id = str(row.id);
    if (!id) return [];
    return [{
      id,
      name: str(row.name || row.label) || "槽位",
      nameId: str(row.name_id || row.nameId),
      required: row.required === true || row.mandatory === true,
      installed: readPart(row.installed),
      children: readSlots(row.children),
    }];
  });
}

function readStats(value: unknown): Stats | null {
  const row = rec(value);
  if (!row) return null;
  return {
    ergonomics: num(row.ergonomics) || 0,
    recoilV: num(row.recoil_vertical ?? row.recoilVertical) || 0,
    recoilH: num(row.recoil_horizontal ?? row.recoilHorizontal) || 0,
    weight: num(row.weight) || 0,
    sighting: num(row.sighting_range ?? row.sightingRange),
    mag: num(row.mag_capacity ?? row.magCapacity),
    price: num(row.price_rub ?? row.priceRub),
    conflicts: strings(row.conflicts),
    accuracy: num(row.accuracy_moa ?? row.accuracyMoa),
    muzzle: num(row.muzzle_velocity ?? row.muzzleVelocity),
    ammoId: str(row.ammo_id || row.ammoId),
  };
}

function pairsOf(value: unknown): Pair[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const row = rec(item);
    const slotId = str(row?.slot_id || row?.slotId);
    const itemId = str(row?.item_id || row?.itemId);
    return slotId && itemId ? [{ slot_id: slotId, item_id: itemId }] : [];
  });
}

function named(value: unknown): Named[] {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const row = rec(item);
    const id = str(row?.id);
    const name = str(row?.name || row?.short_name) || id;
    return id || name ? [{ id, name }] : [];
  });
}

function readSmith(row: Record<string, unknown>): SmithTask | null {
  const task = str(row.task_id || row.taskId);
  const objective = str(row.objective_id || row.objectiveId);
  const id = str(row.id) || `${task}:${objective}`;
  const taskName = str(row.task_name || row.taskName) || task;
  if (!id || !taskName) return null;
  const constraints: Record<string, number> = {};
  const raw = rec(row.constraints);
  if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      const parsed = num(value);
      if (parsed != null) constraints[key] = parsed;
    }
  }
  const groups = Array.isArray(row.required_category_groups) ? row.required_category_groups : Array.isArray(row.requiredCategoryGroups) ? row.requiredCategoryGroups : [];
  return {
    id,
    taskId: task,
    objectiveId: objective,
    taskName,
    trader: str(row.trader_name || row.traderName),
    faction: str(row.faction_name || row.factionName),
    weaponId: str(row.weapon_id || row.weaponId),
    weaponName: str(row.weapon_name || row.weaponName),
    weaponImage: str(row.weapon_image || row.weaponImage),
    loadable: row.loadable === true,
    constraints,
    requiredItems: named(row.required_items || row.requiredItems),
    categoryGroups: groups.map((group) => named(group)),
  };
}

function readBuild(row: Record<string, unknown>): CommunityBuild | null {
  const id = str(row.id);
  if (!id) return null;
  const preview = rec(row.preview);
  return {
    id,
    name: str(row.name) || "方案",
    author: str(row.author) || "匿名",
    featured: row.featured === true,
    loadable: row.loadable === true,
    dropped: Number(row.dropped_pair_count ?? row.droppedPairCount) || 0,
    published: str(row.published_at || row.publishedAt),
    loads: Number(row.load_count ?? row.loadCount) || 0,
    hasPreview: Boolean(preview),
    ergo: preview ? num(preview.ergonomics) : null,
    evo: preview ? num(preview.evo_ergo_delta ?? preview.evoErgoDelta) : null,
    recoilV: preview ? num(preview.recoil_vertical ?? preview.recoilVertical) : null,
    recoilH: preview ? num(preview.recoil_horizontal ?? preview.recoilHorizontal) : null,
    overswing: preview?.overswing === true,
    price: preview ? num(preview.price_rub ?? preview.priceRub) : null,
    pairs: pairsOf(row.pairs),
    ammoId: str(row.ammo_id || row.ammoId),
  };
}

function findSlot(nodes: SlotNode[], id: string): SlotNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findSlot(node.children, id);
    if (hit) return hit;
  }
  return null;
}

function collectIds(nodes: SlotNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.id) out.push(node.id);
    if (node.children.length) out.push(...collectIds(node.children));
  }
  return out;
}

function pairsFromTree(nodes: SlotNode[]): Pair[] {
  const out: Pair[] = [];
  for (const node of nodes) {
    if (node.installed) out.push({ slot_id: node.id, item_id: node.installed.id });
    if (node.children.length) out.push(...pairsFromTree(node.children));
  }
  return out;
}

function collectInstalled(nodes: SlotNode[]): Part[] {
  const out: Part[] = [];
  for (const node of nodes) {
    if (node.installed) out.push(node.installed);
    if (node.children.length) out.push(...collectInstalled(node.children));
  }
  return out;
}

function replacePair(list: Pair[], slotId: string, itemId: string, dropIds: string[]) {
  const drop = new Set([slotId, ...dropIds]);
  const next = list.filter((pair) => !drop.has(pair.slot_id));
  if (itemId) next.push({ slot_id: slotId, item_id: itemId });
  return next;
}

function replaceInstalled(nodes: SlotNode[], slotId: string, part: Part | null): SlotNode[] {
  return nodes.map((node) => {
    if (node.id === slotId) return { ...node, installed: part, children: [] };
    return { ...node, children: replaceInstalled(node.children, slotId, part) };
  });
}

function partConflicts(part: Part, installedIds: string[], replacingId: string, installed: Part[]) {
  const others = new Set(installedIds);
  others.delete(part.id);
  if (replacingId) others.delete(replacingId);
  if (part.conflicts.some((id) => others.has(id))) return true;
  return installed.some((other) => others.has(other.id) && other.conflicts.includes(part.id));
}

function hasInstalled(nodes: SlotNode[]): boolean {
  return nodes.some((node) => Boolean(node.installed) || hasInstalled(node.children));
}

function slotFamily(nameId: string): SlotFamily {
  const id = nameId.toLowerCase();
  if (id.includes("muzzle")) return "muzzle";
  if (id.includes("barrel")) return "barrel";
  if (id.includes("gas")) return "gas";
  if (id.includes("handguard")) return "handguard";
  if (id.includes("catch")) return "catch";
  if (id.includes("charge")) return "charge";
  if (id.includes("sight_front") || id.includes("front_sight")) return "front_sight";
  if (id.includes("sight_rear") || id.includes("rear_sight")) return "rear_sight";
  if (id.includes("scope")) return "scope";
  if (id.includes("sight")) return "scope";
  if (id.includes("mount")) return "mount";
  if (id.includes("magazine") || id.includes("mag_")) return "magazine";
  if (id.includes("pistol_grip") || id.includes("pistolgrip")) return "pistol_grip";
  if (id.includes("foregrip")) return "foregrip";
  if (id.includes("bipod")) return "bipod";
  if (id.includes("tactical") || id.includes("flashlight") || id.includes("laser")) return "tactical";
  if (id.includes("launcher") || id.includes("ubgl")) return "ubgl";
  if (id.includes("stock") || id.includes("buffer")) return "stock";
  if (id === "receiver" || id.includes("reciever") || id.includes("receiver")) return "receiver";
  if (id.includes("trigger")) return "trigger";
  if (id.includes("hammer")) return "hammer";
  if (id.includes("chamber")) return "chamber";
  if (id.includes("shroud")) return "shroud";
  if (id.includes("grip")) return "grip";
  return "unknown";
}

function collectGrid(nodes: SlotNode[], parentSlotId: string | null = null, parentFamily: SlotFamily | null = null, depth = 0): GridSlot[] {
  const out: GridSlot[] = [];
  for (const node of nodes) {
    const family = slotFamily(node.nameId);
    const itemId = node.installed?.id || "";
    out.push({
      slotId: node.id,
      family,
      slotName: node.name,
      itemId,
      icon: node.installed?.icon || "",
      shortName: itemId ? node.installed?.short || node.installed?.name || itemId : "",
      required: node.required,
      empty: !itemId,
      parentSlotId,
      parentFamily,
      isBase: depth === 0,
    });
    if (node.children.length) out.push(...collectGrid(node.children, node.id, family, depth + 1));
  }
  return out;
}

function layoutGrid(items: GridSlot[]) {
  const occupied = new Set<string>();
  const virtual: Array<{ col: number; vrow: number } | null> = [];
  for (let col = GUN_COL; col < GUN_COL + GUN_SPAN; col += 1) occupied.add(`${col},0`);
  const placeAt = (col: number, vrow: number) => {
    if (col < 1 || col > GRID_COLS) return null;
    const key = `${col},${vrow}`;
    if (occupied.has(key)) return null;
    occupied.add(key);
    return { col, vrow };
  };
  const placeUp = (col: number, start: number) => {
    for (let vrow = start; vrow >= start - 20; vrow -= 1) {
      const hit = placeAt(col, vrow);
      if (hit) return hit;
    }
    return null;
  };
  const placeDown = (col: number, start: number) => {
    for (let vrow = start; vrow <= start + 20; vrow += 1) {
      const hit = placeAt(col, vrow);
      if (hit) return hit;
    }
    return null;
  };
  const placeDiagonalDown = (col: number) => {
    for (let vrow = 1; vrow <= 10; vrow += 1) {
      for (const next of [col - 1, col + 1]) {
        if (next >= 1 && next < GUN_COL) {
          const hit = placeAt(next, vrow);
          if (hit) return hit;
        }
      }
    }
    return null;
  };
  const present = new Set(items.map((row) => row.family));
  const leftQueue = LEFT_ORDER.filter((name) => present.has(name));
  const leftCol: Partial<Record<SlotFamily, number>> = {};
  leftQueue.forEach((name, index) => { leftCol[name] = GUN_COL - 1 - index; });
  let muzzleCol = leftCol.muzzle;
  if (muzzleCol == null) {
    if (leftQueue.length) muzzleCol = Math.max(1, (leftCol[leftQueue[leftQueue.length - 1]] || GUN_COL - 1) - 1);
    else muzzleCol = GUN_COL - 1;
  }
  let tacticalCount = 0;
  let bottomLeftCol = GUN_COL;
  let stockChild = 1;
  const installPos = new Map<string, { col: number; vrow: number }>();
  for (const slot of items) {
    const placed = (() => {
      if (EXTRAS.has(slot.family)) return null;
      if (slot.family in leftCol) {
        const col = leftCol[slot.family];
        if (col != null) {
          const hit = placeAt(col, 0);
          if (hit) return hit;
        }
      }
      if (slot.family === "charge") return placeAt(STOCK_COL, -1) || placeAt(bottomLeftCol--, 1);
      if (slot.parentFamily === "stock") return placeAt(STOCK_COL, stockChild++);
      if (slot.family === "stock") return placeAt(STOCK_COL, 0);
      if (slot.family === "tactical" && slot.isBase) {
        tacticalCount += 1;
        return placeAt(GUN_COL, -tacticalCount);
      }
      if (slot.family in TOP_COL && (slot.isBase || slot.parentFamily === "receiver")) {
        const col = TOP_COL[slot.family];
        if (col != null) return placeUp(col, -1);
      }
      if (slot.isBase && slot.family in BOTTOM_COL) {
        const col = BOTTOM_COL[slot.family];
        if (col != null) return placeDown(col, 1);
      }
      if (slot.isBase && BOTTOM_LEFT.has(slot.family)) return placeAt(bottomLeftCol--, 1);
      if (slot.family === "front_sight") return placeAt(muzzleCol, -1);
      const parent = slot.parentSlotId ? installPos.get(slot.parentSlotId) : undefined;
      if (parent) {
        if (parent.vrow < 0) return placeUp(parent.col, parent.vrow - 1);
        if (parent.vrow > 0) return placeDown(parent.col, parent.vrow + 1);
        if (parent.col < GUN_COL) {
          if (slot.family === "mount") return placeDiagonalDown(parent.col);
          if (slot.family === "scope" || slot.family === "tactical") return placeUp(parent.col, -1);
          return placeDown(parent.col, 1);
        }
        return placeDown(parent.col, 1);
      }
      return null;
    })();
    virtual.push(placed);
    if (placed && !slot.empty) installPos.set(slot.slotId, placed);
  }
  const vrows = virtual.flatMap((row) => row ? [row.vrow] : []);
  const minVrow = vrows.length ? Math.min(...vrows, 0) : 0;
  const maxVrow = vrows.length ? Math.max(...vrows, 0) : 0;
  const cells: LaidCell[] = items.map((slot, index) => {
    const pos = virtual[index];
    if (!pos) return { ...slot, col: null, row: null, extras: true };
    return { ...slot, col: pos.col, row: pos.vrow - minVrow + 1, extras: false };
  });
  return { cells, gunRow: 0 - minVrow + 1, totalRows: maxVrow - minVrow + 1 };
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

function constraintText(key: string, value: number) {
  const label = CONSTRAINT_LABEL[key] || key;
  const shown = key === "min_durability" ? `${value}%` : String(value);
  if (key.startsWith("min_")) return `${label} ≥ ${shown}`;
  if (key.startsWith("max_")) return `${label} ≤ ${shown}`;
  return `${label} ${shown}`;
}

function liveCheck(task: SmithTask) {
  const installed = collectInstalled(slots);
  const have = new Set(installed.map((part) => part.id));
  const cats = new Set(installed.flatMap((part) => part.categories));
  const missingItems = task.requiredItems.filter((item) => item.id && !have.has(item.id));
  const missingGroups = task.categoryGroups.filter((group) => {
    const ids = group.map((item) => item.id).filter(Boolean);
    return ids.length > 0 && !ids.some((id) => cats.has(id));
  });
  const unmet: string[] = [];
  const ergo = stats?.ergonomics || 0;
  const recoil = (stats?.recoilV || 0) + (stats?.recoilH || 0);
  const weight = stats?.weight || 0;
  const mag = stats?.mag || 0;
  const sight = stats?.sighting || 0;
  const rules = task.constraints;
  if (rules.min_ergonomics != null && ergo < rules.min_ergonomics) unmet.push("min_ergonomics");
  if (rules.max_recoil_sum != null && recoil > rules.max_recoil_sum) unmet.push("max_recoil_sum");
  if (rules.max_weight != null && weight > rules.max_weight) unmet.push("max_weight");
  if (rules.min_mag_capacity != null && mag < rules.min_mag_capacity) unmet.push("min_mag_capacity");
  if (rules.max_mag_capacity != null && (mag <= 0 || mag > rules.max_mag_capacity)) unmet.push("max_mag_capacity");
  if (rules.min_sighting_range != null && sight < rules.min_sighting_range) unmet.push("min_sighting_range");
  return { missingItems, missingGroups, unmet };
}

function findSpec() {
  const tid = taskId.trim();
  if (!tid) return null;
  const rows = smithTasks.filter((row) => row.taskId === tid);
  if (!rows.length) return null;
  const oid = objectiveId.trim();
  if (oid) return rows.find((row) => row.objectiveId === oid) || rows[0];
  return rows[0];
}

function workHref(gunId = "", task = "", objective = "") {
  const path = gunId ? `${BASE}/${gunId}` : BASE;
  const query = new URLSearchParams();
  if (task) query.set("task", task);
  if (objective) query.set("obj", objective);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

function currentHref() {
  return decodeURI(location.pathname) + location.search;
}

function readRoute() {
  const params = new URLSearchParams(location.search);
  taskId = (params.get("task") || "").trim();
  objectiveId = (params.get("obj") || "").trim();
}

function syncMode() {
  const next = gameMode();
  if (cacheMode && cacheMode !== next) {
    guns = [];
    gunsReady = false;
    smithTasks = [];
    smithReady = false;
    smithMode = "";
    community = [];
    communityGun = "";
    communityMode = "";
    loadedGunId = "";
    gun = null;
    slots = [];
    stats = null;
    allowedKey = "";
    allowedMap = {};
  }
  cacheMode = next;
}

function hostEl() {
  return document.querySelector<HTMLElement>("#workbench");
}

let modalLive = false;

function paint() {
  const host = hostEl();
  if (!host) return;
  const wasOpen = modalLive;
  const active = document.activeElement;
  const keep = active instanceof HTMLInputElement && active.type === "text" && host.contains(active) ? active.id : "";
  const pos = keep && active instanceof HTMLInputElement ? active.selectionStart : null;
  host.innerHTML = render();
  const modal = host.querySelector<HTMLElement>(".wb-modal");
  modalLive = Boolean(modal);
  if (modal && !wasOpen) fadeIn(modal);
  ensureBound();
  if (!keep) return;
  const input = host.querySelector<HTMLInputElement>(`#${keep}`);
  input?.focus();
  if (pos != null && input && input.type === "text") input.setSelectionRange(pos, pos);
}

function modal(title: string, body: string, wide = false, foot = "") {
  return `<div class="wb-modal"><div class="wb-dialog${wide ? " wide" : ""}" role="dialog" aria-label="${esc(title)}"><header class="wb-dialog-head"><h2>${esc(title)}</h2><button type="button" data-wb-close aria-label="关闭">×</button></header><div class="wb-dialog-body">${body}</div>${foot}</div></div>`;
}

function sortMark(active: boolean, dir: SortDir) {
  if (!active) return "";
  return dir === "asc" ? " ↑" : " ↓";
}

function listedGuns() {
  const needle = gunQuery.trim().toLowerCase();
  return guns.filter((item) => {
    if (caliberFilter && item.caliber !== caliberFilter) return false;
    if (classFilter && item.weaponClass !== classFilter) return false;
    if (!needle) return true;
    return `${item.name} ${item.short}`.toLowerCase().includes(needle);
  }).sort((a, b) => {
    const byCaliber = caliberLabel(a.caliber).localeCompare(caliberLabel(b.caliber), "zh");
    if (byCaliber) return byCaliber;
    return (a.name || a.short).localeCompare(b.name || b.short, "zh");
  });
}

function gunPicker() {
  if (!pickOpen) return "";
  const calibers = [...new Set(guns.map((item) => item.caliber).filter(Boolean))].sort((a, b) => caliberLabel(a).localeCompare(caliberLabel(b), "zh"));
  const classes = [...new Set(guns.map((item) => item.weaponClass))].sort((a, b) => classLabel(a).localeCompare(classLabel(b), "zh"));
  const rows = listedGuns();
  const body = gunsLoading
    ? spin("正在读取枪械")
    : gunsError
      ? `<p class="wb-hint">${esc(gunsError)}</p>`
      : `<div class="wb-filters"><select id="wb-gun-caliber" aria-label="口径"><option value="">全部口径</option>${calibers.map((item) => `<option value="${esc(item)}"${item === caliberFilter ? " selected" : ""}>${esc(caliberLabel(item))}</option>`).join("")}</select><select id="wb-gun-class" aria-label="类型"><option value="">全部类型</option>${classes.map((item) => `<option value="${esc(item)}"${item === classFilter ? " selected" : ""}>${esc(classLabel(item))}</option>`).join("")}</select><input id="wb-gun-q" type="text" value="${esc(gunQuery)}" placeholder="关键词搜索" aria-label="搜索枪械" /></div><p class="wb-hint">共 ${rows.length} 把</p>${rows.length ? `<table class="wb-table wb-gun-table"><thead><tr><th>口径</th><th>图片</th><th>名称</th><th>类型</th></tr></thead><tbody>${rows.map((item) => {
        const icon = iconOf(item.icon, item.id);
        return `<tr data-wb-gun="${esc(item.id)}"><td>${esc(caliberLabel(item.caliber))}</td><td>${icon ? `<img src="${esc(icon)}" alt="" />` : "—"}</td><td><button type="button" data-wb-gun="${esc(item.id)}" title="进入改枪">${esc(item.name || item.short)}</button></td><td>${esc(classLabel(item.weaponClass))}</td></tr>`;
      }).join("")}</tbody></table>` : `<p class="wb-hint">没有匹配的枪</p>`}`;
  return modal("选枪", body, true);
}

function listedSmith() {
  const needle = smithQuery.trim().toLowerCase();
  return smithTasks.filter((task) => {
    if (!factionOk(task.faction)) return false;
    if (!needle) return true;
    return `${task.taskName} ${task.weaponName} ${task.trader} ${task.taskId}`.toLowerCase().includes(needle);
  });
}

function smithPicker() {
  if (!smithOpen) return "";
  const rows = listedSmith();
  const body = smithLoading
    ? spin("正在读取枪匠任务")
    : smithError
      ? `<p class="wb-hint">${esc(smithError)}</p>`
      : `<input id="wb-smith-q" class="wb-search" type="text" value="${esc(smithQuery)}" placeholder="搜索任务 / 枪名" aria-label="搜索枪匠任务" />${rows.length ? `<div class="wb-smith-list">${rows.map((task) => {
        const meta = [task.trader, task.weaponName].filter(Boolean).join(" · ");
        const extra = task.loadable ? "" : " · 图鉴没有这把枪";
        const icon = iconOf(task.weaponImage, task.weaponId);
        return `<button type="button" class="wb-smith-row" data-wb-task="${esc(task.id)}" ${task.loadable ? "" : "disabled"}>${icon ? `<img src="${esc(icon)}" alt="" />` : `<span class="wb-smith-thumb"></span>`}<span><strong>${esc(task.taskName)}</strong><em>${esc(meta)}${esc(extra)}</em></span></button>`;
      }).join("")}</div>` : `<p class="wb-hint">没有枪匠改装任务</p>`}`;
  return modal("枪匠任务", body);
}

function communityRows() {
  const rows = [...community];
  if (communitySort) {
    const sign = communitySort.dir === "asc" ? 1 : -1;
    const key = communitySort.key;
    rows.sort((a, b) => sign * compareBuild(a, b, key));
  }
  return rows;
}

function compareBuild(a: CommunityBuild, b: CommunityBuild, key: CommunitySortKey) {
  const value = (item: number | null) => item == null || !Number.isFinite(item) ? Number.NEGATIVE_INFINITY : item;
  if (key === "published") return a.published.localeCompare(b.published);
  if (key === "loads") return a.loads - b.loads;
  if (key === "overswing") return Number(a.hasPreview && a.overswing) - Number(b.hasPreview && b.overswing);
  if (key === "ergo") return value(a.ergo) - value(b.ergo);
  if (key === "evo") return value(a.evo) - value(b.evo);
  if (key === "recoilV") return value(a.recoilV) - value(b.recoilV);
  if (key === "recoilH") return value(a.recoilH) - value(b.recoilH);
  return value(a.price) - value(b.price);
}

function dayText(value: string) {
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

function communityHead(label: string, key: CommunitySortKey) {
  const mark = sortMark(communitySort?.key === key, communitySort?.dir || "desc");
  return `<th><button type="button" data-wb-build-sort="${key}">${label}${mark}</button></th>`;
}

function communityPicker() {
  if (!communityOpen) return "";
  const rows = communityRows();
  const pages = Math.max(1, Math.ceil(rows.length / pageSize) || 1);
  if (page > pages) page = pages;
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);
  const table = slice.length ? `<table class="wb-table"><thead><tr><th>方案名称</th>${communityHead("更新日期", "published")}${communityHead("加载次数", "loads")}${communityHead("人工机效", "ergo")}${communityHead("EVO人机DELTA", "evo")}${communityHead("垂直后坐力", "recoilV")}${communityHead("水平后坐力", "recoilH")}${communityHead("过摆", "overswing")}${communityHead("费用", "price")}<th>操作</th></tr></thead><tbody>${slice.map((build) => {
    const evo = formatEvo(build.evo);
    const swing = build.hasPreview ? (build.overswing ? "是" : "否") : "—";
    return `<tr><td class="wb-build-name">${build.featured ? `<span class="wb-featured">精选</span>` : ""}<strong>${esc(build.name)}</strong><em>${esc(build.author)}</em>${build.dropped ? `<span>省略 ${build.dropped} 件本站没有的配件</span>` : ""}</td><td>${esc(dayText(build.published) || "—")}</td><td>${build.loads}</td><td>${esc(build.ergo == null ? "—" : String(Math.round(build.ergo * 10) / 10))}</td><td class="${build.evo == null ? "" : build.evo >= 0 ? "wb-good" : "wb-bad"}">${esc(evo)}</td><td>${build.recoilV ?? "—"}</td><td>${build.recoilH ?? "—"}</td><td class="${!build.hasPreview ? "" : build.overswing ? "wb-bad" : "wb-good"}">${swing}</td><td>${esc(formatMoney(build.price))}</td><td><button type="button" data-wb-build="${esc(build.id)}" ${build.loadable ? "" : "disabled"} title="${build.loadable ? "加载" : "这套方案与当前图鉴对不上，无法装入"}">加载</button></td></tr>`;
  }).join("")}</tbody></table><div class="wb-pager"><button type="button" data-wb-page="prev" ${page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${page} / ${pages} 页</span><button type="button" data-wb-page="next" ${page >= pages ? "disabled" : ""}>下一页</button><select id="wb-page-size" aria-label="每页条数">${[20, 50, 100].map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size} / 页</option>`).join("")}</select></div>` : `<p class="wb-hint">${community.length ? "没有匹配的方案" : "这把枪还没有公开方案。"}</p>`;
  const body = communityLoading ? spin("正在读取社区方案") : communityError ? `<p class="wb-hint">${esc(communityError)}</p>` : table;
  return modal("社区方案", body, true, `<footer class="wb-dialog-foot">列表来自 EFTForge 社区公开方案，按本站图鉴装入。不代为点赞或评论。</footer>`);
}

function filteredParts(parts: Part[]) {
  const needle = partQuery.trim().toLowerCase();
  const rows = needle ? parts.filter((part) => part.name.toLowerCase().includes(needle) || part.short.toLowerCase().includes(needle)) : parts;
  const sign = partSort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const cmp = comparePart(a, b) * sign;
    if (cmp) return cmp;
    return a.name.localeCompare(b.name, "zh");
  });
}

function comparePart(a: Part, b: Part) {
  if (partSort.key === "name") return a.name.localeCompare(b.name, "zh");
  const value = (part: Part) => partSort.key === "ergonomics" ? part.ergo : partSort.key === "recoil" ? part.recoil : partSort.key === "weight" ? part.weight : (part.price || 0);
  return value(a) - value(b);
}

function partHead(label: string, key: PartSortKey) {
  return `<button type="button" data-wb-part-sort="${key}">${label}${sortMark(partSort.key === key, partSort.dir)}</button>`;
}

function partPicker() {
  const slot = activeSlot ? findSlot(slots, activeSlot) : null;
  if (!slot) return "";
  const installed = slot.installed ? slot.installed.name : "空";
  const title = `${slot.name}${slot.required ? " · 必装" : ""} · ${installed}`;
  const parts = allowedMap[slot.id] || [];
  const loading = allowedLoading && !parts.length;
  const installedIds = pairs.map((pair) => pair.item_id);
  const installedParts = collectInstalled(slots);
  const rows = loading ? "" : filteredParts(parts).map((part) => {
    const current = slot.installed?.id === part.id;
    const conflict = partConflicts(part, installedIds, slot.installed?.id || "", installedParts);
    const icon = part.icon ? `<img src="${esc(part.icon)}" alt="" />` : `<span class="wb-part-empty"></span>`;
    return `<button type="button" class="wb-part${current ? " on" : ""}${conflict ? " bad" : ""}" data-wb-install="${esc(part.id)}" title="${conflict ? "与已装配件冲突" : esc(part.name)}">${icon}<span>${esc(part.name)}</span><span>${esc(formatSigned(part.ergo))}</span><span>${esc(formatPercent(part.recoil))}</span><span>${esc(formatWeight(part.weight))}</span><span>${esc(formatMoney(part.price))}</span></button>`;
  }).join("");
  const foot = slot.installed && !slot.required ? `<footer class="wb-dialog-foot"><button type="button" data-wb-unload>卸下</button></footer>` : "";
  const body = `<input id="wb-part-q" class="wb-search" type="text" value="${esc(partQuery)}" placeholder="搜索配件" aria-label="搜索配件" />${loading ? spin("正在读取配件", true) : `<div class="wb-part-head"><span></span>${partHead("配件", "name")}${partHead("人机", "ergonomics")}${partHead("后坐", "recoil")}${partHead("重量", "weight")}${partHead("估价", "price")}</div><div class="wb-parts">${rows || `<p class="wb-hint">没有匹配配件</p>`}</div>`}`;
  return modal(title, body, false, foot);
}

function cellButton(cell: LaidCell, style: string) {
  const conflict = new Set(stats?.conflicts || []);
  const cls = ["wb-cell", cell.slotId === activeSlot ? "on" : "", cell.empty ? "empty" : "", cell.empty && cell.required ? "need" : "", cell.itemId && conflict.has(cell.itemId) ? "bad" : ""].filter(Boolean).join(" ");
  const src = cell.empty ? "" : iconOf(cell.icon, cell.itemId);
  const inner = src ? `<img src="${esc(src)}" alt="" />` : `<span class="wb-plus">+</span>`;
  const short = cell.shortName ? `<span class="wb-short">${esc(cell.shortName)}</span>` : "";
  const title = `${cell.slotName}${cell.shortName ? ` · ${cell.shortName}` : ""}`;
  return `<button type="button" class="${cls}" ${style} data-wb-slot="${esc(cell.slotId)}" title="${esc(title)}"><span class="wb-cell-in">${inner}${short}</span><span class="wb-label">${esc(cell.slotName)}</span></button>`;
}

function board() {
  if (!gun) return "";
  const layout = layoutGrid(collectGrid(slots));
  const raw = hasInstalled(slots) ? gun.preset || gun.image : gun.image || gun.preset;
  const art = hdOf(raw) || raw;
  if (!art && !layout.cells.length) return `<p class="wb-hint">没有枪图</p>`;
  const placed = layout.cells.filter((cell) => !cell.extras);
  const extras = layout.cells.filter((cell) => cell.extras);
  const cells = placed.map((cell) => cellButton(cell, `style="grid-column:${cell.col};grid-row:${cell.row}"`)).join("");
  const extra = extras.length ? `<div class="wb-extras">${extras.map((cell) => cellButton(cell, "")).join("")}</div>` : "";
  const image = art ? `<img src="${esc(art)}" alt="${esc(gun.short || gun.name)}" />` : `<span class="wb-plus">+</span>`;
  return `<div class="wb-board" aria-label="配件示意图"><div class="wb-board-wrap"><div class="wb-grid" style="grid-template-rows:repeat(${layout.totalRows}, var(--wb-cell-h))"><div class="wb-gun" style="grid-column:${GUN_COL} / ${GUN_COL + GUN_SPAN};grid-row:${layout.gunRow}">${image}<span class="wb-label">${esc(gun.short || gun.name)}</span></div>${cells}</div>${extra}</div></div>`;
}

function smithPanel() {
  const spec = findSpec();
  if (spec) {
    const check = liveCheck(spec);
    const missed = new Set(check.unmet);
    const missingItems = new Set(check.missingItems.map((item) => item.id));
    const missingGroups = new Set(check.missingGroups.map((group) => group.map((item) => item.id).join("\0")));
    const lines = orderedConstraints(spec).map(([key, value]) => {
      const live = LIVE_CONSTRAINTS.has(key);
      const fail = live && missed.has(key);
      const hint = key === "min_durability" ? "（上交时）" : key === "max_width" || key === "max_height" ? "（工作台暂不按折叠对照）" : "";
      const mark = live ? (fail ? "×" : "✓") : "·";
      return `<li class="${fail ? "bad" : live ? "ok" : "note"}">${mark} ${esc(constraintText(key, value))}${hint}</li>`;
    });
    for (const item of spec.requiredItems) {
      const fail = Boolean(item.id) && missingItems.has(item.id);
      lines.push(`<li class="${fail ? "bad" : "ok"}">${fail ? "×" : "✓"} 必装 ${esc(item.name || item.id)}</li>`);
    }
    for (const group of spec.categoryGroups) {
      const key = group.map((item) => item.id).join("\0");
      const fail = missingGroups.has(key);
      const label = group.map((item) => item.name || item.id).filter(Boolean).join(" / ");
      if (label) lines.push(`<li class="${fail ? "bad" : "ok"}">${fail ? "×" : "✓"} 配件分类：${esc(label)}</li>`);
    }
    const meta = [spec.trader, spec.weaponName].filter(Boolean).join(" · ");
    return `<section class="wb-smith"><div class="wb-pane-head"><span>枪匠任务</span><button type="button" data-wb-smith-exit>退出</button></div><h3>${esc(spec.taskName)}</h3>${meta ? `<p class="wb-hint">${esc(meta)}</p>` : ""}${lines.length ? `<ul class="wb-checks">${lines.join("")}</ul>` : ""}<button type="button" class="wb-solve" data-wb-solve ${spec.loadable && !pending ? "" : "disabled"}>求解</button></section>`;
  }
  if (taskId && smithReady) return `<p class="wb-hint">没有这条枪匠任务</p>`;
  if (taskId && smithError) return `<p class="wb-hint">${esc(smithError)}</p>`;
  return "";
}

function statRow(label: string, value: string, tone = "", hint = "", hintLabel = "", val = "") {
  const info = hint ? `<span class="wb-info" tabindex="0" title="${esc(hint)}" aria-label="${esc(hintLabel || label)}说明">i</span>` : "";
  const mark = val ? ` data-wb-val="${val}"` : "";
  return `<div class="wb-stat"><span>${esc(label)}${info}</span><strong class="${tone}"${mark}>${esc(value)}</strong></div>`;
}

function statsPane() {
  const ergo = stats?.ergonomics ?? 0;
  const weight = stats?.weight ?? 0;
  const eed = stats ? eedOf(ergo, weight) : null;
  const swing = stats ? overswingOf(ergo, weight) : false;
  const arm = stats ? armSeconds(weight, ergo) : null;
  const conflict = new Set(stats?.conflicts || []);
  const ammo = gun?.ammo || [];
  return `<section class="wb-pane wb-stats" aria-label="属性">${smithPanel()}<div class="wb-pane-head">属性</div><div class="wb-stat-list">
    ${statRow("人机", formatErgo(stats?.ergonomics))}
    ${statRow("垂直后坐", stats ? String(stats.recoilV) : "—")}
    ${statRow("水平后坐", stats ? String(stats.recoilH) : "—")}
    ${statRow("精确度", stats?.accuracy == null ? "—" : `${stats.accuracy.toFixed(2)} MOA`)}
    ${statRow("重量", formatWeight(stats?.weight))}
    ${statRow("Evo人机Delta", eed == null ? "—" : formatEed(eed), eed == null ? "" : eed >= 0 ? "wb-good" : "wb-bad", EED_HINT, "Evo人机Delta（EED）", "eed")}
    ${statRow("过摆", stats ? (swing ? "是" : "否") : "—", stats ? (swing ? "wb-bad" : "wb-good") : "", OVERSWING_HINT, "过摆", "swing")}
    ${statRow("手臂耐力", arm == null ? "—" : `${arm.toFixed(1)}s`, "", "", "", "arm")}
    ${statRow("瞄具距离", stats?.sighting == null ? "—" : `${stats.sighting} m`)}
    ${statRow("膛口初速", ammoId ? (stats?.muzzle == null ? "—" : `${Math.round(stats.muzzle)} m/s`) : "无弹药")}
    ${statRow("弹匣容量", stats?.mag == null ? "—" : String(stats.mag))}
    ${statRow("估价", formatMoney(stats?.price))}
    ${conflict.size ? `<p class="wb-warn">冲突件已标红，请卸下或更换</p>` : ""}
    <div class="wb-tune"><h3>自身情况</h3><div><div class="wb-stat"><span>力量等级</span></div><p>${STRENGTH_HINT}</p><div class="wb-tune-row"><input data-wb-tune="strength" type="range" min="${STRENGTH_MIN}" max="${STRENGTH_MAX}" value="${strength}" aria-label="力量等级" /><input data-wb-tune="strength" id="wb-strength" type="number" min="${STRENGTH_MIN}" max="${STRENGTH_MAX}" value="${strength}" aria-label="力量等级数值" /></div></div><div><div class="wb-stat"><span>装备人机工效修正</span></div><p>${EQUIP_HINT}</p><div class="wb-tune-row"><input data-wb-tune="equip" type="range" min="${EQUIP_MIN}" max="${EQUIP_MAX}" value="${equipPenalty}" aria-label="装备人机工效修正" /><span data-wb-equip-sign>${equipPenalty ? "-" : ""}</span><input data-wb-tune="equip" id="wb-equip" type="number" min="${EQUIP_MIN}" max="${EQUIP_MAX}" value="${equipPenalty}" aria-label="装备人机工效修正数值" /><span>%</span></div></div></div>
    ${ammo.length ? `<label class="wb-ammo">弹药<select id="wb-ammo" aria-label="弹药">${ammoId ? "" : `<option value="">选择弹药</option>`}${ammo.map((item) => `<option value="${esc(item.id)}"${item.id === ammoId ? " selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label>` : ""}
  </div></section>`;
}

function buildView() {
  if (!gun) return "";
  return `<div class="wb"><header class="wb-head"><h2><a href="/主菜单/逃离塔科夫/物品/${esc(gun.id)}" data-link>${esc(gun.name || gun.short || gun.id)}</a></h2><div class="wb-actions"><button type="button" data-wb-smith-open>枪匠任务</button><button type="button" data-wb-community-open>社区方案</button><button type="button" data-wb-change>换一把枪</button><button type="button" data-wb-clear ${pending ? "disabled" : ""}>清空配件</button><button type="button" data-wb-restore ${pending ? "disabled" : ""}>恢复预设</button></div></header>${note ? `<p class="wb-note${noteBad ? " bad" : ""}">${esc(note)}</p>` : ""}<div class="wb-layout"><section class="wb-pane" aria-label="预览与配件"><div class="wb-preview">${board()}</div></section>${statsPane()}</div></div>`;
}

function emptyView() {
  return `<div class="wb"><div class="wb-empty"><button type="button" data-wb-pick aria-label="选枪"><strong>+</strong><span>选枪</span></button><button type="button" data-wb-smith-open aria-label="枪匠任务"><strong>⚒</strong><span>枪匠任务</span></button></div>${note ? `<p class="wb-note${noteBad ? " bad" : ""}">${esc(note)}</p>` : ""}</div>`;
}

function errorView() {
  return `<div class="wb"><p class="wb-note bad">无法打开这把枪</p><p class="wb-hint">${esc(gunError || "未找到枪械")} · <a href="${BASE}" data-link>返回枪匠工作台</a></p></div>`;
}

function render() {
  const pageBody = gunError && routeGun && !gun ? errorView() : gun ? buildView() : emptyView();
  return `${pageBody}${gunPicker()}${smithPicker()}${communityPicker()}${partPicker()}`;
}

let modalClosing = false;

function closeTop() {
  if (modalClosing) return;
  const modal = hostEl()?.querySelector<HTMLElement>(".wb-modal");
  const finish = () => {
    modalClosing = false;
    closeTopNow();
  };
  if (!modal) {
    finish();
    return;
  }
  modalClosing = true;
  modalLive = false;
  void fadeOut(modal).then(finish);
}

function closeTopNow() {
  if (activeSlot) {
    activeSlot = "";
    partQuery = "";
    partSort = { key: "ergonomics", dir: "desc" };
    paint();
    return;
  }
  if (communityOpen) {
    communityOpen = false;
    paint();
    return;
  }
  if (smithOpen) {
    smithOpen = false;
    smithQuery = "";
    paint();
    return;
  }
  if (pickOpen) {
    pickOpen = false;
    gunQuery = "";
    caliberFilter = "";
    classFilter = "";
    paint();
  }
}

function goWorkbench(gunId = "", task = "", objective = "", replace = false) {
  pickOpen = false;
  smithOpen = false;
  communityOpen = false;
  activeSlot = "";
  const next = workHref(gunId, task, objective);
  if (currentHref() !== next) {
    const url = encodeURI(next);
    if (replace) replaceNav(url);
    else pushNav(url);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  paint();
}

function syncTune() {
  const host = hostEl();
  if (!host) return;
  host.querySelectorAll<HTMLInputElement>("[data-wb-tune]").forEach((el) => {
    if (el === document.activeElement && el.type === "number") return;
    const next = el.dataset.wbTune === "strength" ? String(strength) : String(equipPenalty);
    if (el.value !== next) el.value = next;
  });
  const sign = host.querySelector<HTMLElement>("[data-wb-equip-sign]");
  if (sign) sign.textContent = equipPenalty ? "-" : "";
  if (!stats) return;
  const eed = eedOf(stats.ergonomics, stats.weight);
  const swing = overswingOf(stats.ergonomics, stats.weight);
  const arm = armSeconds(stats.weight, stats.ergonomics);
  const eedEl = host.querySelector<HTMLElement>("[data-wb-val='eed']");
  const swingEl = host.querySelector<HTMLElement>("[data-wb-val='swing']");
  const armEl = host.querySelector<HTMLElement>("[data-wb-val='arm']");
  if (eedEl) {
    eedEl.textContent = formatEed(eed);
    eedEl.className = eed >= 0 ? "wb-good" : "wb-bad";
  }
  if (swingEl) {
    swingEl.textContent = swing ? "是" : "否";
    swingEl.className = swing ? "wb-bad" : "wb-good";
  }
  if (armEl) armEl.textContent = `${arm.toFixed(1)}s`;
}

function onTune(el: HTMLInputElement) {
  const value = Number(el.value);
  if (!Number.isFinite(value)) return;
  if (el.dataset.wbTune === "strength") saveStrength(value);
  else saveEquip(value);
  syncTune();
}

async function loadGuns() {
  if (gunsReady && guns.length) return;
  gunsLoading = true;
  gunsError = "";
  try {
    const data = await invoke<{ items?: Record<string, unknown>[] } | Record<string, unknown>[]>("site_get", { path: "/guides/tarkov/guns" });
    const list = Array.isArray(data) ? data : data.items || [];
    guns = list.flatMap((item) => {
      const row = rec(item);
      if (!row) return [];
      const id = str(row.id);
      const name = str(row.name || row.short_name) || id;
      if (!id || !name) return [];
      return [{
        id,
        name,
        short: str(row.short_name || row.shortName),
        caliber: str(row.caliber),
        weaponClass: str(row.weapon_class || row.weaponClass),
        icon: str(row.icon_link || row.iconLink),
      }];
    });
    gunsReady = true;
  } catch (error) {
    gunsError = error instanceof Error ? error.message : "枪械读取失败";
  }
  gunsLoading = false;
}

async function ensureSmith() {
  if (smithReady && smithMode === gameMode()) return;
  smithLoading = true;
  smithError = "";
  try {
    const data = await invoke<{ items?: Record<string, unknown>[] } | Record<string, unknown>[]>("site_get", { path: "/guides/tarkov/workbench/gunsmith-tasks" });
    const list = Array.isArray(data) ? data : data.items || [];
    smithTasks = list.flatMap((item) => {
      const row = rec(item);
      const task = row ? readSmith(row) : null;
      return task ? [task] : [];
    });
    smithReady = true;
    smithMode = gameMode();
  } catch (error) {
    smithReady = false;
    smithError = error instanceof Error ? error.message : "枪匠任务读取失败";
  }
  smithLoading = false;
}

async function loadCommunity() {
  if (!gun) return;
  if (communityGun === gun.id && communityMode === gameMode()) return;
  communityLoading = true;
  communityError = "";
  const gunId = gun.id;
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
    communityMode = gameMode();
  } catch (error) {
    community = [];
    communityGun = "";
    communityError = error instanceof Error ? error.message : "社区方案读取失败";
  }
  communityLoading = false;
}

async function loadAllowed() {
  const ids = collectIds(slots);
  const key = [...ids].sort().join(",");
  if (!ids.length || key === allowedKey) return;
  const epoch = ++allowedEpoch;
  allowedLoading = true;
  if (activeSlot) paint();
  try {
    const data = await invoke<{ slots?: Record<string, unknown[]> }>("site_post", {
      path: "/guides/tarkov/workbench/slots/allowed-items",
      body: { slot_ids: ids },
    });
    if (epoch !== allowedEpoch) return;
    const next: Record<string, Part[]> = {};
    for (const [id, list] of Object.entries(data.slots || {})) {
      next[id] = (Array.isArray(list) ? list : []).flatMap((item) => {
        const part = readPart(item);
        return part ? [part] : [];
      });
    }
    allowedMap = next;
    allowedKey = key;
  } catch (error) {
    if (epoch !== allowedEpoch) return;
    note = error instanceof Error ? error.message : "配件读取失败";
    noteBad = true;
  }
  if (epoch !== allowedEpoch) return;
  allowedLoading = false;
  paint();
}

async function calculate(next: Pair[], nextAmmo: string | null, setAmmo: boolean, done = "") {
  if (!gun) return false;
  const epoch = ++calcEpoch;
  const gunId = gun.id;
  pairs = next;
  if (setAmmo) ammoId = nextAmmo || "";
  pending = true;
  note = "正在计算…";
  noteBad = false;
  paint();
  try {
    const data = await invoke<Record<string, unknown>>("site_post", {
      path: "/guides/tarkov/workbench/calculate",
      body: { gun_id: gunId, pairs: next, ammo_id: ammoId || null },
    });
    if (epoch !== calcEpoch) return false;
    slots = readSlots(data.slots);
    const nextStats = readStats(data.stats);
    if (nextStats) stats = nextStats;
    pairs = pairsFromTree(slots);
    if (activeSlot && !findSlot(slots, activeSlot)) activeSlot = "";
    note = done;
    noteBad = false;
    pending = false;
    paint();
    void loadAllowed();
    return true;
  } catch (error) {
    if (epoch !== calcEpoch) return false;
    note = error instanceof Error ? error.message : "属性计算失败";
    noteBad = true;
    pending = false;
    paint();
    return false;
  }
}

function applyGun(data: Record<string, unknown>) {
  const id = str(data.id);
  const name = str(data.name || data.short_name) || id;
  if (!id || !name) throw new Error("未找到枪械");
  gun = {
    id,
    name,
    short: str(data.short_name || data.shortName),
    image: str(data.image_link || data.imageLink),
    preset: str(data.preset_image_link || data.presetImageLink),
    ammo: (Array.isArray(data.ammo) ? data.ammo : []).flatMap((item) => {
      const row = rec(item);
      const ammo = str(row?.id);
      const label = str(row?.name || row?.short_name) || ammo;
      return ammo ? [{ id: ammo, name: label }] : [];
    }),
  };
  loadedGunId = id;
  slots = readSlots(data.slots);
  stats = readStats(data.stats);
  factoryPairs = pairsOf(data.factory_pairs || data.factoryPairs);
  pairs = factoryPairs.length ? factoryPairs.map((pair) => ({ ...pair })) : pairsFromTree(slots);
  defaultAmmo = str(data.default_ammo_id || data.defaultAmmoId);
  ammoId = defaultAmmo || stats?.ammoId || "";
  gunError = "";
  note = "";
  noteBad = false;
  activeSlot = "";
  partQuery = "";
  allowedKey = "";
  allowedMap = {};
  if (communityGun && communityGun !== id) {
    community = [];
    communityGun = "";
    communityOpen = false;
    page = 1;
  }
}

async function openPick() {
  communityOpen = false;
  smithOpen = false;
  activeSlot = "";
  pickOpen = true;
  gunQuery = "";
  caliberFilter = "";
  classFilter = "";
  paint();
  if (!gunsReady) {
    await loadGuns();
    if (pickOpen) paint();
  }
}

async function openSmith() {
  pickOpen = false;
  communityOpen = false;
  activeSlot = "";
  smithOpen = true;
  smithQuery = "";
  paint();
  await ensureSmith();
  if (smithOpen) paint();
}

async function openCommunity() {
  if (!gun) return;
  pickOpen = false;
  smithOpen = false;
  activeSlot = "";
  communityOpen = true;
  communitySort = null;
  page = 1;
  paint();
  await loadCommunity();
  if (communityOpen) paint();
}

function install(partId: string) {
  const slot = activeSlot ? findSlot(slots, activeSlot) : null;
  const part = slot ? (allowedMap[slot.id] || []).find((item) => item.id === partId) : null;
  if (!slot || !part) return;
  if (slot.installed?.id === part.id) {
    activeSlot = "";
    paint();
    return;
  }
  if (partConflicts(part, pairs.map((pair) => pair.item_id), slot.installed?.id || "", collectInstalled(slots))) {
    note = "与已装配件冲突";
    noteBad = true;
    paint();
    return;
  }
  const next = replacePair(pairs, slot.id, part.id, collectIds(slot.children));
  slots = replaceInstalled(slots, slot.id, part);
  activeSlot = "";
  void calculate(next, null, false);
}

function unload(slot: SlotNode) {
  if (!slot.installed) return false;
  if (slot.required) {
    note = "必装槽请改选配件，不能卸空";
    noteBad = false;
    return false;
  }
  const next = replacePair(pairs, slot.id, "", collectIds(slot.children));
  slots = replaceInstalled(slots, slot.id, null);
  note = "";
  void calculate(next, null, false);
  return true;
}

async function solve() {
  const spec = findSpec();
  if (!spec || !gun || !spec.loadable || pending) return;
  activeSlot = "";
  pending = true;
  note = "正在求解…";
  noteBad = false;
  paint();
  try {
    const data = await invoke<Record<string, unknown>>("site_post", {
      path: "/guides/tarkov/workbench/gunsmith-solve",
      body: { task_id: spec.taskId, objective_id: spec.objectiveId || null, ammo_id: ammoId || null },
    });
    const next = pairsOf(data.pairs);
    const nextAmmo = str(data.ammo_id || data.ammoId) || ammoId;
    if (next.length) {
      const ok = await calculate(next, nextAmmo, true);
      if (!ok) return;
    }
    const status = str(data.status);
    note = status === "optimal" ? "已满足枪匠要求" : str(data.reason) || "当前改装未完全满足要求";
    noteBad = status !== "optimal";
  } catch (error) {
    note = error instanceof Error ? error.message : "枪匠求解失败";
    noteBad = true;
  }
  pending = false;
  paint();
}

async function applyCommunity(id: string) {
  const build = community.find((item) => item.id === id);
  if (!build || !build.loadable) return;
  communityOpen = false;
  activeSlot = "";
  const dropped = build.dropped ? `已装入「${build.name}」，省略了 ${build.dropped} 件本站没有的配件` : `已装入「${build.name}」`;
  const ok = await calculate(build.pairs, build.ammoId || null, true, dropped);
  if (!ok) return;
  note = dropped;
  noteBad = false;
  paint();
}

function togglePartSort(key: PartSortKey) {
  if (partSort.key === key) partSort = { key, dir: partSort.dir === "asc" ? "desc" : "asc" };
  else partSort = { key, dir: key === "name" ? "asc" : "desc" };
  paint();
}

function toggleBuildSort(key: CommunitySortKey) {
  if (communitySort?.key === key) communitySort = communitySort.dir === "desc" ? { key, dir: "asc" } : null;
  else communitySort = { key, dir: "desc" };
  page = 1;
  paint();
}

function onClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.classList.contains("wb-modal")) {
    closeTop();
    return;
  }
  const el = target.closest<HTMLElement>("[data-wb-close], [data-wb-pick], [data-wb-smith-open], [data-wb-community-open], [data-wb-change], [data-wb-clear], [data-wb-restore], [data-wb-slot], [data-wb-install], [data-wb-unload], [data-wb-gun], [data-wb-task], [data-wb-build], [data-wb-solve], [data-wb-smith-exit], [data-wb-part-sort], [data-wb-build-sort], [data-wb-page]");
  if (!el || (el instanceof HTMLButtonElement && el.disabled)) return;
  if (el.hasAttribute("data-wb-close")) { closeTop(); return; }
  if (el.hasAttribute("data-wb-pick") || el.hasAttribute("data-wb-change")) { void openPick(); return; }
  if (el.hasAttribute("data-wb-smith-open")) { void openSmith(); return; }
  if (el.hasAttribute("data-wb-community-open")) { void openCommunity(); return; }
  if (el.hasAttribute("data-wb-clear")) {
    activeSlot = "";
    void calculate([], ammoId || null, true);
    return;
  }
  if (el.hasAttribute("data-wb-restore")) {
    activeSlot = "";
    void calculate(factoryPairs, defaultAmmo || null, true);
    return;
  }
  if (el.dataset.wbSlot) {
    if (activeSlot !== el.dataset.wbSlot) {
      partQuery = "";
      partSort = { key: "ergonomics", dir: "desc" };
    }
    activeSlot = el.dataset.wbSlot;
    paint();
    void loadAllowed();
    return;
  }
  if (el.dataset.wbInstall) { install(el.dataset.wbInstall); return; }
  if (el.hasAttribute("data-wb-unload")) {
    const slot = activeSlot ? findSlot(slots, activeSlot) : null;
    if (slot && !unload(slot)) paint();
    return;
  }
  if (el.dataset.wbGun) { goWorkbench(el.dataset.wbGun); return; }
  if (el.dataset.wbTask) {
    const task = smithTasks.find((item) => item.id === el.dataset.wbTask);
    if (!task?.loadable || !task.weaponId) return;
    goWorkbench(task.weaponId, task.taskId, task.objectiveId);
    return;
  }
  if (el.dataset.wbBuild) { void applyCommunity(el.dataset.wbBuild); return; }
  if (el.hasAttribute("data-wb-solve")) { void solve(); return; }
  if (el.hasAttribute("data-wb-smith-exit")) { goWorkbench(gun?.id || routeGun); return; }
  const partKey = el.dataset.wbPartSort;
  if (partKey === "name" || partKey === "ergonomics" || partKey === "recoil" || partKey === "weight" || partKey === "price") {
    togglePartSort(partKey);
    return;
  }
  const buildKey = el.dataset.wbBuildSort;
  if (buildKey === "published" || buildKey === "loads" || buildKey === "ergo" || buildKey === "evo" || buildKey === "recoilV" || buildKey === "recoilH" || buildKey === "overswing" || buildKey === "price") {
    toggleBuildSort(buildKey);
    return;
  }
  if (el.dataset.wbPage === "prev") { page = Math.max(1, page - 1); paint(); }
  if (el.dataset.wbPage === "next") { page += 1; paint(); }
}

function onInput(event: Event) {
  const el = event.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el.dataset.wbTune) { onTune(el); return; }
  if (el.id === "wb-gun-q") { gunQuery = el.value; paint(); }
  if (el.id === "wb-smith-q") { smithQuery = el.value; paint(); }
  if (el.id === "wb-part-q") { partQuery = el.value; paint(); }
}

function onChange(event: Event) {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.dataset.wbTune) {
    onTune(el);
    if (el.type === "number") paint();
    return;
  }
  if (!(el instanceof HTMLSelectElement)) return;
  if (el.id === "wb-gun-caliber") { caliberFilter = el.value; paint(); }
  if (el.id === "wb-gun-class") { classFilter = el.value; paint(); }
  if (el.id === "wb-ammo" && el.value) void calculate(pairs, el.value, true);
  if (el.id === "wb-page-size") {
    pageSize = Number(el.value) || 50;
    page = 1;
    paint();
  }
}

function onContext(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const cell = target.closest<HTMLElement>("[data-wb-slot]");
  if (!cell?.dataset.wbSlot) return;
  event.preventDefault();
  const slot = findSlot(slots, cell.dataset.wbSlot);
  if (!activeSlot || activeSlot === cell.dataset.wbSlot) activeSlot = "";
  if (!slot || !unload(slot)) paint();
}

function onKey(event: KeyboardEvent) {
  if (!hostEl()) {
    document.removeEventListener("keydown", onKey);
    keyBound = false;
    return;
  }
  if (event.key !== "Escape") return;
  if (!activeSlot && !communityOpen && !smithOpen && !pickOpen) return;
  event.preventDefault();
  closeTop();
}

function ensureBound() {
  const host = hostEl();
  if (!host) return;
  if (host.dataset.bound !== "1") {
    host.dataset.bound = "1";
    host.addEventListener("click", onClick);
    host.addEventListener("input", onInput);
    host.addEventListener("change", onChange);
    host.addEventListener("contextmenu", onContext);
  }
  if (!keyBound) {
    keyBound = true;
    document.addEventListener("keydown", onKey);
  }
}

export function workbenchShell() {
  return `<section class="workbench" id="workbench"></section>`;
}

export async function mountWorkbench(gunId: string) {
  syncMode();
  readRoute();
  routeGun = gunId;
  const token = ++seq;
  const host = hostEl();
  if (!host) return;
  if (taskId) {
    if (!gun) host.innerHTML = spin("正在读取枪匠任务");
    await ensureSmith();
    if (token !== seq) return;
    const spec = findSpec();
    if (spec?.loadable && spec.weaponId && spec.weaponId !== gunId) {
      goWorkbench(spec.weaponId, spec.taskId, spec.objectiveId, true);
      return;
    }
  }
  if (!gunId) {
    const keepModal = !gun && !loadedGunId;
    gun = null;
    loadedGunId = "";
    slots = [];
    stats = null;
    pairs = [];
    gunError = "";
    if (!keepModal) {
      note = "";
      noteBad = false;
      activeSlot = "";
      pickOpen = false;
      smithOpen = false;
      communityOpen = false;
    }
    paint();
    return;
  }
  if (loadedGunId === gunId && gun) {
    paint();
    return;
  }
  gunError = "";
  host.innerHTML = spin("正在读取枪械");
  try {
    const data = await invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/workbench/guns/${encodeURIComponent(gunId)}` });
    if (token !== seq) return;
    calcEpoch += 1;
    allowedEpoch += 1;
    applyGun(data);
    paint();
    void loadAllowed();
  } catch (error) {
    if (token !== seq) return;
    gun = null;
    loadedGunId = "";
    slots = [];
    stats = null;
    gunError = error instanceof Error ? error.message : "未找到枪械";
    paint();
  }
}

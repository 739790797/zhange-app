import { isPending, spin } from "./spinner";

type Cat = { id: string; order: number; label: string; slug: string; children: Cat[] };
type Item = {
  id: string;
  name?: string;
  short_name?: string;
  icon_link?: string;
  width?: number | null;
  height?: number | null;
  weight?: number | null;
  last_low_price?: number | null;
  avg24h_price?: number | null;
  base_price?: number | null;
  properties?: Record<string, unknown> | null;
};
type Loaded = { key: string; query: string; client: boolean; items: Item[]; total: number };

export type CatalogSpec = { slug: string; child: string };

const PAGE_SIZES = [20, 50, 100];
const CLIENT_KINDS = new Set(["rigs", "armors"]);
const NUMERIC = new Set([
  "slots", "weight", "slotRatio", "pricePerSlot", "class", "durability", "price", "fuse", "fragments",
  "energy", "hydration", "useTime", "uses", "ergo", "ergoPenalty", "speedPenalty", "turnPenalty",
  "recoil", "loudness", "hp", "slashDamage", "stabDamage",
]);
const COLUMNS: Record<string, string[]> = {
  backpacks: ["name", "grid", "slots", "weight", "slotRatio", "pricePerSlot", "price"],
  containers: ["name", "grid", "slots", "weight", "slotRatio", "pricePerSlot", "price"],
  rigs: ["name", "slots", "weight", "ergoPenalty", "speedPenalty", "turnPenalty", "price"],
  armors: ["name", "class", "weight", "ergoPenalty", "speedPenalty", "turnPenalty", "price"],
  helmets: ["name", "class", "zones", "ricochet", "turnPenalty", "blocksHeadset", "price"],
  glasses: ["name", "class", "blindness", "price"],
  headsets: ["name", "distance", "weight", "price"],
  grenades: ["name", "grenadeType", "fuse", "fragments", "radius", "price"],
  provisions: ["name", "energy", "hydration", "useTime", "price"],
  keys: ["name", "uses", "grid", "price"],
  barter: ["name", "grid", "weight", "price"],
  meds: ["name", "hp", "useTime", "price"],
  "weapon-mods": ["name", "ergo", "recoil", "price"],
  "ammo-packs": ["name", "grid", "slots", "weight", "slotRatio", "pricePerSlot", "price"],
  melee: ["name", "slashDamage", "stabDamage", "weight", "price"],
  "pistol-grips": ["name", "ergo", "price"],
  suppressors: ["name", "ergo", "recoil", "loudness", "price"],
  gear: ["name", "grid", "weight", "price"],
  money: ["name", "grid", "price"],
  maps: ["name", "grid", "price"],
  "quest-items": ["name", "grid", "weight", "price"],
  "info-items": ["name", "grid", "weight", "price"],
  "special-equipment": ["name", "grid", "weight", "price"],
  "battle-pass": ["name", "grid", "price"],
};
const DEFAULT_COLUMNS = ["name", "grid", "weight", "price"];
const COLUMN_LABEL: Record<string, string> = {
  name: "名称", grid: "格子", slots: "内部格", weight: "重量", slotRatio: "格效", pricePerSlot: "每格价",
  class: "等级", zones: "防护部位", durability: "耐久", ricochet: "跳弹", ergoPenalty: "人机惩罚",
  speedPenalty: "移速惩罚", turnPenalty: "转向", blocksHeadset: "挡耳机", blindness: "闪光防护",
  distance: "听力", fuse: "引信", fragments: "破片", radius: "半径", grenadeType: "类型",
  energy: "能量", hydration: "水分", useTime: "使用", uses: "次数", ergo: "人机", recoil: "后座",
  loudness: "响度", hp: "生命", slashDamage: "劈砍", stabDamage: "刺击", price: "价格",
};
const KIND_BY_ID: Record<string, string> = {
  "5b5f6f3c86f774094242ef87": "headsets",
  "5b47574386f77428ca22b330": "helmets",
  "5b47574386f77428ca22b331": "glasses",
  "5b5f701386f774093f2ecf0f": "armors",
  "5b5f6f8786f77447ed563642": "rigs",
  "5b5f6f6c86f774093f2ecf0b": "backpacks",
  "5b5f6fa186f77409407a7eb7": "containers",
  "5b47574386f77428ca22b33c": "ammo-packs",
  "5b5f7a2386f774093f2ed3c4": "grenades",
  "5b5f7a0886f77409407a7f96": "melee",
  "5b5f761f86f774094242f1a1": "pistol-grips",
  "5b5f731a86f774093e6cb4f9": "suppressors",
};
const ZONES: Record<string, string> = {
  head: "头部", headcommon: "头部", parietalhead: "头顶", backhead: "后脑", ears: "耳朵", eyes: "眼睛",
  jaw: "下颌", neckfront: "喉咙", neckback: "后颈", throat: "喉咙", ribcageup: "上胸", ribcagelow: "下胸",
  spinetop: "上背", spinedown: "下背", leftsidechestup: "左上侧胸", leftsidechestdown: "左下侧胸",
  rightsidechestup: "右上侧胸", rightsidechestdown: "右下侧胸", pelvis: "骨盆", pelvisback: "臀部",
  leftupperarm: "左上臂", leftforearm: "左前臂", rightupperarm: "右上臂", rightforearm: "右前臂",
  leftthigh: "左大腿", leftcalf: "左小腿", rightthigh: "右大腿", rightcalf: "右小腿", chest: "胸部",
  thorax: "胸部", stomach: "腹部", groin: "裆部", back: "背部", sides: "侧面", arms: "手臂",
  leftarm: "左臂", rightarm: "右臂", leftleg: "左腿", rightleg: "右腿", front_plate: "前胸",
  back_plate: "后背", left_side_plate: "左侧", right_side_plate: "右侧", front: "前胸", frontplate: "前胸",
  backplate: "后背", helmet_top: "盔顶", helmet_back: "盔后", helmet_eyes: "眼部", helmet_jaw: "下颌",
  helmet_ears: "耳部", shoulder_l: "左肩", shoulder_r: "右肩", collar: "衣领",
};
const PLATES: [RegExp, string][] = [
  [/_side_left_high$/i, "左侧插板（高）"],
  [/_side_right_high$/i, "右侧插板（高）"],
  [/_side_left$/i, "左侧插板"],
  [/_side_right$/i, "右侧插板"],
  [/_chest$/i, "前胸插板"],
  [/_back$/i, "后背插板"],
];
const RICOCHET: Record<string, string> = { high: "高", medium: "中", low: "低", none: "无" };
const GRENADE: Record<string, string> = {
  frag: "破片", fragmentation: "破片", flash: "闪光", flashbang: "闪光",
  smoke: "烟雾", stun: "震撼", impact: "触发",
};

function wordLabel(value: string, table: Record<string, string>) {
  const text = value.trim();
  if (!text || /[\u4e00-\u9fff]/.test(text)) return text;
  return table[text.toLowerCase().replace(/[\s_-]+/g, "")] || text;
}

function cat(id: string, order: number, label: string, slug = "", children: Cat[] = []): Cat {
  return { id, order, label, slug, children };
}

const roots: Cat[] = [
  cat("6564b96a189fe36f356d177c", 0, "战令文件", "battle-pass"),
  cat("5b619f1a86f77450a702a6f3", 1, "任务物品", "quest-items"),
  cat("5b5f78b786f77447ed5636af", 2, "货币", "money"),
  cat("5b47574386f77428ca22b343", 3, "地图", "maps"),
  cat("5b47574386f77428ca22b345", 4, "特殊装备", "special-equipment"),
  cat("5b47574386f77428ca22b341", 5, "情报物品", "info-items"),
  cat("5b47574386f77428ca22b342", 6, "钥匙", "keys", [
    cat("5c518ec986f7743b68682ce2", 100, "机械钥匙"),
    cat("5c518ed586f774119a772aee", 100, "电子钥匙"),
  ]),
  cat("5b47574386f77428ca22b344", 7, "医疗物品", "meds", [
    cat("5b47574386f77428ca22b338", 100, "急救包"),
    cat("5b47574386f77428ca22b337", 100, "药品"),
    cat("5b47574386f77428ca22b339", 100, "创伤处理"),
    cat("5b47574386f77428ca22b33a", 100, "注射器"),
  ]),
  cat("5b47574386f77428ca22b340", 8, "饮食", "provisions", [
    cat("5b47574386f77428ca22b335", 100, "饮品"),
    cat("5b47574386f77428ca22b336", 100, "食物"),
  ]),
  cat("5b47574386f77428ca22b346", 9, "弹药", "ammo", [
    cat("5b47574386f77428ca22b33c", 100, "弹药包"),
    cat("5b47574386f77428ca22b33b", 100, "子弹"),
  ]),
  cat("5b5f78dc86f77409407a7f8e", 10, "武器", "guns", [
    cat("5b5f78fc86f77409407a7f90", 100, "突击步枪"),
    cat("5b5f796a86f774093f2ed3c0", 100, "冲锋枪"),
    cat("5b5f794b86f77409407a7f92", 100, "霰弹枪"),
    cat("5b5f7a2386f774093f2ed3c4", 100, "投掷物"),
    cat("5b5f79a486f77409407a7f94", 100, "机枪"),
    cat("5b5f78e986f77447ed5636b1", 100, "突击卡宾枪"),
    cat("5b5f7a0886f77409407a7f96", 100, "近战武器"),
    cat("5b5f79d186f774093f2ed3c2", 100, "榴弹发射器"),
    cat("5b5f791486f774093f2ed3be", 100, "精确射手步枪"),
    cat("5b5f792486f77447ed5636b3", 100, "手枪"),
    cat("5b5f798886f77447ed5636b5", 100, "栓动式步枪"),
    cat("5b5f79eb86f77447ed5636b7", 100, "特殊武器"),
  ]),
  cat("5b5f71a686f77447ed5636ab", 11, "武器零件&配件", "weapon-mods", [
    cat("5b5f750686f774093e6cb503", 100, "装备配件", "", [
      cat("5b5f754a86f774094242f19b", 100, "弹匣"),
      cat("5b5f757486f774093e6cb507", 110, "枪托"),
      cat("5b5f761f86f774094242f1a1", 120, "手枪式握把"),
      cat("5b5f755f86f77447ec5d770e", 130, "导轨"),
      cat("5b5f751486f77447ec5d770c", 140, "拉机柄"),
      cat("5b5f752e86f774093e6cb505", 150, "榴弹发射器"),
    ]),
    cat("5b5f71b386f774093f2ecf11", 110, "功能模块", "", [
      cat("5b5f73ec86f774093e6cb4fd", 100, "瞄具", "", [
        cat("5b5f740a86f77447ec5d7706", 100, "突击瞄准镜"),
        cat("5b5f742686f774093e6cb4ff", 110, "反射式瞄具"),
        cat("5b5f744786f774094242f197", 120, "小型反射式瞄具"),
        cat("5b5f746686f77447ec5d7708", 130, "机械瞄具"),
        cat("5b5f748386f774093e6cb501", 140, "光学瞄具"),
        cat("5b5f749986f774094242f199", 150, "特殊瞄具"),
      ]),
      cat("5b5f724186f77447ed5636ad", 110, "枪口装置", "", [
        cat("5b5f724c86f774093f2ecf15", 100, "消焰器及制退器"),
        cat("5b5f72f786f77447ec5d7702", 110, "枪口转接器"),
        cat("5b5f731a86f774093e6cb4f9", 120, "消音器"),
      ]),
      cat("5b5f736886f774094242f193", 120, "照明激光设备", "", [
        cat("5b5f73ab86f774094242f195", 100, "手电筒"),
        cat("5b5f73c486f77447ec5d7704", 110, "激光瞄准模块"),
      ]),
      cat("5b5f737886f774093e6cb4fb", 130, "战术组合设备"),
      cat("5b5f71de86f774093f2ecf13", 140, "前握把"),
      cat("5b5f71c186f77409407a7ec0", 150, "两脚架"),
      cat("5b5f74cc86f77447ec5d770a", 160, "辅助零件"),
    ]),
    cat("5b5f75b986f77447ec5d7710", 120, "基础部件", "", [
      cat("5b5f75c686f774094242f19f", 100, "枪管"),
      cat("5b5f75e486f77447ec5d7712", 110, "护木"),
      cat("5b5f760586f774093e6cb509", 120, "导气箍"),
      cat("5b5f764186f77447ec5d7714", 130, "机匣和套筒"),
    ]),
  ]),
  cat("5b47574386f77428ca22b33f", 12, "装备", "gear", [
    cat("5b47574386f77428ca22b330", 100, "头部装备"),
    cat("5b47574386f77428ca22b331", 110, "眼部装备"),
    cat("5b47574386f77428ca22b32f", 120, "面部装备"),
    cat("5b5f6f8786f77447ed563642", 130, "战术胸挂"),
    cat("5b5f701386f774093f2ecf0f", 140, "防弹衣"),
    cat("5b5f6f3c86f774094242ef87", 150, "耳机"),
    cat("5b5f6f6c86f774093f2ecf0b", 160, "背包"),
    cat("5b5f6fa186f77409407a7eb7", 170, "容器"),
    cat("5b5f6fd286f774093f2ecf0d", 180, "安全箱"),
    cat("5b5f704686f77447ec5d76d7", 190, "装备组件"),
  ]),
  cat("5b47574386f77428ca22b33e", 13, "交换用物品", "barter", [
    cat("5b47574386f77428ca22b2f6", 100, "工具"),
    cat("5b47574386f77428ca22b2f0", 100, "日常用品"),
    cat("5b47574386f77428ca22b2ed", 100, "能源物品"),
    cat("5b47574386f77428ca22b2f1", 100, "贵重物品"),
    cat("5b47574386f77428ca22b2ef", 100, "电子产品"),
    cat("5b47574386f77428ca22b2f2", 100, "易燃物品"),
    cat("5b47574386f77428ca22b2f3", 100, "医疗用品"),
    cat("5b47574386f77428ca22b2ee", 100, "建筑材料"),
    cat("5b47574386f77428ca22b2f4", 110, "其他"),
  ]),
];

let seq = 0;
let query = "";
let page = 1;
let pageSize = 50;
let key = "";
let sortKey = "";
let sortDir: "ascend" | "descend" = "ascend";
let rig: "all" | "plain" | "armored" = "all";
let focusSearch = false;
let searchTimer = 0;
let sideScroll = 0;
let sideAnchor: { id: string; offset: number } | null = null;
const open = new Set<string>();
let loaded: Loaded | null = null;

export function pinCatalogList(id: string) {
  const side = document.querySelector<HTMLElement>(".catalog-side");
  const node = side?.querySelector<HTMLElement>(`[data-catalog-node="${CSS.escape(id)}"]`);
  if (!side || !node) {
    sideAnchor = { id, offset: 0 };
    return;
  }
  sideAnchor = { id, offset: node.getBoundingClientRect().top - side.getBoundingClientRect().top };
}

function placeSidebar() {
  const side = document.querySelector<HTMLElement>(".catalog-side");
  if (!side) return;
  const anchor = sideAnchor;
  sideAnchor = null;
  if (anchor) {
    const node = side.querySelector<HTMLElement>(`[data-catalog-node="${CSS.escape(anchor.id)}"]`);
    if (node) {
      const delta = node.getBoundingClientRect().top - side.getBoundingClientRect().top - anchor.offset;
      side.scrollTop += delta;
    }
  } else {
    side.scrollTop = sideScroll;
  }
  sideScroll = side.scrollTop;
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function ordered(nodes: Cat[]) {
  return nodes.map((item, index) => ({ item, index })).sort((a, b) => a.item.order - b.item.order || a.index - b.index).map((row) => row.item);
}

function findChild(nodes: Cat[], id: string): Cat | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findChild(node.children, id);
    if (hit) return hit;
  }
  return null;
}

function rootOf(slug: string) {
  return roots.find((item) => item.slug === slug) || null;
}

function selection(spec: CatalogSpec) {
  const root = rootOf(spec.slug);
  if (!root) return { root: null, node: null };
  if (!spec.child) return { root, node: root };
  return { root, node: findChild(root.children, spec.child) || root };
}

function collect(node: Cat): string[] {
  return [node.id, ...node.children.flatMap(collect)];
}

function idsOf(spec: CatalogSpec) {
  const { root, node } = selection(spec);
  if (!root || !node) return roots.map((item) => item.id);
  return collect(node);
}

function kindOf(spec: CatalogSpec) {
  const { root, node } = selection(spec);
  if (!root || !node) return "";
  return KIND_BY_ID[node.id] || root.slug;
}

function columnsOf(kind: string) {
  return COLUMNS[kind] || DEFAULT_COLUMNS;
}

function columnTitle(kind: string, column: string) {
  if (kind === "rigs" && column === "slots") return "容量";
  if ((kind === "rigs" || kind === "armors") && column === "turnPenalty") return "转向惩罚";
  return COLUMN_LABEL[column] || column;
}

function sortable(kind: string, column: string) {
  return CLIENT_KINDS.has(kind) && column !== "name";
}

function findNode(nodes: Cat[], id: string): Cat | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}

function branchIds(node: Cat): string[] {
  return [node.id, ...node.children.flatMap(branchIds)];
}

function openBranch(id: string) {
  const keep = new Set<string>();
  const walk = (nodes: Cat[], ancestors: string[]): boolean => {
    for (const item of nodes) {
      if (item.id === id || walk(item.children, [...ancestors, item.id])) {
        for (const ancestor of ancestors) keep.add(ancestor);
        keep.add(item.id);
        return true;
      }
    }
    return false;
  };
  if (!walk(roots, [])) return;
  open.clear();
  for (const kept of keep) open.add(kept);
}

function reveal(root: Cat, node: Cat) {
  const path = new Set<string>();
  const walk = (nodes: Cat[]): boolean => {
    for (const item of nodes) {
      if (item.id === node.id || walk(item.children)) {
        path.add(item.id);
        return true;
      }
    }
    return false;
  };
  walk([root]);
  open.clear();
  for (const id of path) open.add(id);
}

function readError(error: unknown) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message || "").trim();
    if (message) return message;
  }
  return "物品读取失败";
}

export function catalogHref(slug = "", child = "") {
  if (!slug) return "/主菜单/逃离塔科夫/物品图鉴";
  return `/主菜单/逃离塔科夫/物品图鉴/${slug}${child ? `/${child}` : ""}`;
}

export function matchCatalog(path: string): CatalogSpec | null {
  const prefix = "/主菜单/逃离塔科夫/物品图鉴";
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  const rest = path.slice(prefix.length).replace(/^\//, "");
  if (!rest) return { slug: "", child: "" };
  const [slug = "", child = ""] = rest.split("/");
  const root = rootOf(slug);
  if (slug && !root) return { slug: "", child: "" };
  if (child && root && !findChild(root.children, child)) return { slug, child: "" };
  return { slug, child };
}

export function catalogShell() {
  return `<section class="catalog" id="catalog">${spin("正在读取物品")}</section>`;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function propsOf(item: Item) {
  return item.properties && typeof item.properties === "object" ? item.properties : {};
}

function numProp(obj: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = Number(obj[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function textProp(obj: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function boolProp(obj: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function slotsOf(obj: Record<string, unknown>) {
  const capacity = numProp(obj, "capacity");
  if (capacity != null && capacity > 0) return capacity;
  if (!Array.isArray(obj.grids)) return null;
  let sum = 0;
  for (const grid of obj.grids) {
    if (!grid || typeof grid !== "object") continue;
    const row = grid as Record<string, unknown>;
    const width = Number(row.width);
    const height = Number(row.height);
    if (Number.isFinite(width) && Number.isFinite(height)) sum += width * height;
  }
  return sum > 0 ? sum : null;
}

function priceAmount(item: Item) {
  for (const value of [item.last_low_price, item.avg24h_price, item.base_price]) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return null;
}

function money(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value).toLocaleString("zh-CN")} ₽`;
}

function plain(value: number | string | null | undefined) {
  if (value == null || value === "") return "—";
  return String(value);
}

function percent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

function signed(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function zoneName(value: string) {
  const text = value.trim();
  if (!text) return "";
  if (/[\u3400-\u9fff]/.test(text)) return text;
  const cleaned = text.replace(/^(collider\s*type|armor\s*zone|ebodypartcollidertype)[.\s:_-]*/i, "").trim();
  const lookup = (raw: string) => {
    const spaced = raw.toLowerCase().replace(/[\s-]+/g, "_");
    return ZONES[raw] || ZONES[raw.toLowerCase()] || ZONES[spaced] || ZONES[spaced.replace(/_/g, "")];
  };
  return lookup(cleaned) || PLATES.find(([pattern]) => pattern.test(cleaned))?.[1] || lookup(text) || cleaned || text;
}

function zoneText(value: unknown) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of list) {
    const name = zoneName(String(item || ""));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.join(" · ");
}

function armored(item: Item) {
  const body = propsOf(item);
  if (boolProp(body, "armored") === true) return true;
  const level = numProp(body, "class");
  return level != null && level > 0;
}

function cell(column: string, item: Item) {
  const body = propsOf(item);
  switch (column) {
    case "grid":
      return item.width == null || item.height == null ? "—" : `${item.width}×${item.height}`;
    case "slots":
      return plain(slotsOf(body));
    case "weight": {
      const amount = Number(item.weight);
      return Number.isFinite(amount) ? `${Math.round(amount * 1000) / 1000} kg` : "—";
    }
    case "slotRatio": {
      const inner = slotsOf(body);
      const area = item.width != null && item.height != null ? item.width * item.height : 0;
      return !inner || !area ? "—" : String(Math.round((inner / area) * 100) / 100);
    }
    case "pricePerSlot": {
      const inner = slotsOf(body);
      const amount = priceAmount(item);
      return !inner || amount == null ? "—" : money(Math.round(amount / inner));
    }
    case "class":
      return plain(numProp(body, "class"));
    case "zones":
      return plain(zoneText(body.zones));
    case "durability": {
      const current = numProp(body, "durability");
      const max = numProp(body, "maxDurability");
      if (current == null && max == null) return "—";
      return current != null && max != null && current !== max ? `${current} / ${max}` : plain(current ?? max);
    }
    case "ricochet":
      return plain(wordLabel(textProp(body, "ricochetY"), RICOCHET) || numProp(body, "ricochetChance"));
    case "grenadeType":
      return plain(wordLabel(textProp(body, "type"), GRENADE));
    case "turnPenalty":
      return percent(numProp(body, "turnPenalty"));
    case "blocksHeadset": {
      const flag = boolProp(body, "blocksHeadset", "blockHeadset");
      return flag == null ? "—" : flag ? "是" : "否";
    }
    case "blindness":
      return percent(numProp(body, "blindnessProtection"));
    case "distance":
      return signed(numProp(body, "distanceModifier"));
    case "fuse":
      return plain(numProp(body, "fuse"));
    case "fragments":
      return plain(numProp(body, "fragments"));
    case "radius": {
      const min = numProp(body, "minExplosionDistance");
      const max = numProp(body, "maxExplosionDistance");
      if (min == null && max == null) return "—";
      return min != null && max != null ? `${min}–${max}` : plain(max ?? min);
    }
    case "energy":
      return plain(numProp(body, "energy", "energyImpact"));
    case "hydration":
      return plain(numProp(body, "hydration", "hydrationImpact"));
    case "useTime":
      return plain(numProp(body, "useTime"));
    case "uses":
      return plain(numProp(body, "uses"));
    case "ergo":
      return signed(numProp(body, "ergonomics", "ergoPenalty"));
    case "ergoPenalty":
      return percent(numProp(body, "ergoPenalty"));
    case "speedPenalty":
      return percent(numProp(body, "speedPenalty"));
    case "recoil":
      return signed(numProp(body, "recoilModifier", "recoil"));
    case "loudness":
      return plain(numProp(body, "loudness"));
    case "hp":
      return plain(numProp(body, "hitpoints", "hp"));
    case "slashDamage":
      return plain(numProp(body, "slashDamage"));
    case "stabDamage":
      return plain(numProp(body, "stabDamage"));
    case "price":
      return money(priceAmount(item));
    default:
      return "—";
  }
}

function sortValue(column: string, item: Item): number | string | null {
  const body = propsOf(item);
  switch (column) {
    case "slots":
      return slotsOf(body);
    case "class":
      return numProp(body, "class");
    case "weight":
      return item.weight ?? null;
    case "ergoPenalty":
      return numProp(body, "ergoPenalty");
    case "speedPenalty":
      return numProp(body, "speedPenalty");
    case "turnPenalty":
      return numProp(body, "turnPenalty");
    case "price":
      return priceAmount(item);
    default:
      return null;
  }
}

function compare(left: Item, right: Item, column: string, dir: "ascend" | "descend") {
  const a = sortValue(column, left);
  const b = sortValue(column, right);
  const emptyA = a == null || a === "";
  const emptyB = b == null || b === "";
  if (emptyA && emptyB) return String(left.id).localeCompare(String(right.id));
  if (emptyA) return 1;
  if (emptyB) return -1;
  let delta = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "zh");
  if (delta === 0) delta = String(left.id).localeCompare(String(right.id));
  return dir === "descend" ? -delta : delta;
}

function iconOf(icon: string, id: string) {
  if (icon) return icon;
  return /^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-icon.webp` : "";
}

function allIcon() {
  return `<span class="catalog-cat-icon"><svg class="catalog-cat-svg" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.25" y="1.25" width="5.5" height="5.5" rx="0.6"></rect><rect x="9.25" y="1.25" width="5.5" height="5.5" rx="0.6"></rect><rect x="1.25" y="9.25" width="5.5" height="5.5" rx="0.6"></rect><rect x="9.25" y="9.25" width="5.5" height="5.5" rx="0.6"></rect></svg></span>`;
}

function catIcon(id: string) {
  const src = `https://assets.tarkov.dev/handbook-category-${id}-icon.webp`;
  return `<span class="catalog-cat-icon"><img src="${esc(src)}" alt="" draggable="false" onerror="this.remove()" /></span>`;
}

function allButton(spec: CatalogSpec) {
  return `<button type="button" class="catalog-cat${spec.slug ? "" : " on"}" data-catalog="" data-catalog-node="all">${allIcon()}<span>全部</span></button>`;
}

function treeNodes(spec: CatalogSpec, nodes: Cat[], depth: number, rootSlug: string): string {
  return ordered(nodes).map((node) => {
    const kids = node.children;
    const expanded = open.has(node.id);
    const caret = kids.length
      ? `<button type="button" class="catalog-caret${expanded ? " open" : ""}" data-catalog-toggle="${esc(node.id)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "收起" : "展开"}${esc(node.label)}"></button>`
      : `<span class="catalog-caret-slot"></span>`;
    const button = `<button type="button" class="catalog-cat${spec.child === node.id || (depth === 0 && !spec.child && node.slug === spec.slug) ? " on" : ""}" data-catalog="${esc(depth === 0 ? node.slug : rootSlug)}" data-catalog-node="${esc(node.id)}"${depth === 0 ? "" : ` data-catalog-child="${esc(node.id)}"`}>${catIcon(node.id)}<span>${esc(node.label)}</span></button>`;
    const nested = expanded && kids.length ? `<div class="catalog-kids">${treeNodes(spec, kids, depth + 1, depth === 0 ? node.slug : rootSlug)}</div>` : "";
    return `<div class="catalog-node"><div class="catalog-cat-row">${caret}${button}</div>${nested}</div>`;
  }).join("");
}

function sidebar(spec: CatalogSpec) {
  return `<nav class="catalog-tree" aria-label="手册分类"><div class="catalog-cat-row"><span class="catalog-caret-slot"></span>${allButton(spec)}</div><div class="catalog-roots">${treeNodes(spec, roots, 0, spec.slug)}</div></nav>`;
}

function visibleRows(kind: string, source: Item[], client: boolean) {
  if (!client) return { rows: source, total: loaded?.total ?? source.length };
  let rows = source;
  if (kind === "rigs" && rig !== "all") rows = rows.filter((item) => armored(item) === (rig === "armored"));
  if (sortKey && sortable(kind, sortKey)) rows = [...rows].sort((left, right) => compare(left, right, sortKey, sortDir));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page > pages) page = pages;
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), total };
}

function table(spec: CatalogSpec, source: Item[] | null, client: boolean, note: string) {
  const kind = kindOf(spec);
  const columns = columnsOf(kind);
  const head = columns.map((column) => {
    const title = columnTitle(kind, column);
    const mark = sortKey === column ? (sortDir === "descend" ? " ↓" : " ↑") : "";
    const label = sortable(kind, column) ? `<button type="button" data-catalog-sort="${esc(column)}">${esc(title)}${mark}</button>` : esc(title);
    return `<th class="${NUMERIC.has(column) ? "num" : ""}">${label}</th>`;
  }).join("");
  if (source == null) return `<div class="catalog-panel">${isPending(note) ? spin(note) : `<p class="catalog-empty">${esc(note)}</p>`}</div>`;
  const shown = visibleRows(kind, source, client);
  const body = shown.rows.map((item) => {
    const id = String(item.id || "").trim();
    const name = String(item.name || item.short_name || id).trim();
    const icon = iconOf(String(item.icon_link || ""), id);
    const cells = columns.map((column) => {
      if (column === "name") {
        return `<td><button type="button" class="catalog-name" data-wiki="item" data-wiki-id="${esc(id)}">${icon ? `<img src="${esc(icon)}" alt="" />` : "<i></i>"}<span>${esc(name)}</span></button></td>`;
      }
      return `<td class="${NUMERIC.has(column) ? "num" : ""}">${esc(cell(column, item))}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  const empty = body ? "" : `<tr><td colspan="${columns.length}"><p class="catalog-empty">当前筛选下无物品</p></td></tr>`;
  return `<div class="catalog-panel"><table class="catalog-table"><thead><tr>${head}</tr></thead><tbody>${body || empty}</tbody></table></div>${pager(shown.total)}`;
}

function pager(total: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total, page * pageSize);
  const sizes = PAGE_SIZES.map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size}</option>`).join("");
  return `<div class="catalog-pager"><button type="button" data-catalog-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button><span>${start}–${end} / ${total}</span><label>每页 <select data-catalog-size aria-label="每页数量">${sizes}</select></label><button type="button" data-catalog-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button></div>`;
}

function layout(spec: CatalogSpec, main: string, meta: string) {
  const { node, root } = selection(spec);
  const childLabel = root && node && node.id !== root.id ? node.label : "";
  const kinds = kindOf(spec) === "rigs"
    ? `<div class="catalog-kinds" role="group" aria-label="胸挂类型">${[["all", "全部"], ["plain", "胸挂"], ["armored", "防弹胸挂"]].map(([id, label]) => `<button type="button" data-catalog-rig="${id}" class="${rig === id ? "on" : ""}" aria-pressed="${rig === id ? "true" : "false"}">${label}</button>`).join("")}</div>`
    : "";
  return `
    <div class="catalog-layout">
      <aside class="catalog-side">${sidebar(spec)}</aside>
      <div class="catalog-main">
        <div class="catalog-toolbar">
          <div class="catalog-toolbar-side">${kinds}<span class="catalog-meta">${esc(meta)}${childLabel ? ` · ${esc(childLabel)}` : ""}</span></div>
          <form id="catalog-find"><input class="catalog-search" name="q" value="${esc(query)}" placeholder="搜索名称 / 短名" aria-label="搜索物品" /></form>
        </div>
        ${main}
      </div>
    </div>`;
}

function paint(spec: CatalogSpec, data: Loaded | null, note = "") {
  const host = document.querySelector<HTMLElement>("#catalog");
  if (!host) return;
  const catalogScroll = host.scrollTop;
  const side = host.querySelector<HTMLElement>(".catalog-side");
  if (side && !sideAnchor) sideScroll = side.scrollTop;
  const pending = !data && isPending(note || "正在读取物品…");
  const meta = data ? `共 ${data.client ? visibleRows(kindOf(spec), data.items, true).total : data.total} 件` : pending ? "" : note;
  const main = data ? table(spec, data.items, data.client, "") : pending ? `<div class="catalog-panel">${spin(note || "正在读取物品")}</div>` : `<div class="catalog-panel"><p class="catalog-empty">${esc(note)}</p></div>`;
  host.innerHTML = layout(spec, main, data ? meta : note);
  host.scrollTop = catalogScroll;
  placeSidebar();
  bind(host, spec);
  if (focusSearch) {
    focusSearch = false;
    const input = host.querySelector<HTMLInputElement>("[name=q]");
    input?.focus();
    const end = input?.value.length ?? 0;
    input?.setSelectionRange(end, end);
  }
}

function bind(host: HTMLElement, spec: CatalogSpec) {
  host.querySelector("#catalog-find")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLInputElement>("[name=q]");
    window.clearTimeout(searchTimer);
    query = input?.value.trim() || "";
    page = 1;
    void mountCatalog(spec);
  });
  host.querySelector<HTMLInputElement>("[name=q]")?.addEventListener("input", (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      const next = input.value.trim();
      if (next === query) return;
      query = next;
      page = 1;
      focusSearch = document.activeElement === input;
      void mountCatalog(spec);
    }, 300);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-catalog-page]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      page = Math.max(1, Number(button.dataset.catalogPage) || 1);
      if (loaded?.client && loaded.key === `${spec.slug}/${spec.child}` && loaded.query === query) paint(spec, loaded);
      else void mountCatalog(spec);
    });
  });
  host.querySelector<HTMLSelectElement>("[data-catalog-size]")?.addEventListener("change", (event) => {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;
    const next = Number(select.value);
    if (!PAGE_SIZES.includes(next) || next === pageSize) return;
    pageSize = next;
    page = 1;
    if (loaded?.client && loaded.key === `${spec.slug}/${spec.child}` && loaded.query === query) paint(spec, loaded);
    else void mountCatalog(spec);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-catalog-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const column = button.dataset.catalogSort || "";
      if (!sortable(kindOf(spec), column)) return;
      if (sortKey !== column) {
        sortKey = column;
        sortDir = "ascend";
      } else if (sortDir === "ascend") sortDir = "descend";
      else sortKey = "";
      page = 1;
      if (loaded) paint(spec, loaded);
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-catalog-rig]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.catalogRig;
      if (next !== "all" && next !== "plain" && next !== "armored") return;
      rig = next;
      page = 1;
      if (loaded) paint(spec, loaded);
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-catalog-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = button.dataset.catalogToggle || "";
      if (!id) return;
      const row = button.closest(".catalog-cat-row");
      const cat = row?.querySelector<HTMLElement>(".catalog-cat");
      if (cat?.dataset.catalogNode) pinCatalogList(cat.dataset.catalogNode);
      const node = findNode(roots, id);
      if (open.has(id)) {
        for (const branch of node ? branchIds(node) : [id]) open.delete(branch);
      } else {
        openBranch(id);
      }
      if (loaded && loaded.key === `${spec.slug}/${spec.child}` && loaded.query === query) paint(spec, loaded);
      else paint(spec, null, "正在读取物品…");
    });
  });
}

function readItems(data: Record<string, unknown>) {
  if (!Array.isArray(data.items)) return [];
  return data.items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Item;
    return String(row.id || "").trim() ? [row] : [];
  });
}

async function fetchItems(ids: string[], text: string, index: number, size: number) {
  const params = new URLSearchParams();
  if (ids.length) params.set("category_ids", ids.join(","));
  if (text) params.set("q", text);
  params.set("page", String(index));
  params.set("page_size", String(size));
  return invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/items?${params.toString()}` });
}

export async function mountCatalog(spec: CatalogSpec, local = false) {
  const nextKey = `${spec.slug}/${spec.child}`;
  if (key !== nextKey) {
    key = nextKey;
    page = 1;
    sortKey = "";
    sortDir = "ascend";
    rig = "all";
    const picked = selection(spec);
    if (picked.root && picked.node) reveal(picked.root, picked.node);
    else open.clear();
  }
  if (local && loaded && loaded.key === nextKey && loaded.query === query) {
    paint(spec, loaded);
    return;
  }
  const token = ++seq;
  const kind = kindOf(spec);
  const client = CLIENT_KINDS.has(kind);
  const restore = focusSearch;
  const anchor = sideAnchor;
  paint(spec, null, "正在读取物品…");
  focusSearch = restore;
  sideAnchor = anchor;
  try {
    const ids = idsOf(spec);
    let items: Item[] = [];
    let total = 0;
    if (client) {
      const first = await fetchItems(ids, query, 1, 100);
      if (token !== seq) return;
      const count = Number(first.item_count);
      const pages = Math.max(1, Math.ceil((Number.isFinite(count) ? count : readItems(first).length) / 100));
      const rest = pages > 1 ? await Promise.all(Array.from({ length: pages - 1 }, (_, index) => fetchItems(ids, query, index + 2, 100))) : [];
      if (token !== seq) return;
      items = readItems(first).concat(...rest.map(readItems));
      total = Number.isFinite(count) ? count : items.length;
    } else {
      const data = await fetchItems(ids, query, page, pageSize);
      if (token !== seq) return;
      items = readItems(data);
      const count = Number(data.item_count);
      total = Number.isFinite(count) ? count : items.length;
    }
    loaded = { key: nextKey, query, client, items, total };
    paint(spec, loaded);
  } catch (error) {
    if (token !== seq) return;
    loaded = null;
    paint(spec, null, readError(error));
  }
}

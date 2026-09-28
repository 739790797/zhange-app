type Bag = Record<string, unknown>;
type Mode = "full" | "embed";
type Link = { id: string; name: string; icon: string; badge: string };
type Loot = { id: string; name: string; icon: string; count: number | null; money: boolean; fir: boolean };
type Offer = { vendor: string; name: string; price: number | null; currency: string; priceRub: number | null; minLevel: number | null };
type Prop = { label: string; html: string; large: boolean; note: string };

const AMMO_NOTE = "标「默认」的是参考弹：瞄具归零按它的初速算；商人默认预设和战局里刷出的枪，弹匣里通常也是它。游戏检视界面不会单独列出。";
const PLATE_NOTE = "默认是出厂插板；Stripped 是未插板配置，不单独占一页。";
const SKIP = new Set(["grid", "__typename", "slots", "armorSlots", "content", "armored", "propertiesType", "pouches", "conflictingSlotIds", "defaultAmmo", "default"]);
const LABELS: Record<string, string> = {
  weight: "重量", size: "尺寸", caliber: "口径", ammoType: "弹药类型", stackMaxSize: "堆叠", tracer: "曳光", tracerColor: "曳光色",
  projectileCount: "弹丸数", damage: "威力", penetrationPower: "穿透力", penetrationChance: "穿透概率", penetrationPowerDeviation: "穿透偏差",
  armorDamage: "对甲", initialSpeed: "初速", accuracyModifier: "精度", recoilModifier: "后座", lightBleedModifier: "小出血", heavyBleedModifier: "大出血",
  fragmentationChance: "碎弹率", ricochetChance: "跳弹率", durabilityBurnFactor: "耐久损耗", staminaBurnPerDamage: "耐力消耗", ballisticCoeficient: "弹道系数",
  bulletDiameterMilimeters: "弹径 mm", bulletMassGrams: "弹重 g", misfireChance: "哑火", failureToFeedChance: "卡弹", class: "护甲等级", durability: "耐久",
  maxDurability: "最大耐久", repairCost: "修理花费", ergoPenalty: "人机惩罚", speedPenalty: "移速惩罚", turnPenalty: "转向惩罚", bluntThroughput: "钝伤穿透",
  zones: "防护部位", headZones: "头部防护", material: "材质", armorType: "护甲类型", useTime: "使用时间", cures: "治疗", hitpoints: "生命", maxHealPerUse: "单次治疗",
  hpCostLightBleeding: "小出血耗血", hpCostHeavyBleeding: "大出血耗血", energyImpact: "能量", hydrationImpact: "水分", painkillerDuration: "止疼时长",
  minLimbHealth: "肢体最低生命", maxLimbHealth: "肢体最高生命", units: "份数", uses: "次数", function: "功能", ergonomics: "人机", recoil: "后座", capacity: "容量",
  grids: "格仓", loadModifier: "装填", ammoCheckModifier: "查弹", malfunctionChance: "故障率", allowedAmmo: "可用弹药", presets: "预设", conflictingItems: "冲突物品",
  conflictingCategories: "冲突分类", distanceModifier: "听力距离", distortion: "失真", ambientVolume: "环境音", compressorAttack: "压缩启动", compressorGain: "压缩增益",
  compressorRelease: "压缩释放", compressorThreshold: "压缩阈值", compressorVolume: "压缩音量", cutoffFrequency: "截止频率", dryVolume: "干音量", highFrequencyGain: "高频增益",
  resonance: "共振", blindnessProtection: "闪光防护", blocksHeadset: "挡住耳机", ricochetX: "跳弹 X", ricochetY: "跳弹", ricochetZ: "跳弹 Z", deafening: "听力影响",
  fuse: "引信", fragments: "破片数", fragmentation: "破片伤害", minExplosionDistance: "最小爆炸距离", maxExplosionDistance: "最大爆炸距离", contusionRadius: "震荡半径",
  type: "类型", energy: "能量", hydration: "水分", loudness: "响度", accuracy: "精度", velocity: "初速", heatFactor: "积热", coolingFactor: "散热", centerOfImpact: "散布",
  deviationCurve: "散布曲线", deviationMax: "最大散布", fireRate: "射速", effectiveDistance: "有效距离", fireModes: "射击模式", recoilVertical: "垂直后座",
  recoilHorizontal: "水平后座", recoilDispersion: "后座散布", recoilAngle: "后座角度", cameraRecoil: "镜头后座", cameraSnap: "镜头回正", convergence: "收敛",
  sightingRange: "瞄具距离", sightModes: "瞄具模式", zoomLevels: "变倍", slashDamage: "劈砍伤害", stabDamage: "刺击伤害", hitRadius: "攻击距离", intensity: "亮度",
  noiseIntensity: "噪点强度", noiseScale: "噪点缩放", diffuseIntensity: "漫射", moa: "MOA", defaultWidth: "默认宽", defaultHeight: "默认高", defaultErgonomics: "默认人机",
  defaultRecoilVertical: "默认垂直后座", defaultRecoilHorizontal: "默认水平后座", defaultWeight: "默认重量", categories: "分类", usedOnMaps: "地图", stimEffects: "注射效果",
  baseItem: "基础物品", defaultPreset: "默认预设", bodyPartsHealth: "部位生命",
};
const ZONES: Record<string, string> = {
  head: "头部", headcommon: "头部", parietalhead: "头顶", backhead: "后脑", ears: "耳朵", eyes: "眼睛", jaw: "下颌", neckfront: "喉咙", neckback: "后颈",
  throat: "喉咙", ribcageup: "上胸", ribcagelow: "下胸", spinetop: "上背", spinedown: "下背", leftsidechestup: "左上侧胸", leftsidechestdown: "左下侧胸",
  rightsidechestup: "右上侧胸", rightsidechestdown: "右下侧胸", pelvis: "骨盆", pelvisback: "臀部", leftupperarm: "左上臂", leftforearm: "左前臂",
  rightupperarm: "右上臂", rightforearm: "右前臂", leftthigh: "左大腿", leftcalf: "左小腿", rightthigh: "右大腿", rightcalf: "右小腿", chest: "胸部", thorax: "胸部",
  stomach: "腹部", groin: "裆部", back: "背部", sides: "侧面", arms: "手臂", leftarm: "左臂", rightarm: "右臂", leftleg: "左腿", rightleg: "右腿", front_plate: "前胸",
  back_plate: "后背", left_side_plate: "左侧", right_side_plate: "右侧", front: "前胸", frontplate: "前胸", backplate: "后背", helmet_top: "盔顶", helmet_back: "盔后",
  helmet_eyes: "眼部", helmet_jaw: "下颌", helmet_ears: "耳部", shoulder_l: "左肩", shoulder_r: "右肩", collar: "衣领",
};
const ZONE_RULES: [RegExp, string][] = [
  [/_side_left_high$/i, "左侧插板（高）"], [/_side_right_high$/i, "右侧插板（高）"], [/_side_left$/i, "左侧插板"], [/_side_right$/i, "右侧插板"],
  [/_chest$/i, "前胸插板"], [/_back$/i, "后背插板"],
];
const MATERIALS: Record<string, string> = { aramid: "芳纶", uhmwpe: "聚乙烯", combined: "复合材料", titan: "钛", titanium: "钛", aluminium: "铝", aluminum: "铝", armoredsteel: "装甲钢", steel: "钢", ceramic: "陶瓷", glass: "玻璃" };
const ARMOR_TYPES: Record<string, string> = { light: "轻型", heavy: "重型" };
const CALIBERS: Record<string, string> = {
  "1143x23acp": ".45 ACP", "9x18pm": "9x18mm", "9x18pmm": "9x18mm PMM", "9x18mmpmm": "9x18mm PMM", "9x19para": "9x19mm", "9x21": "9x21mm", "9x33r": ".357 Magnum",
  "7.62x25tt": "7.62x25mm", "46x30": "4.6x30mm", "57x28": "5.7x28mm", "5.45x39": "5.45x39mm", "5.56x45nato": "5.56x45mm", "58x42": "5.8x42mm", "68x51": "6.8x51mm",
  "7.62x35": ".300 Blackout", "7.62x39": "7.62x39mm", "7.62x51": "7.62x51mm", "7.62x54r": "7.62x54mm R", "784x49": ".308 Marlin Express", "9x39": "9x39mm",
  "93x64": "9.3x64mm", "366tkm": ".366 TKM", "127x33": ".50 AE", "127x55": "12.7x55mm", "127x99": ".50 BMG", "86x70": ".338 Lapua", "12g": "12/70", "20g": "20/70",
  "20x1mm": "20x1mm", "23x75": "23x75mm", "26x75": "26x75mm", "40x46": "40x46mm", "40mmru": "40mm RU", "127x108": "12.7x108mm", "30x29": "30x29mm", "725": "72.5mm",
};
const AMMO_KINDS: Record<string, string> = { bullet: "子弹", buckshot: "霰弹", grenade: "榴弹", flashbang: "闪光" };
const LOCK_TYPES: Record<string, string> = { door: "门", opening: "门", container: "容器", crate: "容器", drawer: "抽屉", trunk: "后备箱", vehicle: "后备箱", hatch: "舱口", gate: "大门", safe: "保险箱" };
const STEP_LABEL: Record<string, string> = {
  findItem: "找到", findQuestItem: "找到", giveItem: "上交", giveQuestItem: "上交", plantItem: "藏匿", plantQuestItem: "藏匿", mark: "标记", useItem: "使用",
  shoot: "击杀", visit: "到访", extract: "撤离", experience: "经验", skill: "技能", traderLevel: "商人等级", traderStanding: "商人声望", buildWeapon: "改装武器",
  sellItem: "出售", haveItem: "持有", start: "接取", finish: "完成", require: "需求", neededKeys: "钥匙", wearing: "穿戴", build: "建造",
};
const TRADER_IDS: Record<string, string> = {
  "54cb50c76803fa8b248b4571": "prapor", "54cb57776803fa99248b456e": "therapist", "579dc571d53a0658a154fbec": "fence", "58330581ace78e27b8b10cee": "skier",
  "5935c25fb3acc3127c3d8cd9": "peacekeeper", "5a7c2eca46aef81a7ca2145d": "mechanic", "5ac3b934156ae10c4430e83c": "ragman", "5c0647fdd443bc2504c2d371": "jaeger",
  "638f541a29ffd1183d187f57": "lightkeeper", "6617beeaa9cfa777ca915b7c": "ref", "656f0f98d80a697f855d34b1": "btr-driver",
};
const TRADER_NAMES: Record<string, string> = {
  prapor: "Prapor", therapist: "Therapist", fence: "Fence", skier: "Skier", peacekeeper: "Peacekeeper", mechanic: "Mechanic", ragman: "Ragman", jaeger: "Jaeger",
  lightkeeper: "Lightkeeper", ref: "Ref", "btr-driver": "BTR Driver",
};

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function rec(value: unknown): Bag | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Bag;
}

function rows(value: unknown): Bag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = rec(item);
    return row ? [row] : [];
  });
}

function str(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map((item) => str(item)).filter(Boolean) : [];
}

function clean(value: string) {
  const text = value.trim();
  return !text || /^[a-f0-9]{24}$/i.test(text) ? "" : text;
}

function field(row: Bag, ...keys: string[]) {
  for (const key of keys) {
    const text = str(row[key]);
    if (text) return text;
  }
  return "";
}

function lookup(map: Record<string, string>, value: string) {
  const text = value.trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  const underscored = lower.replace(/[\s-]+/g, "_");
  return map[text] || map[lower] || map[underscored] || map[underscored.replace(/_/g, "")] || "";
}

function zoneName(value: string) {
  const text = value.trim();
  if (!text) return "";
  if (/[\u3400-\u9fff]/.test(text)) return text;
  const stripped = text.replace(/^(collider\s*type|armor\s*zone|ebodypartcollidertype)[.\s:_-]*/i, "").trim();
  const ruled = ZONE_RULES.find(([pattern]) => pattern.test(stripped));
  return lookup(ZONES, stripped) || ruled?.[1] || lookup(ZONES, text) || stripped || text;
}

function zoneText(value: unknown) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of list) {
    const name = zoneName(str(item) || (rec(item) ? field(rec(item) || {}, "name", "id") : ""));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.join(" · ");
}

function named(value: unknown) {
  if (typeof value === "string") return clean(value);
  const row = rec(value);
  if (!row) return "";
  if (row.id && /^[a-f0-9]{24}$/i.test(str(row.id)) && !clean(str(row.name))) return "";
  return clean(str(row.name));
}

function joinNames(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value.map(named).filter(Boolean).join(" · ");
}

function weightText(value: number) {
  return `${Math.round(value * 1000) / 1000} kg`;
}

function penaltyText(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

function money(amount: number | null, currency = "RUB") {
  if (amount == null) return "—";
  const unit = currency.toUpperCase();
  const mark = unit === "USD" ? "$" : unit === "EUR" ? "€" : "₽";
  return `${Math.round(amount).toLocaleString("zh-CN")} ${mark}`;
}

function durationText(value: number | null) {
  if (value == null || value <= 0) return "即时";
  const total = Math.round(value);
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  const parts: string[] = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  if (second && !hour) parts.push(`${second} 秒`);
  return parts.join(" ") || "即时";
}

function caliberName(value: string) {
  const text = value.trim();
  if (!text) return "";
  const key = text.toLowerCase().replace(/\s+/g, "").replace(/^caliber/, "");
  const dotted = key.replace(/^(\d)(\d\dx)/, "$1.$2");
  return CALIBERS[key] || CALIBERS[dotted] || (/^caliber/i.test(text) ? key : text);
}

function materialName(value: unknown) {
  const text = typeof value === "string" ? value.trim() : field(rec(value) || {}, "name", "id");
  if (!text) return "";
  return /[\u3400-\u9fff]/.test(text) ? text : lookup(MATERIALS, text) || text;
}

function armorTypeName(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return /[\u3400-\u9fff]/.test(text) ? text : lookup(ARMOR_TYPES, text) || text;
}

function positive(value: unknown) {
  const amount = num(value);
  return amount != null && amount > 0 ? amount : null;
}

function itemOf(data: Bag) {
  return rec(data.item) || data;
}

function propsOf(data: Bag) {
  return rec(data.properties) || rec(itemOf(data).properties) || {};
}

function selfId(data: Bag) {
  return str(data.id) || str(itemOf(data).id);
}

export function gunReceiverId(data: Bag) {
  const item = itemOf(data);
  const props = propsOf(data);
  const types = strings(item.types);
  const base = rec(props.baseItem) || rec(item.baseItem);
  const id = str(base?.id);
  const self = selfId(data);
  if (!id || !self || id === self) return "";
  const baseTypes = strings(base?.types);
  if (types.includes("preset") && (types.includes("gun") || baseTypes.includes("gun"))) return id;
  return "";
}

function imageOf(item: Bag, id: string) {
  for (const key of ["image512pxLink", "inspectImageLink", "gridImageLink", "baseImageLink", "iconLink", "icon_link"]) {
    const link = str(item[key]);
    if (link) return link;
  }
  return /^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-512.webp` : "";
}

function asLink(value: unknown, badge = ""): Link | null {
  const row = rec(value);
  if (!row) return null;
  const id = str(row.id);
  const name = clean(str(row.name)) || clean(str(row.shortName)) || clean(str(row.short_name));
  if (!id || !name) return null;
  return { id, name, icon: str(row.iconLink || row.baseImageLink || row.icon_link), badge };
}

function propLinks(key: string, value: unknown, defaultAmmo: unknown) {
  if (key === "defaultPreset" || key === "baseItem") {
    const link = asLink(value);
    return link ? [link] : [];
  }
  if (key === "allowedAmmo" && Array.isArray(value)) {
    const links = value.flatMap((item) => {
      const link = asLink(item);
      return link ? [link] : [];
    });
    const ammo = asLink(defaultAmmo);
    if (ammo && !links.some((item) => item.id === ammo.id)) links.unshift(ammo);
    const marked = ammo ? links.map((item) => item.id === ammo.id ? { ...item, badge: "默认" } : item) : links;
    if (!marked.some((item) => item.badge)) return marked;
    return [...marked.filter((item) => item.badge), ...marked.filter((item) => !item.badge)];
  }
  if ((key === "presets" || key === "conflictingItems") && Array.isArray(value)) {
    return value.flatMap((item) => {
      const link = asLink(item);
      return link ? [link] : [];
    });
  }
  return [];
}

function gridVisual(value: unknown) {
  if (!Array.isArray(value)) return "";
  const pockets = value.flatMap((item) => {
    const row = rec(item);
    const width = Math.round(num(row?.width) || 0);
    const height = Math.round(num(row?.height) || 0);
    if (!row || width < 1 || height < 1 || width > 24 || height > 24) return [];
    return [{ width, height }];
  });
  if (!pockets.length) return "";
  const counts = new Map<string, number>();
  for (const pocket of pockets) {
    const key = `${pocket.width}×${pocket.height}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const caption = [...counts.entries()].map(([key, count]) => count > 1 ? `${key} ×${count}` : key).join(", ");
  const cells = pockets.map((pocket) => {
    const boxes = Array.from({ length: pocket.width * pocket.height }, () => "<i></i>").join("");
    return `<div class="item-pocket" style="grid-template-columns:repeat(${pocket.width},22px);grid-template-rows:repeat(${pocket.height},22px)" aria-label="${esc(`${pocket.width}×${pocket.height}`)}">${boxes}</div>`;
  }).join("");
  return `<div class="item-grids">${cells}</div>${caption ? `<span class="item-grid-caption">${esc(caption)}</span>` : ""}`;
}

function formatProp(key: string, value: unknown): string | null {
  if (value == null || value === "" || SKIP.has(key)) return null;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (key === "caliber" && typeof value === "string") return caliberName(value) || null;
  if (key === "ammoType" && typeof value === "string") return AMMO_KINDS[value.trim()] || value.trim() || null;
  if (key === "weight" && typeof value === "number") return weightText(value);
  if ((key === "speedPenalty" || key === "turnPenalty" || key === "ergoPenalty") && typeof value === "number") return penaltyText(value);
  if (key === "armorDamage" && typeof value === "number") return `${value}%`;
  if (key === "zones" || key === "headZones") return zoneText(value) || null;
  if (key === "material") return materialName(value) || null;
  if (key === "armorType") return armorTypeName(value) || null;
  if (key === "baseItem" || key === "defaultPreset") {
    const row = rec(value);
    if (row) return clean(str(row.name)) || clean(str(row.shortName)) || null;
    return typeof value === "string" ? clean(value) || null : null;
  }
  if (key === "categories" || key === "conflictingCategories" || key === "usedOnMaps" || key === "allowedAmmo" || key === "presets" || key === "conflictingItems") return joinNames(value) || null;
  if (key === "zoomLevels" && Array.isArray(value)) {
    const levels = new Set<string>();
    for (const group of value) {
      if (!Array.isArray(group)) continue;
      for (const level of group) if (Number.isFinite(Number(level))) levels.add(String(level));
    }
    return levels.size ? [...levels].join(", ") : null;
  }
  if (key === "bodyPartsHealth" && Array.isArray(value)) {
    const text = value.flatMap((item) => {
      const row = rec(item);
      const part = str(row?.bodyPart);
      if (!part) return [];
      return [row?.max == null ? part : `${part}: ${str(row?.max)}`];
    }).join(" · ");
    return text || null;
  }
  if (key === "stimEffects" && Array.isArray(value)) {
    const text = value.flatMap((item) => {
      const row = rec(item);
      const name = str(row?.skillName || row?.type);
      if (!name) return [];
      const amount = num(row?.value);
      const delta = amount != null && amount !== 0 ? `${amount > 0 ? "+" : ""}${amount}${row?.percent ? "%" : ""}` : "";
      const chance = num(row?.chance);
      const rate = chance != null && chance !== 1 ? ` ${Math.round(chance * 100)}%` : "";
      return [delta || rate ? `${name}: ${delta}${rate}` : name];
    }).join("；");
    return text || null;
  }
  if (key === "grids" && Array.isArray(value)) {
    const counts = new Map<string, number>();
    for (const item of value) {
      const row = rec(item);
      const width = num(row?.width);
      const height = num(row?.height);
      if (width == null || height == null) continue;
      const label = `${width}×${height}`;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const text = [...counts.entries()].map(([label, count]) => count > 1 ? `${label} ×${count}` : label).join(", ");
    return text || null;
  }
  if (Array.isArray(value)) {
    if (!value.length || value.some((item) => item && typeof item === "object")) return null;
    const text = value.map((item) => clean(str(item))).filter(Boolean).join(", ");
    return text || null;
  }
  if (typeof value === "object") return null;
  const text = clean(str(value)) || (typeof value === "number" ? String(value) : "");
  return text || null;
}

function mapLinks(value: unknown) {
  const links = rows(value).flatMap((row) => {
    const label = field(row, "name");
    const slug = field(row, "normalizedName", "slug", "id");
    if (!label) return [];
    if (!slug || /[\u4e00-\u9fff]/.test(slug)) return [esc(label)];
    return [`<a data-link href="/主菜单/逃离塔科夫/实时地图/${esc(slug)}">${esc(label)}</a>`];
  });
  return links.join(" · ");
}

function chipButton(link: Link) {
  const icon = link.icon ? `<img src="${esc(link.icon)}" alt="" />` : "";
  const title = link.badge ? `${link.badge} · ${link.name}` : link.name;
  return `<button type="button" class="item-chip${link.badge ? " is-mark" : ""}" data-wiki="item" data-wiki-id="${esc(link.id)}" title="${esc(title)}"><span class="item-chip-icon">${icon}</span><span class="item-chip-name">${esc(link.name)}</span>${link.badge ? `<span class="item-chip-badge">${esc(link.badge)}</span>` : ""}</button>`;
}

function propBag(data: Bag) {
  const item = itemOf(data);
  const props = propsOf(data);
  const types = strings(item.types);
  const width = num(item.width);
  const height = num(item.height);
  const cats = Array.isArray(item.handbookCategories) && item.handbookCategories.length ? item.handbookCategories : item.categories;
  const bag: Bag = {};
  for (const [key, value] of Object.entries(props)) {
    if (SKIP.has(key) || key === "baseItem") continue;
    bag[key] = value;
  }
  if (item.weight != null && item.weight !== "") bag.weight = item.weight;
  if (width != null && height != null) bag.size = `${width}×${height}`;
  if (Array.isArray(cats) && cats.length) bag.categories = cats;
  if (Array.isArray(item.conflictingItems)) bag.conflictingItems = item.conflictingItems;
  if (Array.isArray(item.conflictingCategories)) bag.conflictingCategories = item.conflictingCategories;
  if (!gunReceiverId(data)) {
    const base = props.baseItem ?? item.baseItem;
    if (base) bag.baseItem = base;
  }
  if (!types.includes("gun") && !types.includes("preset")) {
    delete bag.defaultPreset;
    delete bag.presets;
  }
  if (lockMaps(data).length) delete bag.usedOnMaps;
  else if (bag.usedOnMaps == null && item.usedOnMaps != null) bag.usedOnMaps = item.usedOnMaps;
  return bag;
}

function propRows(data: Bag) {
  const bag = propBag(data);
  const ammo = propsOf(data).defaultAmmo;
  const list: Prop[] = [];
  for (const key of Object.keys(LABELS)) {
    if (SKIP.has(key) || !(key in bag)) continue;
    const value = bag[key];
    if (key === "grids") {
      const visual = gridVisual(value);
      const text = formatProp(key, value);
      if (!visual && !text) continue;
      list.push({ label: LABELS[key], html: visual || esc(text || ""), large: true, note: "" });
      continue;
    }
    if (key === "usedOnMaps") {
      const html = mapLinks(value);
      if (!html) continue;
      list.push({ label: LABELS[key], html, large: html.length >= 40, note: "" });
      continue;
    }
    const links = propLinks(key, value, ammo);
    const text = formatProp(key, value);
    if (!links.length && !text) continue;
    const note = key === "allowedAmmo" && links.some((item) => item.badge) ? AMMO_NOTE : "";
    const large = links.filter((item) => item.id).length > 1 || (text || "").length >= 40 || links.length > 4 || !!note;
    const html = links.length ? `<div class="item-chips">${links.map(chipButton).join("")}</div>` : esc(text || "");
    list.push({ label: LABELS[key] || key, html, large, note });
  }
  return list;
}

function heroHtml(data: Bag) {
  const item = itemOf(data);
  const name = str(data.name) || str(item.name) || "物品";
  const short = str(data.short_name) || str(item.shortName) || str(item.short_name);
  const desc = str(data.description) || str(item.description);
  const wiki = str(item.wikiLink);
  const image = imageOf(item, selfId(data));
  return `<header class="item-hero"><div class="item-copy"><h1>${esc(name)}</h1>${short && short !== name ? `<cite class="item-short">${esc(short)}</cite>` : ""}${wiki ? `<a class="item-wiki" href="${esc(wiki)}" target="_blank" rel="noreferrer">Wiki</a>` : ""}${desc ? `<p class="item-desc">${esc(desc)}</p>` : ""}</div>${image ? `<div class="item-visual"><div class="item-photo"><img src="${esc(image)}" alt="${esc(name)}" /></div></div>` : ""}</header>`;
}

function embedHead(data: Bag) {
  const item = itemOf(data);
  const id = selfId(data);
  const name = str(data.name) || str(item.name) || "物品";
  const short = str(data.short_name) || str(item.shortName) || str(item.short_name);
  return `<div class="item-embed-head"><h3><button type="button" data-wiki="item" data-wiki-id="${esc(id)}">${esc(name)}</button></h3>${short && short !== name ? `<cite class="item-short">${esc(short)}</cite>` : ""}</div>`;
}

function lockMaps(data: Bag) {
  return rows(data.locks).filter((map) => field(map, "slug") && rows(map.locks).some((lock) => num(lock.x) != null && num(lock.z) != null));
}

function lockLabel(lock: Bag, index: number, all: Bag[]) {
  const raw = field(lock, "lock_type");
  const kind = LOCK_TYPES[raw.toLowerCase()] || raw || "锁";
  const same = all.filter((item) => field(item, "lock_type") === raw);
  const nth = same.indexOf(lock);
  const title = same.length > 1 ? `${kind} ${nth >= 0 ? nth + 1 : index + 1}` : kind;
  return lock.needs_power === true ? `${title} · 需供电` : title;
}

function locksHtml(data: Bag) {
  const maps = lockMaps(data);
  if (!maps.length) return "";
  const body = maps.map((map) => {
    const slug = field(map, "slug");
    const name = field(map, "name") || slug;
    const locks = rows(map.locks).filter((lock) => num(lock.x) != null && num(lock.z) != null);
    const points = locks.map((lock, index) => `<span class="item-point">${esc(lockLabel(lock, index, locks))}</span>`).join("");
    return `<div class="item-lock-map"><div class="item-lock-meta"><span>${esc(name)}</span><a data-link href="/主菜单/逃离塔科夫/实时地图/${esc(slug)}">打开${esc(name)}地图</a></div><div class="item-points">${points}</div></div>`;
  }).join("");
  return `<div class="item-locks"><div class="item-locks-head"><h3>能开的锁</h3></div>${body}</div>`;
}

function softArmor(props: Bag) {
  return rows(props.armorSlots).flatMap((row, index) => {
    const durability = num(row.durability);
    if (durability == null || durability <= 0) return [];
    return [{ key: String(index), zones: zoneText(row.zones) || zoneName(field(row, "name")) || "—", className: row.class == null || row.class === "" ? "—" : str(row.class), durability: String(durability) }];
  });
}

function softArmorHtml(props: Bag) {
  const slots = softArmor(props);
  if (!slots.length) return "";
  const body = slots.map((slot) => `<tr><td>${esc(slot.zones)}</td><td>${esc(slot.className)}</td><td>${esc(slot.durability)}</td></tr>`).join("");
  return `<h3 class="item-sub">软甲槽</h3><div class="item-scroll"><table class="item-table"><thead><tr><th>部位</th><th style="width:72px">等级</th><th style="width:80px">耐久</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function presetKind(name: string, forced: boolean) {
  if (forced) return "default";
  const text = name.trim().toLowerCase();
  if (!text) return "";
  if (/\bstripped\b/.test(text) || name.includes("剥离")) return "stripped";
  if (text.endsWith("默认") || text.includes(" default")) return "default";
  return "";
}

function plateMarks(props: Bag) {
  const seen = new Set<string>();
  const marks: { kind: string; name: string; ids: Set<string> }[] = [];
  const list = [props.defaultPreset, ...(Array.isArray(props.presets) ? props.presets : [])];
  for (const raw of list) {
    const row = rec(raw);
    if (!row) continue;
    const name = field(row, "name", "shortName");
    const kind = presetKind(name, row.default === true);
    if (!kind) continue;
    const key = `${kind}:${field(row, "id") || name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ids = new Set<string>();
    for (const part of rows(row.containsItems)) {
      const nested = rec(part.item) || part;
      const id = field(nested, "id");
      if (id) ids.add(id);
    }
    marks.push({ kind, name: kind === "default" ? "默认" : "Stripped", ids });
  }
  return marks;
}

function fleaAmount(row: Bag) {
  return positive(row.lastLowPrice ?? row.last_low_price) ?? positive(row.avg24hPrice ?? row.avg24h_price) ?? positive(row.basePrice ?? row.base_price);
}

function plateRows(props: Bag) {
  const marks = plateMarks(props);
  const list = rows(props.armorSlots).flatMap((slot, slotIndex) => rows(slot.allowedPlates).flatMap((plate, plateIndex) => {
    const id = field(plate, "id");
    const name = clean(field(plate, "name", "shortName"));
    if (!id || !name) return [];
    const badges = marks.filter((mark) => mark.ids.has(id)).map((mark) => mark.name).filter((name, index, all) => all.indexOf(name) === index);
    return [{
      key: `${slotIndex}-${plateIndex}-${id}`,
      id,
      name,
      icon: field(plate, "iconLink", "baseImageLink", "icon_link"),
      slot: zoneText(slot.zones) || zoneName(field(slot, "name")) || "插板槽",
      className: plate.class == null ? "—" : str(plate.class),
      material: materialName(plate.material) || "—",
      armorType: armorTypeName(plate.armorType) || "—",
      ergo: num(plate.ergoPenalty),
      speed: num(plate.speedPenalty),
      turn: num(plate.turnPenalty),
      durability: plate.durability == null ? "—" : str(plate.durability),
      weight: num(plate.weight),
      price: fleaAmount(plate),
      badges,
    }];
  }));
  return { list, marks };
}

function plateName(row: { id: string; name: string; icon: string; badges: string[] }) {
  const icon = row.icon ? `<img src="${esc(row.icon)}" alt="" />` : "<i></i>";
  const badges = row.badges.length ? `<span class="item-badges">${row.badges.map((badge) => `<span class="item-badge">${esc(badge)}</span>`).join("")}</span>` : "";
  return `<span class="item-loot"><span class="item-loot-icon">${icon}</span><span class="item-loot-body"><button type="button" data-wiki="item" data-wiki-id="${esc(row.id)}">${esc(row.name)}</button>${badges}</span></span>`;
}

function platesHtml(props: Bag) {
  const { list, marks } = plateRows(props);
  if (!list.length) return "";
  const kinds = marks.filter((mark, index, all) => all.findIndex((item) => item.kind === mark.kind) === index);
  const legend = kinds.length ? `<p class="item-legend">${kinds.map((mark) => `<span class="item-badge">${esc(mark.name)}</span>`).join("")}<span>${PLATE_NOTE}</span></p>` : "";
  const body = list.map((row) => `<tr><td>${plateName(row)}</td><td>${esc(row.slot)}</td><td>${esc(row.className)}</td><td>${esc(row.material)}</td><td>${esc(row.armorType)}</td><td>${row.ergo == null ? "—" : esc(penaltyText(row.ergo))}</td><td>${row.speed == null ? "—" : esc(penaltyText(row.speed))}</td><td>${row.turn == null ? "—" : esc(penaltyText(row.turn))}</td><td>${esc(row.durability)}</td><td>${row.weight == null ? "—" : esc(weightText(row.weight))}</td><td>${esc(money(row.price))}</td></tr>`).join("");
  return `<div class="item-plates"><div class="item-plates-head"><h3>兼容护甲板</h3>${legend}</div><div class="item-scroll"><table class="item-table"><thead><tr><th>名称</th><th>槽位</th><th>等级</th><th>材质</th><th>护甲类型</th><th>人机惩罚</th><th>移速惩罚</th><th>转向惩罚</th><th>耐久</th><th>重量</th><th>价格</th></tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function lootOf(row: Bag): Loot | null {
  const id = field(row, "id");
  const name = clean(field(row, "name", "short_name", "shortName"));
  if (!id || !name) return null;
  return {
    id,
    name,
    icon: field(row, "icon_link", "iconLink", "baseImageLink"),
    count: num(row.count),
    money: strings(row.types).includes("money"),
    fir: row.found_in_raid === true || row.foundInRaid === true,
  };
}

function qtyText(item: Loot) {
  const value = item.count == null ? 1 : item.count;
  if (item.money) return Math.round(value).toLocaleString("zh-CN");
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function lootCell(item: Loot, self: string, always: boolean) {
  const qty = qtyText(item);
  const label = always || qty !== "1" ? `${qty}× ${item.name}` : item.name;
  const icon = item.icon ? `<img src="${esc(item.icon)}" alt="" />` : "<i></i>";
  return `<span class="item-loot${item.id === self ? " is-self" : ""}"><span class="item-loot-icon">${icon}</span><span class="item-loot-body"><button type="button" data-wiki="item" data-wiki-id="${esc(item.id)}">${esc(label)}</button>${item.fir ? `<span class="item-fir">战局内找到</span>` : ""}</span></span>`;
}

function lootStack(items: Bag[], self: string, always: boolean) {
  const loot = items.flatMap((row) => {
    const item = lootOf(row);
    return item ? [item] : [];
  });
  if (!loot.length) return "—";
  return `<div class="item-stack">${loot.map((item) => lootCell(item, self, always)).join("")}</div>`;
}

function chipGrid(items: Loot[]) {
  if (!items.length) return "";
  return `<div class="item-chips">${items.map((item) => {
    const qty = qtyText(item);
    const name = qty !== "1" ? `${qty}× ${item.name}` : item.name;
    const icon = item.icon ? `<img src="${esc(item.icon)}" alt="" />` : "";
    return `<button type="button" class="item-chip" data-wiki="item" data-wiki-id="${esc(item.id)}" title="${esc(name)}"><span class="item-chip-icon">${icon}</span><span class="item-chip-name">${esc(name)}</span></button>`;
  }).join("")}</div>`;
}

function contained(item: Bag) {
  return rows(item.containsItems || item.contains_items).flatMap((row) => {
    const nested = rec(row.item) || row;
    const loot = lootOf({ ...nested, count: row.count ?? nested.count });
    return loot ? [loot] : [];
  });
}

function contentLines(props: Bag) {
  if (!Array.isArray(props.content)) return [];
  return props.content.map((item) => str(item)).filter((line) => line && !/^[a-f0-9]{24}$/i.test(line) && !line.includes("_Note_Page"));
}

function attrsHtml(data: Bag, mode: Mode) {
  const item = itemOf(data);
  const props = propsOf(data);
  const propsHtml = propRows(data).map((row) => `<div class="item-prop${row.large ? " is-large" : ""}"><span class="item-prop-key">${esc(row.label)}</span><div class="item-prop-value">${row.html}${row.note ? `<span class="item-prop-note">${esc(row.note)}</span>` : ""}</div></div>`).join("");
  const inside = contained(item);
  const lines = contentLines(props);
  const extra = [
    locksHtml(data),
    softArmorHtml(props),
    platesHtml(props),
    inside.length ? `<h3 class="item-sub">内含物品</h3>${chipGrid(inside)}` : "",
    lines.length ? `<h3 class="item-sub">内容</h3><div class="item-content">${lines.map((line) => `<p>${esc(line)}</p>`).join("")}</div>` : "",
  ].join("");
  if (!propsHtml && !extra) return mode === "embed" ? `<div class="item-empty">暂无属性</div>` : "";
  return `<section class="item-attrs">${mode === "embed" ? "" : `<h2>属性</h2>`}${propsHtml ? `<div class="item-props">${propsHtml}</div>` : ""}${extra}</section>`;
}

function traderSlug(raw: string) {
  const text = raw.trim();
  if (!text) return "";
  return /^[a-f0-9]{24}$/i.test(text) ? TRADER_IDS[text.toLowerCase()] || "" : text.toLowerCase();
}

function traderName(slug: string, fallback: string) {
  return TRADER_NAMES[slug] || clean(fallback) || slug;
}

function traderPortrait(slug: string) {
  return slug ? `https://tarkov.dev/images/traders/${encodeURIComponent(slug)}-portrait.png` : "";
}

function loyalty(row: Bag) {
  for (const req of rows(row.requirements)) {
    if (field(req, "type") !== "loyaltyLevel") continue;
    const level = num(req.value);
    if (level != null) return level;
  }
  return null;
}

function parseOffer(row: Bag): Offer | null {
  const vendorRaw = row.vendor ?? row.trader;
  let slug = "";
  let fallback = "";
  let level = num(row.minTraderLevel ?? row.min_trader_level);
  if (vendorRaw && typeof vendorRaw === "object") {
    const vendor = rec(vendorRaw);
    const id = field(vendor || {}, "id", "_id");
    const normalized = field(vendor || {}, "normalizedName", "name");
    slug = traderSlug(id) || traderSlug(normalized);
    fallback = normalized;
    level = level ?? num(vendor?.minTraderLevel ?? vendor?.min_trader_level);
  } else if (typeof vendorRaw === "string") {
    slug = traderSlug(vendorRaw);
    fallback = vendorRaw;
  }
  level = level ?? loyalty(row);
  const name = traderName(slug, fallback);
  if (!slug && !name) return null;
  return {
    vendor: slug || name,
    name: name || slug,
    price: num(row.price),
    currency: field(row, "currency") || "RUB",
    priceRub: num(row.priceRUB ?? row.priceRub ?? row.price),
    minLevel: level,
  };
}

function offersOf(item: Bag, keys: string[]) {
  const seen = new Set<string>();
  const offers: Offer[] = [];
  for (const key of keys) {
    for (const row of rows(item[key])) {
      const offer = parseOffer(row);
      if (!offer) continue;
      const id = offer.vendor || offer.name;
      if (seen.has(id)) continue;
      seen.add(id);
      offers.push(offer);
    }
  }
  return offers;
}

function fleaKey(value: string) {
  const key = value.trim().toLowerCase().replace(/\s+/g, "-");
  return key === "flea-market" || key === "fleamarket" || key === "flea";
}

function splitOffers(offers: Offer[]) {
  const flea: Offer[] = [];
  const traders: Offer[] = [];
  for (const offer of offers) {
    if (fleaKey(offer.vendor) || fleaKey(offer.name)) flea.push(offer);
    else if (offer.vendor && offer.vendor !== "—") traders.push(offer);
  }
  return { flea, traders };
}

function offerPrice(offer: Offer) {
  if (offer.currency && offer.currency !== "RUB" && offer.price != null) {
    const mark = offer.currency === "USD" ? "$" : offer.currency === "EUR" ? "€" : "";
    return `${mark}${offer.price.toLocaleString("zh-CN")}`;
  }
  return money(offer.priceRub ?? offer.price);
}

function offerHtml(offer: Offer, best: Offer | null) {
  const flea = fleaKey(offer.vendor) || fleaKey(offer.name);
  const bestOn = !!best && offer.vendor === best.vendor && offer.priceRub === best.priceRub;
  const icon = flea ? `<span class="item-offer-flea">跳蚤</span>` : `<img src="${esc(traderPortrait(offer.vendor))}" alt="" onerror="this.remove()" />`;
  const level = !flea && offer.minLevel ? `<span class="item-offer-level">${offer.minLevel}</span>` : "";
  const inner = `<span class="item-offer-icon">${icon}${level}</span><span class="item-offer-name">${esc(offer.name)}</span><span class="item-offer-price">${esc(offerPrice(offer))}</span>`;
  const cls = `item-offer${bestOn ? " is-best" : ""}`;
  if (!flea && offer.vendor) return `<button type="button" class="${cls}" data-wiki="trader" data-wiki-id="${esc(offer.vendor)}" title="${esc(offer.name)}">${inner}</button>`;
  return `<span class="${cls}" title="${esc(offer.name)}">${inner}</span>`;
}

function fleaHtml(item: Bag, fallback: Offer[]) {
  if (strings(item.types).includes("noFlea")) return "";
  let last = positive(item.lastLowPrice ?? item.last_low_price);
  let avg = positive(item.avg24hPrice ?? item.avg24h_price);
  if (last == null && avg == null) last = positive(fallback[0]?.priceRub ?? fallback[0]?.price);
  if (last == null && avg == null) return "";
  const change = num(item.changeLast48h ?? item.change_last_48h);
  const percent = num(item.changeLast48hPercent ?? item.change_last_48h_percent);
  const tone = change == null ? "" : change > 0 ? " is-up" : change < 0 ? " is-down" : "";
  const changeText = change == null ? "" : `${change > 0 ? "+" : ""}${Math.round(change).toLocaleString("zh-CN")} ₽${percent != null ? ` · ${Number.isInteger(percent) ? percent.toLocaleString("zh-CN") : String(Math.round(percent * 100) / 100)}%` : ""}`;
  return `<div class="item-flea">${last == null ? "" : `<div class="item-flea-stat"><span>最近低价</span><strong>${esc(money(last))}</strong></div>`}${avg == null ? "" : `<div class="item-flea-stat"><span>24h 均价</span><strong>${esc(money(avg))}</strong></div>`}${changeText ? `<div class="item-flea-stat"><span>较昨日</span><strong class="item-flea-value${tone}">${esc(changeText)}</strong></div>` : ""}</div>`;
}

function block(title: string, inner: string, count: number | null = null, extra = "", clipRows = false) {
  if (!inner) return "";
  const clip = clipRows && count != null && count > 8;
  const tools = `${extra}${clip ? `<button type="button" class="item-expand" data-item-expand="${count}">显示全部 ${count}</button>` : ""}`;
  return `<div class="item-block"${clip ? " data-item-clip" : ""}><div class="item-block-head"><h3>${esc(title)}${count != null ? `<span class="item-count">${count}</span>` : ""}</h3>${tools ? `<div class="item-block-extra">${tools}</div>` : ""}</div>${inner}</div>`;
}

function table(cols: { label: string; width?: string }[], body: string) {
  const head = cols.map((col) => `<th${col.width ? ` style="width:${col.width}"` : ""}>${esc(col.label)}</th>`).join("");
  return `<div class="item-scroll"><table class="item-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function sideItems(row: Bag, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value) && value.length) return rows(value);
    const one = rec(value);
    if (one && (one.id || one.name)) return [one];
  }
  return [];
}

function traderCell(slug: string, name: string, level: string) {
  const label = traderName(traderSlug(slug) || slug, name);
  const id = traderSlug(slug) || slug;
  const img = id ? `<img src="${esc(traderPortrait(id))}" alt="" onerror="this.remove()" />` : "";
  const text = `${esc(label || "—")}${level ? `<span class="item-level">${esc(level)}</span>` : ""}`;
  const body = `${img}<span>${text}</span>`;
  if (!id) return `<span class="item-trader">${body}</span>`;
  return `<button type="button" class="item-trader" data-wiki="trader" data-wiki-id="${esc(id)}">${body}</button>`;
}

function sourceCell(row: Bag) {
  const id = field(row, "task_unlock", "taskUnlock");
  const name = field(row, "task_unlock_name", "taskUnlockName");
  const label = id ? name || "任务解锁" : "默认";
  if (!id) return `<span class="item-muted">${esc(label)}</span>`;
  return `<button type="button" class="item-source" data-wiki="task" data-wiki-id="${esc(id)}">${esc(label)}</button>`;
}

function stationCell(row: Bag) {
  const slug = field(row, "station_slug", "stationSlug");
  const name = field(row, "station_name", "stationName") || slug;
  const level = field(row, "level");
  const levelText = level ? `<span class="item-level"> Lv.${esc(level)}</span>` : "";
  if (!slug) return `${esc(name)}${levelText}`;
  return `<a class="item-station" data-link href="/主菜单/逃离塔科夫/藏身处/${esc(slug)}">${esc(name)}</a>${levelText}`;
}

function stepsOf(row: Bag) {
  const steps = rows(row.steps);
  if (steps.length) return steps;
  if (field(row, "kind", "type") || num(row.count) != null) return [{ type: field(row, "kind", "type"), count: row.count, found_in_raid: row.found_in_raid, text: "" }];
  return [];
}

function stepHtml(step: Bag) {
  const text = field(step, "text", "description") || STEP_LABEL[field(step, "type")] || "相关";
  const count = num(step.count);
  const qty = count != null && count > 0 ? `×${Number.isInteger(count) ? count : String(Math.round(count * 100) / 100)}` : "";
  const fir = step.found_in_raid === true || step.foundInRaid === true;
  return `<div class="item-step"><span>${esc(text)}</span>${qty ? `<em>${esc(qty)}</em>` : ""}${fir ? `<i class="item-fir">战局内</i>` : ""}</div>`;
}

function barterTable(list: Bag[], self: string) {
  const body = list.map((row) => `<tr><td>${traderCell(field(row, "trader_slug", "traderSlug"), field(row, "trader_name", "traderName"), field(row, "min_trader_level", "minTraderLevel") ? ` LL${field(row, "min_trader_level", "minTraderLevel")}` : "")}</td><td>${sourceCell(row)}</td><td>${lootStack(sideItems(row, ["required_items", "requiredItems"]), self, true)}</td><td>${lootStack(sideItems(row, ["offered_item", "offeredItem", "reward_items"]), self, true)}</td></tr>`).join("");
  return table([{ label: "商人", width: "18%" }, { label: "配方来源", width: "14%" }, { label: "消耗物品", width: "40%" }, { label: "获得物品", width: "28%" }], body);
}

function craftTable(list: Bag[], self: string) {
  const body = list.map((row) => `<tr><td>${stationCell(row)}</td><td>${sourceCell(row)}</td><td>${lootStack(sideItems(row, ["required_items", "requiredItems"]), self, true)}</td><td>${lootStack(sideItems(row, ["product_item", "productItem"]), self, true)}</td><td>${esc(durationText(num(row.duration)))}</td></tr>`).join("");
  return table([{ label: "模块", width: "16%" }, { label: "配方来源", width: "14%" }, { label: "材料", width: "38%" }, { label: "产品", width: "22%" }, { label: "时长", width: "10%" }], body);
}

function questTable(list: Bag[]) {
  const body = list.map((row) => {
    const id = field(row, "id");
    const name = field(row, "name") || id;
    const steps = stepsOf(row);
    return `<tr><td>${traderCell(field(row, "trader_slug", "traderSlug"), field(row, "trader_name", "traderName"), "")}</td><td>${id ? `<button type="button" class="item-task" data-wiki="task" data-wiki-id="${esc(id)}">${esc(name)}</button>` : esc(name)}</td><td>${steps.length ? `<div class="item-steps">${steps.map(stepHtml).join("")}</div>` : "—"}</td></tr>`;
  }).join("");
  return table([{ label: "商人", width: "180px" }, { label: "任务", width: "180px" }, { label: "相关步骤" }], body);
}

function startsBoss(id: string) {
  return id.trim().toLowerCase().startsWith("boss");
}

function dropBucket(id: string, parents: string[]) {
  const key = id.trim();
  const parent = parents.find((item) => startsBoss(item)) || "";
  const boss = startsBoss(key) && !parent;
  const crew = !!parent && key !== parent && (key.toLowerCase().startsWith("follower") || startsBoss(key));
  return !key || boss || crew ? "boss" : "other";
}

function dropCard(row: Bag) {
  const slug = field(row, "slug");
  const name = field(row, "name") || slug || field(row, "id");
  const maps = field(row, "maps_label", "mapsLabel");
  const portrait = field(row, "portrait_link", "image_link", "icon_link");
  const icon = portrait ? `<img src="${esc(portrait)}" alt="" />` : `<span>${esc((name || "?").slice(0, 1))}</span>`;
  const inner = `<span class="item-drop-icon">${icon}</span><span class="item-drop-name">${esc(name)}</span>${maps ? `<span class="item-drop-maps">${esc(maps)}</span>` : ""}`;
  if (!slug) return `<span class="item-drop">${inner}</span>`;
  return `<button type="button" class="item-drop" data-wiki="boss" data-wiki-id="${esc(slug)}" title="${esc(name)}">${inner}</button>`;
}

function dropGroup(title: string, list: Bag[]) {
  if (!list.length) return "";
  const clip = list.length > 8 ? ` data-item-clip` : "";
  const button = list.length > 8 ? `<button type="button" class="item-expand" data-item-expand="${list.length}">显示全部 ${list.length}</button>` : "";
  return `<div class="item-drop-group"${clip}><h4>${esc(title)}<span class="item-count">${list.length}</span>${button}</h4><div class="item-drops">${list.map(dropCard).join("")}</div></div>`;
}

function relationsHtml(data: Bag) {
  const item = itemOf(data);
  const self = selfId(data);
  const sources = rec(data.sources) || {};
  const uses = rec(data.uses) || {};
  const buys = splitOffers(offersOf(item, ["buyFor", "buy_for", "buyFromTrader", "buy_from_trader"]));
  const sells = splitOffers(offersOf(item, ["sellFor", "sell_for", "sellToTrader", "sell_to_trader"]));
  const flea = fleaHtml(item, [...buys.flea, ...sells.flea]);
  const best = sells.traders.reduce<Offer | null>((picked, offer) => {
    const price = offer.priceRub ?? offer.price ?? -1;
    const prev = picked ? picked.priceRub ?? picked.price ?? -1 : -1;
    return price > prev ? offer : picked;
  }, null);
  const barterIn = rows(sources.barters).length ? rows(sources.barters) : rows(data.barters);
  const barterOut = rows(uses.barters);
  const craftIn = rows(sources.crafts).length ? rows(sources.crafts) : rows(data.crafts);
  const craftOut = rows(uses.crafts);
  const rewards = rows(sources.quest_rewards);
  const needs = rows(uses.tasks).length ? rows(uses.tasks) : rows(data.tasks || item.tasks);
  const hideout = rows(uses.hideout).length ? rows(uses.hideout) : rows(data.hideout);
  const drops = rows(sources.drops).length ? rows(sources.drops) : rows(data.drops);
  const trade = [
    flea ? block("跳蚤市场", flea) : "",
    buys.traders.length ? block("从商人购买", `<div class="item-offers">${buys.traders.map((offer) => offerHtml(offer, null)).join("")}</div>`, buys.traders.length) : "",
    sells.traders.length ? block("出售给商人", `<div class="item-offers">${sells.traders.map((offer) => offerHtml(offer, best)).join("")}</div>`, sells.traders.length) : "",
    barterIn.length ? block("换到此物", barterTable(barterIn, self), barterIn.length, "", true) : "",
    barterOut.length ? block("用此物换", barterTable(barterOut, self), barterOut.length, "", true) : "",
  ].join("");
  const quests = [
    rewards.length ? block("任务奖励", questTable(rewards), rewards.length, "", true) : "",
    needs.length ? block("任务需求", questTable(needs), needs.length, "", true) : "",
  ].join("");
  const crafts = [
    craftIn.length ? block("作为产品", craftTable(craftIn, self), craftIn.length, "", true) : "",
    craftOut.length ? block("作为材料", craftTable(craftOut, self), craftOut.length, "", true) : "",
  ].join("");
  const hideoutRows = hideout.map((row) => {
    const slug = field(row, "station_slug", "stationSlug");
    const name = `${field(row, "station_name", "stationName") || slug} Lv.${field(row, "level")}`;
    const count = num(row.count) ?? 1;
    const fir = row.found_in_raid === true;
    const inner = `<span class="item-kind">建造</span><span class="item-quest-name">${esc(name)}</span><span class="item-quest-meta">${count > 1 ? `<em>×${esc(String(count))}</em>` : ""}${fir ? `<i class="item-fir">战局内</i>` : ""}</span>`;
    return slug ? `<a class="item-quest" data-link href="/主菜单/逃离塔科夫/藏身处/${esc(slug)}">${inner}</a>` : `<span class="item-quest">${inner}</span>`;
  }).join("");
  const hideoutBlock = hideoutRows ? block("建造", `<div class="item-quests">${hideoutRows}</div>`, hideout.length, `<a class="item-more" data-link href="/主菜单/逃离塔科夫/藏身处">藏身处</a>`, true) : "";
  const grouped = { boss: [] as Bag[], other: [] as Bag[] };
  for (const row of drops) {
    const parents = Array.isArray(row.parent_ids) ? row.parent_ids.map((item) => str(item)) : strings(row.parent_ids);
    grouped[dropBucket(field(row, "id"), parents)].push(row);
  }
  const dropBody = `${dropGroup("Boss", grouped.boss)}${dropGroup("非 Boss", grouped.other)}`;
  return [
    trade ? `<section class="item-rel"><h2>交易</h2>${trade}</section>` : "",
    quests ? `<section class="item-rel"><h2>任务</h2>${quests}</section>` : "",
    crafts ? `<section class="item-rel"><h2>制作</h2>${crafts}</section>` : "",
    hideoutBlock ? `<section class="item-rel"><h2>藏身处</h2>${hideoutBlock}</section>` : "",
    dropBody ? `<section class="item-rel"><h2>掉落</h2><div class="item-block">${dropBody}</div></section>` : "",
  ].join("");
}

function itemBody(data: Bag, mode: Mode) {
  return `${mode === "embed" ? embedHead(data) : heroHtml(data)}${attrsHtml(data, mode)}${mode === "full" ? relationsHtml(data) : ""}`;
}

function receiverWrap(inner: string) {
  return `<section class="item-rel item-receiver"><h2>机匣</h2><p class="item-receiver-note">口径、可用弹药和射击数据属于机匣，本配置及其他预设共用。</p><div class="item-embed">${inner}</div></section>`;
}

export function renderItem(data: Bag, receiver: Bag | null = null) {
  const extra = receiver ? receiverWrap(itemBody(receiver, "embed")) : "";
  return `<div class="item-page">${itemBody(data, "full")}${extra}</div>`;
}

export function bindItemDetail(host: HTMLElement) {
  host.querySelectorAll<HTMLButtonElement>("[data-item-expand]").forEach((button) => {
    button.addEventListener("click", () => {
      const block = button.closest<HTMLElement>("[data-item-clip]");
      if (!block) return;
      const open = block.classList.toggle("is-open");
      const total = button.dataset.itemExpand || "";
      button.textContent = open ? "收起" : `显示全部 ${total}`;
    });
  });
}

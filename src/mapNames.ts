const GROUPS = [
  ["streets", "streets-of-tarkov", "tarkovstreets", "city"],
  ["lab", "the-lab", "laboratory", "labs"],
  ["labyrinth", "the-labyrinth"],
  ["night-factory", "factory-night", "factory4-night"],
  ["factory", "factory-day", "factory4-day"],
  ["ground-zero", "ground-zero-21", "ground-zero-tutorial", "sandbox", "sandbox-high", "groundzero"],
  ["customs", "bigmap"],
  ["reserve", "rezerv-base", "rezervbase"],
  ["woods", "forest"],
  ["interchange", "shopping-mall", "mall"],
  ["lighthouse"],
  ["shoreline"],
  ["terminal"],
  ["icebreaker", "suburbs"],
];

const LABEL: Record<string, string> = {
  streets: "塔科夫街区",
  lab: "实验室",
  labyrinth: "迷宫",
  "night-factory": "夜间工厂",
  factory: "工厂",
  "ground-zero": "中心区",
  customs: "海关",
  reserve: "储备站",
  woods: "森林",
  interchange: "立交桥",
  lighthouse: "灯塔",
  shoreline: "海岸线",
  terminal: "码头",
  icebreaker: "破冰船",
};

export function mapKey(value: string) {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function groupOf(key: string) {
  return GROUPS.find((group) => group.includes(key));
}

export function sameMap(left: string, right: string) {
  const a = mapKey(left);
  const b = mapKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const group = groupOf(a);
  return Boolean(group?.includes(b));
}

export function mapLabel(value: string) {
  const key = mapKey(value);
  if (!key) return "";
  if (LABEL[key]) return LABEL[key];
  const group = groupOf(key);
  if (!group) return "";
  for (const item of group) {
    if (LABEL[item]) return LABEL[item];
  }
  return "";
}

export function mapTitle(slug: string, name = "", empty = "") {
  const text = name.trim();
  if (text && /[\u4e00-\u9fff]/.test(text)) return text;
  return mapLabel(slug) || mapLabel(text) || text || slug.trim() || empty;
}

export function mapPhrase(value: string, empty = "") {
  const text = value.trim();
  if (!text) return empty;
  if (/[\u4e00-\u9fff]/.test(text)) return text;
  const parts = text.split(/[、,，/|;]+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const titled = parts.map((part) => mapTitle(part, "", "")).filter(Boolean);
    return titled.join("、") || text;
  }
  return mapTitle(text, "", empty);
}

export function findMap<T extends { slug: string }>(slug: string, options: T[]) {
  const key = mapKey(slug);
  return options.find((item) => mapKey(item.slug) === key) || options.find((item) => sameMap(item.slug, slug));
}

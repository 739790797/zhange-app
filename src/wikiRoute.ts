export type WikiKind = "item" | "task" | "trader" | "boss";

export type WikiHit = {
  name: string;
  extra: string;
  mapSlug: string;
  kind: "" | WikiKind;
  id: string;
  icon: string;
};

export type WikiSpec = { kind: WikiKind; id: string; crumb: string };

const BASE = "/主菜单/逃离塔科夫";
const HEADS: { head: string; kind: WikiKind; crumb: string }[] = [
  { head: "物品", kind: "item", crumb: "物品" },
  { head: "任务", kind: "task", crumb: "任务" },
  { head: "商人", kind: "trader", crumb: "商人" },
  { head: "Boss", kind: "boss", crumb: "Boss" },
];

export function wikiHref(kind: string, id: string) {
  const head = HEADS.find((item) => item.kind === kind);
  if (!head || !id) return "";
  return `${BASE}/${head.head}/${encodeURIComponent(id)}`;
}

export function matchWiki(path: string): WikiSpec | null {
  const prefix = `${BASE}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const head = rest.slice(0, slash);
  const id = rest.slice(slash + 1).trim();
  const spec = HEADS.find((item) => item.head === head);
  if (!spec || !id || id.includes("/")) return null;
  return { kind: spec.kind, id, crumb: spec.crumb };
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function field(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim())
      return String(value).trim();
  }
  return "";
}

export function readWikiHits(value: unknown, kind: WikiKind): WikiHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = record(raw);
    if (!item) return [];
    const name = field(item, "name");
    const id =
      kind === "trader" || kind === "boss" ? field(item, "slug", "id") : field(item, "id", "slug");
    if (!name || !id) return [];
    return [
      {
        name,
        extra: field(item, "extra"),
        mapSlug: "",
        kind,
        id,
        icon: field(item, "icon_link", "iconLink"),
      },
    ];
  });
}

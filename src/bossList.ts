type BossMap = { slug: string; name: string; chance: string; heat: number };
type BossZone = { mapSlug: string; name: string; chance: string };
type Boss = { slug: string; name: string; image: string; maps: BossMap[]; zones: BossZone[] };

let seq = 0;
let bosses: Boss[] = [];
let pickedBoss = "";
let pickedMap = "";

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

function chanceOf(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value.replace("%", ""));
    return { text: value.trim(), heat: Number.isFinite(numeric) ? numeric : 0 };
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return { text: "", heat: 0 };
  const percent = amount <= 1 ? amount * 100 : amount;
  return { text: `${Math.round(percent)}%`, heat: percent };
}

function readBoss(row: Record<string, unknown>): Boss | null {
  const slug = str(row.slug || row.id);
  const name = str(row.name) || slug;
  if (!slug || !name) return null;
  const maps = (Array.isArray(row.maps) ? row.maps : []).flatMap((item) => {
    const map = rec(item);
    if (!map) return [];
    const mapSlug = str(map.slug || map.map_slug);
    const mapName = str(map.name) || mapSlug;
    if (!mapSlug && !mapName) return [];
    const chance = chanceOf(map.spawn_chance ?? map.spawnChance);
    return [{ slug: mapSlug || mapName, name: mapName, chance: chance.text, heat: chance.heat }];
  });
  const zones = (Array.isArray(row.spawn_locations) ? row.spawn_locations : []).flatMap((item) => {
    const zone = rec(item);
    if (!zone) return [];
    const mapSlug = str(zone.map_slug || zone.mapSlug || zone.map);
    const zoneName = str(zone.name);
    if (!zoneName) return [];
    return [{ mapSlug, name: zoneName, chance: chanceOf(zone.chance).text }];
  });
  return {
    slug,
    name,
    image: str(row.portrait_link || row.image_link || row.icon_link),
    maps,
    zones,
  };
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

export function bossShell() {
  return `<section class="boss-list" id="boss-list"><p class="wiki-note">正在读取 Boss…</p></section>`;
}

function mapColumns() {
  const seen = new Map<string, string>();
  for (const boss of bosses) {
    for (const map of boss.maps) {
      if (!seen.has(map.slug)) seen.set(map.slug, map.name);
    }
  }
  return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
}

function render() {
  const columns = mapColumns();
  const head = columns.map((map) => `<th>${esc(map.name)}</th>`).join("");
  const body = bosses.map((boss) => {
    const byMap = new Map(boss.maps.map((map) => [map.slug, map]));
    const cells = columns.map((column) => {
      const hit = byMap.get(column.slug);
      if (!hit?.chance && !boss.zones.some((zone) => zone.mapSlug === column.slug)) return `<td class="boss-empty">—</td>`;
      const on = pickedBoss === boss.slug && pickedMap === column.slug;
      const heat = Math.max(0.15, Math.min(1, (hit?.heat || 0) / 100));
      return `<td><button type="button" class="boss-rate${on ? " on" : ""}" style="--heat:${heat}" data-boss-cell="${esc(boss.slug)}" data-boss-map="${esc(column.slug)}">${esc(hit?.chance || "有点位")}</button></td>`;
    }).join("");
    const image = boss.image ? `<img src="${esc(boss.image)}" alt="" />` : "";
    return `<tr><th><button type="button" class="boss-name" data-wiki="boss" data-wiki-id="${esc(boss.slug)}">${image}${esc(boss.name)}</button></th>${cells}</tr>`;
  }).join("");
  const boss = bosses.find((item) => item.slug === pickedBoss);
  const zones = boss?.zones.filter((zone) => !pickedMap || zone.mapSlug === pickedMap || zone.mapSlug === columns.find((map) => map.slug === pickedMap)?.name) || [];
  const mapName = columns.find((map) => map.slug === pickedMap)?.name || pickedMap;
  const panel = boss && pickedMap ? `<aside class="boss-zones"><h2>${esc(boss.name)} · ${esc(mapName)}</h2>${zones.length ? `<ul>${zones.map((zone) => `<li>${esc(zone.name)}${zone.chance ? ` · ${esc(zone.chance)}` : ""}</li>`).join("")}</ul>` : `<p>这份数据没有列出区域名，仍可打开地图看 Boss 点。</p>`}<button type="button" data-map="${esc(pickedMap)}">打开这张地图</button></aside>` : "";
  return `
    <p class="wiki-note">格子是各地图的出生率。点格子看刷新区域，点名字打开档案。</p>
    <div class="boss-board">
      <div class="boss-scroll"><table class="boss-table"><thead><tr><th>名称</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      ${panel}
    </div>`;
}

function paint() {
  const host = document.querySelector<HTMLElement>("#boss-list");
  if (!host) return;
  host.innerHTML = bosses.length ? render() : `<p class="wiki-note">没有读到 Boss</p>`;
  host.querySelectorAll<HTMLButtonElement>("[data-boss-cell]").forEach((button) => {
    button.addEventListener("click", () => {
      pickedBoss = button.dataset.bossCell || "";
      pickedMap = button.dataset.bossMap || "";
      paint();
    });
  });
}

export async function mountBosses() {
  const token = ++seq;
  const host = document.querySelector<HTMLElement>("#boss-list");
  if (!host) return;
  host.innerHTML = `<p class="wiki-note">正在读取 Boss…</p>`;
  try {
    const data = await invoke<{ items?: Record<string, unknown>[] }>("site_get", { path: "/guides/tarkov/bosses" });
    if (token !== seq || !document.querySelector("#boss-list")) return;
    bosses = (data.items || []).flatMap((item) => {
      const row = rec(item);
      const boss = row ? readBoss(row) : null;
      return boss ? [boss] : [];
    });
    if (!bosses.some((boss) => boss.slug === pickedBoss)) {
      pickedBoss = "";
      pickedMap = "";
    }
    paint();
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#boss-list");
    if (!live) return;
    const message = error instanceof Error ? error.message : "Boss 读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

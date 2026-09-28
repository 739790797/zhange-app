type Ammo = {
  id: string;
  name: string;
  short: string;
  caliber: string;
  type: string;
  tracer: string;
  damage: number;
  penetration: number;
  armorDamage: number;
  fragmentation: number;
  ricochet: number;
  accuracy: number;
  recoil: number;
  lightBleed: number;
  heavyBleed: number;
  speed: number;
};

const TYPE_LABEL: Record<string, string> = {
  bullet: "子弹",
  buckshot: "霰弹",
  grenade: "榴弹",
  flashbang: "闪光",
};

const CALIBER_LABEL: Record<string, string> = {
  "1143x23acp": ".45 ACP",
  "9x18pm": "9x18mm",
  "9x18pmm": "9x18mm PMM",
  "9x19para": "9x19mm",
  "9x21": "9x21mm",
  "9x33r": ".357 Magnum",
  "762x25tt": "7.62x25mm",
  "46x30": "4.6x30mm",
  "57x28": "5.7x28mm",
  "545x39": "5.45x39mm",
  "556x45nato": "5.56x45mm",
  "58x42": "5.8x42mm",
  "68x51": "6.8x51mm",
  "762x35": ".300 Blackout",
  "762x39": "7.62x39mm",
  "762x51": "7.62x51mm",
  "762x54r": "7.62x54mm R",
  "9x39": "9x39mm",
  "93x64": "9.3x64mm",
  "366tkm": ".366 TKM",
  "127x33": ".50 AE",
  "127x55": "12.7x55mm",
  "127x99": ".50 BMG",
  "86x70": ".338 Lapua",
  "12g": "12/70",
  "20g": "20/70",
  "23x75": "23x75mm",
  "40x46": "40x46mm",
  "127x108": "12.7x108mm",
};

const EFFECT = ["无效", "勉强", "扫射", "略好", "有效", "很好", "无视"];
const EFFECT_BG = ["#6d1010", "#8f2a14", "#a34818", "#a35f16", "#6b7024", "#3d7a2a", "#2f9b32"];

type SortKey = "penetration" | "damage" | "armorDamage" | "speed" | "name";

let seq = 0;
let rows: Ammo[] = [];
let query = "";
let sortKey: SortKey = "penetration";
let sortAsc = false;
let picked = new Set<string>();
let pickedReady = false;

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function caliberKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "").replace(/^caliber/, "");
}

function caliberLabel(value: string) {
  const key = caliberKey(value);
  return CALIBER_LABEL[key] || value.replace(/^caliber/i, "") || "—";
}

function armorBlock(pen: number, armorClass: number, durability = 100) {
  const dura = Math.max(0, Math.min(100, durability));
  const threshold = (121 - 5000 / (45 + dura * 2)) * armorClass * 0.1;
  const delta = pen - threshold;
  if (delta >= 0) return Math.min(0.99, 0.9 + Math.min(0.09, delta * 0.01));
  if (delta <= -15) return 0;
  return Math.min(1, Math.max(0, 0.004 * (15 + delta) ** 2));
}

function armorHit(pen: number, armorClass: number, armorDamage: number) {
  return Math.max(1, armorDamage / 100 * pen * 0.45 * (0.7 + 0.05 * armorClass)) / 60 * 100;
}

function effectOf(pen: number, armorClass: number, armorDamage: number) {
  const klass = Math.min(6, Math.max(1, Math.round(armorClass)));
  let dura = 100;
  let expected = 0;
  let survive = 1;
  for (let i = 0; i < 40 && survive > 1e-4 && dura > 0; i += 1) {
    const pass = armorBlock(pen, klass, dura);
    expected += survive * (1 - pass);
    survive *= 1 - pass;
    dura = Math.max(0, dura - armorHit(pen, klass, armorDamage));
  }
  const shots = survive > 0.25 ? 30 : expected;
  const first = armorBlock(pen, klass, 100);
  if (first >= 0.8 || shots < 1) return 6;
  if (shots < 3) return 5;
  if (shots < 5) return 4;
  if (shots < 9) return 3;
  if (shots < 13) return 2;
  return shots < 20 ? 1 : 0;
}

function pct(value: number) {
  if (!value) return "0%";
  const shown = Math.abs(value) <= 1 ? value * 100 : value;
  return `${Math.round(shown)}%`;
}

function signed(value: number) {
  if (!value) return "0";
  const shown = Math.abs(value) <= 1 ? Math.round(value * 100) : Math.round(value);
  return shown > 0 ? `+${shown}` : String(shown);
}

function readAmmo(value: unknown): Ammo | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id || "").trim();
  const name = String(row.name || row.short_name || id).trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    short: String(row.short_name || "").trim(),
    caliber: String(row.caliber || "").trim(),
    type: String(row.ammo_type || "").trim(),
    tracer: String(row.tracer || "").trim(),
    damage: num(row.damage),
    penetration: num(row.penetration),
    armorDamage: num(row.armor_damage),
    fragmentation: num(row.fragmentation_chance),
    ricochet: num(row.ricochet_chance),
    accuracy: num(row.accuracy_modifier),
    recoil: num(row.recoil_modifier),
    lightBleed: num(row.light_bleed_modifier),
    heavyBleed: num(row.heavy_bleed_modifier),
    speed: num(row.initial_speed),
  };
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function groups() {
  const byType = new Map<string, Set<string>>();
  for (const row of rows) {
    const bucket = byType.get(row.type) || new Set<string>();
    if (row.caliber) bucket.add(row.caliber);
    byType.set(row.type, bucket);
  }
  const order = ["bullet", "buckshot", "grenade", "flashbang"];
  const known = new Set(order);
  const rest = [...byType.keys()].filter((item) => !known.has(item)).sort();
  return [...order.filter((item) => byType.has(item)), ...rest].map((type) => ({
    type,
    label: TYPE_LABEL[type] || type || "未标注",
    calibers: [...(byType.get(type) || [])].sort((a, b) => caliberLabel(a).localeCompare(caliberLabel(b), "zh")),
  }));
}

function visible() {
  const needle = query.trim().toLowerCase();
  const list = rows.filter((row) => {
    if (pickedReady && row.caliber && !picked.has(row.caliber)) return false;
    if (!needle) return true;
    return `${row.name} ${row.short} ${caliberLabel(row.caliber)}`.toLowerCase().includes(needle);
  });
  list.sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    if (sortKey === "name") return a.name.localeCompare(b.name, "zh") * dir;
    const delta = a[sortKey] - b[sortKey];
    if (delta) return delta * dir;
    return b.penetration - a.penetration;
  });
  return list;
}

function armorCells(row: Ammo) {
  return [1, 2, 3, 4, 5, 6].map((klass) => {
    const level = effectOf(row.penetration, klass, row.armorDamage);
    return `<i style="background:${EFFECT_BG[level]}" title="${klass}级 ${EFFECT[level]}">${EFFECT[level]}</i>`;
  }).join("");
}

function sortButton(key: SortKey, label: string) {
  const mark = sortKey === key ? (sortAsc ? " ↑" : " ↓") : "";
  return `<button type="button" data-ammo-sort="${key}">${label}${mark}</button>`;
}

function scatter(list: Ammo[]) {
  const plotted = list.filter((row) => row.penetration > 0 || row.damage > 0);
  if (!plotted.length) return "";
  const width = 760;
  const height = 340;
  const pad = { left: 44, right: 16, top: 16, bottom: 36 };
  const maxX = Math.max(10, Math.ceil(Math.max(...plotted.map((row) => row.penetration)) / 10) * 10);
  const maxY = Math.max(10, Math.ceil(Math.max(...plotted.map((row) => row.damage)) / 10) * 10);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xOf = (value: number) => pad.left + (value / maxX) * plotW;
  const yOf = (value: number) => pad.top + plotH - (value / maxY) * plotH;
  const colors = new Map<string, string>();
  for (const row of plotted) {
    if (colors.has(row.caliber)) continue;
    colors.set(row.caliber, `hsl(${Math.round((colors.size * 137.508) % 360)} 68% 58%)`);
  }
  const ticks = (max: number) => [0, max / 2, max];
  const xTicks = ticks(maxX).map((value) => `<text x="${xOf(value)}" y="${height - 10}" text-anchor="middle">${value}</text>`).join("");
  const yTicks = ticks(maxY).map((value) => `<text x="${pad.left - 8}" y="${yOf(value) + 4}" text-anchor="end">${value}</text>`).join("");
  const dots = plotted.map((row) => {
    const color = colors.get(row.caliber) || "#e8b86d";
    const label = `${row.short || row.name} · 穿透 ${row.penetration} · 伤害 ${row.damage}`;
    return `<circle cx="${xOf(row.penetration).toFixed(1)}" cy="${yOf(row.damage).toFixed(1)}" r="5" fill="${color}" data-wiki="item" data-wiki-id="${esc(row.id)}"><title>${esc(label)}</title></circle>`;
  }).join("");
  return `<div class="ammo-scatter"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="弹药穿透与伤害散点图">
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" />
    <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" />
    ${xTicks}${yTicks}
    <text x="${pad.left + plotW / 2}" y="${height - 1}" text-anchor="middle">穿透</text>
    <text x="14" y="${pad.top + plotH / 2}" text-anchor="middle" transform="rotate(-90 14 ${pad.top + plotH / 2})">伤害</text>
    ${dots}
  </svg></div>`;
}

function render() {
  const list = visible();
  const filter = groups().map((group) => {
    const on = group.calibers.filter((item) => picked.has(item)).length;
    return `<div class="ammo-row"><span>${esc(group.label)}</span><div>${group.calibers.map((item) => `<button type="button" data-ammo-caliber="${esc(item)}" class="${picked.has(item) ? "on" : ""}">${esc(caliberLabel(item))}</button>`).join("")}</div><button type="button" data-ammo-type="${esc(group.type)}" ${on === group.calibers.length ? "disabled" : ""}>全选</button><button type="button" data-ammo-type-clear="${esc(group.type)}" ${on === 0 ? "disabled" : ""}>清空</button></div>`;
  }).join("");
  const body = list.map((row) => {
    const sub = row.speed > 0 && row.speed < 343 ? `<b title="亚音速">S</b>` : "";
    const tracer = row.tracer ? `<b title="曳光弹">T</b>` : "";
    return `<tr>
      <td>${esc(caliberLabel(row.caliber))}</td>
      <td><button type="button" class="wiki-link" data-wiki="item" data-wiki-id="${esc(row.id)}">${esc(row.short || row.name)}</button>${sub}${tracer}</td>
      <td>${row.damage || "—"}</td>
      <td>${row.penetration || "—"}</td>
      <td>${row.armorDamage || "—"}</td>
      <td>${pct(row.fragmentation)}</td>
      <td>${pct(row.ricochet)}</td>
      <td>${row.speed ? Math.round(row.speed) : "—"}</td>
      <td>${signed(row.accuracy)}</td>
      <td>${signed(row.recoil)}</td>
      <td class="ammo-armor">${armorCells(row)}</td>
    </tr>`;
  }).join("");
  return `
    <div class="ammo-page">
      <form class="wiki-tools" id="ammo-find">
        <input name="q" value="${esc(query)}" placeholder="搜弹药名称" aria-label="搜索弹药" />
        <button type="submit">搜索</button>
        <span>${list.length} / ${rows.length} 发</span>
      </form>
      <div class="ammo-filters">${filter || `<p class="wiki-note">没有口径数据</p>`}</div>
      ${scatter(list)}
      <div class="ammo-scroll">
        <table class="ammo-table">
          <thead><tr>
            <th>口径</th>
            <th>${sortButton("name", "名称")}</th>
            <th>${sortButton("damage", "伤害")}</th>
            <th>${sortButton("penetration", "穿透")}</th>
            <th>${sortButton("armorDamage", "对甲")}</th>
            <th>碎弹</th>
            <th>跳弹</th>
            <th>${sortButton("speed", "初速")}</th>
            <th>精度</th>
            <th>后坐</th>
            <th>1–6 级护甲</th>
          </tr></thead>
          <tbody>${body || `<tr><td colspan="11">当前筛选下没有弹药。</td></tr>`}</tbody>
        </table>
      </div>
      <p class="wiki-note">横轴是穿透，纵轴是伤害，颜色区分口径。点色点或表里的名称打开物品详情。护甲色块是估算：红是无效，绿是能打穿。S 是亚音速，T 是曳光弹。</p>
    </div>`;
}

function bind(host: HTMLElement) {
  host.querySelector("#ammo-find")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLInputElement>("[name=q]");
    query = input?.value.trim() || "";
    paint();
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-caliber]").forEach((button) => {
    button.addEventListener("click", () => {
      const caliber = button.dataset.ammoCaliber || "";
      if (!caliber) return;
      if (picked.has(caliber)) picked.delete(caliber);
      else picked.add(caliber);
      paint();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-type]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = groups().find((item) => item.type === button.dataset.ammoType);
      group?.calibers.forEach((item) => picked.add(item));
      paint();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-type-clear]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = groups().find((item) => item.type === button.dataset.ammoTypeClear);
      group?.calibers.forEach((item) => picked.delete(item));
      paint();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.ammoSort as SortKey;
      if (sortKey === key) sortAsc = !sortAsc;
      else {
        sortKey = key;
        sortAsc = key === "name";
      }
      paint();
    });
  });
}

function paint() {
  const host = document.querySelector<HTMLElement>("#ammo-chart");
  if (!host) return;
  host.innerHTML = render();
  bind(host);
}

export function ammoShell() {
  return `<section class="ammo-chart" id="ammo-chart"><p class="wiki-note">正在读取弹药…</p></section>`;
}

export async function mountAmmo() {
  const token = ++seq;
  const host = document.querySelector("#ammo-chart");
  if (!host) return;
  if (rows.length) {
    paint();
    return;
  }
  host.innerHTML = `<p class="wiki-note">正在读取弹药…</p>`;
  try {
    const data = await invoke<{ items?: unknown[] }>("site_get", { path: "/guides/tarkov/ammo" });
    if (token !== seq || !document.querySelector("#ammo-chart")) return;
    rows = (data.items || []).flatMap((item) => {
      const row = readAmmo(item);
      return row ? [row] : [];
    });
    if (!pickedReady) {
      picked = new Set(rows.map((row) => row.caliber).filter(Boolean));
      pickedReady = true;
    }
    paint();
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#ammo-chart");
    if (!live) return;
    const message = error instanceof Error ? error.message : "弹药读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

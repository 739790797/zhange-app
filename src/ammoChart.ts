import { fadeIn, fadeOut } from "./motion";
import { spin } from "./spinner";

type Ammo = {
  id: string;
  name: string;
  short: string;
  caliber: string;
  type: string;
  tracer: boolean;
  tracerColor: string;
  icon: string;
  pack: string;
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

type SortKey = "penetration" | "damage" | "armorDamage" | "fragmentation" | "ricochet" | "accuracy" | "recoil" | "lightBleed" | "heavyBleed" | "speed";

const FILTER_KEY = "zhange.guides.tarkov.ammoFilters.v2";
const COLUMN_HINT: Record<string, string> = {
  caliber: "弹药口径。点击只看这个口径。",
  name: "弹药名称。右上角 S 为亚音速弹，T 为曳光弹。",
  pack: "对应的盒装弹药外观。",
  damage: "击中未护甲部位的肉体伤害。",
  penetration: "穿透力，决定打穿护甲的难度。",
  armorDamage: "每次命中护甲的耐久损耗。",
  fragmentation: "击中后破片的概率。破片通常额外造成约 50% 肉体伤害。",
  ricochet: "击中头盔时发生跳弹的概率。护甲一般不判定跳弹。",
  accuracy: "相对默认弹药的精度修正。",
  recoil: "相对默认弹药的后坐力修正。增为更难压，减为更稳。",
  lightBleed: "造成小出血的概率修正。",
  heavyBleed: "造成大出血的概率修正。",
  speed: "枪口初速（米/秒）。低于音速（约 343 m/s）视为亚音速。",
  armor: "对 1–6 级护甲的估算效果，不是游戏内实时演算。",
};
const TRACER_ZH: Record<string, string> = {
  red: "红色", green: "绿色", yellow: "黄色", orange: "橙色", white: "白色", blue: "蓝色",
  tracerred: "红色", tracergreen: "绿色", traceryellow: "黄色",
};

let seq = 0;
let rows: Ammo[] = [];
let query = "";
let sortKey: SortKey = "penetration";
let sortAsc = true;
let page = 1;
let pageSize = 50;
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

function thumbUrl(src: string) {
  const url = src.trim();
  if (!url) return "";
  return url.replace(/-(?:icon|grid-image|base-image|512|8x|image)\.webp(\?.*)?$/i, "-base-image.webp$1");
}

function readAmmo(value: unknown): Ammo | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id || "").trim();
  const name = String(row.name || row.short_name || id).trim();
  if (!id || !name) return null;
  const tracerRaw = row.tracer;
  const tracerColor = String(row.tracer_color || "").trim();
  const icon = String(row.icon_link || row.iconLink || "").trim();
  return {
    id,
    name,
    short: String(row.short_name || "").trim(),
    caliber: String(row.caliber || "").trim(),
    type: String(row.ammo_type || "").trim(),
    tracer: tracerRaw === true || tracerRaw === 1 || Boolean(String(tracerRaw || "").trim()) || Boolean(tracerColor),
    tracerColor,
    icon: thumbUrl(icon) || (/^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-base-image.webp` : ""),
    pack: thumbUrl(String(row.pack_icon_link || row.packIconLink || "").trim()),
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

function allCalibers() {
  return [...new Set(rows.map((row) => row.caliber).filter(Boolean))].sort((a, b) => caliberLabel(a).localeCompare(caliberLabel(b), "zh", { numeric: true }));
}

function caliberColor(caliber: string) {
  const index = Math.max(0, allCalibers().indexOf(caliber));
  const hue = Math.round((index * 137.508) % 360);
  const sat = index % 2 === 0 ? 72 : 64;
  const light = index % 3 === 0 ? 52 : index % 3 === 1 ? 58 : 48;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function loadPicked(available: string[]) {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return available;
    const parsed = JSON.parse(raw) as { selectedCalibers?: unknown };
    if (!Array.isArray(parsed.selectedCalibers)) return available;
    const saved = new Set(parsed.selectedCalibers.filter((item): item is string => typeof item === "string" && item.trim().length > 0));
    return available.filter((item) => saved.has(item));
  } catch {
    return available;
  }
}

function savePicked() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ selectedCalibers: [...picked] }));
  } catch {
    /* 口径勾选写不进时只留在当前页面 */
  }
}

function visible() {
  const needle = query.trim().toLowerCase();
  const list = rows.filter((row) => {
    if (pickedReady && row.caliber && !picked.has(row.caliber)) return false;
    if (!needle) return true;
    return `${row.name} ${row.short} ${caliberLabel(row.caliber)}`.toLowerCase().includes(needle);
  });
  const dir = sortAsc ? 1 : -1;
  list.sort((a, b) => {
    const byCaliber = caliberLabel(a.caliber).localeCompare(caliberLabel(b.caliber), "zh", { numeric: true });
    if (byCaliber) return byCaliber;
    const delta = a[sortKey] - b[sortKey];
    if (delta) return delta * dir;
    return a.name.localeCompare(b.name, "zh");
  });
  return list;
}

function chanceText(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  const shown = Math.round(value * 1000) / 10;
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)}%`;
}

function modifierText(value: number) {
  if (!Number.isFinite(value) || value === 0) return "0%";
  const shown = Math.round(value * 1000) / 10;
  const text = Number.isInteger(shown) ? String(shown) : shown.toFixed(1);
  return shown > 0 ? `+${text}%` : `${text}%`;
}

function muted(text: string, quiet: boolean) {
  return quiet ? `<span class="ammo-zero">${text}</span>` : text;
}

function signedCell(value: number, polarity: "accuracy" | "recoil") {
  const text = modifierText(value);
  if (!value) return muted(text, true);
  const good = polarity === "accuracy" ? value > 0 : value < 0;
  return `<span class="${good ? "ammo-good" : "ammo-bad"}">${text}</span>`;
}

function traitMarks(row: Ammo) {
  const marks: string[] = [];
  if (row.speed > 0 && row.speed < 343) marks.push(`<sup class="ammo-mark" title="亚音速弹">S</sup>`);
  if (row.tracer) {
    const color = TRACER_ZH[row.tracerColor.trim().toLowerCase()];
    marks.push(`<sup class="ammo-mark" title="${esc(color ? `${color}曳光弹` : "曳光弹")}">T</sup>`);
  }
  return marks.length ? `<span class="ammo-marks">${marks.join("")}</span>` : "";
}

function armorCells(row: Ammo) {
  return `<div class="ammo-armor">${[1, 2, 3, 4, 5, 6].map((klass) => {
    const level = effectOf(row.penetration, klass, row.armorDamage);
    return `<i style="background:${EFFECT_BG[level]}" title="${klass}级 ${EFFECT[level]}">${EFFECT[level]}</i>`;
  }).join("")}</div>`;
}

function sortButton(key: SortKey, label: string) {
  const mark = sortKey === key ? (sortAsc ? " ↑" : " ↓") : "";
  return `<button type="button" data-ammo-sort="${key}" title="${esc(COLUMN_HINT[key] || "")}">${label}${mark}</button>`;
}

function scatter(list: Ammo[]) {
  const plotted = list.filter((row) => row.penetration > 0 || row.damage > 0);
  if (!plotted.length) return `<p class="ammo-empty">当前筛选下没有可绘制的弹药。</p>`;
  const width = 920;
  const height = 460;
  const pad = { left: 52, right: 20, top: 16, bottom: 40 };
  const ceil10 = (value: number) => Math.max(10, Math.ceil(value / 10) * 10);
  const maxX = ceil10(Math.max(...rows.map((row) => row.penetration)));
  const maxY = ceil10(Math.max(...rows.map((row) => row.damage)));
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xOf = (value: number) => pad.left + (value / maxX) * plotW;
  const yOf = (value: number) => pad.top + plotH - (value / maxY) * plotH;
  const grid = [0.25, 0.5, 0.75, 1].map((step) => {
    const x = pad.left + plotW * step;
    const y = pad.top + plotH * (1 - step);
    return `<line class="ammo-grid" x1="${x}" y1="${pad.top}" x2="${x}" y2="${pad.top + plotH}" /><line class="ammo-grid" x1="${pad.left}" y1="${y}" x2="${pad.left + plotW}" y2="${y}" />`;
  }).join("");
  const ticks = (max: number) => [0, max / 2, max];
  const xTicks = ticks(maxX).map((value) => `<text x="${xOf(value)}" y="${height - 12}" text-anchor="middle">${value}</text>`).join("");
  const yTicks = ticks(maxY).map((value) => `<text x="${pad.left - 8}" y="${yOf(value) + 4}" text-anchor="end">${value}</text>`).join("");
  const dots = plotted.map((row) => `<circle cx="${xOf(row.penetration).toFixed(1)}" cy="${yOf(row.damage).toFixed(1)}" r="5" fill="${caliberColor(row.caliber)}" data-wiki="item" data-wiki-id="${esc(row.id)}" data-ammo-tip="${esc(row.id)}"></circle>`).join("");
  return `<div class="ammo-scatter"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="弹药穿透与伤害散点图">
    ${grid}
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" />
    <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" />
    ${xTicks}${yTicks}
    <text x="${pad.left + plotW / 2}" y="${height - 1}" text-anchor="middle">穿透</text>
    <text x="14" y="${pad.top + plotH / 2}" text-anchor="middle" transform="rotate(-90 14 ${pad.top + plotH / 2})">伤害</text>
    ${dots}
  </svg><div class="ammo-tip" hidden></div></div>`;
}

function rowSpans(list: Ammo[]) {
  const map = new Map<string, number>();
  let index = 0;
  while (index < list.length) {
    let next = index + 1;
    while (next < list.length && list[next].caliber === list[index].caliber) next += 1;
    map.set(list[index].id, next - index);
    for (let cursor = index + 1; cursor < next; cursor += 1) map.set(list[cursor].id, 0);
    index = next;
  }
  return map;
}

function render() {
  const list = visible();
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  if (page > pages) page = pages;
  const slice = list.slice((page - 1) * pageSize, page * pageSize);
  const spans = rowSpans(slice);
  const checkIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 2h12v12H2V2zm1.6 1.6v8.8h8.8V3.6H3.6zm1 4.3 1.5 1.5 3.5-3.7.9.9-4.4 4.6-2.4-2.4.9-.9z"/></svg>`;
  const clearIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M3.2 3.2 12.8 12.8M12.8 3.2 3.2 12.8"/></svg>`;
  const filter = groups().map((group) => {
    const on = group.calibers.filter((item) => picked.has(item)).length;
    const chips = group.calibers.map((item) => {
      const checked = picked.has(item);
      const label = caliberLabel(item);
      return `<button type="button" class="ammo-chip${checked ? " on" : ""}" data-ammo-caliber="${esc(item)}" title="${esc(label)}"><i class="ammo-dot" style="background:${caliberColor(item)};opacity:${checked ? 1 : 0.35}"></i><span>${esc(label)}</span></button>`;
    }).join("");
    return `<div class="ammo-row"><div class="ammo-label">${esc(group.label)}</div><div class="ammo-chips">${chips}</div><div class="ammo-row-acts"><button type="button" class="ammo-icon-btn" data-ammo-type="${esc(group.type)}" title="全选本行" aria-label="全选本行" ${on === group.calibers.length ? "disabled" : ""}>${checkIcon}</button><button type="button" class="ammo-icon-btn" data-ammo-type-clear="${esc(group.type)}" title="清空本行" aria-label="清空本行" ${on === 0 ? "disabled" : ""}>${clearIcon}</button></div></div>`;
  }).join("");
  const body = slice.map((row) => {
    const span = spans.get(row.id) ?? 1;
    const caliber = span
      ? `<td class="ammo-caliber" rowspan="${span}"><button type="button" data-ammo-only="${esc(row.caliber)}" title="只看${esc(caliberLabel(row.caliber))}">${esc(caliberLabel(row.caliber))}</button></td>`
      : "";
    const thumb = row.icon ? `<img class="ammo-thumb" src="${esc(row.icon)}" alt="" />` : `<i class="ammo-thumb"></i>`;
    const pack = row.pack ? `<img class="ammo-thumb" src="${esc(row.pack)}" alt="" title="弹药包形态" />` : `<span class="ammo-zero" title="没有对应的弹药包">—</span>`;
    return `<tr>
      ${caliber}
      <td><span class="ammo-name">${thumb}<button type="button" class="ammo-link" data-wiki="item" data-wiki-id="${esc(row.id)}" title="查看弹药详情">${esc(row.name)}</button>${traitMarks(row)}</span></td>
      <td class="ammo-pack">${pack}</td>
      <td class="num">${row.damage}</td>
      <td class="num">${row.penetration}</td>
      <td class="num">${row.armorDamage}</td>
      <td class="num">${muted(chanceText(row.fragmentation), row.fragmentation <= 0)}</td>
      <td class="num">${muted(chanceText(row.ricochet), row.ricochet <= 0)}</td>
      <td class="num">${signedCell(row.accuracy, "accuracy")}</td>
      <td class="num">${signedCell(row.recoil, "recoil")}</td>
      <td class="num">${muted(modifierText(row.lightBleed), !row.lightBleed)}</td>
      <td class="num">${muted(modifierText(row.heavyBleed), !row.heavyBleed)}</td>
      <td class="num">${row.speed > 0 ? Math.round(row.speed) : "—"}</td>
      <td class="ammo-armor-cell">${armorCells(row)}</td>
    </tr>`;
  }).join("");
  const armorHead = [1, 2, 3, 4, 5, 6].map((klass) => `<b title="${klass} 级护甲。色块表示该弹对该级护甲的估算效果。">${klass}</b>`).join("");
  return `
    <div class="ammo-stack">
      <div class="ammo-filters">${filter || `<p class="ammo-empty">暂无口径数据</p>`}</div>
      <section class="ammo-panel">
        <div class="ammo-chart-bar">
          <span>点色点或名称打开物品详情。颜色区分口径，横轴穿透，纵轴伤害。</span>
          <form id="ammo-find"><input name="q" value="${esc(query)}" placeholder="搜弹药名称" aria-label="搜索弹药" /></form>
          <b>${list.length} / ${rows.length}</b>
        </div>
        ${scatter(list)}
      </section>
      <section class="ammo-panel ammo-table-panel">
        <div class="ammo-scroll">
          <table class="ammo-table">
            <thead><tr>
              <th title="${esc(COLUMN_HINT.caliber)}">口径</th>
              <th title="${esc(COLUMN_HINT.name)}">名称</th>
              <th title="${esc(COLUMN_HINT.pack)}">弹药包</th>
              <th>${sortButton("damage", "伤害")}</th>
              <th>${sortButton("penetration", "穿透")}</th>
              <th>${sortButton("armorDamage", "护甲伤害")}</th>
              <th>${sortButton("fragmentation", "碎弹%")}</th>
              <th>${sortButton("ricochet", "跳弹%")}</th>
              <th>${sortButton("accuracy", "精度%")}</th>
              <th>${sortButton("recoil", "后坐力")}</th>
              <th>${sortButton("lightBleed", "小出血")}</th>
              <th>${sortButton("heavyBleed", "大出血")}</th>
              <th>${sortButton("speed", "M/S")}</th>
              <th class="ammo-armor-th"><span title="${esc(COLUMN_HINT.armor)}">对护甲效果（估）</span><span class="ammo-armor-nums">${armorHead}</span></th>
            </tr></thead>
            <tbody>${body || `<tr><td class="ammo-empty" colspan="14">当前筛选下无弹药</td></tr>`}</tbody>
          </table>
        </div>
        <div class="ammo-pager">
          <button type="button" data-ammo-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
          <span>${page} / ${pages}</span>
          <button type="button" data-ammo-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button>
          <label>每页<select data-ammo-size>${[20, 50, 100].map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size}</option>`).join("")}</select></label>
        </div>
      </section>
    </div>`;
}

function tipHtml(row: Ammo) {
  const cells = [1, 2, 3, 4, 5, 6].map((klass) => {
    const level = effectOf(row.penetration, klass, row.armorDamage);
    return `<i style="background:${EFFECT_BG[level]}"><b>${klass}级</b>${EFFECT[level]}</i>`;
  }).join("");
  return `<strong>${esc(row.name)}</strong><div><span>穿透　${row.penetration}<br>伤害　${row.damage}<br>对甲　${row.armorDamage}</span><div><em>对护甲效果（估）</em><div class="ammo-tip-armor">${cells}</div></div></div>`;
}

function bind(host: HTMLElement, caret: number | null) {
  host.querySelector("#ammo-find")?.addEventListener("submit", (event) => event.preventDefault());
  host.querySelector("#ammo-find")?.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    query = input.value;
    page = 1;
    paint();
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-caliber]").forEach((button) => {
    button.addEventListener("click", () => {
      const caliber = button.dataset.ammoCaliber || "";
      if (!caliber) return;
      if (picked.has(caliber)) picked.delete(caliber);
      else picked.add(caliber);
      savePicked();
      page = 1;
      paint();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-only]").forEach((button) => {
    button.addEventListener("click", () => {
      const caliber = button.dataset.ammoOnly || "";
      if (!caliber) return;
      picked = new Set([caliber]);
      savePicked();
      page = 1;
      paint();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-type]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = groups().find((item) => item.type === button.dataset.ammoType);
      group?.calibers.forEach((item) => picked.add(item));
      savePicked();
      page = 1;
      paint();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-type-clear]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = groups().find((item) => item.type === button.dataset.ammoTypeClear);
      group?.calibers.forEach((item) => picked.delete(item));
      savePicked();
      page = 1;
      paint();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.ammoSort as SortKey;
      if (!key) return;
      if (sortKey === key) sortAsc = !sortAsc;
      else {
        sortKey = key;
        sortAsc = true;
      }
      paint();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-ammo-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = Number(button.dataset.ammoPage);
      if (!Number.isFinite(next) || next < 1) return;
      page = next;
      paint();
    });
  });
  host.querySelector<HTMLSelectElement>("[data-ammo-size]")?.addEventListener("change", (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    pageSize = Number(select.value) || 50;
    page = 1;
    paint();
  });
  const chart = host.querySelector(".ammo-scatter");
  const tip = host.querySelector<HTMLElement>(".ammo-tip");
  chart?.addEventListener("mousemove", (event) => {
    if (!(event.target instanceof Element) || !tip) return;
    const dot = event.target.closest<SVGCircleElement>("[data-ammo-tip]");
    if (!dot) {
      void fadeOut(tip);
      return;
    }
    const row = rows.find((item) => item.id === dot.dataset.ammoTip);
    if (!row) return;
    tip.innerHTML = tipHtml(row);
    fadeIn(tip);
    const point = event instanceof MouseEvent ? event : null;
    const x = point ? point.clientX + 14 : 0;
    const y = point ? point.clientY + 14 : 0;
    tip.style.left = `${Math.min(x, window.innerWidth - 340)}px`;
    tip.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
  });
  chart?.addEventListener("mouseleave", () => {
    if (tip) void fadeOut(tip);
  });
  if (caret != null) {
    const input = host.querySelector<HTMLInputElement>("#ammo-find [name=q]");
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }
}

function paint() {
  const host = document.querySelector<HTMLElement>("#ammo-chart");
  if (!host) return;
  const typing = document.activeElement instanceof HTMLInputElement && Boolean(document.activeElement.closest("#ammo-find"));
  const caret = typing && document.activeElement instanceof HTMLInputElement ? document.activeElement.selectionStart : null;
  host.innerHTML = render();
  bind(host, caret);
}

export function ammoShell() {
  return `<section class="ammo-chart" id="ammo-chart">${spin("正在读取弹药")}</section>`;
}

export async function mountAmmo() {
  const token = ++seq;
  const host = document.querySelector("#ammo-chart");
  if (!host) return;
  if (rows.length) {
    paint();
    return;
  }
  host.innerHTML = spin("正在读取弹药");
  try {
    const data = await invoke<{ items?: unknown[] }>("site_get", { path: "/guides/tarkov/ammo" });
    if (token !== seq || !document.querySelector("#ammo-chart")) return;
    rows = (data.items || []).flatMap((item) => {
      const row = readAmmo(item);
      return row ? [row] : [];
    });
    picked = new Set(loadPicked(allCalibers()));
    pickedReady = true;
    paint();
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#ammo-chart");
    if (!live) return;
    const message = error instanceof Error ? error.message : "弹药读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

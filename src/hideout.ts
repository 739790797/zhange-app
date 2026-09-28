type Need = { id: string; name: string; count: number; icon: string; fir: boolean };
type StationNeed = { id: string; level: number };
type Level = { level: number; items: Need[]; stations: StationNeed[]; bonuses: string[] };
type Station = { id: string; slug: string; name: string; image: string; levels: Level[] };
type Craft = { id: string; level: number; duration: number; product: Need | null; needs: Need[] };

let seq = 0;
let stations: Station[] = [];
let built = new Map<string, number>();
let stashFloor = 1;
let preview = 0;
let previewKey = "";

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function rec(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rows(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item) => {
    const row = rec(item);
    return row ? [row] : [];
  }) : [];
}

function str(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
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

function needOf(row: Record<string, unknown>): Need | null {
  const item = rec(row.item) || row;
  const id = str(item.id || row.item_id || row.id);
  const name = str(item.name || item.shortName || item.short_name || row.name) || id;
  if (!id && !name) return null;
  const count = Number(row.count ?? item.count ?? 1);
  return {
    id,
    name,
    count: Number.isFinite(count) && count > 0 ? count : 1,
    icon: iconOf(str(item.icon_link || item.iconLink || row.icon_link), id),
    fir: item.found_in_raid === true || row.found_in_raid === true,
  };
}

function chip(item: Need) {
  const qty = item.count !== 1 ? `${item.count} × ` : "";
  const image = item.icon ? `<img src="${esc(item.icon)}" alt="" />` : "";
  const label = `${qty}${item.name}${item.fir ? " · 战局内" : ""}`;
  const body = `${image}<span>${esc(label)}</span>`;
  return item.id ? `<button type="button" class="wiki-chip" data-wiki="item" data-wiki-id="${esc(item.id)}">${body}</button>` : `<span class="wiki-chip">${body}</span>`;
}

function readLevel(row: Record<string, unknown>): Level | null {
  const level = Number(row.level || 0);
  if (!Number.isFinite(level) || level <= 0) return null;
  return {
    level,
    items: rows(row.item_requirements).flatMap((item) => {
      const need = needOf(item);
      return need ? [need] : [];
    }),
    stations: rows(row.station_requirements).flatMap((item) => {
      const id = str(item.station_id || item.stationId);
      const required = Number(item.level || 0);
      return id ? [{ id, level: required }] : [];
    }),
    bonuses: rows(row.bonuses).map((item) => str(item.name || item.type)).filter(Boolean),
  };
}

function readStation(row: Record<string, unknown>): Station | null {
  const id = str(row.id);
  const slug = str(row.slug) || id;
  const name = str(row.name) || slug;
  if (!id || !name) return null;
  return {
    id,
    slug,
    name,
    image: str(row.image_link || row.icon_link),
    levels: rows(row.levels).flatMap((item) => {
      const level = readLevel(item);
      return level ? [level] : [];
    }).sort((a, b) => a.level - b.level),
  };
}

function floorOf(station: Station) {
  return station.slug === "stash" ? stashFloor : 0;
}

function maxOf(station: Station) {
  return station.levels.reduce((max, level) => Math.max(max, level.level), 0);
}

function currentOf(station: Station) {
  const saved = built.get(station.id);
  const floor = floorOf(station);
  return saved == null ? floor : Math.max(floor, saved);
}

function clock(value: number) {
  const total = Math.max(0, Math.round(value));
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  if (hour) return `${hour}小时${minute}分`;
  if (minute) return second ? `${minute}分${second}秒` : `${minute}分`;
  return `${second}秒`;
}

function readCraft(row: Record<string, unknown>): Craft | null {
  const id = str(row.id);
  if (!id) return null;
  const product = rec(row.product_item);
  return {
    id,
    level: Number(row.level || 0),
    duration: Number(row.duration || 0),
    product: product ? needOf(product) : null,
    needs: rows(row.required_items).flatMap((item) => {
      const need = needOf(item);
      return need ? [need] : [];
    }),
  };
}

function stationName(id: string) {
  return stations.find((item) => item.id === id)?.name || "设施";
}

function materialTotal() {
  const totals = new Map<string, Need>();
  let steps = 0;
  for (const station of stations) {
    const current = currentOf(station);
    for (const level of station.levels) {
      if (level.level <= current) continue;
      steps += 1;
      for (const item of level.items) {
        const key = item.id || item.name;
        const prev = totals.get(key);
        if (prev) prev.count += item.count;
        else totals.set(key, { ...item });
      }
    }
  }
  return {
    steps,
    items: [...totals.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh")),
  };
}

function summaryHtml() {
  const total = materialTotal();
  const body = total.items.length ? `<div class="wiki-chips">${total.items.map(chip).join("")}</div>` : `<p class="wiki-note">当前等级到满级没有额外材料。</p>`;
  return `<section class="wiki-block"><h2>升到满级还差</h2><p class="wiki-note">${total.steps ? `还要升 ${total.steps} 级，材料已按全部设施合计。` : "设施都已升到当前数据里的最高级。"}</p>${body}</section>`;
}

export function hideoutShell() {
  return `<section class="hideout" id="hideout"><p class="wiki-note">正在读取藏身处…</p></section>`;
}

function render(selected: Station | null, crafts: Craft[]) {
  const side = stations.map((station) => {
    const current = currentOf(station);
    const max = maxOf(station);
    const on = selected?.id === station.id;
    return `<a class="hideout-station${on ? " on" : ""}" href="/主菜单/逃离塔科夫/藏身处/${esc(station.slug)}" data-link><strong>${esc(station.name)}</strong><span>Lv.${current}${max ? ` / ${max}` : ""}</span></a>`;
  }).join("");
  if (!selected) {
    return `<div class="hideout-layout"><aside class="hideout-side">${side}</aside><div class="hideout-main">${summaryHtml()}<p class="wiki-note">选一个设施查看这一级的材料和配方。</p></div></div>`;
  }
  const current = currentOf(selected);
  const max = maxOf(selected);
  const shown = preview >= floorOf(selected) && preview <= max ? preview : Math.min(max, current + 1);
  const level = selected.levels.find((item) => item.level === shown);
  const chips = selected.levels.map((item) => `<button type="button" data-hideout-preview="${item.level}" class="${item.level === shown ? "on" : ""}">${item.level}</button>`).join("");
  const prereq = (level?.stations || []).map((item) => {
    const other = stations.find((station) => station.id === item.id);
    const have = other ? currentOf(other) : 0;
    const ok = have >= item.level;
    return `<li class="${ok ? "ok" : ""}">${esc(stationName(item.id))} Lv.${item.level}</li>`;
  }).join("");
  const materials = (level?.items || []).map(chip).join("");
  const bonuses = (level?.bonuses || []).map((item) => `<li>${esc(item)}</li>`).join("");
  const craftRows = crafts.map((craft) => {
    const locked = craft.level > current;
    return `<tr class="${locked ? "locked" : ""}"><td>${craft.product ? chip(craft.product) : "—"}</td><td>${craft.needs.map(chip).join("") || "—"}</td><td>Lv.${craft.level || "—"}</td><td>${craft.duration ? clock(craft.duration) : "—"}</td></tr>`;
  }).join("");
  return `
    <div class="hideout-layout">
      <aside class="hideout-side">${side}</aside>
      <div class="hideout-main">
        <header class="wiki-hero">${selected.image ? `<img class="wiki-hero-img" src="${esc(selected.image)}" alt="" />` : ""}<div><span class="wiki-badge">藏身处</span><h1>${esc(selected.name)}</h1><p>${current ? `已建到 Lv.${current}` : "尚未建造"}${max ? ` / ${max}` : ""} · <a href="/主菜单/逃离塔科夫/藏身处" data-link>全部材料合计</a></p></div></header>
        <p class="wiki-actions">
          <button type="button" data-hideout-step="-1" ${current <= floorOf(selected) ? "disabled" : ""}>降一级</button>
          <button type="button" data-hideout-step="1" ${current >= max ? "disabled" : ""}>升一级</button>
        </p>
        <div class="wiki-levels">${chips}</div>
        <section class="wiki-block"><h2>Lv.${shown} 升级要求</h2>${prereq ? `<ul class="wiki-lines">${prereq}</ul>` : `<p class="wiki-note">无设施前置。</p>`}${materials ? `<div class="wiki-chips">${materials}</div>` : `<p class="wiki-note">这一级没有列出材料。</p>`}</section>
        ${bonuses ? `<section class="wiki-block"><h2>效果</h2><ul class="wiki-lines">${bonuses}</ul></section>` : ""}
        ${craftRows ? `<section class="wiki-block"><h2>制作</h2><table class="wiki-table"><thead><tr><th>产物</th><th>材料</th><th>模块</th><th>时长</th></tr></thead><tbody>${craftRows}</tbody></table></section>` : ""}
      </div>
    </div>`;
}

async function loadCrafts(station: Station) {
  const data = await invoke<{ items?: Record<string, unknown>[] }>("site_get", {
    path: `/guides/tarkov/crafts?station=${encodeURIComponent(station.slug || station.id)}&page=1&page_size=100`,
  }).catch(() => ({ items: [] }));
  return (data.items || []).flatMap((item) => {
    const row = rec(item);
    if (!row) return [];
    const craft = readCraft(row);
    return craft ? [craft] : [];
  }).sort((a, b) => a.level - b.level);
}

function bind(host: HTMLElement, station: Station | null) {
  host.querySelectorAll<HTMLButtonElement>("[data-hideout-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      preview = Number(button.dataset.hideoutPreview) || 0;
      previewKey = station?.id || "";
      const live = document.querySelector<HTMLElement>("#hideout");
      if (!live || !station) return;
      void loadCrafts(station).then((crafts) => {
        if (!document.querySelector("#hideout")) return;
        live.innerHTML = render(station, crafts);
        bind(live, station);
      });
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-hideout-step]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!station || button.disabled) return;
      const next = currentOf(station) + Number(button.dataset.hideoutStep || 0);
      void saveLevel(station, next);
    });
  });
}

async function saveLevel(station: Station, level: number) {
  const host = document.querySelector<HTMLElement>("#hideout");
  if (!host) return;
  try {
    await invoke("site_put", {
      path: "/guides/tarkov/hideout-levels",
      body: { station_id: station.id, level },
    });
    built.set(station.id, level);
    preview = level;
    previewKey = station.id;
    const crafts = await loadCrafts(station);
    const live = document.querySelector<HTMLElement>("#hideout");
    if (!live) return;
    live.innerHTML = render(station, crafts);
    bind(live, station);
  } catch (error) {
    const live = document.querySelector<HTMLElement>("#hideout");
    if (!live) return;
    const message = error instanceof Error ? error.message : "等级保存失败";
    const note = document.createElement("p");
    note.className = "wiki-note";
    note.textContent = message;
    live.querySelector(".hideout-main")?.prepend(note);
  }
}

export async function mountHideout(slug: string) {
  const token = ++seq;
  const host = document.querySelector<HTMLElement>("#hideout");
  if (!host) return;
  host.innerHTML = `<p class="wiki-note">正在读取藏身处…</p>`;
  try {
    const [catalog, progress, profile] = await Promise.all([
      invoke<{ items?: Record<string, unknown>[] }>("site_get", { path: "/guides/tarkov/hideout" }),
      invoke<{ levels?: { station_id?: string; level?: number }[] }>("site_get", { path: "/guides/tarkov/hideout-levels" }).catch(() => ({ levels: [] })),
      invoke<{ game_edition?: string }>("site_get", { path: "/guides/tarkov/profile" }).catch(() => ({})),
    ]);
    if (token !== seq || !document.querySelector("#hideout")) return;
    stations = (catalog.items || []).flatMap((item) => {
      const row = rec(item);
      const station = row ? readStation(row) : null;
      return station ? [station] : [];
    }).sort((a, b) => a.name.localeCompare(b.name, "zh"));
    built = new Map((progress.levels || []).flatMap((item) => {
      const id = str(item.station_id);
      return id ? [[id, Number(item.level || 0)] as [string, number]] : [];
    }));
    const edition = str((profile as { game_edition?: string }).game_edition).toLowerCase();
    stashFloor = edition === "eod" || edition === "edge" || edition === "blue" ? 4 : 1;
    const selected = stations.find((item) => item.slug === slug || item.id === slug) || null;
    if (selected && previewKey !== selected.id) {
      preview = Math.min(maxOf(selected), currentOf(selected) + 1);
      previewKey = selected.id;
    }
    const crafts = selected ? await loadCrafts(selected) : [];
    if (token !== seq) return;
    const live = document.querySelector<HTMLElement>("#hideout");
    if (!live) return;
    live.innerHTML = render(selected, crafts);
    bind(live, selected);
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#hideout");
    if (!live) return;
    const message = error instanceof Error ? error.message : "藏身处读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

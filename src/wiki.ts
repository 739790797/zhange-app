import { bindItemDetail, gunReceiverId, renderItem } from "./itemDetail";
import { mapTitle } from "./mapNames";
import { spin } from "./spinner";

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

const OBJECTIVE_LABEL: Record<string, string> = {
  findItem: "找到",
  findQuestItem: "找到",
  giveItem: "上交",
  giveQuestItem: "上交",
  plantItem: "藏匿",
  mark: "标记",
  useItem: "使用",
  shoot: "击杀",
  visit: "到访",
  extract: "撤离",
  experience: "经验",
  skill: "技能",
  traderLevel: "商人等级",
  traderStanding: "商人声望",
  buildWeapon: "改装武器",
};

const FAIL_LABEL: Record<string, string> = {
  taskStatus: "任务冲突",
  extract: "撤离失败",
  useItem: "禁止使用",
  traderStanding: "商人声望",
  shoot: "禁止击杀",
};

let wikiSeq = 0;
let traderLevel = "";
let traderQuery = "";
let traderPage = 1;
let traderKey = "";

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function rec(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
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

function field(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const text = str(row[key]);
    if (text) return text;
  }
  return "";
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

function iconUrl(icon: string, id: string) {
  const link = icon.trim();
  if (link) return link;
  return /^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-icon.webp` : "";
}

function rub(value: unknown, currency = "") {
  const amount = num(value);
  if (amount == null) return "";
  const text = Math.round(amount).toLocaleString("zh-CN");
  const unit = currency && currency !== "RUB" ? ` ${currency}` : " ₽";
  return `${text}${unit}`;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

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

export function readWikiHits(value: unknown, kind: WikiKind): WikiHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const item = rec(row);
    if (!item) return [];
    const name = field(item, "name");
    const id = kind === "trader" || kind === "boss" ? field(item, "slug", "id") : field(item, "id", "slug");
    if (!name || !id) return [];
    return [{
      name,
      extra: field(item, "extra"),
      mapSlug: "",
      kind,
      id,
      icon: field(item, "icon_link", "iconLink"),
    }];
  });
}

export function wikiShell(spec: WikiSpec) {
  return `<section class="wiki" id="wiki" data-kind="${spec.kind}" data-id="${esc(spec.id)}">${spin("正在读取")}</section>`;
}

function jump(kind: string, id: string, label: string) {
  const href = wikiHref(kind, id);
  if (!href || !label) return esc(label);
  return `<button type="button" class="wiki-link" data-wiki="${kind}" data-wiki-id="${esc(id)}">${esc(label)}</button>`;
}

function itemName(row: Record<string, unknown>) {
  return field(row, "name", "shortName", "short_name", "label", "title") || field(row, "id", "item_id", "itemId");
}

function itemId(row: Record<string, unknown>) {
  return field(row, "id", "item_id", "itemId");
}

function chip(row: Record<string, unknown>, count?: number | null) {
  const nested = rec(row.item) || rec(row.rewardItem) || rec(row.reward_item) || row;
  const name = itemName(nested);
  const id = itemId(nested);
  if (!name && !id) return "";
  const qty = count ?? num(row.count);
  const label = qty != null && qty !== 1 ? `${qty} × ${name || id}` : (name || id);
  const icon = iconUrl(field(nested, "iconLink", "icon_link", "baseImageLink"), id);
  const image = icon ? `<img src="${esc(icon)}" alt="" />` : "";
  return `<span class="wiki-chip">${image}${jump("item", id, label)}</span>`;
}

function chipList(value: unknown) {
  const chips = rows(value).map((row) => chip(row)).filter(Boolean);
  return chips.length ? `<div class="wiki-chips">${chips.join("")}</div>` : "";
}

function section(title: string, body: string) {
  if (!body) return "";
  return `<section class="wiki-block"><h2>${esc(title)}</h2>${body}</section>`;
}

function facts(pairs: [string, string][]) {
  const ready = pairs.filter((pair) => pair[1]);
  if (!ready.length) return "";
  return `<dl class="wiki-facts">${ready.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function lines(items: string[]) {
  const ready = items.filter(Boolean);
  if (!ready.length) return "";
  return `<ul class="wiki-lines">${ready.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function objectiveText(row: Record<string, unknown>) {
  const type = field(row, "type");
  const desc = field(row, "description", "text", "name");
  let text = desc || OBJECTIVE_LABEL[type] || "目标";
  const count = num(row.count);
  if (count != null && count > 1) text += ` ×${count}`;
  if (row.optional === true) text += "（可选）";
  if (row.found_in_raid === true || row.foundInRaid === true) text += " · 战局内找到";
  const maps = rows(row.maps).map((item) => mapTitle(field(item, "slug", "id", "normalizedName", "normalized_name"), field(item, "name"), "")).filter(Boolean);
  const plainMaps = Array.isArray(row.maps) ? row.maps.flatMap((item) => typeof item === "string" ? [mapTitle(item, "", "")] : []) : [];
  const where = [...maps, ...plainMaps].filter((item, index, list) => list.indexOf(item) === index).join("、");
  return where ? `${esc(text)} <em>${esc(where)}</em>` : esc(text);
}

function mapSlugOf(row: Record<string, unknown>) {
  const maps = rows(row.maps);
  for (const map of maps) {
    const slug = field(map, "slug", "id", "normalizedName", "normalized_name");
    if (slug) return slug;
  }
  if (Array.isArray(row.maps)) {
    for (const map of row.maps) {
      const slug = str(map);
      if (slug && !/[\u4e00-\u9fff]/.test(slug)) return slug;
    }
  }
  const direct = field(row, "map_slug", "mapSlug", "map");
  return direct && !/[\u4e00-\u9fff]/.test(direct) ? direct : "";
}

function rewardBlock(title: string, value: unknown) {
  const bag = rec(value);
  if (!bag) return section(title, chipList(value));
  const body = [
    chipList(bag.items),
    lines(rows(bag.trader_standing || bag.traderStanding).map((row) => {
      const name = field(row, "trader_name", "traderName", "name");
      const standing = field(row, "standing", "value");
      return name ? esc(`${name} 声望 ${standing}`) : "";
    })),
    lines(rows(bag.offer_unlock || bag.offerUnlock).map((row) => {
      const name = field(row, "name", "item_name", "trader_name");
      return name ? esc(`解锁报价 ${name}`) : "";
    })),
    lines(rows(bag.skill_level_reward || bag.skillLevelReward).map((row) => {
      const name = field(row, "name", "skill");
      const level = field(row, "level", "value");
      return name ? esc(`${name} ${level}`) : "";
    })),
    lines(rows(bag.trader_unlock || bag.traderUnlock).map((row) => esc(`解锁商人 ${field(row, "name", "trader_name")}`))),
    lines(rows(bag.craft_unlock || bag.craftUnlock).map((row) => esc(`解锁制作 ${field(row, "name", "station_name")}`))),
  ].filter(Boolean).join("");
  return section(title, body);
}

function hero(title: string, badge: string, image: string, text: string) {
  const photo = image ? `<img class="wiki-hero-img" src="${esc(image)}" alt="" />` : "";
  return `<header class="wiki-hero">${photo}<div><span class="wiki-badge">${esc(badge)}</span><h1>${esc(title)}</h1>${text ? `<p>${esc(text)}</p>` : ""}</div></header>`;
}

function taskView(data: Record<string, unknown>, id: string) {
  const task = rec(data.task) || data;
  const name = field(task, "name") || "任务";
  const trader = field(task, "trader_name", "traderName");
  const traderSlug = field(task, "trader_slug", "traderSlug");
  const image = field(task, "task_image_link", "taskImageLink", "icon_link");
  const kappa = task.kappa_required === true || task.kappaRequired === true;
  const restart = task.restartable === true;
  const objectives = rows(task.objectives);
  const locate = objectives.map(mapSlugOf).find(Boolean) || mapSlugOf(task);
  const keys = rows(task.needed_keys || task.neededKeys || task.required_keys);
  const dialogue = rec(task.dialogue);
  const talk = dialogue ? [
    ["说明", field(dialogue, "description")],
    ["接取", field(dialogue, "start")],
    ["完成", field(dialogue, "success")],
    ["失败", field(dialogue, "fail")],
  ].filter((pair) => pair[1]) : [];
  const fails = rows(task.fail_conditions || task.failConditions).map((row) => {
    const label = FAIL_LABEL[field(row, "type")] || field(row, "type") || "失败";
    const text = field(row, "description", "text");
    return text ? `<b>${esc(label)}</b> ${esc(text)}` : "";
  });
  const related = rows(task.task_requirements || task.prereqs || task.prerequisites).map((row) => jump("task", itemId(row) || field(row, "id"), itemName(row)));
  const next = rows(task.next_tasks || task.unlocks || task.successors).map((row) => jump("task", itemId(row) || field(row, "id"), itemName(row)));
  return [
    hero(name, "任务", image, trader),
    facts([
      ["商人", traderSlug ? jump("trader", traderSlug, trader || traderSlug) : esc(trader)],
      ["等级", esc(field(task, "min_player_level", "minPlayerLevel"))],
      ["经验", esc(field(task, "experience"))],
      ["收藏家", kappa ? "需要" : ""],
      ["失败后", restart ? "可重新接取" : ""],
      ["阵营", esc(field(task, "faction_name", "factionName"))],
    ]),
    locate ? `<p class="wiki-actions"><button type="button" data-locate-task="${esc(id)}" data-locate-map="${esc(locate)}">在地图上定位</button></p>` : "",
    section("目标", lines(objectives.map(objectiveText))),
    section("所需钥匙", chipList(keys)),
    rewardBlock("接取奖励", task.start_rewards || task.startRewards),
    rewardBlock("完成奖励", task.finish_rewards || task.finishRewards),
    rewardBlock("失败惩罚", task.fail_rewards || task.failRewards),
    section("失败条件", lines(fails)),
    section("任务对话", talk.map(([label, text]) => `<p class="wiki-copy"><b>${esc(label)}</b>${esc(text)}</p>`).join("")),
    section("前置任务", lines(related)),
    section("后续任务", lines(next)),
    section("说明", field(task, "description") ? `<p class="wiki-copy">${esc(field(task, "description"))}</p>` : ""),
  ].join("");
}

function restock(value: unknown) {
  const raw = num(value);
  if (raw == null) return str(value);
  const ms = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : 0;
  if (ms) {
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN", { hour12: false });
  }
  const total = Math.max(0, Math.round(raw));
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  const pad = (part: number) => String(part).padStart(2, "0");
  return hour ? `${hour}:${pad(minute)}:${pad(second)}` : `${pad(minute)}:${pad(second)}`;
}

function traderView(data: Record<string, unknown>, id: string) {
  const name = field(data, "name", "english") || id;
  const portrait = field(data, "image_link", "portrait_link", "icon_link");
  const offers = rows(data.items || data.offers);
  const total = num(data.offer_count) ?? offers.length;
  const pages = Math.max(1, Math.ceil(total / 40));
  const levels = [1, 2, 3, 4].map((level) => {
    const on = traderLevel === String(level);
    return `<button type="button" data-trader-level="${level}" class="${on ? "on" : ""}">LL${level}</button>`;
  }).join("");
  const table = offers.length ? `<table class="wiki-table"><thead><tr><th>名称</th><th>跳蚤</th><th>商人报价</th></tr></thead><tbody>${offers.map((row) => {
    const item = itemId(row);
    const label = itemName(row) || item;
    const icon = iconUrl(field(row, "icon_link", "iconLink"), item);
    const flea = rub(row.last_low_price ?? row.avg24h_price);
    const price = rub(row.price, field(row, "currency") || "RUB");
    const level = field(row, "min_trader_level");
    const unlock = field(row, "task_unlock_id");
    const unlockName = field(row, "task_unlock_name") || "任务解锁";
    return `<tr><td>${icon ? `<img src="${esc(icon)}" alt="" />` : ""}${jump("item", item, label)}</td><td>${esc(flea || "—")}</td><td>${esc(price || "—")}${level ? `<em>LL${esc(level)}</em>` : ""}${unlock ? jump("task", unlock, unlockName) : ""}</td></tr>`;
  }).join("")}</tbody></table>` : `<p class="wiki-note">这个忠诚等级下没有现金报价。</p>`;
  return [
    hero(name, "商人", portrait, field(data, "description")),
    facts([
      ["英文名", esc(field(data, "english"))],
      ["补货", esc(restock(data.reset_time))],
      ["报价", esc(String(total))],
    ]),
    `<form class="wiki-tools" id="trader-find">
      <div class="wiki-levels">${levels}</div>
      <input name="q" value="${esc(traderQuery)}" placeholder="按物品筛选" aria-label="按物品筛选" />
      <button type="submit">筛选</button>
    </form>`,
    table,
    pages > 1 ? `<p class="wiki-actions"><button type="button" data-trader-page="${traderPage - 1}" ${traderPage <= 1 ? "disabled" : ""}>上一页</button><span>${traderPage} / ${pages}</span><button type="button" data-trader-page="${traderPage + 1}" ${traderPage >= pages ? "disabled" : ""}>下一页</button></p>` : "",
  ].join("");
}

function bossView(data: Record<string, unknown>) {
  const boss = rec(data.boss) || data;
  const name = field(boss, "name") || "Boss";
  const image = field(boss, "image_link", "portrait_link", "icon_link", "image");
  const chance = num(boss.spawnChance ?? boss.spawn_chance);
  const locations = rows(boss.locations || data.locations);
  const escorts = rows(boss.escorts || data.escorts);
  const health = rows(boss.health || data.health);
  const maps = rows(boss.maps || data.maps);
  const where = locations.map((row) => {
    const place = field(row, "name", "zoneName", "zone_name");
    const map = mapTitle(field(row, "map_slug", "mapSlug", "slug"), field(row, "mapName", "map_name") || field(rec(row.map) || {}, "name"), "");
    const rate = num(row.chance ?? row.spawnChance ?? row.spawn_chance);
    return [map, place, rate != null ? `${rate}%` : ""].filter(Boolean).join(" · ");
  }).filter(Boolean);
  const mapNames = maps.map((row) => {
    const label = mapTitle(field(row, "slug", "map_slug", "mapSlug"), field(row, "name"), "");
    const rate = num(row.spawnChance ?? row.spawn_chance);
    return [label, rate != null ? `${rate}%` : ""].filter(Boolean).join(" · ");
  }).filter(Boolean);
  const crew = escorts.map((row) => {
    const label = field(row, "name") || field(row, "slug");
    const count = field(row, "count");
    const slug = field(row, "slug", "id");
    const text = count ? `${label} ×${count}` : label;
    return slug ? jump("boss", slug, text) : esc(text);
  });
  const parts = health.map((row) => {
    const part = bodyName(field(row, "bodyPart", "body_part", "name", "id"));
    const max = field(row, "max", "health");
    return part && max ? `${part} ${max}` : part;
  }).filter(Boolean);
  return [
    hero(name, "Boss", image, field(boss, "description")),
    facts([
      ["出生率", chance != null ? esc(`${chance}%`) : ""],
      ["出现地图", esc(mapNames.join("、"))],
    ]),
    section("刷新位置", lines(where.map((item) => esc(item)))),
    section("随从", lines(crew)),
    section("生命值", lines(parts.map((item) => esc(item)))),
  ].join("");
}

function bindTrader(host: HTMLElement, spec: WikiSpec) {
  host.querySelector("#trader-find")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLInputElement>("[name=q]");
    traderQuery = input?.value.trim() || "";
    traderPage = 1;
    void mountWiki(spec);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-trader-level]").forEach((button) => {
    button.addEventListener("click", () => {
      const level = button.dataset.traderLevel || "";
      traderLevel = traderLevel === level ? "" : level;
      traderPage = 1;
      void mountWiki(spec);
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-trader-page]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      traderPage = Math.max(1, Number(button.dataset.traderPage) || 1);
      void mountWiki(spec);
    });
  });
}

export async function mountWiki(spec: WikiSpec) {
  const seq = ++wikiSeq;
  const host = document.querySelector<HTMLElement>("#wiki");
  if (!host || host.getAttribute("data-id") !== spec.id || host.getAttribute("data-kind") !== spec.kind) return;
  if (spec.kind === "trader") {
    if (traderKey !== spec.id) {
      traderKey = spec.id;
      traderLevel = "";
      traderQuery = "";
      traderPage = 1;
    }
  }
  host.innerHTML = spin("正在读取");
  try {
    const path = spec.kind === "item"
      ? `/guides/tarkov/items/${encodeURIComponent(spec.id)}`
      : spec.kind === "task"
        ? `/guides/tarkov/tasks/${encodeURIComponent(spec.id)}`
        : spec.kind === "boss"
          ? `/guides/tarkov/bosses/${encodeURIComponent(spec.id)}`
          : traderPath(spec.id);
    const data = await invoke<Record<string, unknown>>("site_get", { path });
    if (seq !== wikiSeq) return;
    const live = document.querySelector<HTMLElement>("#wiki");
    if (!live || live.getAttribute("data-id") !== spec.id) return;
    let receiver: Record<string, unknown> | null = null;
    if (spec.kind === "item") {
      const receiverId = gunReceiverId(data);
      if (receiverId) {
        receiver = await invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/items/${encodeURIComponent(receiverId)}` }).catch(() => null);
        if (seq !== wikiSeq) return;
      }
    }
    const body = spec.kind === "item"
      ? renderItem(data, receiver)
      : spec.kind === "task"
        ? taskView(data, spec.id)
        : spec.kind === "boss"
          ? bossView(data)
          : traderView(data, spec.id);
    const shown = document.querySelector<HTMLElement>("#wiki");
    if (!shown || shown.getAttribute("data-id") !== spec.id) return;
    shown.innerHTML = body || `<p class="wiki-note">没有读到内容</p>`;
    if (spec.kind === "item") bindItemDetail(shown);
    if (spec.kind === "trader") bindTrader(shown, spec);
  } catch (error) {
    if (seq !== wikiSeq) return;
    const live = document.querySelector("#wiki");
    if (!live || live.getAttribute("data-id") !== spec.id) return;
    const message = error instanceof Error ? error.message : "读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

function traderPath(id: string) {
  const params = new URLSearchParams();
  if (traderLevel) params.set("level", traderLevel);
  if (traderQuery) params.set("q", traderQuery);
  params.set("page", String(traderPage));
  params.set("page_size", "40");
  return `/guides/tarkov/traders/${encodeURIComponent(id)}?${params.toString()}`;
}

type KeyRow = {
  id: string;
  name: string;
  short: string;
  icon: string;
  uses: string;
  price: string;
  detail: string;
  map: string;
};

type KeyGroup = { slug: string; name: string; keys: KeyRow[] };

let seq = 0;
let groups: KeyGroup[] = [];
let owned = new Set<string>();
let ownsReady = false;

export async function loadOwnedKeyIds(): Promise<Set<string> | null> {
  try {
    const data = await invoke<{ item_ids?: string[] }>("site_get", { path: "/guides/tarkov/key-owns" });
    owned = new Set(data.item_ids || []);
    ownsReady = true;
    return owned;
  } catch {
    return ownsReady ? owned : null;
  }
}
let query = "";
let have: "all" | "owned" | "missing" = "all";

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

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function iconOf(icon: string, id: string) {
  if (icon) return icon;
  return /^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-icon.webp` : "";
}

function priceOf(row: Record<string, unknown>) {
  const sources = rec(row.sources);
  const flea = rec(sources?.flea);
  const amount = Number(flea?.price);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return `${Math.round(amount).toLocaleString("zh-CN")} ₽`;
}

function detailOf(row: Record<string, unknown>) {
  const parts = [str(row.description)];
  if (row.access === true) parts.push("入场");
  if (row.needs_power === true) parts.push("需供电");
  const tasks = Array.isArray(row.used_in_tasks) ? row.used_in_tasks : [];
  const names = tasks.flatMap((item) => {
    const task = rec(item);
    const name = str(task?.name);
    return name ? [name] : [];
  }).slice(0, 2);
  if (names.length) parts.push(`任务：${names.join("、")}`);
  return parts.filter(Boolean).join(" · ");
}

function readKey(row: Record<string, unknown>, map: string): KeyRow | null {
  const id = str(row.id);
  const name = str(row.name) || id;
  if (!id || !name) return null;
  const uses = Number(row.uses);
  return {
    id,
    name,
    short: str(row.short_name || row.shortName),
    icon: iconOf(str(row.icon_link || row.iconLink), id),
    uses: Number.isFinite(uses) && uses >= 0 ? (uses === 0 ? "无限" : String(uses)) : "",
    price: priceOf(row),
    detail: detailOf(row),
    map,
  };
}

function readGroup(row: Record<string, unknown>, fallback: string): KeyGroup | null {
  const slug = str(row.slug) || fallback;
  const name = str(row.name) || (fallback === "unbound" ? "未归类" : slug);
  const keys = (Array.isArray(row.keys) ? row.keys : []).flatMap((item) => {
    const key = rec(item);
    const parsed = key ? readKey(key, name) : null;
    return parsed ? [parsed] : [];
  });
  if (!keys.length && fallback !== "unbound") return { slug, name, keys };
  return keys.length || fallback === "unbound" ? { slug, name, keys } : null;
}

export function keyShell() {
  return `<section class="keys" id="keys"><p class="wiki-note">正在读取钥匙…</p></section>`;
}

function visible(slug: string) {
  const group = slug ? groups.find((item) => item.slug === slug) : null;
  const pool = group ? group.keys : groups.flatMap((item) => item.keys);
  const needle = query.trim().toLowerCase();
  return pool.filter((key) => {
    if (have === "owned" && !owned.has(key.id)) return false;
    if (have === "missing" && owned.has(key.id)) return false;
    if (!needle) return true;
    return `${key.name} ${key.short} ${key.detail} ${key.map}`.toLowerCase().includes(needle);
  });
}

function render(slug: string) {
  const side = [`<a class="${slug ? "" : "on"}" href="/主菜单/逃离塔科夫/钥匙" data-link>全部</a>`, ...groups.map((group) => `<a class="${group.slug === slug ? "on" : ""}" href="/主菜单/逃离塔科夫/钥匙/${esc(group.slug)}" data-link>${esc(group.name)}<span>${group.keys.length}</span></a>`)].join("");
  const list = visible(slug);
  const cards = list.map((key) => {
    const mine = owned.has(key.id);
    return `<article class="key-card${mine ? " mine" : ""}">
      <button type="button" class="key-open" data-wiki="item" data-wiki-id="${esc(key.id)}">${key.icon ? `<img src="${esc(key.icon)}" alt="" />` : "<i></i>"}<span><strong>${esc(key.short || key.name)}</strong><em>${esc(key.name)}</em></span></button>
      <p>${esc([key.map, key.uses ? `耐久 ${key.uses}` : "", key.price].filter(Boolean).join(" · "))}</p>
      ${key.detail ? `<p class="key-detail">${esc(key.detail)}</p>` : ""}
      <button type="button" data-key-own="${esc(key.id)}" class="${mine ? "on" : ""}" ${ownsReady ? "" : "disabled"}>${ownsReady ? (mine ? "取消我有" : "标记我有") : "拥有状态未读取"}</button>
    </article>`;
  }).join("");
  return `
    <div class="keys-layout">
      <aside class="keys-side">${side}</aside>
      <div class="keys-main">
        <form id="key-find" class="wiki-tools">
          <input name="q" value="${esc(query)}" placeholder="搜索钥匙、任务或用途" aria-label="搜索钥匙" />
          <button type="submit">搜索</button>
          <button type="button" data-key-have="all" class="${have === "all" ? "on" : ""}">全部</button>
          <button type="button" data-key-have="owned" class="${have === "owned" ? "on" : ""}">已拥有</button>
          <button type="button" data-key-have="missing" class="${have === "missing" ? "on" : ""}">未拥有</button>
        </form>
        ${cards ? `<div class="keys-grid">${cards}</div>` : `<p class="wiki-note">没有符合筛选的钥匙。</p>`}
      </div>
    </div>`;
}

async function toggle(id: string, slug: string) {
  if (!ownsReady) return;
  const next = new Set(owned);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  const previous = owned;
  owned = next;
  paint(slug);
  try {
    const data = await invoke<{ item_ids?: string[] }>("site_put", {
      path: "/guides/tarkov/key-owns",
      body: { item_ids: [...owned] },
    });
    if (Array.isArray(data.item_ids)) owned = new Set(data.item_ids);
    paint(slug);
  } catch (error) {
    owned = previous;
    paint(slug);
    const live = document.querySelector(".keys-main");
    if (!live) return;
    const message = document.createElement("p");
    message.className = "wiki-note";
    message.textContent = error instanceof Error ? error.message : "钥匙拥有保存失败";
    live.prepend(message);
  }
}

function paint(slug: string) {
  const host = document.querySelector<HTMLElement>("#keys");
  if (!host) return;
  host.innerHTML = render(slug);
  host.querySelector("#key-find")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLInputElement>("[name=q]");
    query = input?.value.trim() || "";
    paint(slug);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-key-have]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.keyHave;
      if (next === "owned" || next === "missing" || next === "all") have = next;
      paint(slug);
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-key-own]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.keyOwn || "";
      if (id) void toggle(id, slug);
    });
  });
}

export async function mountKeys(slug: string) {
  const token = ++seq;
  const host = document.querySelector<HTMLElement>("#keys");
  if (!host) return;
  host.innerHTML = `<p class="wiki-note">正在读取钥匙…</p>`;
  try {
    const [packs, owns] = await Promise.all([
      invoke<{ maps?: Record<string, unknown>[]; unbound?: Record<string, unknown>[] }>("site_get", { path: "/guides/tarkov/key-packs" }),
      invoke<{ item_ids?: string[] }>("site_get", { path: "/guides/tarkov/key-owns" }).then((data) => {
        owned = new Set(data.item_ids || []);
        ownsReady = true;
        return data;
      }).catch(() => {
        ownsReady = false;
        owned = new Set();
        return { item_ids: [] as string[] };
      }),
    ]);
    if (token !== seq || !document.querySelector("#keys")) return;
    groups = (packs.maps || []).flatMap((item) => {
      const row = rec(item);
      if (!row) return [];
      const group = readGroup(row, str(row.slug) || "map");
      return group ? [group] : [];
    });
    const loose = (packs.unbound || []).flatMap((item) => {
      const row = rec(item);
      const key = row ? readKey(row, "未归类") : null;
      return key ? [key] : [];
    });
    if (loose.length) groups.push({ slug: "unbound", name: "未归类", keys: loose });
    owned = new Set(owns.item_ids || []);
    paint(groups.some((item) => item.slug === slug) ? slug : "");
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#keys");
    if (!live) return;
    const message = error instanceof Error ? error.message : "钥匙读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

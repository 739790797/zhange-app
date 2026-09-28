const RAW = `
6564b96a189fe36f356d177c 0 battle-pass 战令文件
5b619f1a86f77450a702a6f3 1 quest-items 任务物品
5b5f78b786f77447ed5636af 2 money 货币
5b47574386f77428ca22b343 3 maps 地图
5b47574386f77428ca22b345 4 special-equipment 特殊装备
5b47574386f77428ca22b341 5 info-items 情报物品
5b47574386f77428ca22b342 6 keys 钥匙
5c518ec986f7743b68682ce2 100 - 机械钥匙
5c518ed586f774119a772aee 100 - 电子钥匙
5b47574386f77428ca22b344 7 meds 医疗物品
5b47574386f77428ca22b338 100 - 急救包
5b47574386f77428ca22b337 100 - 药品
5b47574386f77428ca22b339 100 - 创伤处理
5b47574386f77428ca22b33a 100 - 注射器
5b47574386f77428ca22b340 8 provisions 饮食
5b47574386f77428ca22b335 100 - 饮品
5b47574386f77428ca22b336 100 - 食物
5b47574386f77428ca22b346 9 ammo 弹药
5b47574386f77428ca22b33c 100 - 弹药包
5b47574386f77428ca22b33b 100 - 子弹
5b5f78dc86f77409407a7f8e 10 guns 武器
5b5f78fc86f77409407a7f90 100 - 突击步枪
5b5f796a86f774093f2ed3c0 100 - 冲锋枪
5b5f794b86f77409407a7f92 100 - 霰弹枪
5b5f7a2386f774093f2ed3c4 100 - 投掷物
5b5f79a486f77409407a7f94 100 - 机枪
5b5f78e986f77447ed5636b1 100 - 突击卡宾枪
5b5f7a0886f77409407a7f96 100 - 近战武器
5b5f79d186f774093f2ed3c2 100 - 榴弹发射器
5b5f791486f774093f2ed3be 100 - 精确射手步枪
5b5f792486f77447ed5636b3 100 - 手枪
5b5f798886f77447ed5636b5 100 - 栓动式步枪
5b5f79eb86f77447ed5636b7 100 - 特殊武器
5b5f71a686f77447ed5636ab 11 weapon-mods 武器零件&配件
5b5f750686f774093e6cb503 100 - 装备配件
5b5f754a86f774094242f19b 100 - 弹匣
5b5f757486f774093e6cb507 110 - 枪托
5b5f761f86f774094242f1a1 120 - 手枪式握把
5b5f755f86f77447ec5d770e 130 - 导轨
5b5f751486f77447ec5d770c 140 - 拉机柄
5b5f752e86f774093e6cb505 150 - 榴弹发射器
5b5f71b386f774093f2ecf11 110 - 功能模块
5b5f73ec86f774093e6cb4fd 100 - 瞄具
5b5f740a86f77447ec5d7706 100 - 突击瞄准镜
5b5f742686f774093e6cb4ff 110 - 反射式瞄具
5b5f744786f774094242f197 120 - 小型反射式瞄具
5b5f746686f77447ec5d7708 130 - 机械瞄具
5b5f748386f774093e6cb501 140 - 光学瞄具
5b5f749986f774094242f199 150 - 特殊瞄具
5b5f724186f77447ed5636ad 110 - 枪口装置
5b5f724c86f774093f2ecf15 100 - 消焰器及制退器
5b5f72f786f77447ec5d7702 110 - 枪口转接器
5b5f731a86f774093e6cb4f9 120 - 消音器
5b5f736886f774094242f193 120 - 照明激光设备
5b5f73ab86f774094242f195 100 - 手电筒
5b5f73c486f77447ec5d7704 110 - 激光瞄准模块
5b5f737886f774093e6cb4fb 130 - 战术组合设备
5b5f71de86f774093f2ecf13 140 - 前握把
5b5f71c186f77409407a7ec0 150 - 两脚架
5b5f74cc86f77447ec5d770a 160 - 辅助零件
5b5f75b986f77447ec5d7710 120 - 基础部件
5b5f75c686f774094242f19f 100 - 枪管
5b5f75e486f77447ec5d7712 110 - 护木
5b5f760586f774093e6cb509 120 - 导气箍
5b5f764186f77447ec5d7714 130 - 机匣和套筒
5b47574386f77428ca22b33f 12 gear 装备
5b47574386f77428ca22b330 100 - 头部装备
5b47574386f77428ca22b331 110 - 眼部装备
5b47574386f77428ca22b32f 120 - 面部装备
5b5f6f8786f77447ed563642 130 - 战术胸挂
5b5f701386f774093f2ecf0f 140 - 防弹衣
5b5f6f3c86f774094242ef87 150 - 耳机
5b5f6f6c86f774093f2ecf0b 160 - 背包
5b5f6fa186f77409407a7eb7 170 - 容器
5b5f6fd286f774093f2ecf0d 180 - 安全箱
5b5f704686f77447ec5d76d7 190 - 装备组件
5b47574386f77428ca22b33e 13 barter 交换用物品
5b47574386f77428ca22b2f6 100 - 工具
5b47574386f77428ca22b2f0 100 - 日常用品
5b47574386f77428ca22b2ed 100 - 能源物品
5b47574386f77428ca22b2f1 100 - 贵重物品
5b47574386f77428ca22b2ef 100 - 电子产品
5b47574386f77428ca22b2f2 100 - 易燃物品
5b47574386f77428ca22b2f3 100 - 医疗用品
5b47574386f77428ca22b2ee 100 - 建筑材料
5b47574386f77428ca22b2f4 110 - 其他
`;

type Row = { id: string; order: number; slug: string; label: string };
type Group = Row & { kids: Row[] };

export type CatalogSpec = { slug: string; child: string };

const PAGE = 48;
const groups: Group[] = [];
for (const line of RAW.trim().split("\n")) {
  const [id, order, slug, ...label] = line.trim().split(" ");
  const row = { id, order: Number(order), slug: slug === "-" ? "" : slug, label: label.join(" ") };
  if (row.slug) groups.push({ ...row, kids: [] });
  else groups[groups.length - 1]?.kids.push(row);
}

let seq = 0;
let query = "";
let page = 1;
let key = "";

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function groupOf(slug: string) {
  return groups.find((item) => item.slug === slug) || null;
}

function idsOf(group: Group | null, child: string) {
  if (!group) return [];
  if (!child) return [group.id, ...group.kids.map((item) => item.id)];
  return group.kids.some((item) => item.id === child) ? [child] : [group.id];
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
  if (slug && !groupOf(slug)) return { slug: "", child: "" };
  return { slug, child };
}

export function catalogShell() {
  return `<section class="catalog" id="catalog"><p class="wiki-note">正在读取物品…</p></section>`;
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
  const amount = Number(row.last_low_price ?? row.avg24h_price ?? row.lastLowPrice ?? row.avg24hPrice);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return `${Math.round(amount).toLocaleString("zh-CN")} ₽`;
}

function render(spec: CatalogSpec, data: Record<string, unknown>) {
  const group = groupOf(spec.slug);
  const items = Array.isArray(data.items) ? data.items : [];
  const total = Number(data.item_count ?? data.itemCount ?? items.length);
  const pages = Math.max(1, Math.ceil((Number.isFinite(total) ? total : items.length) / PAGE));
  const side = [`<button type="button" data-catalog="" class="${spec.slug ? "" : "on"}">全部</button>`, ...groups.map((item) => `<button type="button" data-catalog="${esc(item.slug)}" class="${item.slug === spec.slug ? "on" : ""}">${esc(item.label)}</button>`)].join("");
  const kids = group?.kids.length
    ? `<div class="catalog-kids"><button type="button" data-catalog="${esc(group.slug)}" class="${spec.child ? "" : "on"}">全部${esc(group.label)}</button>${group.kids.map((item) => `<button type="button" data-catalog="${esc(group.slug)}" data-catalog-child="${esc(item.id)}" class="${spec.child === item.id ? "on" : ""}">${esc(item.label)}</button>`).join("")}</div>`
    : "";
  const cards = items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id || "").trim();
    const name = String(row.name || row.short_name || id).trim();
    if (!id || !name) return [];
    const short = String(row.short_name || row.shortName || "").trim();
    const icon = iconOf(String(row.icon_link || row.iconLink || ""), id);
    const price = priceOf(row);
    return [`<button type="button" class="catalog-card" data-wiki="item" data-wiki-id="${esc(id)}">${icon ? `<img src="${esc(icon)}" alt="" />` : "<i></i>"}<span><strong>${esc(name)}</strong>${short && short !== name ? `<em>${esc(short)}</em>` : ""}${price ? `<b>${esc(price)}</b>` : ""}</span></button>`];
  }).join("");
  return `
    <div class="catalog-layout">
      <aside class="catalog-side">${side}</aside>
      <div class="catalog-main">
        <form class="wiki-tools" id="catalog-find">
          <input name="q" value="${esc(query)}" placeholder="在当前分类里搜物品" aria-label="搜索物品" />
          <button type="submit">搜索</button>
        </form>
        ${kids}
        ${cards ? `<div class="catalog-grid">${cards}</div>` : `<p class="wiki-note">这个分类下没有物品。</p>`}
        ${pages > 1 ? `<p class="wiki-actions"><button type="button" data-catalog-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button><span>${page} / ${pages} · ${Number.isFinite(total) ? total : items.length} 件</span><button type="button" data-catalog-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button></p>` : `<p class="wiki-note">${Number.isFinite(total) ? total : items.length} 件</p>`}
      </div>
    </div>`;
}

function bind(host: HTMLElement, spec: CatalogSpec) {
  host.querySelector("#catalog-find")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLInputElement>("[name=q]");
    query = input?.value.trim() || "";
    page = 1;
    void mountCatalog(spec);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-catalog-page]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      page = Math.max(1, Number(button.dataset.catalogPage) || 1);
      void mountCatalog(spec);
    });
  });
}

export async function mountCatalog(spec: CatalogSpec) {
  const token = ++seq;
  const nextKey = `${spec.slug}/${spec.child}`;
  if (key !== nextKey) {
    key = nextKey;
    page = 1;
  }
  const host = document.querySelector<HTMLElement>("#catalog");
  if (!host) return;
  host.innerHTML = `<p class="wiki-note">正在读取物品…</p>`;
  const group = groupOf(spec.slug);
  const ids = idsOf(group, spec.child);
  const params = new URLSearchParams();
  if (ids.length) params.set("category_ids", ids.join(","));
  if (query) params.set("q", query);
  params.set("page", String(page));
  params.set("page_size", String(PAGE));
  try {
    const data = await invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/items?${params.toString()}` });
    if (token !== seq) return;
    const live = document.querySelector<HTMLElement>("#catalog");
    if (!live) return;
    live.innerHTML = render(spec, data);
    bind(live, spec);
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#catalog");
    if (!live) return;
    const message = error instanceof Error ? error.message : "物品读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

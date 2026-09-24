const BASE = "/主菜单/战鸽酒馆";
const SITE = "https://zhange.space";
const PAGE_SIZE = 10;

type Category = { slug: string; name: string; chip_color?: string };
type Author = { display_name?: string; avatar_url?: string };
type ArticleCard = {
  slug: string;
  title: string;
  summary?: string;
  published_at?: string;
  comment_count?: number;
  author?: Author;
  categories?: Category[];
};
type ArticlePage = {
  items?: ArticleCard[];
  total?: number;
  page?: number;
  page_size?: number;
};
type ArticleDetail = ArticleCard & { body?: string; body_format?: string; tags?: { name: string }[] };
type Comment = {
  id: number;
  body: string;
  parent_id: number | null;
  created_at?: string;
  author?: Author;
};

type ListQuery = { q: string; category: string; page: number };

const ALLOWED = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "code", "pre",
  "ul", "ol", "li", "a", "img", "figure", "figcaption", "hr", "br", "blockquote", "span",
]);

let replyTo = 0;

export function tavernMatch(pathname: string): { kind: "list" } | { kind: "article"; slug: string } | null {
  if (pathname === BASE) return { kind: "list" };
  if (!pathname.startsWith(`${BASE}/`)) return null;
  const slug = pathname.slice(BASE.length + 1).split("/")[0];
  return slug ? { kind: "article", slug } : { kind: "list" };
}

export function tavernListHref(query: Partial<ListQuery> = {}) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  const text = params.toString();
  return text ? `${BASE}?${text}` : BASE;
}

function listQuery(): ListQuery {
  const params = new URLSearchParams(location.search);
  const page = Number(params.get("page") || "1");
  return {
    q: (params.get("q") || "").trim(),
    category: params.get("category") || "",
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function safeUrl(value: string, image: boolean) {
  const raw = value.trim();
  if (!raw || raw.startsWith("//") || /^javascript:/i.test(raw) || /^data:/i.test(raw)) return "";
  if (raw.startsWith("/")) return `${SITE}${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (image && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function sanitizeHtml(html: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node: Node): string => {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += esc(child.textContent || "");
        return;
      }
      if (!(child instanceof Element)) return;
      const tag = child.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "iframe" || tag === "object") return;
      if (!ALLOWED.has(tag)) {
        out += walk(child);
        return;
      }
      if (tag === "br" || tag === "hr") {
        out += `<${tag}>`;
        return;
      }
      if (tag === "img") {
        const src = safeUrl(child.getAttribute("src") || "", true);
        if (!src) return;
        const alt = esc(child.getAttribute("alt") || "");
        out += `<img src="${esc(src)}" alt="${alt}">`;
        return;
      }
      if (tag === "a") {
        const href = safeUrl(child.getAttribute("href") || "", false);
        const inner = walk(child);
        out += href
          ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
          : inner;
        return;
      }
      if (tag === "code") {
        const lang = child.getAttribute("class") || "";
        const klass = /^language-[a-z0-9+-]+$/i.test(lang) ? ` class="${lang}"` : "";
        out += `<code${klass}>${walk(child)}</code>`;
        return;
      }
      out += `<${tag}>${walk(child)}</${tag}>`;
    });
    return out;
  };
  return walk(doc.body);
}

export function tavernListHtml() {
  const query = listQuery();
  return `
    <section class="tavern" id="tavern-page">
      <header class="tavern-hero">
        <h1>战鸽酒馆</h1>
        <p>圈子里的文章与随笔</p>
        <form class="tavern-search" id="tavern-search">
          <input name="q" value="${esc(query.q)}" placeholder="输入文章标题" aria-label="搜索文章" />
          <button type="submit">搜索</button>
        </form>
      </header>
      <div class="tavern-board">
        <div class="tavern-feed" id="tavern-feed"><p class="tavern-note">正在读取文章…</p></div>
        <aside class="tavern-side" id="tavern-cats"></aside>
      </div>
    </section>`;
}

export function tavernArticleHtml() {
  return `<article class="tavern-read" id="tavern-page"><p class="tavern-note">正在读取文章…</p></article>`;
}

function cardHtml(item: ArticleCard) {
  const category = item.categories?.[0];
  const chip = category
    ? `<button type="button" class="tavern-chip" data-tavern-cat="${esc(category.slug)}" style="--chip:${esc(category.chip_color || "#8a7344")}">${esc(category.name)}</button>`
    : "";
  const summary = item.summary?.trim() ? `<p>${esc(item.summary)}</p>` : "";
  const meta = [item.author?.display_name, formatDate(item.published_at), `${item.comment_count ?? 0} 条评论`].filter(Boolean).join(" · ");
  return `
    <article class="tavern-card">
      <div class="tavern-card-title">${chip}<a href="${BASE}/${esc(item.slug)}" data-link>${esc(item.title)}</a></div>
      ${summary}
      <span>${esc(meta)}</span>
    </article>`;
}

function pagerHtml(page: number, total: number) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return "";
  const prev = page > 1 ? `<button type="button" data-tavern-page="${page - 1}">上一页</button>` : "";
  const next = page < pages ? `<button type="button" data-tavern-page="${page + 1}">下一页</button>` : "";
  return `<div class="tavern-pager">${prev}<span>${page} / ${pages}</span>${next}</div>`;
}

function catsHtml(items: Category[], active: string) {
  const all = `<button type="button" data-tavern-cat="" class="${active ? "" : "on"}">全部</button>`;
  const rest = items.map((item) =>
    `<button type="button" data-tavern-cat="${esc(item.slug)}" class="${active === item.slug ? "on" : ""}"><i style="background:${esc(item.chip_color || "#8a7344")}"></i>${esc(item.name)}</button>`,
  ).join("");
  return `<h2>分类</h2><div class="tavern-cats">${all}${rest}</div>`;
}

export async function mountTavernList() {
  const query = listQuery();
  const feed = document.querySelector("#tavern-feed");
  const side = document.querySelector("#tavern-cats");
  if (!feed) return;
  const params = new URLSearchParams({ page: String(query.page), page_size: String(PAGE_SIZE) });
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  try {
    const [data, categories] = await Promise.all([
      invoke<ArticlePage>("site_get", { path: `/articles?${params}` }),
      invoke<Category[]>("site_get", { path: "/articles/categories" }).catch(() => []),
    ]);
    if (!document.querySelector("#tavern-feed")) return;
    const items = Array.isArray(data.items) ? data.items : [];
    feed.innerHTML = items.length
      ? `${items.map(cardHtml).join("")}${pagerHtml(data.page || query.page, data.total || 0)}`
      : `<p class="tavern-note">${query.q || query.category ? "没有符合筛选的文章。" : "大厅里暂时还没有已发布的文章。"}</p>`;
    if (side) side.innerHTML = catsHtml(Array.isArray(categories) ? categories : [], query.category);
  } catch (error) {
    feed.innerHTML = `<p class="tavern-note">${esc(error instanceof Error ? error.message : "无法加载文章")}</p>`;
  }
}

function commentHtml(item: Comment, nested: boolean) {
  const name = item.author?.display_name || "读者";
  return `
    <li class="${nested ? "nested" : ""}">
      <strong>${esc(name)}</strong>
      <time>${esc(formatDate(item.created_at))}</time>
      <p>${esc(item.body)}</p>
      <button type="button" data-tavern-reply="${item.parent_id || item.id}">回复</button>
    </li>`;
}

function commentsHtml(items: Comment[], loggedIn: boolean) {
  const listIn = Array.isArray(items) ? items : [];
  const roots = listIn.filter((item) => !item.parent_id);
  const list = roots.flatMap((item) => [item, ...listIn.filter((child) => child.parent_id === item.id)]);
  const thread = list.length
    ? `<ul class="tavern-comments">${list.map((item) => commentHtml(item, Boolean(item.parent_id))).join("")}</ul>`
    : `<p class="tavern-note">还没有评论</p>`;
  const form = loggedIn
    ? `<form class="tavern-comment" id="tavern-comment">
        <p id="tavern-reply" hidden></p>
        <textarea name="body" rows="4" maxlength="2000" placeholder="写一条评论"></textarea>
        <button type="submit">发表</button>
      </form>`
    : `<p class="tavern-note">登录后可以评论</p>`;
  return `<section class="tavern-talk"><h2>评论</h2>${thread}${form}</section>`;
}

export async function mountTavernArticle(slug: string) {
  const host = document.querySelector("#tavern-page");
  if (!host) return;
  try {
    const [article, comments, session] = await Promise.all([
      invoke<ArticleDetail>("site_get", { path: `/articles/${encodeURIComponent(slug)}` }),
      invoke<Comment[]>("site_get", { path: `/articles/${encodeURIComponent(slug)}/comments` }).catch(() => []),
      invoke<{ loggedIn?: boolean }>("site_session").catch(() => ({ loggedIn: false })),
    ]);
    if (!document.querySelector("#tavern-page")) return;
    replyTo = 0;
    const tags = [...(article.categories || []).map((item) => item.name), ...(article.tags || []).map((item) => item.name)];
    const body = article.body_format === "html"
      ? sanitizeHtml(article.body || "")
      : `<p>${esc(article.body || "暂无正文")}</p>`;
    host.innerHTML = `
      <a class="tavern-back" href="${BASE}" data-link>战鸽酒馆</a>
      <h1>${esc(article.title)}</h1>
      <p class="tavern-meta">${esc([article.author?.display_name, formatDate(article.published_at)].filter(Boolean).join(" · "))}</p>
      ${tags.length ? `<p class="tavern-tags">${tags.map((name) => `<span>${esc(name)}</span>`).join("")}</p>` : ""}
      <div class="tavern-body">${body || "<p>暂无正文</p>"}</div>
      ${commentsHtml(comments || [], Boolean(session.loggedIn))}`;
  } catch (error) {
    host.innerHTML = `<a class="tavern-back" href="${BASE}" data-link>战鸽酒馆</a><p class="tavern-note">${esc(error instanceof Error ? error.message : "文章不存在或无法加载")}</p>`;
  }
}

export function tavernSearchHref(form: HTMLFormElement) {
  const query = listQuery();
  const q = String(new FormData(form).get("q") || "").trim();
  return tavernListHref({ q, category: query.category, page: 1 });
}

export function tavernCategoryHref(category: string) {
  const query = listQuery();
  return tavernListHref({ q: query.q, category, page: 1 });
}

export function tavernPageHref(page: number) {
  const query = listQuery();
  return tavernListHref({ ...query, page });
}

export function setTavernReply(id: number) {
  replyTo = id;
  const note = document.querySelector<HTMLElement>("#tavern-reply");
  if (!note) return;
  note.hidden = false;
  note.textContent = `回复评论 #${id}`;
}

export async function submitTavernComment(slug: string, form: HTMLFormElement) {
  const body = String(new FormData(form).get("body") || "").trim();
  const note = form.querySelector("p");
  if (!body) return;
  const button = form.querySelector("button");
  if (button) button.setAttribute("disabled", "");
  try {
    await invoke("site_post", {
      path: `/articles/${encodeURIComponent(slug)}/comments`,
      body: replyTo ? { body, parent_id: replyTo } : { body },
    });
    replyTo = 0;
    await mountTavernArticle(slug);
  } catch (error) {
    if (button) button.removeAttribute("disabled");
    if (note instanceof HTMLElement) {
      note.hidden = false;
      note.textContent = error instanceof Error ? error.message : "发表失败";
    }
  }
}

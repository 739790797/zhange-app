import { invoke } from "./tauriBridge";
import { spin } from "./spinner";
import { TAVERN_BASE as BASE, tavernMatch } from "./routePath";
import {
  boundTavernBody,
  limitTavernText,
  MAX_TAVERN_BODY_CHARS,
  MAX_TAVERN_COMMENTS,
  normalizeTavernComments,
  orderTavernComments,
  type TavernComment,
} from "./tavernData";

export { tavernMatch } from "./routePath";

const SITE = "https://zhange.space";
const IMAGE_HOSTS = new Set(["zhange.space", "assets.tarkov.dev", "tarkov.dev"]);
const PAGE_SIZE = 10;
const MAX_TAVERN_CATEGORIES = 64;
const MAX_ARTICLE_TAGS = 64;

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
type ArticleDetail = ArticleCard & {
  body?: string;
  body_format?: string;
  tags?: { name: string }[];
};
type ListQuery = { q: string; category: string; page: number };

const ALLOWED = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "a",
  "img",
  "figure",
  "figcaption",
  "hr",
  "br",
  "blockquote",
  "span",
]);

let replyTo = 0;
let listRequestGeneration = 0;
let articleRequestGeneration = 0;

function routeKey() {
  return `${location.pathname}${location.search}`;
}

function currentListRequest(generation: number, expectedRoute: string, feed: Element) {
  return (
    generation === listRequestGeneration &&
    expectedRoute === routeKey() &&
    tavernMatch(location.pathname)?.kind === "list" &&
    feed.isConnected &&
    document.querySelector("#tavern-feed") === feed
  );
}

function currentArticleRequest(
  generation: number,
  slug: string,
  expectedRoute: string,
  host: Element,
) {
  return (
    generation === articleRequestGeneration &&
    currentArticleRoute(slug, expectedRoute) &&
    host.isConnected &&
    document.querySelector("#tavern-page") === host
  );
}

function currentArticleRoute(slug: string, expectedRoute: string) {
  const route = tavernMatch(location.pathname);
  return expectedRoute === routeKey() && route?.kind === "article" && route.slug === slug;
}

export function tavernListHref(query: Partial<ListQuery> = {}) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", limitTavernText(query.q, 200));
  if (query.category) params.set("category", limitTavernText(query.category, 256));
  if (query.page && query.page > 1) params.set("page", String(query.page));
  const text = params.toString();
  return text ? `${BASE}?${text}` : BASE;
}

function listQuery(): ListQuery {
  const params = new URLSearchParams(location.search);
  const page = Number(params.get("page") || "1");
  return {
    q: limitTavernText(params.get("q") || "", 200).trim(),
    category: limitTavernText(params.get("category") || "", 256),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function esc(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char,
  );
}

function safePositiveInteger(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && /^\d{1,16}$/.test(value)) parsed = Number(value);
  else return null;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeNonNegativeInteger(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && /^\d{1,16}$/.test(value)) parsed = Number(value);
  else return null;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeChipColor(value: unknown) {
  if (typeof value !== "string") return "#8a7344";
  const color = value.trim();
  if (
    !color ||
    color.length > 64 ||
    /[;{}<>"'\\\u0000-\u001f]/.test(color) ||
    !CSS.supports("color", color)
  ) {
    return "#8a7344";
  }
  return color;
}

function formatDate(value?: unknown) {
  if (typeof value !== "string" || !value) return "";
  const bounded = value.slice(0, 128);
  const date = new Date(bounded);
  if (Number.isNaN(date.getTime())) return bounded.slice(0, 10);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function safeUrl(value: string, image: boolean) {
  const raw = value.trim();
  if (
    !raw ||
    raw.length > 2048 ||
    /[\u0000-\u001f\u007f\\]/.test(raw) ||
    raw.startsWith("//") ||
    /^javascript:/i.test(raw) ||
    /^data:/i.test(raw)
  )
    return "";
  if (raw.startsWith("/")) return `${SITE}${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (image && url.protocol !== "https:") return "";
    if (url.username || url.password || (image && !IMAGE_HOSTS.has(url.hostname.toLowerCase())))
      return "";
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
          <input name="q" maxlength="200" value="${esc(query.q)}" placeholder="输入文章标题" aria-label="搜索文章" />
          <button type="submit">搜索</button>
        </form>
      </header>
      <div class="tavern-board">
        <div class="tavern-feed" id="tavern-feed">${spin("正在读取文章")}</div>
        <aside class="tavern-side" id="tavern-cats"></aside>
      </div>
    </section>`;
}

export function tavernArticleHtml() {
  return `<article class="tavern-read" id="tavern-page">${spin("正在读取文章")}</article>`;
}

function cardHtml(item: ArticleCard) {
  const rawCategory = item.categories?.[0];
  const category = rawCategory
    ? {
        slug: limitTavernText(rawCategory.slug, 256),
        name: limitTavernText(rawCategory.name, 128),
        chip_color: rawCategory.chip_color,
      }
    : undefined;
  const slug = limitTavernText(item.slug, 256).trim();
  const title = limitTavernText(item.title, 512);
  const chip = category
    ? `<button type="button" class="tavern-chip" data-tavern-cat="${esc(category.slug)}" style="--chip:${safeChipColor(category.chip_color)}">${esc(category.name)}</button>`
    : "";
  const summaryText = limitTavernText(item.summary, 3_000).trim();
  const summary = summaryText ? `<p>${esc(summaryText)}</p>` : "";
  const author = limitTavernText(item.author?.display_name, 128);
  const commentCount = safeNonNegativeInteger(item.comment_count) ?? 0;
  const meta = [author, formatDate(item.published_at), `${commentCount} 条评论`]
    .filter(Boolean)
    .join(" · ");
  return `
    <article class="tavern-card">
      <div class="tavern-card-title">${chip}<a href="${BASE}/${encodeURIComponent(slug)}" data-link>${esc(title)}</a></div>
      ${summary}
      <span>${esc(meta)}</span>
    </article>`;
}

function pagerHtml(pageValue: unknown, totalValue: unknown, fallbackPage: number) {
  const total = safeNonNegativeInteger(totalValue) ?? 0;
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return "";
  const requestedPage = safePositiveInteger(pageValue) ?? safePositiveInteger(fallbackPage) ?? 1;
  const page = Math.min(requestedPage, pages);
  const prev =
    page > 1 ? `<button type="button" data-tavern-page="${page - 1}">上一页</button>` : "";
  const next =
    page < pages ? `<button type="button" data-tavern-page="${page + 1}">下一页</button>` : "";
  return `<div class="tavern-pager">${prev}<span>${page} / ${pages}</span>${next}</div>`;
}

function catsHtml(rawItems: unknown, active: string) {
  const all = `<button type="button" data-tavern-cat="" class="${active ? "" : "on"}">全部</button>`;
  const items = Array.isArray(rawItems)
    ? rawItems
        .slice(0, MAX_TAVERN_CATEGORIES)
        .filter((item): item is Category =>
          Boolean(
            item &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof item.slug === "string" &&
              item.slug.trim() &&
              typeof item.name === "string",
          ),
        )
    : [];
  const rest = items
    .map((item) => {
      const slug = limitTavernText(item.slug, 256);
      const name = limitTavernText(item.name, 128);
      return `<button type="button" data-tavern-cat="${esc(slug)}" class="${active === slug ? "on" : ""}"><i style="background:${safeChipColor(item.chip_color)}"></i>${esc(name)}</button>`;
    })
    .join("");
  return `<h2>分类</h2><div class="tavern-cats">${all}${rest}</div>`;
}

export async function mountTavernList() {
  const generation = ++listRequestGeneration;
  const expectedRoute = routeKey();
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
      invoke<unknown>("site_get", { path: "/articles/categories" }).catch(() => []),
    ]);
    if (!currentListRequest(generation, expectedRoute, feed)) return;
    const items = Array.isArray(data.items)
      ? data.items
          .slice(0, PAGE_SIZE)
          .filter(
            (item) => item && typeof item === "object" && limitTavernText(item.slug, 256).trim(),
          )
      : [];
    feed.innerHTML = items.length
      ? `${items.map(cardHtml).join("")}${pagerHtml(data.page ?? query.page, data.total ?? 0, query.page)}`
      : `<p class="tavern-note">${query.q || query.category ? "没有符合筛选的文章。" : "大厅里暂时还没有已发布的文章。"}</p>`;
    if (side?.isConnected && document.querySelector("#tavern-cats") === side) {
      side.innerHTML = catsHtml(categories, query.category);
    }
  } catch (error) {
    if (!currentListRequest(generation, expectedRoute, feed)) return;
    feed.innerHTML = `<p class="tavern-note">${esc(error instanceof Error ? error.message : "无法加载文章")}</p>`;
  }
}

function commentHtml(item: TavernComment, nested: boolean) {
  const name = item.author?.display_name || "读者";
  const replyId = safePositiveInteger(item.parent_id) ?? safePositiveInteger(item.id);
  const replyButton =
    replyId == null ? "" : `<button type="button" data-tavern-reply="${replyId}">回复</button>`;
  return `
    <li class="${nested ? "nested" : ""}">
      <strong>${esc(name)}</strong>
      <time>${esc(formatDate(item.created_at))}</time>
      <p>${esc(item.body)}</p>
      ${replyButton}
    </li>`;
}

function commentsHtml(raw: unknown, loggedIn: boolean, loadFailed = false) {
  const normalized = normalizeTavernComments(raw);
  const list = orderTavernComments(normalized.items);
  const thread = loadFailed
    ? `<p class="tavern-note">评论暂时无法加载，请稍后重试。</p>`
    : list.length
      ? `<ul class="tavern-comments">${list.map((item) => commentHtml(item, Boolean(item.parent_id))).join("")}</ul>`
      : `<p class="tavern-note">还没有评论</p>`;
  const truncated = normalized.truncated
    ? `<p class="tavern-note">评论较多，仅显示前 ${MAX_TAVERN_COMMENTS} 条。</p>`
    : "";
  const form = loggedIn
    ? `<form class="tavern-comment" id="tavern-comment">
        <p id="tavern-reply" hidden></p>
        <textarea name="body" rows="4" maxlength="2000" placeholder="写一条评论"></textarea>
        <button type="submit">发表</button>
      </form>`
    : `<p class="tavern-note">登录后可以评论</p>`;
  return `<section class="tavern-talk"><h2>评论</h2>${thread}${truncated}${form}</section>`;
}

export async function mountTavernArticle(slug: string) {
  const generation = ++articleRequestGeneration;
  const expectedRoute = routeKey();
  const host = document.querySelector("#tavern-page");
  if (!host) return;
  if (!currentArticleRequest(generation, slug, expectedRoute, host)) return;
  try {
    const [article, commentsResult, session] = await Promise.all([
      invoke<ArticleDetail>("site_get", { path: `/articles/${encodeURIComponent(slug)}` }),
      invoke<unknown>("site_get", { path: `/articles/${encodeURIComponent(slug)}/comments` }).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const, value: null }),
      ),
      invoke<{ loggedIn?: boolean }>("site_session").catch(() => ({ loggedIn: false })),
    ]);
    if (!currentArticleRequest(generation, slug, expectedRoute, host)) return;
    replyTo = 0;
    const categories = Array.isArray(article.categories)
      ? article.categories.slice(0, MAX_ARTICLE_TAGS)
      : [];
    const articleTags = Array.isArray(article.tags) ? article.tags.slice(0, MAX_ARTICLE_TAGS) : [];
    const tags = [...categories, ...articleTags]
      .map((item) => (typeof item?.name === "string" ? item.name.slice(0, 128) : ""))
      .filter(Boolean)
      .slice(0, MAX_ARTICLE_TAGS);
    const boundedBody = boundTavernBody(article.body);
    const body =
      article.body_format === "html"
        ? sanitizeHtml(boundedBody.text)
        : `<p>${esc(boundedBody.text || "暂无正文")}</p>`;
    const bodyNote = boundedBody.truncated
      ? `<p class="tavern-note">正文过长，仅显示前 ${MAX_TAVERN_BODY_CHARS.toLocaleString()} 个字符。</p>`
      : "";
    host.innerHTML = `
      <a class="tavern-back" href="${BASE}" data-link>战鸽酒馆</a>
      <h1>${esc(limitTavernText(article.title, 512))}</h1>
      <p class="tavern-meta">${esc([limitTavernText(article.author?.display_name, 128), formatDate(article.published_at)].filter(Boolean).join(" · "))}</p>
      ${tags.length ? `<p class="tavern-tags">${tags.map((name) => `<span>${esc(name)}</span>`).join("")}</p>` : ""}
      <div class="tavern-body">${body || "<p>暂无正文</p>"}${bodyNote}</div>
      ${commentsHtml(commentsResult.value, Boolean(session.loggedIn), !commentsResult.ok)}`;
  } catch (error) {
    if (!currentArticleRequest(generation, slug, expectedRoute, host)) return;
    host.innerHTML = `<a class="tavern-back" href="${BASE}" data-link>战鸽酒馆</a><p class="tavern-note">${esc(error instanceof Error ? error.message : "文章不存在或无法加载")}</p>`;
  }
}

export function tavernSearchHref(form: HTMLFormElement) {
  const query = listQuery();
  const q = limitTavernText(String(new FormData(form).get("q") || ""), 200).trim();
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
  const generation = articleRequestGeneration;
  const expectedRoute = routeKey();
  const host = document.querySelector("#tavern-page");
  if (!host || !currentArticleRequest(generation, slug, expectedRoute, host)) return;
  const isCurrentPage = () => currentArticleRequest(generation, slug, expectedRoute, host);
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
    if (!currentArticleRoute(slug, expectedRoute)) return;
    replyTo = 0;
    await mountTavernArticle(slug);
  } catch (error) {
    if (!isCurrentPage()) return;
    if (button) button.removeAttribute("disabled");
    if (note instanceof HTMLElement) {
      note.hidden = false;
      note.textContent = error instanceof Error ? error.message : "发表失败";
    }
  }
}

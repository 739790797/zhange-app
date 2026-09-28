export function traderShell() {
  return `<section class="trader-list" id="trader-list"><p class="wiki-note">正在读取商人…</p></section>`;
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function portrait(row: Record<string, unknown>, slug: string) {
  const link = String(row.portrait_link || row.image_link || row.icon_link || "").trim();
  if (link) return link;
  return slug ? `https://tarkov.dev/images/traders/${encodeURIComponent(slug)}-portrait.png` : "";
}

let seq = 0;

export async function mountTraders() {
  const token = ++seq;
  const host = document.querySelector<HTMLElement>("#trader-list");
  if (!host) return;
  host.innerHTML = `<p class="wiki-note">正在读取商人…</p>`;
  try {
    const data = await invoke<{ items?: Record<string, unknown>[] }>("site_get", { path: "/guides/tarkov/traders" });
    const live = document.querySelector<HTMLElement>("#trader-list");
    if (token !== seq || !live) return;
    const cards = (data.items || []).flatMap((row) => {
      const slug = String(row.slug || row.id || "").trim();
      const english = String(row.english || row.name || slug).trim();
      const name = String(row.name || "").trim();
      if (!slug || !english) return [];
      const count = Number(row.offer_count);
      const offers = Number.isFinite(count) && count > 0 ? `${count} 条报价` : "无现金报价";
      const image = portrait(row, slug);
      const title = name && name !== english ? name : "";
      return [`<button type="button" class="trader-card" data-wiki="trader" data-wiki-id="${esc(slug)}">${image ? `<img src="${esc(image)}" alt="" />` : "<i></i>"}<strong>${esc(english)}</strong>${title ? `<em>${esc(title)}</em>` : ""}<span>${esc(offers)}</span></button>`];
    }).join("");
    live.innerHTML = cards
      ? `<p class="wiki-note">点进商人查看忠诚等级和现金报价。</p><div class="trader-grid">${cards}</div>`
      : `<p class="wiki-note">没有读到商人</p>`;
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#trader-list");
    if (!live) return;
    const message = error instanceof Error ? error.message : "商人读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

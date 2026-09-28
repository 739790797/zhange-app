import { pushNav } from "./navHistory";
import { spin } from "./spinner";

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

export function listIcon(src = "") {
  if (!src) return `<span class="tarkov-list-icon"></span>`;
  return `<span class="tarkov-list-icon"><img src="${esc(src)}" alt="" /></span>`;
}

export function listAllIcon() {
  return `<span class="tarkov-list-icon"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.25" y="1.25" width="5.5" height="5.5" rx="0.6"></rect><rect x="9.25" y="1.25" width="5.5" height="5.5" rx="0.6"></rect><rect x="1.25" y="9.25" width="5.5" height="5.5" rx="0.6"></rect><rect x="9.25" y="9.25" width="5.5" height="5.5" rx="0.6"></rect></svg></span>`;
}

export function listItem(label: string, on: boolean, attrs: string, icon = "") {
  const tag = /\bhref=/.test(attrs) ? "a" : "button";
  const type = tag === "button" ? ` type="button"` : "";
  return `<div class="tarkov-list-row"><span class="tarkov-list-caret-slot"></span><${tag}${type} class="tarkov-list-item${on ? " on" : ""}" ${attrs}>${icon || listIcon()}<span>${label}</span></${tag}></div>`;
}

export function listShell(id: string, label: string) {
  return `<section class="tarkov-list" id="${esc(id)}">${spin(label)}</section>`;
}

function panelOf(host: ParentNode) {
  const panel = host.querySelector<HTMLElement>(".tarkov-list-panel");
  if (!panel || !host.querySelector(".tarkov-list-layout")) return null;
  return panel;
}

export function listBusy(host: HTMLElement, label: string, mark?: (item: HTMLElement) => boolean) {
  const panel = panelOf(host);
  if (!panel) {
    host.innerHTML = spin(label);
    return;
  }
  if (mark) {
    host.querySelectorAll<HTMLElement>(".tarkov-list-item").forEach((item) => {
      item.classList.toggle("on", mark(item));
    });
  }
  panel.innerHTML = spin(label);
}

export function listFail(host: HTMLElement, message: string) {
  const html = `<p class="tarkov-list-empty">${esc(message)}</p>`;
  const panel = panelOf(host);
  if (panel) panel.innerHTML = html;
  else host.innerHTML = html;
}

export function repaintList(host: HTMLElement, searchId: string, draw: () => void) {
  const form = host.querySelector(`#${searchId}`);
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement && Boolean(form?.contains(active));
  const pos = active instanceof HTMLInputElement && form?.contains(active) ? active.selectionStart : null;
  const top = host.querySelector<HTMLElement>(".tarkov-list-side")?.scrollTop ?? 0;
  draw();
  const side = host.querySelector<HTMLElement>(".tarkov-list-side");
  if (side) side.scrollTop = top;
  if (!typing) return false;
  const input = host.querySelector<HTMLInputElement>(`#${searchId} [name=q]`);
  input?.focus();
  if (pos != null) input?.setSelectionRange(pos, pos);
  return true;
}

export function bindListSearch(host: ParentNode, searchId: string, onInput: (value: string) => void) {
  const form = host.querySelector(`#${searchId}`);
  form?.addEventListener("submit", (event) => event.preventDefault());
  form?.querySelector<HTMLInputElement>("[name=q]")?.addEventListener("input", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) onInput(input.value);
  });
}

export function stayOnList(host: ParentNode | null, href: string, base: string) {
  if (!host?.querySelector(".tarkov-list-layout")) return null;
  const pathOnly = href.split("?")[0].split("#")[0];
  if (pathOnly !== base && !pathOnly.startsWith(`${base}/`)) return null;
  const url = encodeURI(pathOnly);
  if (location.pathname + location.search !== url) pushNav(url);
  const current = host.querySelector<HTMLAnchorElement>(".tarkov-list-item.on");
  const raw = pathOnly === base ? "" : pathOnly.slice(base.length + 1).split("/")[0];
  let slug = raw;
  try { slug = raw ? decodeURIComponent(raw) : ""; } catch { slug = raw; }
  return { slug, same: current?.getAttribute("href") === pathOnly };
}

export function listFrame(options: {
  side: string;
  meta?: string;
  filters?: string;
  search?: { id: string; value: string; placeholder: string; label?: string };
  panel: string;
  rail?: string;
  layoutClass?: string;
}) {
  const search = options.search
    ? `<form id="${esc(options.search.id)}"><input class="tarkov-list-search" name="q" value="${esc(options.search.value)}" placeholder="${esc(options.search.placeholder)}" aria-label="${esc(options.search.label || "搜索")}" /></form>`
    : "";
  const rail = options.rail ? `<aside class="tarkov-list-side lobby-rail">${options.rail}</aside>` : "";
  return `
    <div class="tarkov-list-layout${options.layoutClass ? ` ${options.layoutClass}` : ""}">
      <aside class="tarkov-list-side">${options.side}</aside>
      <div class="tarkov-list-main">
        <div class="tarkov-list-toolbar">
          <div class="tarkov-list-toolbar-side">${options.filters || ""}<span class="tarkov-list-meta">${options.meta || ""}</span></div>
          ${search}
        </div>
        <div class="tarkov-list-panel">${options.panel}</div>
      </div>
      ${rail}
    </div>`;
}

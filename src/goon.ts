import { mapTitle, sameMap } from "./mapNames";

type Goon = { mapSlug: string; seenAt: string };

let goon: Goon | null = null;
let timer = 0;
let painter: (() => void) | null = null;

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function ago(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 45) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}小时${rest}分前` : `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

export function goonSlug() {
  return goon?.mapSlug || "";
}

export function goonHint() {
  if (!goon?.mapSlug) return "";
  const when = ago(goon.seenAt);
  return when ? `三狗出没（${when}上报）` : "";
}

export function goonText(mapName: string) {
  if (!goon?.mapSlug) return "";
  const when = ago(goon.seenAt);
  const place = mapTitle(goon.mapSlug, mapName);
  return when ? `三狗出没 · ${place}（${when}上报）` : `三狗出没 · ${place}`;
}

export function paintGoonBars(nameOf: (slug: string) => string) {
  const slug = goon?.mapSlug || "";
  const jump = slug ? goonText(nameOf(slug)) : "";
  const here = slug ? goonHint() : "";
  document.querySelectorAll<HTMLButtonElement>(".goon-bar").forEach((node) => {
    const onMap = node.classList.contains("map-goon");
    const viewed = onMap ? node.closest(".map-app")?.querySelector("#map-root")?.getAttribute("data-slug") || "" : "";
    const text = onMap ? (sameMap(viewed, slug) ? here : "") : jump;
    if (!text) {
      node.hidden = true;
      node.textContent = "";
      delete node.dataset.map;
      return;
    }
    node.hidden = false;
    node.textContent = text;
    if (onMap) delete node.dataset.map;
    else node.dataset.map = slug;
  });
}

async function refresh() {
  try {
    const data = await invoke<{ map_slug?: string; mapSlug?: string; seen_at?: string; seenAt?: string }>("site_get", { path: "/guides/tarkov/goons" });
    const mapSlug = String(data.map_slug || data.mapSlug || "").trim();
    goon = mapSlug ? { mapSlug, seenAt: String(data.seen_at || data.seenAt || "") } : null;
  } catch {
    goon = null;
  }
  painter?.();
}

export function startGoonWatch(paint: () => void) {
  painter = paint;
  if (timer) return;
  void refresh();
  timer = window.setInterval(() => void refresh(), 8000);
}

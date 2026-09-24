import { emit, listen } from "@tauri-apps/api/event";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { destroyLiveMap, fitLiveMap, liveMapCamera, mountLiveMap, replacePrefs, setLiveMapCamera, snapshotPrefs, watchLiveMapCamera, type FilterPrefs } from "./liveMap";

export type OverlayState = {
  autoFocus: boolean;
  lockAspect: boolean;
  opacity: number;
  shape: "rect" | "circle";
  alwaysOnTop: boolean;
  clickThrough: boolean;
  fullscreen: boolean;
  raidHud: boolean;
  hotkeyEnabled: boolean;
  hotkey: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  aspect: number;
  placed: boolean;
  mapSlug: string;
  autoFollow: boolean;
  raidChime: boolean;
};

export type RaidStatus = {
  inRaid: boolean;
  elapsedSecs: number;
  serverCountry: string;
  location: string;
};

type SyncPayload = { slug: string; prefs: FilterPrefs };

const VIEW_KEY = "zhange.overlay.views";
let overlayState: OverlayState | null = null;
let recording = false;
let mountedSlug = "";

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

export function overlayView(): "overlay" | "raid" | "" {
  const view = new URLSearchParams(location.search).get("view");
  return view === "overlay" || view === "raid" ? view : "";
}

export function overlayCardHtml() {
  return `
    <section class="overlay-card" id="overlay-card">
      <button type="button" id="map-summary">准备内容总结</button>
      <button type="button" id="overlay-settings">地图覆盖层设置</button>
    </section>`;
}

export function overlayDialogHtml(pop = false) {
  return `
    <div id="overlay-settings-modal" class="${pop ? "overlay-pop" : "map-summary"}" hidden>
      <div class="overlay-menu" id="overlay-menu">
        <header><strong>地图覆盖层</strong><button type="button" id="overlay-settings-close">关闭</button></header>
        <label class="overlay-check"><input type="checkbox" data-overlay="autoFocus" />自动聚焦</label>
        <label class="overlay-check"><input type="checkbox" data-overlay="lockAspect" />锁定图片比例</label>
        <label class="overlay-slider"><span>透明度</span><input type="range" min="10" max="100" step="1" data-overlay="opacity" /><strong data-opacity-label>100%</strong></label>
        <button type="button" class="overlay-action" data-overlay="shape">形状切换</button>
        <label class="overlay-check"><input type="checkbox" data-overlay="alwaysOnTop" />置顶锁定</label>
        <label class="overlay-check"><input type="checkbox" data-overlay="fullscreen" />全屏</label>
        <label class="overlay-check"><input type="checkbox" data-overlay="raidHud" />战局悬浮窗</label>
        <label class="overlay-check"><input type="checkbox" data-overlay="autoFollow" />进图自动切图</label>
        <label class="overlay-check"><input type="checkbox" data-overlay="raidChime" />战局提示音</label>
        <button type="button" class="overlay-action" data-overlay="reset">重置位置与尺寸</button>
        <label class="overlay-hotkey"><input type="checkbox" data-overlay="hotkeyEnabled" /><span>快捷键</span><button type="button" id="overlay-hotkey">M</button></label>
      </div>
    </div>`;
}

export async function ensureOverlayState() {
  if (!overlayState) overlayState = await invoke<OverlayState>("overlay_get").catch(() => null);
  return overlayState;
}

export function setOverlayHotkeyLive(live: boolean) {
  void invoke("overlay_set_hotkey_live", { live }).catch(() => undefined);
}

export async function publishOverlayMap(slug: string) {
  if (!slug || overlayView()) return;
  await invoke("overlay_note_map", { slug }).catch(() => undefined);
  await emit("overlay-sync", { slug, prefs: snapshotPrefs() } satisfies SyncPayload);
}

export function bootOverlayShell() {
  const kind = overlayView();
  if (kind === "overlay") {
    document.documentElement.classList.add("overlay-window");
    document.body.classList.add("overlay-window");
    const root = document.querySelector("#root");
    if (root) {
      root.innerHTML = `<div class="overlay-stage" id="overlay-stage"><div id="map-root"></div><div class="overlay-grips" id="overlay-grips"><i></i><i></i><i></i><i></i></div><p class="overlay-empty" id="overlay-empty" hidden>先在主窗口打开一张地图</p></div>${overlayDialogHtml(true)}`;
    }
    void bootMapOverlay();
    return true;
  }
  if (kind === "raid") {
    document.documentElement.classList.add("overlay-window");
    document.body.classList.add("overlay-window");
    const root = document.querySelector("#root");
    if (root) {
      root.innerHTML = `
        <div class="raid-hud" id="raid-hud">
          <p><span>塔科夫</span><strong id="raid-left">--:--:--</strong></p>
          <p><span>第二钟</span><strong id="raid-right">--:--:--</strong></p>
          <p><span>战局</span><strong id="raid-elapsed">未开始</strong></p>
          <p><span>服务器</span><strong id="raid-server">—</strong></p>
        </div>`;
    }
    void bootRaidHud();
    return true;
  }
  return false;
}

export async function openOverlaySettings(point?: { x: number; y: number }) {
  const modal = document.querySelector<HTMLElement>("#overlay-settings-modal");
  if (!modal) return;
  overlayState = await invoke<OverlayState>("overlay_get");
  paintOverlayDialog(overlayState);
  modal.hidden = false;
  if (!point) return;
  const menu = modal.querySelector<HTMLElement>(".overlay-menu");
  if (!menu) return;
  const width = menu.offsetWidth || 280;
  const height = menu.offsetHeight || 420;
  const x = Math.max(8, Math.min(point.x, window.innerWidth - width - 8));
  const y = Math.max(8, Math.min(point.y, window.innerHeight - height - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

export function closeOverlaySettings() {
  const modal = document.querySelector<HTMLElement>("#overlay-settings-modal");
  if (modal) modal.hidden = true;
  if (recording) {
    recording = false;
    void invoke("overlay_set_guard", { capturing: false, typing: typingActive() });
  }
}

export function onOverlayClick(target: Element) {
  if (target.closest("#overlay-settings")) {
    void openOverlaySettings();
    return true;
  }
  if (target.closest("#overlay-settings-close") || target.id === "overlay-settings-modal") {
    closeOverlaySettings();
    return true;
  }
  if (target.closest("#overlay-hotkey")) {
    recording = true;
    void invoke("overlay_set_guard", { capturing: true, typing: false });
    const button = document.querySelector("#overlay-hotkey");
    if (button) button.textContent = "请按键";
    return true;
  }
  const action = target.closest<HTMLButtonElement>("[data-overlay]");
  if (action?.dataset.overlay === "shape" && overlayState) {
    overlayState.shape = overlayState.shape === "circle" ? "rect" : "circle";
    void persistOverlay(overlayState);
    return true;
  }
  if (action?.dataset.overlay === "reset") {
    void invoke<OverlayState>("overlay_reset").then((state) => {
      overlayState = state;
      paintOverlayDialog(state);
    });
    return true;
  }
  return false;
}

export function onOverlayInput(target: EventTarget | null) {
  if (!(target instanceof HTMLInputElement) || !overlayState) return false;
  if (target.dataset.overlay === "opacity") {
    overlayState.opacity = Number(target.value);
    const label = document.querySelector("[data-opacity-label]");
    if (label) label.textContent = `${overlayState.opacity}%`;
    void persistOverlay(overlayState);
    return true;
  }
  return false;
}

export function onOverlayChange(target: EventTarget | null) {
  if (!(target instanceof HTMLInputElement) || !overlayState || target.type !== "checkbox") return false;
  const key = target.dataset.overlay;
  if (key === "autoFocus") overlayState.autoFocus = target.checked;
  else if (key === "lockAspect") overlayState.lockAspect = target.checked;
  else if (key === "alwaysOnTop") overlayState.alwaysOnTop = target.checked;
  else if (key === "fullscreen") overlayState.fullscreen = target.checked;
  else if (key === "raidHud") overlayState.raidHud = target.checked;
  else if (key === "autoFollow") overlayState.autoFollow = target.checked;
  else if (key === "raidChime") overlayState.raidChime = target.checked;
  else if (key === "hotkeyEnabled") overlayState.hotkeyEnabled = target.checked;
  else return false;
  void persistOverlay(overlayState);
  return true;
}

export function onOverlayKey(event: KeyboardEvent) {
  if (!recording || !overlayState) return false;
  event.preventDefault();
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key.toUpperCase();
  recording = false;
  if (key !== "ESCAPE") overlayState.hotkey = key;
  void invoke("overlay_set_guard", { capturing: false, typing: typingActive() });
  if (key !== "ESCAPE") void persistOverlay(overlayState);
  else paintOverlayDialog(overlayState);
  return true;
}

export function watchOverlayTyping() {
  const sync = () => {
    if (recording) return;
    void invoke("overlay_set_guard", { capturing: false, typing: typingActive() }).catch(() => undefined);
  };
  document.addEventListener("focusin", sync);
  document.addEventListener("focusout", sync);
  void listen<OverlayState>("overlay-changed", (event) => {
    overlayState = event.payload;
    if (document.querySelector("#overlay-menu") && !document.querySelector("#overlay-settings-modal")?.hasAttribute("hidden")) {
      paintOverlayDialog(event.payload);
    }
  }).catch(() => undefined);
  void listen("overlay-shown", () => {
    const slug = document.querySelector("#map-root")?.getAttribute("data-slug") || "";
    if (slug) void publishOverlayMap(slug);
  }).catch(() => undefined);
}

function paintOverlayDialog(state: OverlayState) {
  const menu = document.querySelector("#overlay-menu");
  if (!menu) return;
  const box = (key: string) => menu.querySelector<HTMLInputElement>(`[data-overlay="${key}"]`);
  const auto = box("autoFocus");
  const lock = box("lockAspect");
  const top = box("alwaysOnTop");
  const fullscreen = box("fullscreen");
  const raid = box("raidHud");
  const follow = box("autoFollow");
  const chime = box("raidChime");
  const hotkey = box("hotkeyEnabled");
  const opacity = box("opacity");
  if (auto) auto.checked = state.autoFocus;
  if (lock) lock.checked = state.lockAspect;
  if (top) top.checked = state.alwaysOnTop;
  if (fullscreen) fullscreen.checked = state.fullscreen;
  if (raid) raid.checked = state.raidHud;
  if (follow) follow.checked = state.autoFollow !== false;
  if (chime) chime.checked = state.raidChime !== false;
  if (hotkey) hotkey.checked = state.hotkeyEnabled;
  if (opacity) opacity.value = String(state.opacity);
  const label = menu.querySelector("[data-opacity-label]");
  if (label) label.textContent = `${state.opacity}%`;
  const shape = menu.querySelector("[data-overlay=\"shape\"]");
  if (shape) shape.textContent = state.shape === "circle" ? "形状切换：圆形" : "形状切换：矩形";
  const button = menu.querySelector("#overlay-hotkey");
  if (button) button.textContent = recording ? "请按键" : state.hotkey || "M";
}

async function persistOverlay(state: OverlayState) {
  overlayState = await invoke<OverlayState>("overlay_save", { state });
  paintOverlayDialog(overlayState);
}

function typingActive() {
  const node = document.activeElement;
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

function savedViews(): Record<string, { lat: number; lng: number; zoom: number }> {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") as Record<string, { lat: number; lng: number; zoom: number }>;
  } catch {
    return {};
  }
}

function rememberView(slug: string) {
  const camera = liveMapCamera();
  if (!camera || !slug) return;
  const views = savedViews();
  views[slug] = camera;
  localStorage.setItem(VIEW_KEY, JSON.stringify(views));
}

async function bootMapOverlay() {
  const stage = document.querySelector<HTMLElement>("#overlay-stage");
  document.querySelector("#overlay-grips")?.addEventListener("pointerdown", (event) => {
    if (!(event instanceof PointerEvent) || event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  });
  stage?.addEventListener("pointerdown", (event) => {
    if (event.button === 2) return;
    const modal = document.querySelector("#overlay-settings-modal");
    if (!modal || modal.hasAttribute("hidden")) return;
    if (event.target instanceof Element && event.target.closest("#overlay-menu")) return;
    closeOverlaySettings();
  });
  let rightDrag: { x: number; y: number; winX: number; winY: number; scale: number; moved: boolean; ready: boolean } | null = null;
  document.addEventListener("pointerdown", (event) => {
    if (!(event instanceof PointerEvent) || event.button !== 2) return;
    if (event.target instanceof Element && event.target.closest("#overlay-menu")) return;
    const target = event.target;
    const originX = event.screenX;
    const originY = event.screenY;
    rightDrag = { x: originX, y: originY, winX: 0, winY: 0, scale: window.devicePixelRatio || 1, moved: false, ready: false };
    if (target instanceof Element) target.setPointerCapture?.(event.pointerId);
    void getCurrentWindow().outerPosition().then(async (pos) => {
      if (!rightDrag || rightDrag.x !== originX || rightDrag.y !== originY) return;
      rightDrag.winX = pos.x;
      rightDrag.winY = pos.y;
      rightDrag.scale = await getCurrentWindow().scaleFactor();
      rightDrag.ready = true;
    });
  }, true);
  document.addEventListener("pointermove", (event) => {
    if (!rightDrag || !(event instanceof PointerEvent) || (event.buttons & 2) === 0) return;
    const dx = event.screenX - rightDrag.x;
    const dy = event.screenY - rightDrag.y;
    if (Math.hypot(dx, dy) > 4) rightDrag.moved = true;
    if (!rightDrag.ready || !rightDrag.moved) return;
    void getCurrentWindow().setPosition(new PhysicalPosition(Math.round(rightDrag.winX + dx * rightDrag.scale), Math.round(rightDrag.winY + dy * rightDrag.scale)));
  }, true);
  document.addEventListener("pointerup", (event) => {
    if (!(event instanceof PointerEvent) || event.button !== 2 || !rightDrag?.moved) return;
    window.setTimeout(() => {
      rightDrag = null;
    }, 0);
  }, true);
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const dragged = rightDrag?.moved;
    if (!dragged) rightDrag = null;
    if (dragged) return;
    if (event.target instanceof Element && event.target.closest("#overlay-menu")) return;
    void openOverlaySettings({ x: event.clientX, y: event.clientY });
  }, true);
  document.addEventListener("mouseleave", () => {
    void invoke("overlay_return_focus").catch(() => undefined);
  });
  const applyChrome = (state: OverlayState) => {
    if (!stage) return;
    stage.style.opacity = String(Math.max(0.1, state.opacity / 100));
    stage.classList.toggle("is-circle", state.shape === "circle");
  };
  overlayState = await invoke<OverlayState>("overlay_get").catch(() => null);
  if (overlayState) applyChrome(overlayState);
  void listen<OverlayState>("overlay-changed", (event) => {
    overlayState = event.payload;
    applyChrome(event.payload);
    const modal = document.querySelector("#overlay-settings-modal");
    if (modal && !modal.hasAttribute("hidden")) paintOverlayDialog(event.payload);
  });
  void listen<SyncPayload>("overlay-sync", (event) => {
    void showMap(event.payload.slug, event.payload.prefs);
  });
  if (overlayState?.mapSlug) await showMap(overlayState.mapSlug, null);
}

async function showMap(slug: string, prefs: FilterPrefs | null) {
  const empty = document.querySelector<HTMLElement>("#overlay-empty");
  const host = document.querySelector<HTMLElement>("#map-root");
  if (!slug || !host) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  if (prefs) replacePrefs(prefs);
  if (mountedSlug !== slug) {
    mountedSlug = slug;
    host.setAttribute("data-slug", slug);
    destroyLiveMap();
    await mountLiveMap(slug, false);
    const saved = savedViews()[slug];
    if (saved) setLiveMapCamera(saved.lat, saved.lng, saved.zoom);
    else fitLiveMap();
    watchLiveMapCamera(() => rememberView(slug));
    return;
  }
  if (prefs) replacePrefs(prefs);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function clockText(total: number) {
  const day = ((total % 86400) + 86400) % 86400;
  const hour = Math.floor(day / 3600);
  const minute = Math.floor((day % 3600) / 60);
  const second = Math.floor(day % 60);
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function tarkovClocks() {
  const now = new Date();
  const seconds = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds() + 10800;
  const accelerated = ((seconds % 86400) + 86400) % 86400 * 7;
  return { left: clockText(accelerated), right: clockText(accelerated + 12 * 3600) };
}

function paintRaid(status: RaidStatus | null) {
  const clocks = tarkovClocks();
  const left = document.querySelector("#raid-left");
  const right = document.querySelector("#raid-right");
  const elapsed = document.querySelector("#raid-elapsed");
  const server = document.querySelector("#raid-server");
  if (left) left.textContent = clocks.left;
  if (right) right.textContent = clocks.right;
  if (elapsed) {
    if (!status?.inRaid) elapsed.textContent = "未开始";
    else {
      const hours = Math.floor(status.elapsedSecs / 3600);
      const minutes = Math.floor((status.elapsedSecs % 3600) / 60);
      const seconds = status.elapsedSecs % 60;
      elapsed.textContent = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    }
  }
  if (server) server.textContent = status?.inRaid ? status.serverCountry || "未知" : "—";
}

async function bootRaidHud() {
  const frame = document.querySelector<HTMLElement>("#raid-hud");
  frame?.addEventListener("pointerdown", () => {
    void getCurrentWindow().startDragging();
  });
  const pull = async () => {
    const status = await invoke<RaidStatus>("raid_status").catch(() => null);
    lastRaid = status;
    raidStamp = Date.now();
    paintRaid(shownRaid());
  };
  paintRaid(null);
  window.setInterval(() => paintRaid(shownRaid()), 1000);
  window.setInterval(() => {
    void pull();
  }, 3000);
  await pull();
}

let lastRaid: RaidStatus | null = null;
let raidStamp = 0;

function shownRaid(): RaidStatus | null {
  if (!lastRaid) return null;
  if (!lastRaid.inRaid) return lastRaid;
  const extra = Math.max(0, Math.floor((Date.now() - raidStamp) / 1000));
  return { ...lastRaid, elapsedSecs: lastRaid.elapsedSecs + extra };
}

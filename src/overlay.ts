import { invoke } from "./tauriBridge";
import { emit, listen } from "@tauri-apps/api/event";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { adoptAccount, type AccountMapFilters } from "./mapFilterAccount";
import {
  destroyLiveMap,
  fitLiveMap,
  invalidateLiveMap,
  liveMapCamera,
  mountLiveMap,
  replacePrefs,
  setLiveMapCamera,
  snapshotAccount,
  snapshotPrefs,
  watchLiveMapCamera,
  type FilterPrefs,
} from "./liveMap";
import { fadeIn, fadeOut } from "./motion";

export type OverlayState = {
  autoFocus: boolean;
  lockAspect: boolean;
  opacity: number;
  shape: "rect" | "circle";
  alwaysOnTop: boolean;
  clickThrough: boolean;
  fullscreen: boolean;
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
};

type SyncPayload = { slug: string; prefs: FilterPrefs; account?: AccountMapFilters };

const VIEW_KEY = "zhange.overlay.views";
let overlayState: OverlayState | null = null;
let recording = false;
let mountedSlug = "";
let mapMountGeneration = 0;
let overlayRevision = 0;
let overlaySavePending = 0;
let overlaySaveQueue: Promise<void> = Promise.resolve();

export function overlayView(): "overlay" | "" {
  const view = new URLSearchParams(location.search).get("view");
  return view === "overlay" ? view : "";
}

export function overlayCardHtml() {
  return `
    <div class="dock-lead" id="overlay-card">
      <button type="button" id="map-summary" class="map-summary-launch">
        <span>准备内容总结</span>
        <small>勾选任务后查看所需物品</small>
      </button>
      <button type="button" id="overlay-settings">地图覆盖层设置</button>
      <button type="button" id="shot-settings">截图设置</button>
    </div>`;
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
        <label class="overlay-check"><input type="checkbox" data-overlay="autoFollow" />进图自动切图</label>
        <button type="button" class="overlay-action" data-overlay="reset">重置位置与尺寸</button>
        <label class="overlay-hotkey"><input type="checkbox" data-overlay="hotkeyEnabled" /><span>战局快捷键</span><button type="button" id="overlay-hotkey">M</button></label>
      </div>
    </div>`;
}

export async function ensureOverlayState() {
  if (!overlayState) overlayState = await invoke<OverlayState>("overlay_get").catch(() => null);
  return overlayState;
}

export async function publishOverlayMap(slug: string) {
  if (!slug || overlayView()) return;
  await invoke("overlay_note_map", { slug }).catch(() => undefined);
  await emit("overlay-sync", {
    slug,
    prefs: snapshotPrefs(),
    account: snapshotAccount(),
  } satisfies SyncPayload);
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
  return false;
}

export async function openOverlaySettings(point?: { x: number; y: number }) {
  const modal = document.querySelector<HTMLElement>("#overlay-settings-modal");
  if (!modal) return;
  overlayState = await invoke<OverlayState>("overlay_get");
  paintOverlayDialog(overlayState);
  fadeIn(modal);
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
  if (modal) void fadeOut(modal);
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
    void resetOverlay();
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
  if (!(target instanceof HTMLInputElement) || !overlayState || target.type !== "checkbox")
    return false;
  const key = target.dataset.overlay;
  if (key === "autoFocus") overlayState.autoFocus = target.checked;
  else if (key === "lockAspect") overlayState.lockAspect = target.checked;
  else if (key === "alwaysOnTop") overlayState.alwaysOnTop = target.checked;
  else if (key === "fullscreen") overlayState.fullscreen = target.checked;
  else if (key === "autoFollow") overlayState.autoFollow = target.checked;
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
    void invoke("overlay_set_guard", { capturing: false, typing: typingActive() }).catch(
      () => undefined,
    );
  };
  document.addEventListener("focusin", sync);
  document.addEventListener("focusout", sync);
  void listen<OverlayState>("overlay-changed", (event) => {
    acceptOverlayState(event.payload);
    if (
      document.querySelector("#overlay-menu") &&
      !document.querySelector("#overlay-settings-modal")?.hasAttribute("hidden")
    ) {
      if (overlayState) paintOverlayDialog(overlayState);
    }
  }).catch(() => undefined);
  void listen<string>("overlay-persistence-error", (event) => {
    showOverlaySaveNote(event.payload || "覆盖层位置保存失败");
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
  const follow = box("autoFollow");
  const hotkey = box("hotkeyEnabled");
  const opacity = box("opacity");
  if (auto) auto.checked = state.autoFocus;
  if (lock) lock.checked = state.lockAspect;
  if (top) top.checked = state.alwaysOnTop;
  if (fullscreen) fullscreen.checked = state.fullscreen;
  if (follow) follow.checked = state.autoFollow !== false;
  if (hotkey) hotkey.checked = state.hotkeyEnabled;
  if (opacity) opacity.value = String(state.opacity);
  const label = menu.querySelector("[data-opacity-label]");
  if (label) label.textContent = `${state.opacity}%`;
  const shape = menu.querySelector('[data-overlay="shape"]');
  if (shape) shape.textContent = state.shape === "circle" ? "形状切换：圆形" : "形状切换：矩形";
  const button = menu.querySelector("#overlay-hotkey");
  if (button) button.textContent = recording ? "请按键" : state.hotkey || "M";
}

async function persistOverlay(state: OverlayState) {
  const revision = ++overlayRevision;
  const snapshot = { ...state };
  overlaySavePending += 1;
  const operation = overlaySaveQueue
    .then(async () => {
      if (revision !== overlayRevision) return;
      try {
        const saved = await invoke<OverlayState>("overlay_save", { state: snapshot });
        if (revision !== overlayRevision) return;
        overlayState = saved;
        clearOverlaySaveNote();
        paintOverlayDialog(saved);
      } catch (error) {
        if (revision !== overlayRevision) return;
        const saved = await invoke<OverlayState>("overlay_get").catch(() => null);
        if (saved) overlayState = saved;
        showOverlaySaveNote(error instanceof Error ? error.message : "覆盖层设置保存失败");
        if (overlayState) paintOverlayDialog(overlayState);
      }
    })
    .finally(() => {
      overlaySavePending = Math.max(0, overlaySavePending - 1);
    });
  overlaySaveQueue = operation.then(() => undefined);
  return operation;
}

function acceptOverlayState(next: OverlayState) {
  if (!overlaySavePending || !overlayState) {
    overlayState = next;
    return;
  }
  overlayState = {
    ...next,
    ...overlayState,
    x: next.x,
    y: next.y,
    width: next.width,
    height: next.height,
    aspect: next.aspect,
    placed: next.placed,
    mapSlug: next.mapSlug,
    visible: next.visible,
  };
}

async function resetOverlay() {
  const revision = ++overlayRevision;
  overlaySavePending += 1;
  const operation = overlaySaveQueue
    .then(async () => {
      if (revision !== overlayRevision) return;
      try {
        const saved = await invoke<OverlayState>("overlay_reset");
        if (revision !== overlayRevision) return;
        overlayState = saved;
        clearOverlaySaveNote();
        paintOverlayDialog(saved);
      } catch (error) {
        if (revision !== overlayRevision) return;
        showOverlaySaveNote(error instanceof Error ? error.message : "覆盖层重置失败");
      }
    })
    .finally(() => {
      overlaySavePending = Math.max(0, overlaySavePending - 1);
    });
  overlaySaveQueue = operation.then(() => undefined);
  return operation;
}

function showOverlaySaveNote(message: string) {
  const menu = document.querySelector<HTMLElement>("#overlay-menu");
  if (!menu) return;
  let note = menu.querySelector<HTMLElement>("#overlay-save-note");
  if (!note) {
    note = document.createElement("p");
    note.id = "overlay-save-note";
    note.setAttribute("role", "status");
    menu.append(note);
  }
  note.textContent = message;
}

function clearOverlaySaveNote() {
  document.querySelector("#overlay-save-note")?.remove();
}

function typingActive() {
  const node = document.activeElement;
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

function savedViews(): Record<string, { lat: number; lng: number; zoom: number }> {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") as Record<
      string,
      { lat: number; lng: number; zoom: number }
    >;
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
  let rightDrag: {
    x: number;
    y: number;
    winX: number;
    winY: number;
    scale: number;
    moved: boolean;
    ready: boolean;
  } | null = null;
  let dragPoint: { x: number; y: number } | null = null;
  let dragFrame = 0;
  let dragSending = false;
  let dragAgain = false;
  const flushOverlayDrag = () => {
    dragFrame = 0;
    const point = dragPoint;
    if (!point) return;
    if (dragSending) {
      dragAgain = true;
      return;
    }
    dragSending = true;
    void getCurrentWindow()
      .setPosition(new PhysicalPosition(point.x, point.y))
      .finally(() => {
        dragSending = false;
        if (!dragAgain) return;
        dragAgain = false;
        if (!dragPoint || (dragPoint.x === point.x && dragPoint.y === point.y)) return;
        dragFrame = window.requestAnimationFrame(flushOverlayDrag);
      });
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!(event instanceof PointerEvent) || event.button !== 2) return;
      if (event.target instanceof Element && event.target.closest("#overlay-menu")) return;
      const target = event.target;
      const originX = event.screenX;
      const originY = event.screenY;
      dragPoint = null;
      dragAgain = false;
      rightDrag = {
        x: originX,
        y: originY,
        winX: 0,
        winY: 0,
        scale: window.devicePixelRatio || 1,
        moved: false,
        ready: false,
      };
      if (target instanceof Element) target.setPointerCapture?.(event.pointerId);
      void getCurrentWindow()
        .outerPosition()
        .then(async (pos) => {
          if (!rightDrag || rightDrag.x !== originX || rightDrag.y !== originY) return;
          rightDrag.winX = pos.x;
          rightDrag.winY = pos.y;
          rightDrag.scale = await getCurrentWindow().scaleFactor();
          rightDrag.ready = true;
        });
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!rightDrag || !(event instanceof PointerEvent) || (event.buttons & 2) === 0) return;
      const dx = event.screenX - rightDrag.x;
      const dy = event.screenY - rightDrag.y;
      if (Math.hypot(dx, dy) > 4) rightDrag.moved = true;
      if (!rightDrag.ready || !rightDrag.moved) return;
      dragPoint = {
        x: Math.round(rightDrag.winX + dx * rightDrag.scale),
        y: Math.round(rightDrag.winY + dy * rightDrag.scale),
      };
      if (!dragFrame) dragFrame = window.requestAnimationFrame(flushOverlayDrag);
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      const dragging = Boolean(rightDrag?.moved);
      if (dragFrame) {
        window.cancelAnimationFrame(dragFrame);
        dragFrame = 0;
      }
      if (dragging) flushOverlayDrag();
      if (!(event instanceof PointerEvent) || event.button !== 2 || !dragging) return;
      window.setTimeout(() => {
        rightDrag = null;
        dragPoint = null;
      }, 0);
    },
    true,
  );
  document.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
      const dragged = rightDrag?.moved;
      if (!dragged) rightDrag = null;
      if (dragged) return;
      if (event.target instanceof Element && event.target.closest("#overlay-menu")) return;
      void openOverlaySettings({ x: event.clientX, y: event.clientY });
    },
    true,
  );
  document.addEventListener("mouseleave", () => {
    void invoke("overlay_return_focus").catch(() => undefined);
  });
  const applyChrome = (state: OverlayState) => {
    if (!stage) return;
    stage.style.opacity = String(Math.max(0.1, state.opacity / 100));
    stage.classList.toggle("is-circle", state.shape === "circle");
  };
  const refit = () => {
    invalidateLiveMap();
  };
  window.addEventListener("resize", refit);
  overlayState = await invoke<OverlayState>("overlay_get").catch(() => null);
  if (overlayState) applyChrome(overlayState);
  void listen<OverlayState>("overlay-changed", (event) => {
    acceptOverlayState(event.payload);
    const state = overlayState || event.payload;
    applyChrome(state);
    const modal = document.querySelector("#overlay-settings-modal");
    if (modal && !modal.hasAttribute("hidden")) paintOverlayDialog(state);
  });
  void listen<SyncPayload>("overlay-sync", (event) => {
    if (event.payload.account) adoptAccount(event.payload.account);
    void showMap(event.payload.slug, event.payload.account ? null : event.payload.prefs);
  });
  if (overlayState?.mapSlug) await showMap(overlayState.mapSlug, null);
}

async function showMap(slug: string, prefs: FilterPrefs | null) {
  const empty = document.querySelector<HTMLElement>("#overlay-empty");
  const host = document.querySelector<HTMLElement>("#map-root");
  if (!slug || !host) {
    mapMountGeneration += 1;
    if (mountedSlug) {
      mountedSlug = "";
      destroyLiveMap();
    }
    if (empty) empty.hidden = false;
    return;
  }
  const generation = mountedSlug === slug ? mapMountGeneration : ++mapMountGeneration;
  if (empty) empty.hidden = true;
  if (prefs) replacePrefs(prefs);
  if (mountedSlug !== slug) {
    mountedSlug = slug;
    host.setAttribute("data-slug", slug);
    destroyLiveMap();
    await mountLiveMap(slug, false);
    if (generation !== mapMountGeneration || mountedSlug !== slug) return;
    const saved = savedViews()[slug];
    if (saved) setLiveMapCamera(saved.lat, saved.lng, saved.zoom);
    else fitLiveMap();
    requestAnimationFrame(() => {
      if (generation !== mapMountGeneration || mountedSlug !== slug) return;
      invalidateLiveMap();
      if (!savedViews()[slug]) fitLiveMap();
    });
    watchLiveMapCamera(() => {
      if (generation === mapMountGeneration && mountedSlug === slug) rememberView(slug);
    });
    return;
  }
  if (prefs) replacePrefs(prefs);
}

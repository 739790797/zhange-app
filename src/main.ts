import { listen } from "@tauri-apps/api/event";
import { closeLogSync, logSyncBusy, openLogSync, pickLogSyncRange, runLogSync } from "./logSync";
import { applyRoomClaims, clearMapTasks, closeMapSummary, mapQuestProgress, mountMapTasks, onMapObjectiveChange, onMapTaskChange, onMapTaskClick, onMapTaskInput, openMapGuide, openMapSummary, patchLoggedQuest, setMapHighlight, setMapObjective, watchMapTasks } from "./mapTasks";
import { applyLoggedQuest, mountTaskPage, onTaskChange, onTaskEvent, taskPageShell } from "./taskFlow";
import { bindQuestActions, bindQuestHighlight, destroyLiveMap, invalidateLiveMap, locateQuest, mountLiveMap, onQuestFilterClick, setLayerVisible, setMapFloor, setMapStyle, setQuestRoom, toggleFold } from "./liveMap";
import { bootOverlayShell, ensureOverlayState, onOverlayChange, onOverlayClick, onOverlayInput, onOverlayKey, overlayCardHtml, overlayDialogHtml, publishOverlayMap, setOverlayHotkeyLive, watchOverlayTyping } from "./overlay";
import { mountTavernArticle, mountTavernList, setTavernReply, submitTavernComment, tavernArticleHtml, tavernCategoryHref, tavernListHtml, tavernMatch, tavernPageHref, tavernSearchHref } from "./tavern";

watchMapTasks(
  () => { void syncQuestClaims(); },
  (id, on) => { void toggleClaim(id, on); },
  (id) => { void locateQuest(id); },
  (taskId, objectiveId, done) => { void markQuestObjective(taskId, objectiveId, done); },
);
bindQuestActions(
  (id) => openMapGuide(id),
  (taskId, objectiveId, done) => { void markQuestObjective(taskId, objectiveId, done); },
);
bindQuestHighlight((id) => setMapHighlight(id));

const rootNode = document.querySelector("#root");
if (!rootNode) throw new Error("缺少根节点");
const root = rootNode;

type MapItem = { slug: string; name: string; english: string; thumbLink: string };
type RoomMember = {
  userId: number;
  name: string;
  host: boolean;
  online: boolean;
  inRoom: boolean;
};
type RoomClaim = { taskId: string; userId: number; name: string };
type RoomObjective = { taskId: string; objectiveId: string; userId: number };
type RoomDetail = {
  id: string;
  title: string;
  mapSlug: string;
  gameMode: string;
  listed: boolean;
  hasPassword: boolean;
  hostName: string;
  memberCount: number;
  maxMembers: number;
  isHost: boolean;
  members: RoomMember[];
  claims: RoomClaim[];
  objectives: RoomObjective[];
};
type RoomState = { slug: string; id: string; status: string; error: string; password: string; detail: RoomDetail | null };

const sections = ["综合搜索", "实时地图", "任务管理", "妙妙工具", "日志监控"] as const;
let maps: MapItem[] = [];
let mapsNote = "";
let mapsLoading = false;
let mapsLoaded = false;
let room: RoomState = { slug: "", id: "", status: "", error: "", password: "", detail: null };
let roomSeq = 0;
let roomPending = false;
let roomTimer = 0;
let roomLive = false;
let socketRoomId = "";
let viewerName = "";
let viewerId = 0;
let claimSeedKey = "";
let lastMapSlug = "";
let mapPage: HTMLElement | null = null;
let usageTimer = 0;
let gameMode: "pvp" | "pve" = localStorage.getItem("zhange.guides.tarkov.gameMode") === "pve" ? "pve" : "pvp";

function path() {
  return decodeURIComponent(location.pathname.replace(/\/+$/, "") || "/");
}

function go(next: string) {
  const url = encodeURI(next);
  if (location.pathname + location.search !== url) history.pushState({}, "", url);
  render();
}

function reasonText(reason: unknown) {
  if (typeof reason === "string" && reason.trim()) return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason) {
    const message = String((reason as { message: unknown }).message || "");
    if (message) return message;
  }
  return "登录失败，请使用战鸽网站的账号和密码";
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

async function loggedIn() {
  try {
    const user = await invoke<{ loggedIn: boolean; username?: string }>("site_session");
    viewerName = user.username || "";
    if (user.loggedIn) {
      const me = await invoke<{ id?: number; display_name?: string; username?: string }>("site_get", { path: "/auth/me" }).catch(() => null);
      viewerId = Number(me?.id || 0);
      if (me?.display_name) viewerName = me.display_name;
      else if (me?.username) viewerName = me.username;
    }
    return user.loggedIn;
  } catch {
    return false;
  }
}

function crumbs(items: { label: string; href?: string }[]) {
  return `<nav class="crumbs">${items
    .map((item) => item.href ? `<a href="${item.href}" data-link>/${item.label}</a>` : `<span>/${item.label}</span>`)
    .join("")}</nav>`;
}

function mapMenuHtml() {
  if (!maps.length) return `<p>${esc(mapsNote || "正在读取地图")}</p>`;
  return maps.map((map) => `<button type="button" data-map="${esc(map.slug)}">${esc(map.name)}</button>`).join("");
}

function fillMapMenu() {
  document.querySelectorAll(".map-pop").forEach((node) => {
    node.innerHTML = mapMenuHtml();
  });
}

function topNav(active: string) {
  const buttons = sections.map((name) => {
    if (name === "实时地图") {
      return `<div class="nav-drop ${active === name ? "on" : ""}"><button type="button" data-section="${name}">${name}</button><div class="map-pop">${mapMenuHtml()}</div></div>`;
    }
    return `<button type="button" data-section="${name}" class="${active === name ? "on" : ""}">${name}</button>`;
  }).join("");
  return `<header class="topnav">${buttons}<div class="mode-switch" role="group" aria-label="游戏模式"><button type="button" data-mode="pvp" class="${gameMode === "pvp" ? "on" : ""}" title="在线对战（PVP）">PVP</button><button type="button" data-mode="pve" class="${gameMode === "pve" ? "on" : ""}" title="合作模式（PVE）">PVE</button></div></header>`;
}

function loginView() {
  return `
    <main class="login">
      <form class="login-card" id="login-form">
        <img src="/logo.png" alt="" />
        <h1>战鸽助手</h1>
        <p>使用战鸽账号登录</p>
        <label for="account">账号</label>
        <input id="account" name="account" autocomplete="username" />
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" />
        <p class="login-error" id="login-error"></p>
        <button type="submit">登录</button>
      </form>
    </main>`;
}

function menuView() {
  return `
    <main class="shell">
      ${crumbs([{ label: "主菜单" }])}
      <section class="menu">
        <button class="game-card" id="open-tavern" type="button">
          <img src="/logo.png" alt="" />
          <strong>战鸽酒馆</strong>
        </button>
        <button class="game-card" id="open-tarkov" type="button">
          <img src="/platform-icons/tarkov.png" alt="" />
          <strong>逃离塔科夫</strong>
        </button>
      </section>
    </main>`;
}

type SearchRow = { name: string; extra: string; mapSlug: string };

let searchQuery = "";
let searchNote = "";
let searchRows: { label: string; rows: SearchRow[] }[] = [];

function searchView() {
  return `
    <section class="search-home">
      <h1>逃离塔科夫</h1>
      <p class="sub">ESCAPE FROM TARKOV · 中文攻略站</p>
      <form class="search-bar" id="search-form" action="#">
        <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 15 L20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <input id="search-q" name="q" value="${esc(searchQuery)}" placeholder="搜物品、任务、地图、商人、BOSS..." aria-label="搜索" autocomplete="off" />
        <button type="submit">Enter</button>
      </form>
      <p class="search-note" id="search-note">${esc(searchNote)}</p>
      <div class="search-results" id="search-results">${searchResultsHtml()}</div>
    </section>`;
}

function searchResultsHtml() {
  return searchRows.map((section) => `
    <section>
      <h2>${esc(section.label)}</h2>
      ${section.rows.map((row) => `
        <button type="button" class="search-hit" ${row.mapSlug ? `data-search-map="${esc(row.mapSlug)}"` : "data-search-closed"}>
          <strong>${esc(row.name)}</strong>
          ${row.extra ? `<span>${esc(row.extra)}</span>` : ""}
        </button>`).join("")}
    </section>`).join("");
}

function paintSearch() {
  const note = document.querySelector("#search-note");
  const results = document.querySelector("#search-results");
  if (note) note.textContent = searchNote;
  if (results) results.innerHTML = searchResultsHtml();
}

function readSearchRows(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const name = String(item.name || "").trim();
    if (!name) return [];
    return [{ name, extra: String(item.extra || "").trim(), mapSlug: "" }];
  });
}

function localMapRows(query: string): SearchRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return maps.flatMap((map) => {
    const hay = `${map.name} ${map.english} ${map.slug}`.toLowerCase();
    if (!hay.includes(needle)) return [];
    return [{ name: map.name, extra: map.english, mapSlug: map.slug }];
  });
}

async function runSearch() {
  const input = document.querySelector<HTMLInputElement>("#search-q");
  const query = (input?.value || "").trim();
  searchQuery = query;
  if (!query) {
    searchNote = "";
    searchRows = [];
    paintSearch();
    return;
  }
  searchNote = "正在搜索…";
  searchRows = [];
  paintSearch();
  try {
    const data = await invoke<{ items?: unknown; tasks?: unknown; traders?: unknown; bosses?: unknown }>("site_get", {
      path: `/guides/tarkov/search?q=${encodeURIComponent(query)}`,
    });
    if ((document.querySelector<HTMLInputElement>("#search-q")?.value || "").trim() !== query) return;
    const sections = [
      ["地图", localMapRows(query)],
      ["任务", readSearchRows(data.tasks)],
      ["物品", readSearchRows(data.items)],
      ["商人", readSearchRows(data.traders)],
      ["BOSS", readSearchRows(data.bosses)],
    ].filter((section): section is [string, SearchRow[]] => Array.isArray(section[1]) && section[1].length > 0)
      .map(([label, rows]) => ({ label, rows }));
    searchRows = sections;
    searchNote = sections.length
      ? "地图标注尚未接入。已有的地图可以打开实时地图，其它结果点开不会进入未完成页面。"
      : "没有匹配结果";
  } catch (error) {
    if ((document.querySelector<HTMLInputElement>("#search-q")?.value || "").trim() !== query) return;
    searchRows = [];
    searchNote = error instanceof Error ? error.message : "搜索失败";
  }
  paintSearch();
}

function mapView(slug: string) {
  const map = maps.find((item) => item.slug === slug);
  const name = map?.name || slug;
  const image = `<div class="map-viewport" id="map-viewport"><div id="map-root" data-slug="${slug}"></div></div>`;
  return `
    <section class="map-app tarkov-page">
      ${image}
      <div class="map-chrome">
        ${crumbs([
          { label: "主菜单", href: "/主菜单" },
          { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
          { label: "实时地图", href: "/主菜单/逃离塔科夫/实时地图" },
          { label: name },
        ])}
        ${topNav("实时地图")}
      </div>
      <div class="left-stack">
        <button class="room-expand" type="button" data-expand="room" hidden>房间</button>
        <section class="room-card" id="room-panel">
          <header class="room-head">
            <span class="room-home" aria-hidden="true"></span>
            <strong>房间</strong>
            <span class="room-code" id="room-code">……</span>
            <button type="button" data-room="copy">复制</button>
            <button type="button" data-collapse="room">收起</button>
          </header>
          <div class="room-actions">
            <button type="button" data-room="join">加入队友房间</button>
            <button type="button" data-room="settings">设置</button>
            <button type="button" class="room-leave" data-room="leave">离开房间</button>
          </div>
          <form class="room-form" id="room-join" hidden>
            <input name="code" placeholder="队友的房间号" maxlength="16" />
            <input name="password" placeholder="密码，没有就留空" maxlength="32" />
            <button type="submit">加入</button>
          </form>
          <form class="room-form" id="room-settings" hidden>
            <input name="password" placeholder="设置房间密码，留空则清除" maxlength="32" />
            <button type="submit">保存</button>
          </form>
          <div id="room-live"></div>
        </section>
        <aside class="overlay left" id="filter-panel">
          <header><strong>筛选</strong><button type="button" data-collapse="filter">收起</button></header>
          <div class="panel-body" id="filter-body"><p>正在读取图层…</p></div>
        </aside>
      </div>
      <button class="overlay-tab left" type="button" data-expand="filter" hidden>筛选</button>
      <div class="right-stack">
        ${overlayCardHtml()}
        <aside class="overlay right" id="task-panel">
          <header><strong>任务</strong><button type="button" data-collapse="task">收起</button></header>
          <div class="panel-body tasks" id="task-body"><p>正在读取任务…</p></div>
        </aside>
      </div>
      <button class="overlay-tab right" type="button" data-expand="task" hidden>任务</button>
      ${overlayDialogHtml()}
      <div id="map-summary-modal" class="map-summary" hidden>
        <div class="map-summary-card">
          <header><strong>准备内容总结</strong><button type="button" id="map-summary-close">关闭</button></header>
          <div id="map-summary-body"><p>正在加载…</p></div>
        </div>
      </div>
    </section>`;
}

function toolsView() {
  const slider = (id: string, label: string, min: string, max: string, step: string) =>
    `<label class="tool-slider"><span>${label}</span><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" /><strong id="${id}-val"></strong></label>`;
  const delays = Array.from({ length: 15 }, (_, index) => `<label><span>${index + 1}</span><input data-delay="${index}" inputmode="numeric" /></label>`).join("");
  return `
    <section class="tools-page">
      <div class="tools-pair">
        <article>
          <header class="tool-head"><h2>视觉增强</h2><button type="button" id="visual-toggle" class="tool-switch on" aria-pressed="true" aria-label="视觉增强开关"></button></header>
          <div class="tool-row screen-row">
            <span>屏幕</span>
            <label><input id="screen-1" type="checkbox" value="1" />屏幕 1</label>
            <label><input id="screen-2" type="checkbox" value="2" />屏幕 2</label>
          </div>
          <div class="vis-body">
            <div class="scheme-col" id="scheme-buttons"></div>
            <div class="tool-sliders">
              ${slider("vis-gamma", "伽马", "0.5", "4", "0.01")}
              ${slider("vis-bright", "亮度", "-100", "100", "1")}
              ${slider("vis-contrast", "对比度", "-100", "100", "1")}
              ${slider("vis-red", "红色", "0", "255", "1")}
              ${slider("vis-green", "绿色", "0", "255", "1")}
              ${slider("vis-blue", "蓝色", "0", "255", "1")}
            </div>
          </div>
          <div class="tool-row tool-actions">
            <button type="button" id="scheme-save">保存方案</button>
            <button type="button" id="scheme-reset">恢复默认</button>
          </div>
          <p id="visual-note"></p>
        </article>
        <article>
          <header class="tool-head"><h2>健身助手</h2><button type="button" id="fit-toggle" class="tool-switch on" aria-pressed="true" aria-label="健身助手开关"></button></header>
          <p class="tool-warn">须以管理员身份运行。站在健身器材旁按下热键后，会先按 F，再按延迟自动点击。</p>
          <div class="fit-hotkey"><button type="button" id="fit-hotkey" data-hotkey="fitness">快捷键：F9</button></div>
          <div class="delay-grid">${delays}</div>
          <div class="tool-actions fit-actions">
            <button type="button" id="fit-save">保存延迟配置</button>
            <button type="button" id="fit-reset">恢复默认延迟</button>
          </div>
          <p id="fit-note">状态：就绪</p>
        </article>
      </div>
      <div class="tools-split">
        <article>
          <h2>目录绑定</h2>
          <label>截图目录</label>
          <div class="path-row"><input id="shot-path" readonly /><button type="button" data-pick="screenshots">设定</button><button type="button" data-open="screenshots">打开</button></div>
          <label>日志目录</label>
          <div class="path-row"><input id="log-path" readonly /><button type="button" data-pick="logs">设定</button><button type="button" data-open="logs">打开</button></div>
          <button type="button" class="detect" id="detect-paths">一键自动检测路径</button>
          <button type="button" id="log-sync" title="本机解析日志，只把任务状态回填到账号，不会上传原文。">历史任务同步</button>
          <div id="log-sync-box" class="log-sync" hidden>
            <p>选择要回填的启动记录范围。默认读取全部。</p>
            <div>
              <button type="button" data-sync="all" class="on">全部</button>
              <button type="button" data-sync="wipe">本赛季</button>
              <button type="button" data-sync="7d">近 7 天</button>
              <button type="button" data-sync="30d">近 30 天</button>
            </div>
            <div class="log-sync-actions">
              <button type="button" id="log-sync-go">开始同步</button>
              <button type="button" id="log-sync-cancel">取消</button>
            </div>
          </div>
          <p id="path-note"></p>
        </article>
      </div>
    </section>`;
}

type LogLive = {
  running: boolean;
  session: string;
  application: string;
  notices: string;
  backend: string;
  slug: string;
  mode: string;
  inRaid: boolean;
  server: string;
  location: string;
};
type LogNote = { at: string; text: string };
const logFeed: LogNote[] = [];
let logTimer = 0;
let seenSession = "";

function logClock() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function baseName(value: string) {
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function noteLog(text: string) {
  logFeed.unshift({ at: logClock(), text });
  if (logFeed.length > 80) logFeed.length = 80;
  const list = document.querySelector("#log-feed");
  if (!list) return;
  list.innerHTML = logFeed.map((item) => `<li><time>${esc(item.at)}</time><span>${esc(item.text)}</span></li>`).join("");
}

function logMonitorHtml() {
  const feed = logFeed.length
    ? logFeed.map((item) => `<li><time>${esc(item.at)}</time><span>${esc(item.text)}</span></li>`).join("")
    : `<li class="log-empty"><span>还没有触发</span></li>`;
  return `
    <section class="log-monitor">
      <article>
        <h2>当前日志</h2>
        <dl id="log-status"><p>正在读取…</p></dl>
      </article>
      <article>
        <h2>触发记录</h2>
        <ol id="log-feed">${feed}</ol>
      </article>
    </section>`;
}

function stopLogTimer() {
  window.clearInterval(logTimer);
  logTimer = 0;
}

async function refreshLogMonitor() {
  const host = document.querySelector("#log-status");
  if (!host) return;
  const live = await invoke<LogLive>("log_state").catch(() => null);
  if (!document.querySelector("#log-status") || !live) return;
  if (live.running && live.session && live.session !== seenSession) {
    seenSession = live.session;
    noteLog(`锁定会话 ${baseName(live.session)}`);
  }
  if (!live.running && seenSession) {
    seenSession = "";
    noteLog("游戏已退出，停止读取日志");
  }
  const mapName = maps.find((item) => item.slug === live.slug)?.name || live.slug || "—";
  const rows: [string, string][] = [
    ["游戏", live.running ? "正在运行" : "未检测到"],
    ["会话", live.session ? baseName(live.session) : "未锁定"],
    ["应用日志", live.application ? baseName(live.application) : "—"],
    ["通知日志", live.notices ? baseName(live.notices) : "—"],
    ["后端日志", live.backend ? baseName(live.backend) : "—"],
    ["地图", mapName],
    ["模式", live.mode ? live.mode.toUpperCase() : "—"],
    ["战局", live.inRaid ? "进行中" : "未开始"],
    ["服务器", live.inRaid ? live.server || "未知" : "—"],
    ["地点", live.location || "—"],
  ];
  host.innerHTML = rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd title="${esc(value)}">${esc(value)}</dd>`).join("");
}

function plainView(title: string, text: string) {
  return `<section class="placeholder"><h1>${title}</h1><p>${text}</p></section>`;
}

function tarkovFrame(active: string, crumbItems: { label: string; href?: string }[], body: string, mapMode = false) {
  if (mapMode) return body;
  return `
    <main class="shell tarkov-page">
      ${crumbs(crumbItems)}
      ${topNav(active)}
      <div class="stage">${body}</div>
    </main>`;
}

function mapLoadingView(slug: string) {
  const map = maps.find((item) => item.slug === slug);
  const name = map?.name || "地图";
  const failed = Boolean(room.error);
  const text = room.error || room.status || "正在创建私人房间…";
  return tarkovFrame("实时地图", [
    { label: "主菜单", href: "/主菜单" },
    { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
    { label: "实时地图", href: "/主菜单/逃离塔科夫/实时地图" },
    { label: name },
  ], `<section class="map-loading" id="map-loading"><p>${esc(text)}</p>${failed ? `<button type="button" data-retry-room>重试</button>` : ""}</section>`);
}

function renderMapPicker() {
  return tarkovFrame("实时地图", [
    { label: "主菜单", href: "/主菜单" },
    { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
    { label: "实时地图" },
  ], plainView("实时地图", "还没有进入房间。把鼠标移到顶部「实时地图」，选择一张地图。地图快捷键要进入房间后才会生效。"));
}

async function loadMaps() {
  if (mapsLoading || mapsLoaded) return;
  mapsLoading = true;
  mapsNote = "正在读取地图";
  try {
    const data = await invoke<{ items: { slug: string; name: string; english?: string; thumb_link?: string; thumbLink?: string }[] }>("site_get", { path: "/guides/tarkov/maps" });
    maps = (data.items || []).map((item) => ({
      slug: item.slug,
      name: item.name,
      english: item.english || "",
      thumbLink: item.thumbLink || item.thumb_link || "",
    }));
    mapsNote = maps.length ? "" : "没有读到地图";
  } catch (error) {
    mapsNote = error instanceof Error ? error.message : "地图读取失败";
  } finally {
    mapsLoading = false;
    mapsLoaded = true;
    fillMapMenu();
    render();
  }
}

function mapPageSlug() {
  return mapPage?.querySelector("#map-root")?.getAttribute("data-slug") || "";
}

function detachMapPage() {
  const node = document.querySelector(".map-app");
  if (!(node instanceof HTMLElement)) return;
  node.hidden = true;
  document.body.appendChild(node);
  mapPage = node;
}

function showCachedMap(slug: string) {
  if (!mapPage || mapPageSlug() !== slug) return false;
  mapPage.hidden = false;
  root.replaceChildren(mapPage);
  requestAnimationFrame(() => invalidateLiveMap());
  return true;
}

function discardMapPage() {
  destroyLiveMap();
  mapPage?.remove();
  mapPage = null;
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function readDetail(value: Record<string, unknown>): RoomDetail | null {
  const id = String(value.public_id || value.publicId || "");
  if (!id) return null;
  const members = Array.isArray(value.members) ? value.members : [];
  return {
    id,
    title: String(value.title || ""),
    mapSlug: String(value.map_slug || value.mapSlug || ""),
    gameMode: String(value.game_mode || value.gameMode || "pvp"),
    listed: Object.prototype.hasOwnProperty.call(value, "listed") ? Boolean(value.listed) : false,
    hasPassword: Boolean(value.has_password || value.hasPassword),
    hostName: String(value.host_display_name || value.hostDisplayName || ""),
    memberCount: Number(value.member_count || value.memberCount || members.length || 0),
    maxMembers: Number(value.max_members || value.maxMembers || 0),
    isHost: Boolean(value.is_host || value.isHost),
    members: members.map((row) => {
      const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
      return {
        userId: Number(item.user_id || item.userId || 0),
        name: String(item.display_name || item.displayName || "成员"),
        host: Boolean(item.is_host || item.isHost),
        online: Boolean(item.online),
        inRoom: item.in_room !== false && item.inRoom !== false,
      };
    }),
    claims: (Array.isArray(value.claims) ? value.claims : []).flatMap((row) => {
      const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const taskId = String(item.task_id || item.taskId || "").trim();
      const userId = Number(item.user_id || item.userId || 0);
      if (!taskId || !userId) return [];
      return [{ taskId, userId, name: String(item.display_name || item.displayName || "") }];
    }),
    objectives: (Array.isArray(value.objective_dones) ? value.objective_dones : []).flatMap((row) => {
      const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const taskId = String(item.task_id || item.taskId || "").trim();
      const objectiveId = String(item.objective_id || item.objectiveId || "").trim();
      const userId = Number(item.user_id || item.userId || 0);
      if (!taskId || !objectiveId || !userId) return [];
      return [{ taskId, objectiveId, userId }];
    }),
  };
}

function roomCode(id: string) {
  return id.trim().toUpperCase();
}

function failText(reason: unknown, fallback: string) {
  if (typeof reason === "string" && reason.trim()) return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason) {
    const message = String((reason as { message: unknown }).message || "");
    if (message) return message;
  }
  return fallback;
}

function applyDetail(detail: RoomDetail, slug: string, password = room.password) {
  roomPending = false;
  room = {
    slug: detail.mapSlug || slug,
    id: detail.id,
    status: `私人房间 ${detail.id}`,
    error: "",
    password,
    detail,
  };
}

function syncOverlayHotkey() {
  const detail = room.detail;
  const mine = detail?.members.find((item) => (viewerId && item.userId === viewerId) || (viewerName && item.name === viewerName));
  setOverlayHotkeyLive(Boolean(room.id && detail && !room.error && mine?.inRoom));
}

function paintRoomCard() {
  syncOverlayHotkey();
  const live = document.querySelector("#room-live");
  const code = document.querySelector("#room-code");
  if (!live || !code) return;
  if (room.error) {
    code.textContent = "未建立";
    live.innerHTML = `<p class="room-error">${esc(room.error)}</p>`;
    return;
  }
  if (!room.id || !room.detail) {
    code.textContent = "创建中";
    live.innerHTML = `<p class="room-wait">${esc(room.status || "正在创建私人房间…")}</p>`;
    return;
  }
  const detail = room.detail;
  const mapName = maps.find((item) => item.slug === (detail.mapSlug || room.slug))?.name || detail.mapSlug || room.slug;
  const seated = detail.members.filter((item) => item.inRoom);
  const people = seated.length ? seated : detail.members;
  const online = people.filter((item) => item.online).length;
  const total = detail.memberCount || people.length;
  code.textContent = roomCode(detail.id);
  const memberHtml = people.map((item) => {
    const mine = item.name === viewerName || (detail.isHost && item.host);
    return `<li>
      <span class="room-dot" data-on="${item.online ? "1" : "0"}"></span>
      <span class="room-name">${esc(item.name)}</span>
      ${mine ? `<span class="room-tag you">你</span>` : ""}
      ${item.host ? `<span class="room-tag host">队长</span>` : ""}
      <span class="room-state">${item.online ? "在线" : "离线"}</span>
    </li>`;
  }).join("");
  const flags = [
    detail.gameMode.toUpperCase(),
    detail.listed ? "公开" : "私人",
    room.password || detail.hasPassword ? "有密码" : "",
    detail.maxMembers ? `上限 ${detail.maxMembers}` : "",
    detail.title && detail.title !== mapName ? detail.title : "",
    detail.hostName ? `房主 ${detail.hostName}` : "",
  ].filter(Boolean).map((item) => esc(item)).join(" · ");
  const phone = `https://zhange.space/guides/tarkov/raid-prep/rooms/${encodeURIComponent(detail.id)}`;
  live.innerHTML = `
    <div class="room-meta">
      <span class="room-map">${esc(mapName)} ${online}/${total} 在线</span>
      <a href="${phone}" target="_blank" rel="noreferrer">手机查看</a>
    </div>
    <ul class="room-members">${memberHtml || `<li><span class="room-name">${esc(viewerName || "你")}</span></li>`}</ul>
    <p class="room-flags">${flags}</p>`;
}

function pushQuestRoom() {
  const detail = room.detail;
  if (!detail || !document.querySelector("#map-root")) return;
  const progress = mapQuestProgress();
  applyRoomClaims(detail.claims, viewerId);
  setQuestRoom({
    claims: detail.claims,
    dones: detail.objectives,
    accountObjectives: progress.objectives,
    doneTaskIds: progress.done,
    selfUserId: viewerId || null,
    selfName: viewerName || "我",
  });
}

async function syncQuestClaims() {
  const detail = room.detail;
  if (!room.id || !detail) return;
  const slug = detail.mapSlug || room.slug;
  const key = `${room.id}:${slug}`;
  if (claimSeedKey === key) {
    pushQuestRoom();
    return;
  }
  claimSeedKey = key;
  const progress = mapQuestProgress();
  const mine = new Set(detail.claims.filter((item) => item.userId === viewerId).map((item) => item.taskId));
  const occupied = new Set(detail.claims.map((item) => item.taskId));
  const added: string[] = [];
  for (const id of progress.onMapIds) {
    if (!progress.started.includes(id) || progress.done.includes(id) || mine.has(id)) continue;
    if (!occupied.has(id) && occupied.size >= 40) break;
    added.push(id);
    occupied.add(id);
  }
  try {
    if (added.length) {
      const claimed = await invoke<Record<string, unknown>>("site_post", {
        path: `/guides/tarkov/raid-rooms/${room.id}/claims`,
        body: { task_ids: added },
      });
      const next = readDetail(claimed);
      if (next) room.detail = next;
    }
    const seeded = await invoke<Record<string, unknown>>("site_post", {
      path: `/guides/tarkov/raid-rooms/${room.id}/claims/from-progress`,
      body: {},
    }).catch(() => null);
    const next = seeded ? readDetail(seeded) : null;
    if (next) room.detail = next;
  } catch {
    /* 勾选失败时仍按当前房间认领画点 */
  }
  pushQuestRoom();
}

async function toggleClaim(id: string, on: boolean) {
  if (!room.id || !room.detail) return;
  const occupied = new Set(room.detail.claims.map((item) => item.taskId));
  if (on && !occupied.has(id) && occupied.size >= 40) return;
  try {
    const data = on
      ? await invoke<Record<string, unknown>>("site_put", { path: `/guides/tarkov/raid-rooms/${room.id}/claims/${encodeURIComponent(id)}`, body: {} })
      : await invoke<Record<string, unknown>>("site_delete", { path: `/guides/tarkov/raid-rooms/${room.id}/claims/${encodeURIComponent(id)}` });
    const next = readDetail(data);
    if (next) room.detail = next;
  } catch {
    /* 认领失败时列表会按房间里的勾选画回去 */
  }
  pushQuestRoom();
}

async function markQuestObjective(taskId: string, objectiveId: string, done: boolean) {
  setMapObjective(taskId, objectiveId, done);
  if (!room.id) return;
  const path = `/guides/tarkov/raid-rooms/${room.id}/objective-dones/${encodeURIComponent(taskId)}/${encodeURIComponent(objectiveId)}`;
  try {
    const data = done
      ? await invoke<Record<string, unknown>>("site_put", { path, body: {} })
      : await invoke<Record<string, unknown>>("site_delete", { path });
    const next = readDetail(data);
    if (next) room.detail = next;
    pushQuestRoom();
  } catch {
    /* 账号进度已记下，房间勾选失败时自己的点仍会隐藏 */
  }
}

function watchRoom() {
  window.clearInterval(roomTimer);
  if (roomLive || !room.id) return;
  roomTimer = window.setInterval(() => void refreshRoom(), 8000);
}

function syncRoomSocket() {
  if (!room.id) {
    if (socketRoomId) {
      socketRoomId = "";
      roomLive = false;
      void invoke("room_unwatch").catch(() => undefined);
    }
    return;
  }
  if (socketRoomId === room.id) return;
  socketRoomId = room.id;
  roomLive = false;
  void invoke("room_watch", { publicId: room.id }).catch(() => undefined);
}

function markOnline(detail: RoomDetail, ids: number[]) {
  const online = new Set(ids);
  detail.members = detail.members.map((row) => ({ ...row, online: online.has(row.userId) }));
}

function adoptRoom(detail: RoomDetail) {
  room.detail = detail;
  room.id = detail.id || room.id;
  syncOverlayHotkey();
  room.error = "";
  room.status = `私人房间 ${roomCode(room.id)}`;
  const nextSlug = detail.mapSlug;
  if (roomPending || !nextSlug || nextSlug === room.slug) {
    if (nextSlug && !roomPending) room.slug = nextSlug;
    paintRoomCard();
    pushQuestRoom();
    return;
  }
  room.slug = nextSlug;
  lastMapSlug = nextSlug;
  if (path().startsWith("/主菜单/逃离塔科夫/实时地图")) go(`/主菜单/逃离塔科夫/实时地图/${nextSlug}`);
  else paintRoomCard();
}

function onRoomSync(payload: Record<string, unknown>) {
  const event = String(payload.event || "");
  if (event === "closed") {
    roomLive = false;
    void refreshRoom();
    watchRoom();
    return;
  }
  if (event === "pong" || event === "ping") return;
  const online = Array.isArray(payload.online_user_ids)
    ? payload.online_user_ids.map((item) => Number(item))
    : null;
  const snap = payload.snapshot && typeof payload.snapshot === "object"
    ? payload.snapshot as Record<string, unknown>
    : null;
  if (snap) {
    if (String(snap.public_id || snap.publicId || "") !== room.id) return;
    roomLive = true;
    window.clearInterval(roomTimer);
    const detail = readDetail(snap);
    if (!detail) return;
    if (online) markOnline(detail, online);
    if (snap.is_member === false) {
      room.error = "已不在该房间";
      room.detail = detail;
      paintRoomCard();
      return;
    }
    adoptRoom(detail);
    return;
  }
  if (event === "presence" && online && room.detail) {
    roomLive = true;
    window.clearInterval(roomTimer);
    markOnline(room.detail, online);
    paintRoomCard();
  }
}

async function refreshRoom() {
  if (!room.id || roomPending) return;
  try {
    const data = await invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/raid-rooms/${room.id}` });
    const detail = readDetail(data);
    if (!detail || detail.id !== room.id) return;
    adoptRoom(detail);
  } catch {
    /* 房间快照失败时保留上一份 */
  }
}

function waitForRoomLive(id: string) {
  if (roomLive && socketRoomId === id) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => finish(false), 8000);
    const poll = window.setInterval(() => {
      if (roomLive && room.id === id) finish(true);
    }, 100);
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      resolve(ok);
    };
  });
}

function keepRoom(slug: string) {
  const map = maps.find((item) => item.slug === slug);
  if (!map || (room.slug === slug && room.id)) return;
  void ensureRoom(slug, map.name);
}

async function ensureRoom(slug: string, name: string) {
  if (room.slug === slug && (room.id || room.error || room.status.startsWith("正在"))) return;
  const seq = ++roomSeq;
  room = { slug, id: "", status: "正在创建私人房间…", error: "", password: "", detail: null };
  render();
  try {
    const created = await invoke<Record<string, unknown>>("site_post", {
      path: "/guides/tarkov/raid-rooms",
      body: { title: name, listed: false, game_mode: gameMode },
    });
    if (seq !== roomSeq) return;
    const id = String(created.public_id || created.publicId || created.id || "");
    if (!id) throw new Error("房间已创建，但没有返回编号");
    roomPending = true;
    room = { slug, id, status: "正在连接房间…", error: "", password: "", detail: null };
    render();
    await waitForRoomLive(id);
    if (seq !== roomSeq) return;
    room.status = "正在设置地图…";
    render();
    const mapped = await invoke<Record<string, unknown>>("site_post", { path: `/guides/tarkov/raid-rooms/${id}/map`, body: { map: slug } });
    if (seq !== roomSeq) return;
    const detail = readDetail(mapped) || readDetail(created);
    if (detail) applyDetail(detail, slug);
    else {
      roomPending = false;
      room = { slug, id, status: `私人房间 ${roomCode(id)}`, error: "", password: "", detail: null };
    }
  } catch (error) {
    if (seq !== roomSeq) return;
    roomPending = false;
    room = { slug, id: "", status: "", error: failText(error, "创建房间失败"), password: "", detail: null };
  }
  render();
}

async function switchRoomMap(slug: string) {
  if (!room.id || roomPending || slug === (room.detail?.mapSlug || "")) return;
  const id = room.id;
  const password = room.password;
  roomPending = true;
  room = { slug, id, status: "正在连接房间…", error: "", password, detail: null };
  lastMapSlug = slug;
  go(`/主菜单/逃离塔科夫/实时地图/${slug}`);
  await waitForRoomLive(id);
  if (room.id !== id) {
    roomPending = false;
    return;
  }
  room.status = "正在更换地图…";
  render();
  try {
    const mapped = await invoke<Record<string, unknown>>("site_post", {
      path: `/guides/tarkov/raid-rooms/${id}/map`,
      body: { map: slug },
    });
    if (room.id !== id) return;
    const seeded = await invoke<Record<string, unknown>>("site_post", {
      path: `/guides/tarkov/raid-rooms/${id}/claims/from-progress`,
      body: {},
    }).catch(() => mapped);
    if (room.id !== id) return;
    const detail = readDetail(seeded) || readDetail(mapped);
    if (detail) applyDetail(detail, slug, password);
    else roomPending = false;
  } catch (error) {
    if (room.id !== id) return;
    roomPending = false;
    room = { slug, id, status: "", error: failText(error, "更换地图失败"), password, detail: null };
  }
  render();
}

function paint() {
  stopLogTimer();
  const current = path();
  const base = "/主菜单/逃离塔科夫";
  const onMap = current.startsWith(`${base}/实时地图/`);
  syncRoomSocket();
  if (!onMap) detachMapPage();
  if (current === "/登录") {
    window.clearInterval(usageTimer);
    root.innerHTML = loginView();
    return;
  }
  if (current === "/" || current === "/主菜单") {
    window.clearInterval(usageTimer);
    root.innerHTML = menuView();
    return;
  }
  const tavern = tavernMatch(current);
  if (tavern) {
    window.clearInterval(usageTimer);
    const crumbsItems = [
      { label: "主菜单", href: "/主菜单" },
      { label: "战鸽酒馆", href: tavern.kind === "article" ? "/主菜单/战鸽酒馆" : undefined },
    ];
    const body = tavern.kind === "article" ? tavernArticleHtml() : tavernListHtml();
    root.innerHTML = `<main class="shell">${crumbs(crumbsItems)}${body}</main>`;
    if (tavern.kind === "article") void mountTavernArticle(tavern.slug);
    else void mountTavernList();
    return;
  }
  if (!current.startsWith(base)) {
    history.replaceState({}, "", encodeURI("/主菜单"));
    root.innerHTML = menuView();
    return;
  }
  void loadMaps();
  const rest = current.slice(base.length + 1);
  const [section = "综合搜索", rawSlug = ""] = rest.split("/");
  const sectionName = section === "视觉增强" || section === "辅助工具" || section === "应用设置" ? "妙妙工具" : section;
  const known = sections.includes(sectionName as (typeof sections)[number]) ? sectionName : "综合搜索";
  const mapSlug = known === "实时地图" && !rawSlug && lastMapSlug ? lastMapSlug : rawSlug;
  if (known === "实时地图" && mapSlug && mapSlug !== rawSlug) {
    history.replaceState({}, "", encodeURI(`/主菜单/逃离塔科夫/实时地图/${mapSlug}`));
  }
  if (known === "实时地图" && mapSlug) {
    window.clearInterval(usageTimer);
    lastMapSlug = mapSlug;
    if (room.id && !roomPending && !room.error) room.slug = mapSlug;
    const ready = Boolean(room.id) && room.slug === mapSlug && !roomPending && !room.error;
    if (ready && (root.querySelector("#map-root")?.getAttribute("data-slug") === mapSlug || showCachedMap(mapSlug))) {
      fillMapMenu();
      paintRoomCard();
      watchRoom();
      void mountMapTasks(mapSlug);
      void publishOverlayMap(mapSlug);
      return;
    }
    if (!ready) {
      discardMapPage();
      root.innerHTML = mapLoadingView(mapSlug);
      if (!room.id && !roomPending) keepRoom(mapSlug);
      return;
    }
    discardMapPage();
    root.innerHTML = mapView(mapSlug);
    void mountLiveMap(mapSlug).then(() => publishOverlayMap(mapSlug));
    paintRoomCard();
    watchRoom();
    void mountMapTasks(mapSlug);
    mapPage = document.querySelector(".map-app");
    return;
  }
  if (known === "实时地图") {
    window.clearInterval(usageTimer);
    root.innerHTML = renderMapPicker();
    return;
  }
  if (known === "妙妙工具") {
    root.innerHTML = tarkovFrame("妙妙工具", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "妙妙工具" },
    ], toolsView());
    void refreshSettings();
    void mountTools();
    return;
  }
  if (known === "日志监控") {
    window.clearInterval(usageTimer);
    root.innerHTML = tarkovFrame("日志监控", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "日志监控" },
    ], logMonitorHtml());
    void refreshLogMonitor();
    logTimer = window.setInterval(() => void refreshLogMonitor(), 1000);
    return;
  }
  window.clearInterval(usageTimer);
  if (known === "任务管理") {
    root.innerHTML = tarkovFrame("任务管理", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "任务管理" },
    ], taskPageShell());
    void mountTaskPage();
    return;
  }
  const body = known === "综合搜索"
    ? searchView()
    : plainView(known, "页面先放在这里，功能稍后接上。");
  root.innerHTML = tarkovFrame(known, [
    { label: "主菜单", href: "/主菜单" },
    { label: "逃离塔科夫", href: known === "综合搜索" ? undefined : "/主菜单/逃离塔科夫/综合搜索" },
    ...(known === "综合搜索" ? [] : [{ label: known }]),
  ], body);
}

type ToolVisual = {
  gamma: number; brightness: number; contrast: number; red: number; green: number; blue: number;
  night: boolean; nightBrightness: number; nightGray: number; nightContrast: number; bigMap: boolean; hotkey: string; screen: number;
};
type ToolState = {
  schemes: { name: string; visual: ToolVisual }[];
  active: number;
  fitness: { enabled: boolean; hotkey: string; delays: number[] };
  visualEnabled: boolean;
  screens: number[];
  status: string;
};
let toolState: ToolState | null = null;
let hotkeyCapture: { kind: "scheme"; index: number } | { kind: "fitness" } | null = null;

const SCHEME_DEFAULTS: ToolVisual[] = [
  { gamma: 1, brightness: 0, contrast: 0, red: 128, green: 128, blue: 128, night: false, nightBrightness: 0, nightGray: 0, nightContrast: 0, bigMap: false, hotkey: "F2", screen: 1 },
  { gamma: 1.3, brightness: 6, contrast: 4, red: 128, green: 128, blue: 128, night: true, nightBrightness: 37, nightGray: 30, nightContrast: 0, bigMap: false, hotkey: "F3", screen: 1 },
  { gamma: 1.55, brightness: 55, contrast: 21, red: 128, green: 128, blue: 128, night: true, nightBrightness: 0, nightGray: 101, nightContrast: 54, bigMap: false, hotkey: "F4", screen: 1 },
  { gamma: 2.4, brightness: 55, contrast: 22, red: 128, green: 128, blue: 128, night: true, nightBrightness: 66, nightGray: 48, nightContrast: 58, bigMap: false, hotkey: "F5", screen: 1 },
  { gamma: 2.9, brightness: 100, contrast: 37, red: 128, green: 128, blue: 128, night: true, nightBrightness: 93, nightGray: 46, nightContrast: 60, bigMap: false, hotkey: "F6", screen: 1 },
];

function readVisual(): ToolVisual {
  const num = (id: string) => Number((document.querySelector(`#${id}`) as HTMLInputElement | null)?.value || 0);
  const current = toolState?.schemes[toolState.active]?.visual;
  return {
    gamma: num("vis-gamma"),
    brightness: num("vis-bright"),
    contrast: num("vis-contrast"),
    red: num("vis-red"),
    green: num("vis-green"),
    blue: num("vis-blue"),
    night: current?.night ?? false,
    nightBrightness: current?.nightBrightness ?? 0,
    nightGray: current?.nightGray ?? 0,
    nightContrast: current?.nightContrast ?? 0,
    bigMap: current?.bigMap ?? false,
    hotkey: current?.hotkey || "F2",
    screen: selectedScreens()[0] ?? current?.screen ?? 1,
  };
}

function selectedScreens(): number[] {
  return [1, 2].filter((screen) => document.querySelector<HTMLInputElement>(`#screen-${screen}`)?.checked);
}

function paintTools(state: ToolState) {
  toolState = state;
  const host = document.querySelector("#scheme-buttons");
  if (!host) return;
  host.innerHTML = state.schemes.map((item, index) => {
    const listening = hotkeyCapture?.kind === "scheme" && hotkeyCapture.index === index;
    return `<div class="scheme-line">
      <button type="button" data-scheme="${index}" class="${index === state.active ? "on" : ""}">${item.name}</button>
      <button type="button" data-hotkey="scheme" data-scheme-key="${index}">${listening ? "请设置快捷键" : `快捷键：${item.visual.hotkey}`}</button>
    </div>`;
  }).join("");
  const visual = state.schemes[state.active]?.visual;
  if (!visual) return;
  const set = (id: string, value: number) => {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    const text = document.querySelector(`#${id}-val`);
    if (input) input.value = String(value);
    if (text) text.textContent = Number(value).toFixed(id === "vis-gamma" ? 2 : 0);
  };
  set("vis-gamma", visual.gamma);
  set("vis-bright", visual.brightness);
  set("vis-contrast", visual.contrast);
  set("vis-red", visual.red);
  set("vis-green", visual.green);
  set("vis-blue", visual.blue);
  const visualToggle = document.querySelector<HTMLButtonElement>("#visual-toggle");
  const fitToggle = document.querySelector<HTMLButtonElement>("#fit-toggle");
  const screens = state.screens?.length ? state.screens : [visual.screen || 1];
  for (const screen of [1, 2]) {
    const box = document.querySelector<HTMLInputElement>(`#screen-${screen}`);
    if (box) box.checked = screens.includes(screen);
  }
  if (visualToggle) {
    visualToggle.classList.toggle("on", state.visualEnabled !== false);
    visualToggle.setAttribute("aria-pressed", state.visualEnabled === false ? "false" : "true");
  }
  if (fitToggle) {
    fitToggle.classList.toggle("on", state.fitness.enabled);
    fitToggle.setAttribute("aria-pressed", state.fitness.enabled ? "true" : "false");
  }
  const fitKey = document.querySelector("#fit-hotkey");
  if (fitKey) fitKey.textContent = hotkeyCapture?.kind === "fitness" ? "请设置快捷键" : `快捷键：${state.fitness.hotkey}`;
  document.querySelectorAll<HTMLInputElement>("[data-delay]").forEach((input) => {
    input.value = String(state.fitness.delays[Number(input.dataset.delay)] ?? "");
  });
  const note = document.querySelector("#fit-note");
  if (note) note.textContent = `状态：${state.status}`;
}

function collectTools(): ToolState | null {
  if (!toolState) return null;
  const visual = readVisual();
  const schemes = toolState.schemes.map((item, index) => index === toolState!.active ? { ...item, visual } : item);
  const delays = [...document.querySelectorAll<HTMLInputElement>("[data-delay]")].map((input) => Number(input.value) || 0);
  return {
    schemes,
    active: toolState.active,
    visualEnabled: toolState.visualEnabled !== false,
    screens: selectedScreens(),
    fitness: {
      enabled: toolState.fitness.enabled,
      hotkey: toolState.fitness.hotkey || "F9",
      delays,
    },
    status: toolState.status,
  };
}

async function mountTools() {
  const state = await invoke<ToolState>("miaomiao_get").catch(() => null);
  if (state) paintTools(state);
}

async function refreshSettings() {
  const paths = await invoke<{ screenshotDir: string; logDir: string }>("paths_get").catch(() => ({ screenshotDir: "", logDir: "" }));
  const shots = document.querySelector<HTMLInputElement>("#shot-path");
  const logs = document.querySelector<HTMLInputElement>("#log-path");
  if (shots) shots.value = paths.screenshotDir;
  if (logs) logs.value = paths.logDir;
}

async function setGameMode(mode: "pvp" | "pve") {
  if (mode === gameMode) return;
  gameMode = mode;
  localStorage.setItem("zhange.guides.tarkov.gameMode", mode);
  await invoke("site_set_game_mode", { mode }).catch(() => undefined);
  mapsLoaded = false;
  mapsLoading = false;
  maps = [];
  clearMapTasks();
  discardMapPage();
  render();
}

type LogWatch = { kind: string; slug: string; mode: string; questKind: string; taskId: string };

function playRaidChime() {
  const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const tone = (freq: number, at: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.06, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.18);
  };
  const now = ctx.currentTime;
  tone(880, now);
  tone(1175, now + 0.14);
  window.setTimeout(() => void ctx.close(), 700);
}

async function onLogWatch(event: LogWatch) {
  const state = await ensureOverlayState();
  if (event.kind === "map" && event.slug) {
    const name = maps.find((item) => item.slug === event.slug)?.name || event.slug;
    const here = path().endsWith(`/实时地图/${event.slug}`);
    if (state?.autoFollow === false) noteLog(`检测到 ${name}，自动切图已关闭`);
    else if (path() === "/登录") noteLog(`检测到 ${name}，登录页不切图`);
    else if (here) noteLog(`检测到 ${name}，已在这张图`);
    else {
      noteLog(room.id ? `房间切到 ${name}` : `切到 ${name}`);
      if (room.id) void switchRoomMap(event.slug);
      else {
        lastMapSlug = event.slug;
        go(`/主菜单/逃离塔科夫/实时地图/${event.slug}`);
      }
    }
  }
  if (event.kind === "mode" && (event.mode === "pvp" || event.mode === "pve")) {
    noteLog(`游戏模式改为 ${event.mode.toUpperCase()}`);
    void setGameMode(event.mode);
  }
  if (event.kind === "raid-start") {
    if (state?.raidChime !== false) {
      playRaidChime();
      noteLog("战局开始，已播放提示音");
    } else noteLog("战局开始，提示音已关闭");
  }
  if (event.kind === "raid-end") noteLog("战局结束");
  if (event.kind === "quest" && (event.questKind === "started" || event.questKind === "failed" || event.questKind === "completed") && event.taskId) {
    const label = event.questKind === "completed" ? "任务完成" : event.questKind === "failed" ? "任务失败" : "任务开始";
    noteLog(`${label} ${event.taskId}`);
    void applyLoggedQuest(event.questKind, event.taskId).then(() => patchLoggedQuest(event.questKind as "started" | "failed" | "completed", event.taskId));
  }
}

async function boot() {
  if (bootOverlayShell()) return;
  watchOverlayTyping();
  void listen<Record<string, unknown>>("room-sync", (event) => onRoomSync(event.payload)).catch(() => undefined);
  void listen<ToolState>("miaomiao-active", (event) => {
    if (document.querySelector("#scheme-buttons")) paintTools(event.payload);
  }).catch(() => undefined);
  await invoke("site_set_game_mode", { mode: gameMode }).catch(() => undefined);
  void listen<LogWatch>("log-watch", (event) => {
    void onLogWatch(event.payload);
  }).catch(() => undefined);
  void invoke<LogWatch>("log_state").then((snap) => {
    if (snap.slug) void onLogWatch({ kind: "map", slug: snap.slug, mode: "", questKind: "", taskId: "" });
    if (snap.mode) void onLogWatch({ kind: "mode", slug: "", mode: snap.mode, questKind: "", taskId: "" });
  }).catch(() => undefined);
  const ok = await loggedIn();
  const current = path();
  if (!ok && current !== "/登录") history.replaceState({}, "", encodeURI("/登录"));
  if (ok && (current === "/" || current === "/登录")) history.replaceState({}, "", encodeURI("/主菜单"));
  render();
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest("[data-link]");
  if (link instanceof HTMLAnchorElement) {
    event.preventDefault();
    go(link.getAttribute("href") || "/主菜单");
    return;
  }
  const mapButton = target.closest<HTMLButtonElement>("[data-map]");
  if (mapButton?.dataset.map) {
    const slug = mapButton.dataset.map;
    if (room.id && slug !== (room.detail?.mapSlug || room.slug)) {
      void switchRoomMap(slug);
      return;
    }
    if (!room.id && (slug !== lastMapSlug || room.error)) {
      roomSeq += 1;
      roomPending = false;
      room = { slug: "", id: "", status: "", error: "", password: "", detail: null };
    }
    lastMapSlug = slug;
    go(`/主菜单/逃离塔科夫/实时地图/${slug}`);
    return;
  }
  const sectionButton = target.closest<HTMLButtonElement>("[data-section]");
  if (sectionButton?.dataset.section) {
    const name = sectionButton.dataset.section;
    if (name === "实时地图" && lastMapSlug) {
      go(`/主菜单/逃离塔科夫/实时地图/${lastMapSlug}`);
      return;
    }
    go(name === "综合搜索" ? "/主菜单/逃离塔科夫/综合搜索" : `/主菜单/逃离塔科夫/${name}`);
    return;
  }
  if (target.closest("[data-retry-room]")) {
    if (room.id && lastMapSlug) {
      room.error = "";
      room.detail = null;
      void switchRoomMap(lastMapSlug);
      return;
    }
    roomSeq += 1;
    roomPending = false;
    room = { slug: "", id: "", status: "", error: "", password: "", detail: null };
    render();
    return;
  }
  const modeButton = target.closest<HTMLButtonElement>("[data-mode]");
  if (modeButton?.dataset.mode === "pvp" || modeButton?.dataset.mode === "pve") {
    void setGameMode(modeButton.dataset.mode);
    return;
  }
  if (onMapTaskClick(target) || onTaskEvent(target)) return;
  if (target.closest("#open-tavern")) {
    go("/主菜单/战鸽酒馆");
    return;
  }
  if (target.closest("#open-tarkov")) {
    go("/主菜单/逃离塔科夫/综合搜索");
    return;
  }
  if (target.closest("[data-search-closed]")) {
    searchNote = "地图标注和这条详情还没接到助手里，先不打开。";
    paintSearch();
    return;
  }
  const searchMap = target.closest<HTMLButtonElement>("[data-search-map]");
  if (searchMap?.dataset.searchMap) {
    const slug = searchMap.dataset.searchMap;
    lastMapSlug = slug;
    go(`/主菜单/逃离塔科夫/实时地图/${slug}`);
    return;
  }
  const tavernCat = target.closest<HTMLButtonElement>("[data-tavern-cat]");
  if (tavernCat) {
    go(tavernCategoryHref(tavernCat.dataset.tavernCat || ""));
    return;
  }
  const tavernPage = target.closest<HTMLButtonElement>("[data-tavern-page]");
  if (tavernPage?.dataset.tavernPage) {
    go(tavernPageHref(Number(tavernPage.dataset.tavernPage)));
    return;
  }
  const tavernReply = target.closest<HTMLButtonElement>("[data-tavern-reply]");
  if (tavernReply?.dataset.tavernReply) {
    setTavernReply(Number(tavernReply.dataset.tavernReply));
    return;
  }
  const collapse = target.closest<HTMLButtonElement>("[data-collapse]");
  if (collapse?.dataset.collapse) {
    document.querySelector(`#${collapse.dataset.collapse}-panel`)?.classList.add("collapsed");
    document.querySelector<HTMLElement>(`[data-expand="${collapse.dataset.collapse}"]`)?.removeAttribute("hidden");
    return;
  }
  const expand = target.closest<HTMLButtonElement>("[data-expand]");
  if (expand?.dataset.expand) {
    document.querySelector(`#${expand.dataset.expand}-panel`)?.classList.remove("collapsed");
    expand.setAttribute("hidden", "");
    return;
  }
  const roomAction = target.closest<HTMLButtonElement>("[data-room]");
  if (roomAction?.dataset.room) void onRoomAction(roomAction.dataset.room, roomAction);
});

async function onRoomAction(action: string, button: HTMLButtonElement) {
  if (action === "copy") {
    if (!room.id) return;
    const text = room.password ? `房间 ${roomCode(room.id)} 密码 ${room.password}` : roomCode(room.id);
    await navigator.clipboard.writeText(text).catch(() => undefined);
    button.textContent = "已复制";
    window.setTimeout(() => { button.textContent = "复制"; }, 1200);
    return;
  }
  if (action === "join") {
    document.querySelector("#room-join")?.toggleAttribute("hidden");
    document.querySelector("#room-settings")?.setAttribute("hidden", "");
    return;
  }
  if (action === "settings") {
    document.querySelector("#room-settings")?.toggleAttribute("hidden");
    document.querySelector("#room-join")?.setAttribute("hidden", "");
    return;
  }
  if (action === "leave") {
    if (!room.id) return;
    button.disabled = true;
    try {
      await invoke("site_post", { path: `/guides/tarkov/raid-rooms/${room.id}/leave`, body: {} });
    } catch (error) {
      room.error = error instanceof Error ? error.message : "离开房间失败";
      paintRoomCard();
      button.disabled = false;
      return;
    }
    roomSeq += 1;
    roomPending = false;
    room = { slug: "", id: "", status: "", error: "", password: "", detail: null };
    lastMapSlug = "";
    setOverlayHotkeyLive(false);
    go("/主菜单/逃离塔科夫/实时地图");
  }
}

async function joinRoom(code: string, password: string) {
  const form = document.querySelector("#room-join");
  try {
    const data = await invoke<Record<string, unknown>>("site_post", {
      path: `/guides/tarkov/raid-rooms/${encodeURIComponent(code)}/join`,
      body: password ? { game_mode: gameMode, password } : { game_mode: gameMode },
    });
    const detail = readDetail(data);
    if (!detail) throw new Error("没有返回房间信息");
    roomSeq += 1;
    applyDetail(detail, detail.mapSlug || lastMapSlug, password);
    form?.setAttribute("hidden", "");
    if (detail.mapSlug && detail.mapSlug !== path().split("/").pop()) {
      lastMapSlug = detail.mapSlug;
      go(`/主菜单/逃离塔科夫/实时地图/${detail.mapSlug}`);
      return;
    }
    paintRoomCard();
  } catch (error) {
    const message = error instanceof Error ? error.message : "加入房间失败";
    if (!form) return;
    let note = form.querySelector(".room-error");
    if (!note) {
      note = document.createElement("p");
      note.className = "room-error";
      form.append(note);
    }
    note.textContent = message;
  }
}

document.addEventListener("keydown", (event) => {
  if (onOverlayKey(event)) return;
  if (!hotkeyCapture || !toolState) return;
  event.preventDefault();
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key.toUpperCase().replace(" ", "");
  if (key === "ESCAPE") {
    hotkeyCapture = null;
    paintTools(toolState);
    return;
  }
  const next = collectTools();
  if (!next) return;
  if (hotkeyCapture.kind === "scheme") {
    const scheme = next.schemes[hotkeyCapture.index];
    if (scheme) scheme.visual.hotkey = key;
  } else {
    next.fitness.hotkey = key;
  }
  hotkeyCapture = null;
  void invoke<ToolState>("miaomiao_save", { state: next, apply: false }).then((saved) => paintTools(saved));
});

document.addEventListener("input", (event) => {
  if (onOverlayInput(event.target)) return;
  onMapTaskInput(event.target);
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id.endsWith("-val") === false && target.id) {
    const text = document.querySelector(`#${target.id}-val`);
    if (text && target.type === "range") {
      const digits = target.id === "vis-gamma" ? 2 : 0;
      text.textContent = Number(target.value).toFixed(digits);
    }
  }
});

document.addEventListener("change", (event) => {
  if (onOverlayChange(event.target)) {
    const slug = document.querySelector("#map-root")?.getAttribute("data-slug") || "";
    if (slug) void publishOverlayMap(slug);
    return;
  }
  if (event.target instanceof HTMLInputElement && (event.target.id === "screen-1" || event.target.id === "screen-2") && toolState) {
    const next = collectTools();
    if (!next) return;
    void invoke<ToolState>("miaomiao_save", { state: next, apply: true }).then((saved) => {
      paintTools(saved);
      const note = document.querySelector("#visual-note");
      if (note) note.textContent = saved.status === "色彩已激活" ? "已应用" : saved.status;
    }).catch((reason: unknown) => {
      const note = document.querySelector("#visual-note");
      if (note) note.textContent = failText(reason, "应用失败");
    });
    return;
  }
  if (event.target instanceof HTMLSelectElement && event.target.id === "scheme-list" && toolState) {
    toolState.active = Number(event.target.value);
    paintTools(toolState);
    return;
  }
  if (onTaskChange(event.target) || onMapObjectiveChange(event.target) || onMapTaskChange(event.target)) event.stopPropagation();
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.id === "search-form") {
    void runSearch();
    return;
  }
  if (form.id === "room-join") {
    const code = String(new FormData(form).get("code") || "").trim();
    const password = String(new FormData(form).get("password") || "");
    if (!code) return;
    void joinRoom(code, password);
    return;
  }
  if (form.id === "room-settings") {
    const password = String(new FormData(form).get("password") || "");
    if (!room.id) return;
    void invoke<Record<string, unknown>>("site_post", {
      path: `/guides/tarkov/raid-rooms/${room.id}/password`,
      body: { password },
    }).then((data) => {
      const detail = readDetail(data);
      if (detail) applyDetail(detail, room.slug, password);
      form.setAttribute("hidden", "");
      paintRoomCard();
    }).catch((reason: unknown) => {
      room.error = reason instanceof Error ? reason.message : "保存密码失败";
      paintRoomCard();
    });
    return;
  }
  if (form.id === "tavern-search") {
    go(tavernSearchHref(form));
    return;
  }
  if (form.id === "tavern-comment") {
    const slug = tavernMatch(path());
    if (slug?.kind === "article") void submitTavernComment(slug.slug, form);
    return;
  }
  if (form.id !== "login-form") return;
  const account = String(new FormData(form).get("account") || "").trim();
  const password = String(new FormData(form).get("password") || "");
  const error = document.querySelector("#login-error");
  if (!account || !password) {
    if (error) error.textContent = "请填写账号和密码";
    return;
  }
  if (error) error.textContent = "正在登录…";
  void invoke("site_login", { username: account, password }).then(() => go("/主菜单")).catch((reason: unknown) => {
    if (error) error.textContent = reasonText(reason);
  });
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const pick = target.closest<HTMLButtonElement>("[data-pick]");
  const open = target.closest<HTMLButtonElement>("[data-open]");
  if (pick?.dataset.pick) {
    void (async () => {
      const title = pick.dataset.pick === "screenshots" ? "选择截图目录" : "选择日志目录";
      const picked = await invoke<string | null>("paths_pick", { title });
      if (!picked) return;
      const shots = document.querySelector<HTMLInputElement>("#shot-path")?.value || "";
      const logs = document.querySelector<HTMLInputElement>("#log-path")?.value || "";
      const next = await invoke<{ screenshotDir: string; logDir: string }>("paths_set", {
        screenshotDir: pick.dataset.pick === "screenshots" ? picked : shots,
        logDir: pick.dataset.pick === "logs" ? picked : logs,
      });
      const shotInput = document.querySelector<HTMLInputElement>("#shot-path");
      const logInput = document.querySelector<HTMLInputElement>("#log-path");
      if (shotInput) shotInput.value = next.screenshotDir;
      if (logInput) logInput.value = next.logDir;
    })();
  }
  if (open?.dataset.open) {
    const value = open.dataset.open === "screenshots"
      ? document.querySelector<HTMLInputElement>("#shot-path")?.value || ""
      : document.querySelector<HTMLInputElement>("#log-path")?.value || "";
    void invoke("paths_open", { path: value }).catch((reason: unknown) => {
      const note = document.querySelector("#path-note");
      if (note) note.textContent = reason instanceof Error ? reason.message : "无法打开目录";
    });
  }
  if (onQuestFilterClick(target)) return;
  const fold = target.closest<HTMLButtonElement>("[data-fold]");
  if (fold?.dataset.fold) {
    const collapsed = toggleFold(fold.dataset.fold);
    const body = document.querySelector(`[data-children="${fold.dataset.fold}"]`);
    if (body) body.toggleAttribute("hidden", collapsed);
    fold.textContent = collapsed ? "＋" : "－";
    return;
  }
  const groupToggle = target.closest<HTMLInputElement>("[data-group]");
  if (groupToggle?.dataset.group) {
    for (const key of groupToggle.dataset.group.split(",").filter(Boolean)) {
      setLayerVisible(key, groupToggle.checked);
      const box = document.querySelector<HTMLInputElement>(`[data-layer="${key}"]`);
      if (box) box.checked = groupToggle.checked;
    }
    const mapSlug = document.querySelector("#map-root")?.getAttribute("data-slug") || "";
    if (mapSlug) void publishOverlayMap(mapSlug);
    return;
  }
  const layerToggle = target.closest<HTMLInputElement>("[data-layer]");
  if (layerToggle) {
    setLayerVisible(layerToggle.dataset.layer || "", layerToggle.checked);
    const mapSlug = document.querySelector("#map-root")?.getAttribute("data-slug") || "";
    if (mapSlug) void publishOverlayMap(mapSlug);
    const parent = layerToggle.closest(".filter-block")?.querySelector<HTMLInputElement>("[data-group]");
    if (parent?.dataset.group) {
      parent.checked = parent.dataset.group.split(",").every((key) => document.querySelector<HTMLInputElement>(`[data-layer="${key}"]`)?.checked);
    }
    return;
  }
  const styleToggle = target.closest<HTMLInputElement>("[data-style]");
  if (styleToggle?.dataset.style === "tile" || styleToggle?.dataset.style === "svg") {
    setMapStyle(styleToggle.dataset.style);
    const mapSlug = document.querySelector("#map-root")?.getAttribute("data-slug") || "";
    if (mapSlug) void publishOverlayMap(mapSlug);
    return;
  }
  const floorToggle = target.closest<HTMLInputElement>("[data-floor]");
  if (floorToggle) {
    setMapFloor(floorToggle.dataset.floor || "");
    const mapSlug = document.querySelector("#map-root")?.getAttribute("data-slug") || "";
    if (mapSlug) void publishOverlayMap(mapSlug);
    return;
  }
  if (target.closest("#visual-toggle") || target.closest("#fit-toggle")) {
    const next = collectTools();
    if (!next) return;
    if (target.closest("#visual-toggle")) next.visualEnabled = !next.visualEnabled;
    if (target.closest("#fit-toggle")) next.fitness.enabled = !next.fitness.enabled;
    void invoke<ToolState>("miaomiao_save", { state: next, apply: false }).then((saved) => paintTools(saved));
    return;
  }
  const schemeButton = target.closest<HTMLButtonElement>("[data-scheme]");
  if (schemeButton?.dataset.scheme && !schemeButton.dataset.hotkey) {
    const next = collectTools();
    if (!next) return;
    next.active = Number(schemeButton.dataset.scheme);
    void invoke<ToolState>("miaomiao_save", { state: next, apply: true }).then((saved) => {
      paintTools(saved);
      const note = document.querySelector("#visual-note");
      if (note) note.textContent = saved.status === "色彩已激活" ? "已应用" : saved.status;
    }).catch((reason: unknown) => {
      const note = document.querySelector("#visual-note");
      if (note) note.textContent = failText(reason, "应用失败");
    });
    return;
  }
  const hotkeyButton = target.closest<HTMLButtonElement>("[data-hotkey]");
  if (hotkeyButton?.dataset.hotkey === "scheme") {
    hotkeyCapture = { kind: "scheme", index: Number(hotkeyButton.dataset.schemeKey || 0) };
    if (toolState) paintTools(toolState);
    const note = document.querySelector("#visual-note");
    if (note) note.textContent = "请设置快捷键";
    return;
  }
  if (hotkeyButton?.dataset.hotkey === "fitness") {
    hotkeyCapture = { kind: "fitness" };
    if (toolState) paintTools(toolState);
    const note = document.querySelector("#fit-note");
    if (note) note.textContent = "请设置快捷键";
    return;
  }
  if (target.closest("#scheme-save")) {
    const next = collectTools();
    if (!next) return;
    void invoke<ToolState>("miaomiao_save", { state: next, apply: true }).then((saved) => {
      paintTools(saved);
      const note = document.querySelector("#visual-note");
      if (note) note.textContent = saved.status === "色彩已激活" ? "方案已保存" : saved.status;
    }).catch((reason: unknown) => {
      const note = document.querySelector("#visual-note");
      if (note) note.textContent = failText(reason, "保存失败");
    });
    return;
  }
  if (target.closest("#scheme-reset")) {
    const next = collectTools();
    if (!next) return;
    const base = SCHEME_DEFAULTS[next.active];
    if (!base || !next.schemes[next.active]) return;
    next.schemes[next.active].visual = { ...base, hotkey: next.schemes[next.active].visual.hotkey };
    void invoke<ToolState>("miaomiao_save", { state: next, apply: false }).then((saved) => paintTools(saved));
    return;
  }
  if (target.closest("#fit-save")) {
    const next = collectTools();
    if (!next) return;
    void invoke<ToolState>("miaomiao_save", { state: next, apply: false }).then((saved) => paintTools(saved));
    return;
  }
  if (target.closest("#fit-reset")) {
    void invoke<ToolState>("miaomiao_restore_delays").then((saved) => paintTools(saved));
    return;
  }
  if (target.closest("#log-sync")) {
    if (logSyncBusy()) void runLogSync();
    else openLogSync();
    return;
  }
  const syncPick = target.closest<HTMLButtonElement>("[data-sync]");
  if (syncPick?.dataset.sync) {
    pickLogSyncRange(syncPick.dataset.sync);
    return;
  }
  if (target.closest("#log-sync-go")) {
    void runLogSync();
    return;
  }
  if (target.closest("#log-sync-cancel")) {
    closeLogSync();
    return;
  }
  if (onOverlayClick(target)) return;
  if (target.closest("#map-summary")) {
    void openMapSummary();
    return;
  }
  if (target.closest("#map-summary-close") || target.id === "map-summary-modal") {
    closeMapSummary();
    return;
  }
  if (target.closest("#detect-paths")) {
    const note = document.querySelector("#path-note");
    if (note) note.textContent = "正在检测…";
    void invoke<{ screenshotDir: string; logDir: string; message: string }>("paths_detect").then((found) => {
      const shotInput = document.querySelector<HTMLInputElement>("#shot-path");
      const logInput = document.querySelector<HTMLInputElement>("#log-path");
      if (shotInput) shotInput.value = found.screenshotDir;
      if (logInput) logInput.value = found.logDir;
      if (note) note.textContent = found.message;
    }).catch((reason: unknown) => {
      if (note) note.textContent = reason instanceof Error ? reason.message : "检测失败";
    });
  }
});

function render() {
  paint();
}

window.addEventListener("popstate", render);
void boot();

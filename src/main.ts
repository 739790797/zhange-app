import "./fonts.css";
import { listen } from "@tauri-apps/api/event";
import { closeLogSync, logSyncBusy, openLogSync, pickLogSyncRange, runLogSync } from "./logSync";
import { applyRoomClaims, clearMapTasks, closeMapSummary, mapQuestProgress, mountMapTasks, onMapObjectiveChange, onMapTaskChange, onMapTaskClick, onMapTaskInput, openMapGuide, openMapSummary, patchLoggedQuest, setMapHighlight, setMapObjective, watchMapTasks } from "./mapTasks";
import { applyLoggedQuest, mountTaskPage, onTaskChange, onTaskEvent, taskPageShell } from "./taskFlow";
import { bindQuestActions, bindQuestHighlight, destroyLiveMap, invalidateLiveMap, locateQuest, mountLiveMap, onQuestFilterClick, setLayerVisible, setMapFloor, setMapStyle, setQuestRoom, toggleFold } from "./liveMap";
import { ammoShell, mountAmmo } from "./ammoChart";
import { bossShell, mountBosses } from "./bossList";
import { hideoutShell, mountHideout, openHideoutList } from "./hideout";
import { keyShell, mountKeys, openKeyList } from "./keys";
import { paintGoonBars, startGoonWatch } from "./goon";
import { findMap, mapTitle, sameMap } from "./mapNames";
import { applyRoomSync, clearMapPresence, loadMapBoard, mapBoardHtml, mapBoardReady, noteLocalPhase, paintMapPickGoon, refreshMapBoard, resetMapBoard, setLocalWatch } from "./mapPicker";
import { closeLobbyDialog, lobbyShell, mountLobby, setLobbyNote, setLobbyRoomKeep, settleLobbyJoin } from "./lobby";
import { mountWorkbench, workbenchShell } from "./workbench";
import { catalogShell, matchCatalog, mountCatalog, pinCatalogList } from "./itemCatalog";
import { fadeIn, fadeOut } from "./motion";
import { isPending, spin } from "./spinner";
import { matchWiki, mountWiki, readWikiHits, wikiHref, wikiShell, type WikiHit } from "./wiki";
import { bootOverlayShell, ensureOverlayState, onOverlayChange, onOverlayClick, onOverlayInput, onOverlayKey, overlayCardHtml, overlayDialogHtml, publishOverlayMap, watchOverlayTyping } from "./overlay";
import { backNav, bindHistory, forwardNav, paintHistoryButtons, pushNav, replaceNav, syncNav } from "./navHistory";
import { shotHotkeyLabel, startPlayerSync } from "./playerFix";
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
type RoomClient = "web" | "desktop";
type RoomMember = {
  userId: number;
  name: string;
  host: boolean;
  online: boolean;
  clients: RoomClient[];
  inRoom: boolean;
};
type RoomViewMap = { userId: number; mapSlug: string };
type RoomPhase = { userId: number; kind: string };
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
  viewMaps: RoomViewMap[];
  phases: RoomPhase[];
  claims: RoomClaim[];
  objectives: RoomObjective[];
};
type RoomState = { slug: string; id: string; status: string; error: string; password: string; detail: RoomDetail | null };

const sections = ["综合搜索", "联机大厅", "实时地图", "物品图鉴", "弹药对照", "Boss", "藏身处", "枪匠工作台", "钥匙管理", "任务管理", "妙妙工具", "日志监控"] as const;
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
let accountPhaseSig = "";
let accountPhaseReady = false;
let accountViewSlug = "";
let viewerName = "";
let viewerId = 0;
let claimSeedKey = "";
let lastMapSlug = "";
let gameInRaid = false;
let gameMapSlug = "";
let localPhaseKind = "";
let spectating = false;
let ignoredRoomId = "";
let mapPage: HTMLElement | null = null;
let usageTimer = 0;
let gameMode: "pvp" | "pve" = localStorage.getItem("zhange.guides.tarkov.gameMode") === "pve" ? "pve" : "pvp";

function path() {
  return decodeURIComponent(location.pathname.replace(/\/+$/, "") || "/");
}

function go(next: string) {
  const url = encodeURI(next);
  if (location.pathname + location.search !== url) pushNav(url);
  render();
}

function historyButtons() {
  const icon = (direction: "back" | "forward") => {
    const path = direction === "back" ? "M10 3.5 5.5 8 10 12.5" : "M6 3.5 10.5 8 6 12.5";
    return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  };
  return `<div class="nav-history" role="group" aria-label="浏览历史"><button type="button" data-history="back" aria-label="后退" title="后退">${icon("back")}</button><button type="button" data-history="forward" aria-label="前进" title="前进">${icon("forward")}</button></div>`;
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

function mapCard(map: MapItem) {
  const image = map.thumbLink ? `<img src="${esc(map.thumbLink)}" alt="" />` : `<i></i>`;
  return `<button type="button" class="map-card" data-map="${esc(map.slug)}">${image}<span>${esc(map.name)}</span></button>`;
}

function mapMenuHtml() {
  if (!maps.length) return isPending(mapsNote || "正在读取地图") ? spin("正在读取地图", true) : `<p>${esc(mapsNote)}</p>`;
  return maps.map(mapCard).join("");
}

function fillMapMenu() {
  document.querySelectorAll(".map-pop").forEach((node) => {
    node.innerHTML = mapMenuHtml();
  });
}

function topNav(active: string) {
  const buttons = sections.map((name) => `<button type="button" data-section="${name}" class="${active === name ? "on" : ""}">${name}</button>`).join("");
  return `<header class="topnav">${historyButtons()}${buttons}<div class="mode-switch" role="group" aria-label="游戏模式"><button type="button" data-mode="pvp" class="${gameMode === "pvp" ? "on" : ""}" title="在线对战（PVP）">PVP</button><button type="button" data-mode="pve" class="${gameMode === "pve" ? "on" : ""}" title="合作模式（PVE）">PVE</button></div></header>`;
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

type SearchRow = WikiHit;

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
      <button type="button" class="goon-bar" hidden></button>
      <div class="search-results" id="search-results">${searchResultsHtml()}</div>
    </section>`;
}

function searchResultsHtml() {
  return searchRows.map((section) => `
    <section>
      <h2>${esc(section.label)}</h2>
      ${section.rows.map((row) => `
        <button type="button" class="search-hit" ${row.mapSlug ? `data-search-map="${esc(row.mapSlug)}"` : row.kind && row.id ? `data-wiki="${row.kind}" data-wiki-id="${esc(row.id)}"` : "data-search-closed"}>
          ${row.icon ? `<img src="${esc(row.icon)}" alt="" />` : ""}
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

function localMapRows(query: string): SearchRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return maps.flatMap((map) => {
    const hay = `${map.name} ${map.english} ${map.slug}`.toLowerCase();
    if (!hay.includes(needle)) return [];
    return [{ name: map.name, extra: map.english, mapSlug: map.slug, kind: "", id: "", icon: map.thumbLink }];
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
      ["任务", readWikiHits(data.tasks, "task")],
      ["物品", readWikiHits(data.items, "item")],
      ["商人", readWikiHits(data.traders, "trader")],
      ["BOSS", readWikiHits(data.bosses, "boss")],
    ].filter((section): section is [string, SearchRow[]] => Array.isArray(section[1]) && section[1].length > 0)
      .map(([label, rows]) => ({ label, rows }));
    searchRows = sections;
    searchNote = sections.length ? "点开结果查看详情。地图会打开实时地图。" : "没有匹配结果";
  } catch (error) {
    if ((document.querySelector<HTMLInputElement>("#search-q")?.value || "").trim() !== query) return;
    searchRows = [];
    searchNote = error instanceof Error ? error.message : "搜索失败";
  }
  paintSearch();
}

function shownMap(slug: string) {
  const map = findMap(slug, maps);
  return mapTitle(slug, map?.name || "");
}

function mapToolIcon(kind: "sidebars" | "full" | "exit") {
  if (kind === "sidebars") return `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2.6 3h2.6v10H2.6zM10.8 3H13.4v10h-2.6z"/></svg>`;
  const stroke = `fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`;
  if (kind === "exit") return `<svg viewBox="0 0 16 16" aria-hidden="true"><path ${stroke} d="M6.2 3v3.2H3M9.8 3v3.2H13M6.2 13v-3.2H3M9.8 13v-3.2H13"/></svg>`;
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path ${stroke} d="M3 6.2V3h3.2M13 6.2V3h-3.2M3 9.8V13h3.2M13 9.8V13h-3.2"/></svg>`;
}

function mapView(slug: string) {
  const name = shownMap(slug);
  const image = `<div class="map-viewport" id="map-viewport"><div id="map-root" data-slug="${slug}"></div></div>`;
  const fullscreen = Boolean(document.fullscreenElement);
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
      <button type="button" class="goon-bar map-goon" hidden></button>
      <div class="left-stack">
        <button class="room-expand" type="button" data-expand="room" hidden>房间</button>
        <section class="room-card" id="room-panel" aria-label="房间信息">
          <header class="room-head">
            <div class="room-head-text">
              <h2 class="room-title" id="room-title">房间</h2>
              <p class="room-meta" id="room-meta"></p>
            </div>
            <button type="button" class="room-collapse" data-collapse="room">收起</button>
          </header>
          <div class="room-actions">
            <button type="button" data-room="maps">更换地图</button>
            <button type="button" data-room="copy">复制编号</button>
            <button type="button" class="room-leave" data-room="leave">离开房间</button>
          </div>
          <div id="room-live"></div>
        </section>
        <aside class="overlay left" id="filter-panel" aria-label="地图筛选">
          <header><strong>图层</strong><button type="button" data-collapse="filter">收起</button></header>
          <div id="place-bar"></div>
          <div class="panel-body" id="filter-body">${spin("正在读取图层")}</div>
        </aside>
      </div>
      <button class="overlay-tab left" type="button" data-expand="filter" hidden>图层</button>
      <div class="right-stack">
        <aside class="overlay right" id="task-panel">
          <header><strong>任务</strong><button type="button" data-collapse="task">收起</button></header>
          ${overlayCardHtml()}
          <div class="panel-body tasks" id="task-body">${spin("正在读取任务")}</div>
        </aside>
      </div>
      <button class="overlay-tab right" type="button" data-expand="task" hidden>任务</button>
      <div class="map-dock" role="toolbar" aria-label="地图工具">
        <button type="button" class="map-dock-icon" id="map-sidebars" aria-pressed="true" title="收起侧边栏" aria-label="收起侧边栏">${mapToolIcon("sidebars")}</button>
        <span class="map-dock-divider" aria-hidden="true"></span>
        <button type="button" class="map-dock-icon" id="map-fullscreen" aria-pressed="${fullscreen ? "true" : "false"}" title="${fullscreen ? "退出全屏" : "全屏"}" aria-label="${fullscreen ? "退出全屏" : "全屏"}">${mapToolIcon(fullscreen ? "exit" : "full")}</button>
      </div>
      ${overlayDialogHtml()}
      ${shotSettingsDialogHtml()}
      <div id="map-summary-modal" class="map-summary" hidden>
        <div class="map-summary-card">
          <header><strong>准备内容总结</strong><button type="button" id="map-summary-close">关闭</button></header>
          <div id="map-summary-body">${spin("正在加载")}</div>
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
  ready: boolean;
  session: string;
  application: string;
  notices: string;
  backend: string;
  slug: string;
  mode: string;
  inRaid: boolean;
  server: string;
  location: string;
  phase: string;
  raidId: string;
  tailStamp: string;
};
type LogNote = { at: string; text: string };
let logActions: LogNote[] = [];
let logTimer = 0;

function baseName(value: string) {
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function logFileName(value: string) {
  const name = baseName(value);
  const space = name.lastIndexOf(" ");
  return space > 0 ? name.slice(space + 1) : name;
}

function sessionClock(value: string) {
  const name = baseName(value);
  const mark = name.lastIndexOf("log_");
  const source = mark >= 0 ? name.slice(mark + 4) : name;
  const parts = source.split(/[._-]/);
  const hour = parts[3] || "";
  const minute = parts[4] || "";
  const second = parts[5] || "";
  if (!/^\d{1,2}$/.test(hour) || !/^\d{2}$/.test(minute) || !/^\d{2}$/.test(second)) return "—";
  return `${hour.padStart(2, "0")}:${minute}:${second}`;
}

function feedHtml(items: LogNote[]) {
  return items.length
    ? items.map((item) => `<li><time>${esc(item.at)}</time><span>${esc(item.text)}</span></li>`).join("")
    : `<li class="log-empty"><span>还没有触发</span></li>`;
}

function renderFeed() {
  const list = document.querySelector("#log-feed");
  if (!list) return;
  const items = [...logActions].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80);
  list.innerHTML = feedHtml(items);
}

function logMonitorHtml() {
  const feed = feedHtml([...logActions].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80));
  const pane = (id: string, title: string) => `
    <article class="log-pane">
      <h2>${title}</h2>
      <pre id="${id}" class="log-empty">正在读取</pre>
    </article>`;
  return `
    <section class="log-monitor">
      <div class="log-side">
        <article>
          <h2>当前日志</h2>
          <dl id="log-status">${spin("正在读取")}</dl>
        </article>
        <article>
          <h2>触发记录</h2>
          <ol id="log-feed">${feed}</ol>
        </article>
      </div>
      ${pane("log-app", "应用日志")}
      ${pane("log-note", "通知日志")}
      ${pane("log-back", "后端日志")}
    </section>`;
}

function stopLogTimer() {
  window.clearInterval(logTimer);
  logTimer = 0;
}

type LogTails = { application: string; notices: string; backend: string };

const LOG_SLUG: Record<string, string> = {
  city: "streets-of-tarkov",
  tarkovstreets: "streets-of-tarkov",
  streets: "streets-of-tarkov",
  streets_of_tarkov: "streets-of-tarkov",
  rezerv_base: "reserve",
  rezervbase: "reserve",
  reserve: "reserve",
  shoreline: "shoreline",
  woods: "woods",
  forest: "woods",
  bigmap: "customs",
  customs: "customs",
  interchange: "interchange",
  shopping_mall: "interchange",
  mall: "interchange",
  laboratory: "the-lab",
  labs: "the-lab",
  lab: "the-lab",
  lighthouse: "lighthouse",
  factory: "factory",
  factory_day: "factory",
  factory4_day: "factory",
  factory_night: "night-factory",
  factory4_night: "night-factory",
  sandbox: "ground-zero",
  sandbox_high: "ground-zero",
  ground_zero: "ground-zero",
  groundzero: "ground-zero",
  labyrinth: "the-labyrinth",
  the_labyrinth: "the-labyrinth",
  terminal: "terminal",
  icebreaker: "icebreaker",
  suburbs: "icebreaker",
};

function locationSlug(raw: string) {
  return LOG_SLUG[raw.trim().toLowerCase().replace(/-/g, "_")] || "";
}

function clocked(line: string) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(line);
}

function lineClock(line: string) {
  const match = /^(\d{4}-\d{2}-\d{2} )(\d{2}:\d{2}:\d{2})/.exec(line);
  return match?.[2] || "";
}

function sceneSlug(line: string) {
  const marker = "scene preset path:";
  const index = line.indexOf(marker);
  if (index < 0) return "";
  const rest = line.slice(index + marker.length);
  const lower = rest.toLowerCase();
  if (lower.includes("hideout") || lower.includes("menu") || lower.includes("empty_preset")) return "";
  const token = rest.trim().split(/\s+/)[0] || "";
  const file = token.split(/[/\\]/).pop() || token;
  const stem = file.split("_preset")[0].replace(/\.bundle$/i, "");
  return locationSlug(stem);
}

function fieldValue(line: string, key: string) {
  const index = line.indexOf(key);
  if (index < 0) return "";
  return line.slice(index + key.length).trim().split(/[,']/)[0]?.trim() || "";
}

function triggerAction(line: string) {
  const mode = /Session mode:\s*([^\s|]+)/i.exec(line);
  if (mode) {
    const key = mode[1].toLowerCase();
    if (key === "pve") return "游戏模式改为 PVE";
    if (key === "pvp" || key === "regular") return "游戏模式改为 PVP";
  }
  if (line.includes("scene preset path:")) {
    const lower = line.toLowerCase();
    if (lower.includes("hideout") || lower.includes("menu") || lower.includes("empty_preset")) return "回到菜单，战局结束";
    const slug = sceneSlug(line);
    if (slug) return `切到${shownMap(slug)}`;
  }
  if (line.includes("LocationLoaded") && !line.includes("LocationLoadedTime")) return "进入匹配";
  if (line.includes("GameStarting") && !line.includes("GameStarted")) return "战局启动";
  if (line.includes("GameStarted:") && clocked(line)) return "战局开始";
  if (line.includes("Network game matching aborted") || line.includes("Network game matching cancelled")) return "匹配取消";
  if (line.includes("Got notification | UserMatchOver")) return "战局结束";
  if (line.includes("---> Request") && line.includes("/client/match/local/end")) return "战局结束";
  if (line.includes("TRACE-NetworkGameCreate profileStatus")) {
    const raw = fieldValue(line, "Location:");
    const slug = locationSlug(raw);
    const name = slug ? shownMap(slug) : raw;
    return name ? `匹配成功，地点${name}` : "匹配成功";
  }
  return "";
}

function jsonObject(text: string) {
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return "";
}

function questAction(json: string) {
  try {
    const parsed = JSON.parse(json) as { message?: Record<string, unknown> };
    const message = parsed.message || (parsed as Record<string, unknown>);
    const type = Number(message.type ?? message.Type);
    const label = type === 12 ? "任务完成" : type === 11 ? "任务失败" : type === 10 ? "任务开始" : "";
    if (!label) return "";
    const raw = String(message.templateId || message.TemplateId || message.questId || message.QuestId || "");
    const id = raw.trim().split(/\s+/)[0] || "";
    if (!/^[a-f0-9]{20,32}$/i.test(id)) return "";
    return `${label} ${id}`;
  } catch {
    return "";
  }
}

function lineActions(text: string) {
  const lines = text.split("\n");
  const actions = lines.map((line) => triggerAction(line));
  let search = 0;
  while (search < text.length) {
    const index = text.indexOf("ChatMessageReceived", search);
    if (index < 0) break;
    search = index + "ChatMessageReceived".length;
    const action = questAction(jsonObject(text.slice(search)));
    if (!action) continue;
    const line = text.slice(0, index).split("\n").length - 1;
    actions[line] = action;
  }
  return actions;
}

function triggerNotes(text: string) {
  const lines = text.split("\n");
  const actions = lineActions(text);
  const notes: LogNote[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const action = actions[index];
    if (!action) return;
    const at = lineClock(line) || "—";
    const key = `${at}|${action}`;
    if (seen.has(key)) return;
    seen.add(key);
    notes.push({ at, text: action });
  });
  return notes;
}

function lineSpan(line: string, action: string) {
  return `<span${action ? ` class="log-hit" title="${esc(action)}"` : ""}>${esc(line) || " "}</span>`;
}

function paintTail(id: string, text: string, ready: boolean) {
  const node = document.querySelector<HTMLElement>(id);
  if (!node) return;
  const next = text.trim() ? text.replace(/\r\n/g, "\n") : ready ? "还没有日志" : "正在读取";
  const prev = node.dataset.raw || "";
  if (prev === next) return;
  node.dataset.raw = next;
  node.classList.toggle("log-empty", !text.trim());
  const stick = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
  if (!text.trim()) {
    node.textContent = next;
    if (stick) node.scrollTop = node.scrollHeight;
    return;
  }
  const body = next.endsWith("\n") ? next.slice(0, -1) : next;
  const prevBody = prev.endsWith("\n") ? prev.slice(0, -1) : prev;
  const grew = Boolean(prevBody && text.trim() && body.startsWith(`${prevBody}\n`) && node.childElementCount > 0);
  if (grew) {
    const extra = body.slice(prevBody.length + 1);
    const actions = lineActions(extra);
    node.insertAdjacentHTML("beforeend", extra.split("\n").map((line, index) => lineSpan(line, actions[index] || "")).join(""));
    if (stick) node.scrollTop = node.scrollHeight;
    return;
  }
  const lines = body.split("\n");
  const actions = lineActions(body);
  node.innerHTML = lines.map((line, index) => lineSpan(line, actions[index] || "")).join("");
  if (stick) node.scrollTop = node.scrollHeight;
}

let seenTailStamp = "";
let cachedTails: LogTails | null = null;

async function refreshLogMonitor() {
  const host = document.querySelector("#log-status");
  if (!host) return;
  const live = await invoke<LogLive>("log_state").catch(() => null);
  if (!document.querySelector("#log-status") || !live) return;
  const mapName = live.slug ? shownMap(live.slug) : "—";
  const raid = !live.ready ? "正在读取" : live.inRaid ? "进行中" : live.phase === "raid_exited" || live.phase === "matching_aborted" ? "已结束" : "未开始";
  const shown = (value: string) => value ? logFileName(value) : "—";
  const full = (value: string) => value ? baseName(value) : "";
  const rows: [string, string, string][] = [
    ["游戏", live.running ? "正在运行" : "未检测到", ""],
    ["启动时间", live.session ? sessionClock(live.session) : "—", live.session ? baseName(live.session) : ""],
    ["应用日志", shown(live.application), full(live.application)],
    ["通知日志", shown(live.notices), full(live.notices)],
    ["后端日志", shown(live.backend), full(live.backend)],
    ["地图", mapName, ""],
    ["模式", live.mode ? live.mode.toUpperCase() : "—", ""],
    ["战局", raid, ""],
    ["服务器", live.server || (live.inRaid ? "未知" : "—"), ""],
    ["地点", live.location ? shownMap(live.location) : "—", ""],
  ];
  host.innerHTML = rows.map(([label, value, title]) => `<dt>${esc(label)}</dt><dd title="${esc(title || value)}">${esc(value)}</dd>`).join("");
  if (!live.ready) {
    seenTailStamp = "";
    cachedTails = null;
    return;
  }
  if (!cachedTails || live.tailStamp !== seenTailStamp) {
    const tails = await invoke<LogTails>("log_tails").catch(() => null);
    if (!tails || !document.querySelector("#log-status")) return;
    cachedTails = tails;
    seenTailStamp = live.tailStamp;
  }
  const tails = cachedTails;
  if (!tails) return;
  paintTail("#log-app", tails.application, true);
  paintTail("#log-note", tails.notices, true);
  paintTail("#log-back", tails.backend, true);
  logActions = [
    ...triggerNotes(tails.application.replace(/\r\n/g, "\n")),
    ...triggerNotes(tails.notices.replace(/\r\n/g, "\n")),
    ...triggerNotes(tails.backend.replace(/\r\n/g, "\n")),
  ];
  renderFeed();
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
  const name = shownMap(slug) || "地图";
  const failed = Boolean(room.error);
  const text = room.error || room.status || "正在创建私人房间…";
  return tarkovFrame("实时地图", [
    { label: "主菜单", href: "/主菜单" },
    { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
    { label: "实时地图", href: "/主菜单/逃离塔科夫/实时地图" },
    { label: name },
  ], `<section class="map-loading" id="map-loading">${failed || !isPending(text) ? `<p>${esc(text)}</p>` : spin(text)}${failed ? `<button type="button" data-retry-room>重试</button>` : ""}</section>`);
}

function onMapPicker() {
  return path() === "/主菜单/逃离塔科夫/实时地图";
}

function rememberBoardRoom(raw: Record<string, unknown> | null) {
  if (!raw || room.id) return;
  const detail = readDetail(raw);
  if (!detail || (ignoredRoomId && detail.id === ignoredRoomId)) return;
  ignoredRoomId = "";
  roomPending = false;
  room = {
    slug: detail.mapSlug,
    id: detail.id,
    status: `私人房间 ${detail.id}`,
    error: "",
    password: "",
    detail,
  };
}

function renderMapPicker() {
  const pending = roomPending ? room.status || "正在加入房间…" : "";
  const body = pending
    ? `<section class="map-loading">${spin(pending)}<p>${esc(pending)}</p></section>`
    : maps.length
    ? mapBoardHtml(maps)
    : isPending(mapsNote || "正在读取地图") ? spin("正在读取地图") : plainView("实时地图", esc(mapsNote));
  return tarkovFrame("实时地图", [
    { label: "主菜单", href: "/主菜单" },
    { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
    { label: "实时地图" },
  ], body);
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
        clients: roomClients(item.clients),
        inRoom: item.in_room !== false && item.inRoom !== false,
      };
    }),
    viewMaps: readViewMaps(value.view_maps ?? value.viewMaps),
    phases: readPhases(value.log_phases ?? value.logPhases),
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

function readViewMaps(raw: unknown): RoomViewMap[] {
  if (!Array.isArray(raw)) return [];
  const out: RoomViewMap[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const userId = Number(row.user_id || row.userId || 0);
    if (!userId) continue;
    out.push({ userId, mapSlug: String(row.map_slug || row.mapSlug || "").trim() });
  }
  return out;
}

function readPhases(raw: unknown): RoomPhase[] {
  if (!Array.isArray(raw)) return [];
  const out: RoomPhase[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const userId = Number(row.user_id || row.userId || 0);
    const kind = String(row.kind || "").trim();
    if (!userId || !kind) continue;
    out.push({ userId, kind });
  }
  return out;
}

function absorbRoomLists(payload: Record<string, unknown>, snap: Record<string, unknown> | null) {
  if (!room.detail) return;
  const phases = payload.log_phases ?? snap?.log_phases;
  const views = payload.view_maps ?? snap?.view_maps;
  let changed = false;
  if (phases !== undefined) {
    room.detail.phases = readPhases(phases);
    changed = true;
  }
  if (views !== undefined) {
    room.detail.viewMaps = readViewMaps(views);
    changed = true;
  }
  if (changed) paintRoomCard();
}

function roomClients(raw: unknown): RoomClient[] {
  if (!Array.isArray(raw)) return [];
  const out: RoomClient[] = [];
  for (const item of raw) {
    const kind = String(item || "").trim();
    if (kind === "web" || kind === "desktop") out.push(kind);
  }
  return out;
}

function readClientMap(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.online_clients)) return null;
  const map = new Map<number, RoomClient[]>();
  for (const item of payload.online_clients) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const userId = Number(row.user_id || row.userId || 0);
    if (!userId) continue;
    map.set(userId, roomClients(row.clients));
  }
  return map;
}

function shownClients(member: RoomMember) {
  const clients = [...member.clients];
  if (member.userId === viewerId && roomLive && !clients.includes("desktop")) clients.push("desktop");
  return clients;
}

function onlineLabel(member: RoomMember) {
  const clients = shownClients(member);
  if (clients.length >= 2) return "在线·多端";
  if (clients.includes("web")) return "在线·网页";
  if (clients.includes("desktop")) return "在线·桌面";
  return member.online ? "在线" : "离线";
}

function roomCode(id: string) {
  return id.trim().toUpperCase();
}

function failText(reason: unknown, fallback: string) {
  let message = "";
  if (typeof reason === "string" && reason.trim()) message = reason.trim();
  else if (reason instanceof Error && reason.message) message = reason.message;
  else if (reason && typeof reason === "object" && "message" in reason) {
    message = String((reason as { message: unknown }).message || "");
  }
  if (/timed out|timeout|超时/i.test(message)) {
    if (fallback.includes("加入房间")) return "加入房间超时，请再试一次";
    if (fallback.includes("更换地图")) return "更换地图超时，请再试一次";
    return "请求超时，请再试一次";
  }
  return message || fallback;
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

const MEMBER_COLORS = ["#e8c36a", "#6cb6ff", "#6fbf4a", "#e08a2c", "#d44a4a", "#c77dff", "#4ab8b8", "#f0a3c2"];

function memberColor(userId: number) {
  const id = `user:${userId}`;
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return MEMBER_COLORS[Math.abs(hash) % MEMBER_COLORS.length] || MEMBER_COLORS[0];
}

function memberViewSlug(userId: number) {
  const listed = room.detail?.viewMaps.find((item) => item.userId === userId)?.mapSlug || "";
  if (listed) return listed;
  if (userId === viewerId) return liveMapSlug();
  return "";
}

function memberTone(online: boolean, kind: string, mapSlug: string) {
  if (!online) return "offline";
  if (kind === "match_found" || kind === "raid_starting" || kind === "raid_started") return "in_raid";
  if (kind === "map_loading" || kind === "matching") return "matching";
  if (mapSlug) return "watching";
  return "lobby";
}

function toneLabel(tone: string) {
  if (tone === "offline") return "离线";
  if (tone === "in_raid") return "战局中";
  if (tone === "matching") return "匹配中";
  if (tone === "watching") return "观战中";
  return "大厅中";
}

function phaseKindFor(userId: number) {
  if (userId === viewerId && localPhaseKind) return localPhaseKind;
  return room.detail?.phases.find((item) => item.userId === userId)?.kind || "";
}

function memberMapText(userId: number) {
  const listed = room.detail?.viewMaps.find((item) => item.userId === userId)?.mapSlug || "";
  const slug = listed || (userId === viewerId ? liveMapSlug() || room.slug : "");
  if (!slug) return "—";
  return shownMap(slug) || "—";
}

function paintRoomCard() {
  const live = document.querySelector("#room-live");
  const title = document.querySelector("#room-title");
  const meta = document.querySelector("#room-meta");
  if (!live || !title || !meta) return;
  if (room.error) {
    title.textContent = "房间";
    meta.textContent = "";
    live.innerHTML = `<p class="room-error">${esc(room.error)}</p>`;
    return;
  }
  if (!room.id || !room.detail) {
    title.textContent = "房间";
    meta.textContent = room.status || "正在创建私人房间…";
    live.innerHTML = "";
    return;
  }
  const detail = room.detail;
  const seated = detail.members.filter((item) => item.inRoom);
  const people = seated.length ? seated : detail.members;
  const mapName = shownMap(detail.mapSlug || room.slug) || "未选地图";
  const count = seated.length || people.length;
  const max = detail.maxMembers;
  title.textContent = detail.title.trim() || "房间";
  meta.textContent = `${mapName} · ${count}${max ? `/${max}` : ""} · ${roomCode(detail.id)}`;
  const rows = people.map((item) => {
    const on = item.online || shownClients(item).length > 0;
    const tone = memberTone(on, phaseKindFor(item.userId), memberViewSlug(item.userId));
    return `<tr data-status="${tone}">
      <td><span class="room-person"><i class="room-dot" style="background:${memberColor(item.userId)}"></i>${item.host ? `<span class="room-star">⭐</span>` : ""}<span class="room-person-name">${esc(item.name)}</span><span class="room-presence">${esc(onlineLabel(item))}</span></span></td>
      <td>${esc(memberMapText(item.userId))}</td>
      <td>${toneLabel(tone)}</td>
    </tr>`;
  }).join("");
  live.innerHTML = `<table class="room-table"><thead><tr><th scope="col">成员</th><th scope="col">地图</th><th scope="col">状态</th></tr></thead><tbody>${rows}</tbody></table>`;
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

function markPresence(detail: RoomDetail, ids: number[] | null, clients: Map<number, RoomClient[]> | null) {
  const online = ids ? new Set(ids) : null;
  detail.members = detail.members.map((row) => {
    const nextClients = clients ? clients.get(row.userId) ?? [] : row.clients;
    const nextOnline = online ? online.has(row.userId) : nextClients.length > 0 || row.online;
    return { ...row, online: nextOnline, clients: nextClients };
  });
}

function viewerStillSeated(snap: Record<string, unknown>) {
  const occupants = Array.isArray(snap.occupants) ? snap.occupants : null;
  const members = Array.isArray(snap.members) ? snap.members : null;
  const rows = occupants && occupants.length ? occupants : members;
  if (!rows || !viewerId) return true;
  return rows.some((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    if (Number(row.user_id || row.userId || 0) !== viewerId) return false;
    return row.in_room !== false && row.inRoom !== false;
  });
}

function accountSlug(raw: string) {
  const text = raw.trim();
  if (!text) return "";
  return findMap(text, maps)?.slug || text;
}

function rowListSlug(raw: unknown) {
  if (!Array.isArray(raw) || !viewerId) return "";
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (Number(row.user_id || row.userId || 0) !== viewerId) continue;
    return String(row.map_slug || row.mapSlug || "").trim();
  }
  return "";
}

function rowListPhase(raw: unknown) {
  if (!Array.isArray(raw) || !viewerId) return null;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (Number(row.user_id || row.userId || 0) !== viewerId) continue;
    const kind = String(row.kind || "").trim();
    if (!kind) continue;
    return {
      kind,
      mapId: String(row.map_id || row.mapId || "").trim(),
      raidId: String(row.raid_id || row.raidId || "").trim(),
    };
  }
  return null;
}

function openSyncedMap(slug: string) {
  const next = accountSlug(slug);
  if (!next || !room.id || roomPending) return;
  if (sameMap(liveMapSlug(), next)) return;
  room.slug = next;
  lastMapSlug = next;
  spectating = !gameInRaid;
  setLocalWatch(gameInRaid ? "" : next);
  go(`/主菜单/逃离塔科夫/实时地图/${next}`);
}

function openSyncedPicker() {
  if (!room.id || roomPending || onMapPicker()) return;
  spectating = false;
  setLocalWatch("");
  lastMapSlug = "";
  resetMapBoard();
  go("/主菜单/逃离塔科夫/实时地图");
}

function followAccount(payload: Record<string, unknown>, snap: Record<string, unknown> | null) {
  if (!room.id || roomPending) return;
  absorbRoomLists(payload, snap);
  const phase = rowListPhase(payload.log_phases) || rowListPhase(snap?.log_phases);
  const leaving = phase?.kind === "raid_exited" || phase?.kind === "matching_aborted";
  if (phase) {
    const sig = `${room.id}:${phase.kind}:${phase.mapId}:${phase.raidId}`;
    const changed = accountPhaseReady && accountPhaseSig !== sig;
    const first = !accountPhaseReady;
    accountPhaseSig = sig;
    accountPhaseReady = true;
    const entered = phase.kind === "match_found" || phase.kind === "raid_starting" || phase.kind === "raid_started";
    if ((changed || first) && entered && phase.mapId) openSyncedMap(phase.mapId);
    else if (changed && leaving) {
      openSyncedPicker();
      return;
    }
  }
  const view = rowListSlug(payload.view_maps) || rowListSlug(snap?.view_maps);
  if (!view) return;
  const next = accountSlug(view);
  if (accountViewSlug && sameMap(accountViewSlug, next)) return;
  accountViewSlug = next;
  if (!liveMapSlug()) return;
  openSyncedMap(next);
}

function adoptRoom(detail: RoomDetail) {
  room.detail = detail;
  room.id = detail.id || room.id;
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
  if (applyRoomSync(payload) && onMapPicker()) refreshMapBoard();
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
  const clients = readClientMap(payload);
  const snap = payload.snapshot && typeof payload.snapshot === "object"
    ? payload.snapshot as Record<string, unknown>
    : null;
  if (snap) {
    if (String(snap.public_id || snap.publicId || "") !== room.id) return;
    roomLive = true;
    window.clearInterval(roomTimer);
    const detail = readDetail(snap);
    if (!detail) return;
    if (online || clients) markPresence(detail, online, clients);
    const kicked = event === "member_leave" && Number(payload.user_id || payload.userId || 0) === viewerId;
    if (kicked || !viewerStillSeated(snap)) {
      exitToLobby();
      return;
    }
    adoptRoom(detail);
    followAccount(payload, snap);
    return;
  }
  if ((event === "presence" || online || clients) && room.detail && (online || clients)) {
    roomLive = true;
    window.clearInterval(roomTimer);
    markPresence(room.detail, online, clients);
    paintRoomCard();
  }
  if (event === "log_phase" || event === "view_map") followAccount(payload, null);
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

function waitForRoomLive(id: string, ms = 8000) {
  if (roomLive && socketRoomId === id) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => finish(false), ms);
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

function clearRoomLocal(bump = true) {
  if (bump) roomSeq += 1;
  roomPending = false;
  roomLive = false;
  window.clearInterval(roomTimer);
  const watching = socketRoomId;
  socketRoomId = "";
  if (room.id) ignoredRoomId = room.id;
  room = { slug: "", id: "", status: "", error: "", password: "", detail: null };
  claimSeedKey = "";
  accountPhaseSig = "";
  accountPhaseReady = false;
  accountViewSlug = "";
  if (watching) void invoke("room_unwatch").catch(() => undefined);
  clearMapPresence();
}

let droppingRoom = "";

function dropUnpickedRoom() {
  const current = path();
  if (current.startsWith("/主菜单/逃离塔科夫/实时地图")) return;
  const slug = (room.slug || room.detail?.mapSlug || "").trim();
  const id = room.id;
  const count = room.detail?.memberCount ?? 1;
  if (!id || slug || roomPending || count > 1 || droppingRoom === id) return;
  droppingRoom = id;
  clearRoomLocal();
  void invoke("site_post", { path: `/guides/tarkov/raid-rooms/${id}/leave`, body: {} }).catch(() => undefined).finally(() => {
    if (droppingRoom === id) droppingRoom = "";
    if (path() === "/主菜单/逃离塔科夫/联机大厅") void mountLobby(true);
  });
}

function exitToMapPicker() {
  clearRoomLocal();
  lastMapSlug = "";
  resetMapBoard();
  go("/主菜单/逃离塔科夫/实时地图");
}

function exitToLobby() {
  clearRoomLocal();
  go("/主菜单/逃离塔科夫/联机大厅");
}

async function createPublicRoom(title: string, listed: boolean, password: string) {
  const secret = listed ? "" : password.trim();
  if (!listed && !secret) {
    setLobbyNote("请输入房间密码");
    return;
  }
  const seq = ++roomSeq;
  if (room.id) {
    await invoke("site_post", { path: `/guides/tarkov/raid-rooms/${room.id}/leave`, body: {} }).catch(() => undefined);
    if (seq !== roomSeq) return;
    clearRoomLocal(false);
  }
  const body: Record<string, unknown> = { listed, game_mode: gameMode };
  const name = title.trim();
  if (name) body.title = name;
  if (secret) body.password = secret;
  try {
    const created = await invoke<Record<string, unknown>>("site_post", {
      path: "/guides/tarkov/raid-rooms",
      body,
    });
    if (seq !== roomSeq) return;
    const id = String(created.public_id || created.publicId || created.id || "");
    if (!id) throw new Error("房间已创建，但没有返回编号");
    const detail = readDetail(created);
    roomPending = false;
    ignoredRoomId = "";
    if (detail) applyDetail(detail, detail.mapSlug || "", secret);
    else room = { slug: "", id, status: `房间 ${roomCode(id)}`, error: "", password: secret, detail: null };
    closeLobbyDialog();
    lastMapSlug = "";
    resetMapBoard();
    if (gameInRaid && gameMapSlug) void switchRoomMap(gameMapSlug);
    else go("/主菜单/逃离塔科夫/实时地图");
  } catch (error) {
    if (seq !== roomSeq) return;
    setLobbyNote(failText(error, "创建房间失败"));
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(message));
      },
    );
  });
}

async function switchRoomMap(slug: string) {
  if (!room.id || roomPending || slug === (room.detail?.mapSlug || "")) return;
  const id = room.id;
  const password = room.password;
  roomPending = true;
  room = { slug, id, status: "正在连接房间…", error: "", password, detail: null };
  lastMapSlug = slug;
  go(`/主菜单/逃离塔科夫/实时地图/${slug}`);
  await waitForRoomLive(id, 1500);
  if (room.id !== id) return;
  room.status = "正在更换地图…";
  render();
  try {
    const mapped = await withTimeout(invoke<Record<string, unknown>>("site_post", {
      path: `/guides/tarkov/raid-rooms/${id}/map`,
      body: { map: slug },
    }), 30000, "更换地图超时，请再试一次");
    if (room.id !== id) return;
    const detail = readDetail(mapped);
    if (detail) applyDetail(detail, slug, password);
    else roomPending = false;
    render();
    void invoke<Record<string, unknown>>("site_post", {
      path: `/guides/tarkov/raid-rooms/${id}/claims/from-progress`,
      body: {},
    }).then((seeded) => {
      if (room.id !== id || roomPending) return;
      const next = readDetail(seeded);
      if (next) adoptRoom(next);
    }).catch(() => undefined);
    return;
  } catch (error) {
    if (room.id !== id) return;
    roomPending = false;
    room = { slug, id, status: "", error: failText(error, "更换地图失败"), password, detail: null };
  }
  render();
}

function liveMapSlug() {
  const prefix = "/主菜单/逃离塔科夫/实时地图/";
  const current = path();
  if (!current.startsWith(prefix)) return "";
  return decodeURIComponent(current.slice(prefix.length).split("/")[0] || "");
}

function syncLocalWatch() {
  if (gameInRaid) {
    spectating = false;
    setLocalWatch("");
    return;
  }
  const slug = liveMapSlug();
  if (slug) spectating = true;
  setLocalWatch(spectating ? (slug || room.slug || "") : "");
}

function openLiveRaidMap() {
  if (!room.id || !gameInRaid || !gameMapSlug || roomPending) return;
  if (liveMapSlug() && sameMap(liveMapSlug(), gameMapSlug)) return;
  void switchRoomMap(gameMapSlug);
}

function paint() {
  dropUnpickedRoom();
  syncLocalWatch();
  if (path() === "/主菜单/逃离塔科夫/联机大厅") lastMapSlug = "";
  if (!onMapPicker()) resetMapBoard();
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
    replaceNav(encodeURI("/主菜单"));
    root.innerHTML = menuView();
    return;
  }
  void loadMaps();
  const catalog = matchCatalog(current);
  if (catalog) {
    window.clearInterval(usageTimer);
    root.innerHTML = tarkovFrame("物品图鉴", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "物品图鉴" },
    ], catalogShell());
    void mountCatalog(catalog);
    return;
  }
  const wiki = matchWiki(current);
  if (wiki) {
    window.clearInterval(usageTimer);
    const wikiNav = wiki.kind === "item" ? "物品图鉴" : wiki.kind === "boss" ? "Boss" : "综合搜索";
    root.innerHTML = tarkovFrame(wikiNav, [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      ...(wiki.kind === "item" ? [{ label: "物品图鉴", href: "/主菜单/逃离塔科夫/物品图鉴" }] : []),
      ...(wiki.kind === "boss" ? [{ label: "Boss", href: "/主菜单/逃离塔科夫/Boss" }] : []),
      { label: wiki.crumb },
    ], wikiShell(wiki));
    void mountWiki(wiki);
    return;
  }
  const rest = current.slice(base.length + 1);
  const [section = "综合搜索", rawSlug = ""] = rest.split("/");
  const sectionName = section === "视觉增强" || section === "辅助工具" || section === "应用设置" ? "妙妙工具" : section === "大厅" ? "联机大厅" : section === "钥匙" ? "钥匙管理" : section === "工作台" ? "枪匠工作台" : section;
  const known = sections.includes(sectionName as (typeof sections)[number]) ? sectionName : "综合搜索";
  const mapSlug = known === "实时地图" ? rawSlug : "";
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
      consumeLocate();
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
    void mountLiveMap(mapSlug).then(() => {
      void publishOverlayMap(mapSlug);
      consumeLocate();
    });
    paintRoomCard();
    watchRoom();
    void mountMapTasks(mapSlug);
    mapPage = document.querySelector(".map-app");
    return;
  }
  if (known === "实时地图") {
    window.clearInterval(usageTimer);
    root.innerHTML = renderMapPicker();
    if (!roomPending && maps.length && !mapBoardReady()) {
      void loadMapBoard({ roomId: room.id, viewerId, viewerName }, maps).then((found) => {
        rememberBoardRoom(found);
        if (gameInRaid && gameMapSlug && room.id) {
          openLiveRaidMap();
          return;
        }
        if (onMapPicker()) render();
      });
    }
    return;
  }
  if (known === "联机大厅") {
    window.clearInterval(usageTimer);
    if (section === "大厅") replaceNav(encodeURI("/主菜单/逃离塔科夫/联机大厅"));
    root.innerHTML = tarkovFrame("联机大厅", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "联机大厅" },
    ], lobbyShell());
    void mountLobby();
    return;
  }
  if (known === "钥匙管理") {
    window.clearInterval(usageTimer);
    if (section === "钥匙") replaceNav(encodeURI(`/主菜单/逃离塔科夫/钥匙管理${rawSlug ? `/${rawSlug}` : ""}`));
    root.innerHTML = tarkovFrame("钥匙管理", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "钥匙管理" },
    ], keyShell());
    void mountKeys(rawSlug);
    return;
  }
  if (known === "枪匠工作台") {
    window.clearInterval(usageTimer);
    if (section === "工作台") {
      replaceNav(encodeURI(`/主菜单/逃离塔科夫/枪匠工作台${rawSlug ? `/${rawSlug}` : ""}`) + location.search);
    }
    root.innerHTML = tarkovFrame("枪匠工作台", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "枪匠工作台" },
    ], workbenchShell());
    void mountWorkbench(rawSlug);
    return;
  }
  if (known === "藏身处") {
    window.clearInterval(usageTimer);
    root.innerHTML = tarkovFrame("藏身处", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "藏身处" },
    ], hideoutShell());
    void mountHideout(rawSlug);
    return;
  }
  if (known === "Boss") {
    window.clearInterval(usageTimer);
    root.innerHTML = tarkovFrame("Boss", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "Boss" },
    ], bossShell());
    void mountBosses();
    return;
  }
  if (known === "弹药对照") {
    window.clearInterval(usageTimer);
    root.innerHTML = tarkovFrame("弹药对照", [
      { label: "主菜单", href: "/主菜单" },
      { label: "逃离塔科夫", href: "/主菜单/逃离塔科夫/综合搜索" },
      { label: "弹药对照" },
    ], ammoShell());
    void mountAmmo();
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
type ShotSettings = { syncEnabled: boolean; pruneEnabled: boolean; keepMax: number; hotkey: string; autoEnabled: boolean; autoSecs: number; hotkeyFromGame?: boolean; gameHotkey?: string };
let shotSettings: ShotSettings = { syncEnabled: true, pruneEnabled: false, keepMax: 20, hotkey: "PrintScreen", autoEnabled: false, autoSecs: 5 };
let shotSaveToken = 0;

function consumeLocate() {
  const pending = sessionStorage.getItem("zhange.locateTask");
  if (!pending) return;
  sessionStorage.removeItem("zhange.locateTask");
  void locateQuest(pending);
}

function shotSettingsDialogHtml() {
  const syncOn = shotSettings.syncEnabled !== false;
  return `
    <div id="shot-settings-modal" class="map-summary" hidden>
      <div class="map-summary-card shot-settings-card">
        <header><strong>截图设置</strong><button type="button" id="shot-settings-close">关闭</button></header>
        <div class="shot-settings-body">
          <div class="shot-settings">
            <label><input id="shot-sync" type="checkbox" ${syncOn ? "checked" : ""} /><span id="shot-key-label">${esc(shotKeyLabel())}</span></label>
            <span id="shot-hotkey">${esc(shotKeyText())}</span>
          </div>
          <div class="shot-settings${syncOn ? "" : " is-locked"}" id="shot-prune-row">
            <label><input id="shot-prune" type="checkbox" ${shotSettings.pruneEnabled ? "checked" : ""} ${syncOn ? "" : "disabled"} />截图多于</label>
            <input id="shot-keep" type="number" min="1" max="200" value="${shotSettings.keepMax}" ${syncOn && shotSettings.pruneEnabled ? "" : "disabled"} />
            <span>张时删除旧图</span>
          </div>
          <div class="shot-settings${syncOn ? "" : " is-locked"}" id="shot-auto-row">
            <label><input id="shot-auto" type="checkbox" ${shotSettings.autoEnabled ? "checked" : ""} ${syncOn ? "" : "disabled"} />每隔</label>
            <input id="shot-every" type="number" inputmode="numeric" min="2" max="120" step="1" value="${shotSettings.autoSecs}" ${syncOn && shotSettings.autoEnabled ? "" : "disabled"} />
            <span>秒自动截图</span>
          </div>
        </div>
      </div>
    </div>`;
}

function shotIntervalText(raw: string) {
  return raw.replace(/\D/g, "");
}

function shotIntervalSecs(raw: string) {
  const digits = shotIntervalText(raw);
  const value = Number(digits);
  if (!digits || !Number.isInteger(value) || value < 2) return 2;
  return Math.min(120, value);
}

function shotKeyLabel() {
  return shotSettings.hotkeyFromGame ? "截图按键已读取到：" : "未从游戏读到按键，沿用：";
}

function shotKeyText() {
  if (shotSettings.hotkeyFromGame && shotSettings.gameHotkey) return shotSettings.gameHotkey;
  return shotHotkeyLabel(shotSettings.hotkey);
}

function paintShotDialog() {
  const syncOn = shotSettings.syncEnabled !== false;
  const sync = document.querySelector<HTMLInputElement>("#shot-sync");
  const prune = document.querySelector<HTMLInputElement>("#shot-prune");
  const keep = document.querySelector<HTMLInputElement>("#shot-keep");
  const auto = document.querySelector<HTMLInputElement>("#shot-auto");
  const every = document.querySelector<HTMLInputElement>("#shot-every");
  const hotkey = document.querySelector("#shot-hotkey");
  const pruneRow = document.querySelector("#shot-prune-row");
  const autoRow = document.querySelector("#shot-auto-row");
  if (sync) sync.checked = syncOn;
  if (prune) {
    prune.checked = shotSettings.pruneEnabled;
    prune.disabled = !syncOn;
  }
  if (keep) {
    keep.value = String(shotSettings.keepMax);
    keep.disabled = !syncOn || !shotSettings.pruneEnabled;
  }
  if (auto) {
    auto.checked = shotSettings.autoEnabled;
    auto.disabled = !syncOn;
  }
  if (every) {
    every.value = String(shotSettings.autoSecs);
    every.disabled = !syncOn || !shotSettings.autoEnabled;
  }
  pruneRow?.classList.toggle("is-locked", !syncOn);
  autoRow?.classList.toggle("is-locked", !syncOn);
  if (hotkey) hotkey.textContent = shotKeyText();
  const caption = document.querySelector("#shot-key-label");
  if (caption) caption.textContent = shotKeyLabel();
}

function openShotSettings() {
  void invoke<ShotSettings>("shot_settings_get").then((saved) => {
    rememberShotSettings(saved);
    paintShotDialog();
    const modal = document.querySelector<HTMLElement>("#shot-settings-modal");
    if (modal) fadeIn(modal);
  }).catch(() => {
    paintShotDialog();
    const modal = document.querySelector<HTMLElement>("#shot-settings-modal");
    if (modal) fadeIn(modal);
  });
}

function closeShotSettings() {
  const modal = document.querySelector<HTMLElement>("#shot-settings-modal");
  if (modal) void fadeOut(modal);
  paintShotDialog();
}

function rememberShotSettings(next: ShotSettings) {
  shotSettings = {
    syncEnabled: next.syncEnabled !== false,
    pruneEnabled: Boolean(next.pruneEnabled),
    keepMax: Math.min(200, Math.max(1, Math.floor(Number(next.keepMax) || 20))),
    hotkey: next.hotkey || "PrintScreen",
    autoEnabled: Boolean(next.autoEnabled),
    autoSecs: Math.min(120, Math.max(2, Math.floor(Number(next.autoSecs) || 5))),
    hotkeyFromGame: Boolean(next.hotkeyFromGame),
    gameHotkey: next.gameHotkey || "",
  };
}

async function saveShotSettings(patch: Partial<ShotSettings> = {}) {
  rememberShotSettings({ ...shotSettings, ...patch });
  paintShotDialog();
  const token = ++shotSaveToken;
  const saved = await invoke<ShotSettings>("shot_settings_set", { settings: shotSettings });
  if (token !== shotSaveToken) return;
  rememberShotSettings(saved);
  paintShotDialog();
  window.dispatchEvent(new CustomEvent("zhange-shot-settings", { detail: shotSettings }));
}

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
  const saved = await invoke<ShotSettings>("shot_settings_get").catch(() => null);
  if (saved) {
    rememberShotSettings(saved);
    window.dispatchEvent(new CustomEvent("zhange-shot-settings", { detail: shotSettings }));
  }
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
  resetMapBoard();
  mapsLoaded = false;
  mapsLoading = false;
  maps = [];
  clearMapTasks();
  discardMapPage();
  render();
}

type LogWatch = { kind: string; slug: string; mode: string; questKind: string; taskId: string; phase?: string; raidId?: string };

function raidPhase(kind: string) {
  return kind === "match_found" || kind === "raid_starting" || kind === "raid_started";
}

function noteGame(input: { inRaid?: boolean; slug?: string; phase?: string }) {
  if (input.slug) gameMapSlug = input.slug;
  const phase = input.phase || "";
  if (phase) localPhaseKind = phase;
  if (phase === "raid_exited" || phase === "matching_aborted") {
    gameInRaid = false;
    gameMapSlug = "";
  } else if (input.inRaid === true || raidPhase(phase)) {
    gameInRaid = true;
  } else if (input.inRaid === false) {
    gameInRaid = false;
  }
  paintRoomCard();
}

function returnToMapPicker() {
  spectating = false;
  setLocalWatch("");
  lastMapSlug = "";
  if (!path().startsWith("/主菜单/逃离塔科夫/实时地图/")) return;
  resetMapBoard();
  go("/主菜单/逃离塔科夫/实时地图");
}

let raidNav: "" | "picker" | "raid" = "";
let raidNavQueued = false;

function queueRaidNav(next: "picker" | "raid") {
  raidNav = next;
  if (raidNavQueued) return;
  raidNavQueued = true;
  queueMicrotask(() => {
    raidNavQueued = false;
    const intent = raidNav;
    raidNav = "";
    if (intent === "picker") returnToMapPicker();
    else if (intent === "raid") openLiveRaidMap();
  });
}

async function onLogWatch(event: LogWatch) {
  if (event.kind === "phase" || event.kind === "map" || event.kind === "raid-end") {
    noteLocalPhase(event.kind === "raid-end" ? { kind: "raid_exited" } : { kind: event.phase, mapId: event.slug });
    if (event.kind === "raid-end") noteGame({ inRaid: false, phase: "raid_exited" });
    else noteGame({ slug: event.slug, phase: event.phase });
    syncLocalWatch();
    if (onMapPicker()) refreshMapBoard();
  }
  if (event.kind === "raid-end" || event.phase === "raid_exited" || event.phase === "matching_aborted") {
    queueRaidNav("picker");
  } else if (gameInRaid) {
    queueRaidNav("raid");
  }
  const state = await ensureOverlayState();
  if (event.kind === "map" && event.slug && state?.autoFollow !== false && room.id && path() !== "/登录" && !sameMap(liveMapSlug(), event.slug)) {
    gameMapSlug = event.slug;
    if (gameInRaid) void switchRoomMap(event.slug);
  }
  if (event.kind === "mode" && (event.mode === "pvp" || event.mode === "pve")) {
    void setGameMode(event.mode);
  }
  if (event.kind === "quest" && (event.questKind === "started" || event.questKind === "failed" || event.questKind === "completed") && event.taskId) {
    void applyLoggedQuest(event.questKind, event.taskId).then(() => patchLoggedQuest(event.questKind as "started" | "failed" | "completed", event.taskId));
  }
}

function applyLogSnap(snap: LogLive) {
  if (!snap.running) {
    const kind = snap.phase === "matching_aborted" ? "matching_aborted" : "raid_exited";
    noteLocalPhase({ kind });
    noteGame({ inRaid: false, phase: kind });
    syncLocalWatch();
    if (onMapPicker()) refreshMapBoard();
    return;
  }
  if (snap.phase || snap.slug) noteLocalPhase({ kind: snap.phase, mapId: snap.slug });
  noteGame({ inRaid: snap.inRaid, slug: snap.slug, phase: snap.phase });
  syncLocalWatch();
  if (snap.mode) void onLogWatch({ kind: "mode", slug: "", mode: snap.mode, questKind: "", taskId: "" });
  if (gameInRaid) openLiveRaidMap();
  else if (onMapPicker()) refreshMapBoard();
}

async function pullLogSnap() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snap = await invoke<LogLive>("log_state").catch(() => null);
    if (snap?.ready) {
      applyLogSnap(snap);
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
}

async function boot() {
  setLobbyRoomKeep((id) => Boolean(id && room.id === id && (room.slug || room.detail?.mapSlug || "").trim()));
  window.addEventListener("zhange-drop-room", (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id || "";
    if (id && room.id === id) clearRoomLocal();
  });
  startPlayerSync();
  void invoke<ShotSettings>("shot_settings_get").then((saved) => rememberShotSettings(saved)).catch(() => undefined);
  if (bootOverlayShell()) return;
  document.addEventListener("fullscreenchange", () => {
    const button = document.querySelector("#map-fullscreen");
    if (!button) return;
    const on = Boolean(document.fullscreenElement);
    button.innerHTML = mapToolIcon(on ? "exit" : "full");
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.setAttribute("aria-label", on ? "退出全屏" : "全屏");
    button.setAttribute("title", on ? "退出全屏" : "全屏");
  });
  startGoonWatch(() => {
    paintGoonBars((slug) => shownMap(slug));
    paintMapPickGoon();
  });
  watchOverlayTyping();
  void listen<Record<string, unknown>>("room-sync", (event) => onRoomSync(event.payload)).catch(() => undefined);
  void listen<ToolState>("miaomiao-active", (event) => {
    if (document.querySelector("#scheme-buttons")) paintTools(event.payload);
  }).catch(() => undefined);
  await invoke("site_set_game_mode", { mode: gameMode }).catch(() => undefined);
  window.addEventListener("zhange-join-room", (event) => {
    const detail = (event as CustomEvent<{ code?: string; password?: string }>).detail;
    if (detail?.code) void joinRoom(detail.code, detail.password || "");
  });
  window.addEventListener("zhange-public-room", (event) => {
    const detail = (event as CustomEvent<{ title?: string; listed?: boolean; password?: string }>).detail;
    if (detail) void createPublicRoom(detail.title || "", detail.listed !== false, detail.password || "");
  });
  window.addEventListener("zhange-wiki", (event) => {
    const detail = (event as CustomEvent<{ kind?: string; id?: string }>).detail;
    const href = wikiHref(detail?.kind || "", detail?.id || "");
    if (href) go(href);
  });
  void listen<LogWatch>("log-watch", (event) => {
    void onLogWatch(event.payload);
  }).catch(() => undefined);
  void pullLogSnap();
  const ok = await loggedIn();
  const current = path();
  bindHistory();
  if (!ok && current !== "/登录") replaceNav(encodeURI("/登录"));
  if (ok && (current === "/" || current === "/登录")) replaceNav(encodeURI("/主菜单"));
  render();
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const historyButton = target.closest<HTMLButtonElement>("[data-history]");
  if (historyButton) {
    if (historyButton.dataset.history === "back") backNav();
    else forwardNav();
    return;
  }
  const link = target.closest("[data-link]");
  if (link instanceof HTMLAnchorElement) {
    event.preventDefault();
    const href = link.getAttribute("href") || "/主菜单";
    if (room.error === "已不在该房间") {
      if (href === "/主菜单/逃离塔科夫/实时地图") {
        exitToMapPicker();
        return;
      }
      clearRoomLocal();
    }
    if (openKeyList(href) || openHideoutList(href)) return;
    go(href);
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
  const catalogButton = target.closest<HTMLElement>("[data-catalog]");
  if (catalogButton && !catalogButton.hasAttribute("data-catalog-page")) {
    const slug = catalogButton.dataset.catalog || "";
    const child = catalogButton.dataset.catalogChild || "";
    const next = slug ? `/主菜单/逃离塔科夫/物品图鉴/${slug}${child ? `/${child}` : ""}` : "/主菜单/逃离塔科夫/物品图鉴";
    if (document.querySelector("#catalog")) {
      pinCatalogList(catalogButton.dataset.catalogNode || "all");
      const url = encodeURI(next);
      if (location.pathname + location.search !== url) pushNav(url);
      void mountCatalog({ slug, child });
      return;
    }
    go(next);
    return;
  }
  if (target.closest("#map-sidebars")) {
    setMapSidebars(!mapSidebarsOpen());
    return;
  }
  if (target.closest("#map-fullscreen")) {
    const node = document.querySelector(".map-app");
    if (node instanceof HTMLElement) {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void node.requestFullscreen();
    }
    return;
  }
  const sectionButton = target.closest<HTMLButtonElement>("[data-section]");
  if (sectionButton?.dataset.section) {
    const name = sectionButton.dataset.section;
    if (room.error === "已不在该房间") {
      if (name === "实时地图") {
        exitToMapPicker();
        return;
      }
      clearRoomLocal();
    } else if (name === "实时地图" && room.id && lastMapSlug) {
      go(`/主菜单/逃离塔科夫/实时地图/${lastMapSlug}`);
      return;
    } else if (name === "实时地图") {
      lastMapSlug = "";
      resetMapBoard();
      go("/主菜单/逃离塔科夫/实时地图");
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
  const wikiHit = target.closest<HTMLElement>("[data-wiki]");
  if (wikiHit?.dataset.wiki && wikiHit.dataset.wikiId) {
    const href = wikiHref(wikiHit.dataset.wiki, wikiHit.dataset.wikiId);
    if (href) go(href);
    return;
  }
  const locate = target.closest<HTMLElement>("[data-locate-task]");
  if (locate?.dataset.locateTask && locate.dataset.locateMap) {
    sessionStorage.setItem("zhange.locateTask", locate.dataset.locateTask);
    const slug = locate.dataset.locateMap;
    if (room.id && slug !== (room.detail?.mapSlug || room.slug)) {
      void switchRoomMap(slug);
      return;
    }
    lastMapSlug = slug;
    go(`/主菜单/逃离塔科夫/实时地图/${slug}`);
    return;
  }
  if (target.closest("[data-search-closed]")) {
    searchNote = "这条结果还没有对应页面。";
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
    syncMapDock();
    return;
  }
  const expand = target.closest<HTMLButtonElement>("[data-expand]");
  if (expand?.dataset.expand) {
    document.querySelector(`#${expand.dataset.expand}-panel`)?.classList.remove("collapsed");
    expand.setAttribute("hidden", "");
    syncMapDock();
    return;
  }
  const roomAction = target.closest<HTMLButtonElement>("[data-room]");
  if (roomAction?.dataset.room) void onRoomAction(roomAction.dataset.room, roomAction);
});

function mapPanel(id: string) {
  return document.querySelector(`#${id}-panel`);
}

function mapSidebarsOpen() {
  return ["room", "filter", "task"].some((id) => {
    const node = mapPanel(id);
    return node && !node.classList.contains("collapsed");
  });
}

function syncMapDock() {
  const leftOpen = ["room", "filter"].some((id) => {
    const node = mapPanel(id);
    return node && !node.classList.contains("collapsed");
  });
  document.querySelector(".map-app")?.classList.toggle("rails-closed", !leftOpen);
  const button = document.querySelector("#map-sidebars");
  if (!button) return;
  const open = mapSidebarsOpen();
  const label = open ? "收起侧边栏" : "展开侧边栏";
  button.setAttribute("aria-pressed", open ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

function setMapSidebars(open: boolean) {
  for (const id of ["room", "filter", "task"]) {
    mapPanel(id)?.classList.toggle("collapsed", !open);
    document.querySelector<HTMLElement>(`[data-expand="${id}"]`)?.setAttribute("hidden", "");
  }
  syncMapDock();
}

async function onRoomAction(action: string, button: HTMLButtonElement) {
  if (action === "copy") {
    if (!room.id) return;
    const text = room.password ? `房间 ${roomCode(room.id)} 密码 ${room.password}` : roomCode(room.id);
    await navigator.clipboard.writeText(text).catch(() => undefined);
    button.textContent = "已复制";
    window.setTimeout(() => { button.textContent = "复制编号"; }, 1200);
    return;
  }
  if (action === "maps") {
    go("/主菜单/逃离塔科夫/实时地图");
    return;
  }
  if (action === "leave") {
    const id = room.id;
    exitToLobby();
    if (id) void invoke("site_post", { path: `/guides/tarkov/raid-rooms/${id}/leave`, body: {} }).catch(() => undefined);
  }
}

async function joinRoom(code: string, password: string) {
  const seq = ++roomSeq;
  ignoredRoomId = "";
  roomPending = true;
  room = { slug: "", id: code, status: "正在加入房间…", error: "", password, detail: null };
  lastMapSlug = "";
  resetMapBoard();
  go("/主菜单/逃离塔科夫/实时地图");
  try {
    const data = await withTimeout(invoke<Record<string, unknown>>("site_post", {
      path: `/guides/tarkov/raid-rooms/${encodeURIComponent(code)}/join`,
      body: password ? { game_mode: gameMode, password } : { game_mode: gameMode },
    }), 30000, "加入房间超时，请再试一次");
    if (seq !== roomSeq) return;
    const detail = readDetail(data);
    if (!detail) throw new Error("没有返回房间信息");
    applyDetail(detail, "", password);
    const mine = detail.viewMaps.find((item) => item.userId === viewerId)?.mapSlug || "";
    const slug = detail.mapSlug || mine;
    if (gameInRaid && gameMapSlug && !sameMap(slug, gameMapSlug)) {
      void switchRoomMap(gameMapSlug);
      return;
    }
    if (slug) {
      lastMapSlug = slug;
      go(`/主菜单/逃离塔科夫/实时地图/${slug}`);
      return;
    }
    resetMapBoard();
    render();
  } catch (error) {
    if (seq !== roomSeq) return;
    roomPending = false;
    room = { slug: "", id: "", status: "", error: "", password: "", detail: null };
    go("/主菜单/逃离塔科夫/联机大厅");
    setLobbyNote(failText(error, "加入房间失败"));
  } finally {
    settleLobbyJoin();
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
  if (target instanceof HTMLInputElement && target.id === "shot-every") {
    const digits = shotIntervalText(target.value);
    if (target.value !== digits) target.value = digits;
    return;
  }
  if (target instanceof HTMLInputElement && target.id.endsWith("-val") === false && target.id) {
    const text = document.querySelector(`#${target.id}-val`);
    if (text && target.type === "range") {
      const digits = target.id === "vis-gamma" ? 2 : 0;
      text.textContent = Number(target.value).toFixed(digits);
    }
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "shot-sync") {
    void saveShotSettings({ syncEnabled: target.checked });
    return;
  }
  if (target instanceof HTMLInputElement && target.id === "shot-auto") {
    void saveShotSettings(target.checked ? { autoEnabled: true, pruneEnabled: true } : { autoEnabled: false });
    return;
  }
  if (target instanceof HTMLInputElement && target.id === "shot-prune") {
    void saveShotSettings({ pruneEnabled: target.checked });
    return;
  }
  if (target instanceof HTMLInputElement && target.id === "shot-keep") {
    void saveShotSettings({ keepMax: Number(target.value) });
    return;
  }
  if (target instanceof HTMLInputElement && target.id === "shot-every") {
    const autoSecs = shotIntervalSecs(target.value);
    target.value = String(autoSecs);
    void saveShotSettings({ autoSecs });
    return;
  }
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
  if (target.closest("#shot-settings")) {
    openShotSettings();
    return;
  }
  if (target.closest("#shot-settings-close") || target.id === "shot-settings-modal") {
    closeShotSettings();
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
  paintGoonBars((slug) => shownMap(slug));
  paintMapPickGoon();
  paintHistoryButtons();
}

window.addEventListener("popstate", () => {
  syncNav();
  render();
});
void boot();

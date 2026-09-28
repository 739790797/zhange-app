import { bindListSearch, listAllIcon, listBusy, listFail, listFrame, listIcon, listItem, listShell, repaintList } from "./listFrame";
import { fadeIn, fadeOut } from "./motion";
import { findMap, mapTitle, sameMap } from "./mapNames";

type LobbyRoom = {
  id: string;
  title: string;
  mapSlug: string;
  mapName: string;
  thumb: string;
  host: string;
  members: number;
  max: number;
  locked: boolean;
  inRaid: boolean;
};

type MapOption = { slug: string; name: string; thumb: string };

const PAGE = 20;
const IN_RAID = new Set(["map_loading", "matching", "match_found", "raid_starting", "raid_started"]);

let seq = 0;
let page = 1;
let note = "";
let mapFilter = "";
let query = "";
let dialog: "" | "create" | "code" = "";
let rooms: LobbyRoom[] = [];
let maps: MapOption[] = [];
let pages = 1;
let queryTimer = 0;
let hostName = "";
let draftTitle = "";
let draftPrivate = false;
let draftPassword = "";
let draftCode = "";
let creating = false;
let shownDialog = "";

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function rec(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function modeOf() {
  return localStorage.getItem("zhange.guides.tarkov.gameMode") === "pve" ? "pve" : "pvp";
}

function defaultTitle() {
  const name = hostName.trim();
  const title = name ? `${name}的房间` : "";
  return title.length > 40 ? title.slice(0, 40) : title;
}

async function ensureHostName() {
  if (hostName) return hostName;
  const me = await invoke<{ display_name?: string; username?: string }>("site_get", { path: "/auth/me" }).catch(() => null);
  hostName = str(me?.display_name || me?.username);
  return hostName;
}

function hostInRaid(row: Record<string, unknown>) {
  const hostId = Number(row.host_user_id ?? row.hostUserId ?? 0);
  const direct = str(row.host_phase || row.hostPhase || row.phase_kind || row.phaseKind);
  if (IN_RAID.has(direct)) return true;
  const phases = Array.isArray(row.phases) ? row.phases : [];
  for (const item of phases) {
    const phase = rec(item);
    if (!phase) continue;
    const userId = Number(phase.user_id ?? phase.userId ?? 0);
    if (hostId && userId !== hostId) continue;
    if (!hostId && phase.is_host !== true && phase.isHost !== true) continue;
    if (IN_RAID.has(str(phase.kind || phase.phase))) return true;
  }
  const members = Array.isArray(row.members) ? row.members : Array.isArray(row.occupants) ? row.occupants : [];
  for (const item of members) {
    const member = rec(item);
    if (!member) continue;
    const userId = Number(member.user_id ?? member.userId ?? 0);
    const isHost = member.is_host === true || member.isHost === true || (hostId > 0 && userId === hostId);
    if (!isHost) continue;
    if (IN_RAID.has(str(member.phase || member.kind || member.raid_phase || member.phase_kind))) return true;
  }
  return false;
}

function readRoom(row: Record<string, unknown>, options: MapOption[]): LobbyRoom | null {
  const id = str(row.public_id || row.publicId || row.id);
  if (!id || id === "solo") return null;
  const mapSlug = str(row.map_slug || row.mapSlug);
  const map = findMap(mapSlug, options);
  const members = Number(row.member_count ?? row.memberCount ?? 0);
  const max = Number(row.max_members ?? row.maxMembers ?? 0);
  return {
    id,
    title: str(row.title) || "房间",
    mapSlug,
    mapName: mapTitle(mapSlug, map?.name || "", "未选地图"),
    thumb: map?.thumb || str(row.thumb_link || row.thumbLink),
    host: str(row.host_display_name || row.hostName || row.host_name),
    members: Number.isFinite(members) ? members : 0,
    max: Number.isFinite(max) ? max : 0,
    locked: row.listed === false || row.has_password === true || row.hasPassword === true,
    inRaid: hostInRaid(row),
  };
}

export function lobbyShell() {
  return listShell("lobby", "正在读取联机大厅");
}

function render() {
  const listed = rooms.filter((room) => {
    if (mapFilter && !sameMap(room.mapSlug, mapFilter)) return false;
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    return `${room.title} ${room.host} ${room.mapName}`.toLowerCase().includes(needle);
  });
  const side = [
    listItem("全部", !mapFilter, `data-lobby-map=""`, listAllIcon()),
    ...maps.map((item) => listItem(esc(item.name), item.slug === mapFilter, `data-lobby-map="${esc(item.slug)}"`, listIcon(item.thumb))),
  ].join("");
  const body = listed.map((room) => {
    const full = room.max > 0 && room.members >= room.max;
    const thumb = room.thumb ? `<img class="lobby-thumb" src="${esc(room.thumb)}" alt="" />` : `<i class="lobby-thumb"></i>`;
    return `<tr class="lobby-row" data-lobby-join="${esc(room.id)}" data-lobby-locked="${room.locked ? "1" : "0"}"${full ? ` data-lobby-full="1"` : ""}>
      <td>${thumb}</td>
      <td>${esc(room.mapName)}</td>
      <td>${room.locked ? "私人" : "公开"}</td>
      <td>${esc(room.host || "—")}</td>
      <td>${room.inRaid ? "战局中" : "大厅中"}</td>
      <td class="num">${room.members}${room.max ? ` / ${room.max}` : ""}</td>
      <td class="lobby-act"><button type="button" class="lobby-join" data-lobby-join-btn ${full ? "disabled" : ""}>加入</button></td>
    </tr>`;
  }).join("");
  const table = listed.length
    ? `<table class="tarkov-list-table"><thead><tr><th>地图缩略图</th><th>地图名称</th><th>隐私</th><th>房主</th><th>状态</th><th class="num">人数</th><th class="lobby-act">加入</th></tr></thead><tbody>${body}</tbody></table>`
    : `<p class="tarkov-list-empty">没有房间。</p>`;
  const pager = pages > 1
    ? `<div class="tarkov-list-pager"><button type="button" data-lobby-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button><span>${page} / ${pages}</span><button type="button" data-lobby-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button></div>`
    : "";
  const dialogHtml = dialog === "create"
    ? `<div class="lobby-pass"><form id="lobby-create" autocomplete="off"><p>创建房间</p><label>房间标题<input name="title" maxlength="40" value="${esc(draftTitle)}" /></label><div class="lobby-privacy" role="radiogroup" aria-label="房间性质"><label><input type="radio" name="privacy" value="public" ${draftPrivate ? "" : "checked"} /> 公开</label><label><input type="radio" name="privacy" value="private" ${draftPrivate ? "checked" : ""} /> 私密</label></div><label data-lobby-password ${draftPrivate ? "" : "hidden"}>房间密码<input name="password" type="password" maxlength="32" autocomplete="new-password" placeholder="加入时需要" value="${esc(draftPassword)}" /></label><p class="wiki-note">私密房间需要密码，不会出现在大厅。地图进房后再选。</p><p class="wiki-actions"><button type="submit" ${creating ? "disabled" : ""}>${creating ? "创建中…" : "创建"}</button><button type="button" data-lobby-dialog-cancel ${creating ? "disabled" : ""}>取消</button></p>${note ? `<p class="wiki-note">${esc(note)}</p>` : ""}</form></div>`
    : dialog === "code"
      ? `<div class="lobby-pass"><form id="lobby-code" autocomplete="off"><p>输入房间码</p><input name="code" maxlength="32" autocomplete="off" placeholder="房间码" value="${esc(draftCode)}" /><label>房间密码<input name="password" type="password" maxlength="32" autocomplete="new-password" placeholder="私密房间才需要" /></label><p class="wiki-actions"><button type="submit">加入</button><button type="button" data-lobby-dialog-cancel>取消</button></p>${note ? `<p class="wiki-note">${esc(note)}</p>` : ""}</form></div>`
      : "";
  const alert = note && !dialog ? `<p class="wiki-note">${esc(note)}</p>` : "";
  return listFrame({
    side,
    filters: `<div class="tarkov-list-kinds"><button type="button" data-lobby-create>创建房间</button></div>`,
    search: { id: "lobby-find", value: query, placeholder: "搜索房间 / 房主", label: "搜索房间" },
    panel: `${alert}${table}${pager}${dialogHtml}`,
  });
}

function join(id: string, password = "") {
  const room = rooms.find((item) => item.id.toLowerCase() === id.trim().toLowerCase());
  if (room && room.max > 0 && room.members >= room.max) {
    note = "房间已满";
    paint();
    return;
  }
  note = "";
  dialog = "";
  window.dispatchEvent(new CustomEvent("zhange-join-room", { detail: { code: id.trim(), password } }));
}

function paint() {
  const host = document.querySelector<HTMLElement>("#lobby");
  if (!host) return;
  const opening = Boolean(dialog) && dialog !== shownDialog;
  const typing = repaintList(host, "lobby-find", () => {
    host.innerHTML = render();
  });
  shownDialog = dialog;
  const pass = host.querySelector<HTMLElement>(".lobby-pass");
  if (opening && pass) fadeIn(pass);
  bind();
  if (typing) return;
  if (dialog === "create") {
    const field = draftPrivate && note.includes("密码")
      ? host.querySelector<HTMLInputElement>("#lobby-create [name=password]")
      : host.querySelector<HTMLInputElement>("#lobby-create [name=title]");
    field?.focus();
  } else if (dialog === "code") {
    const field = draftCode
      ? host.querySelector<HTMLInputElement>("#lobby-code [name=password]")
      : host.querySelector<HTMLInputElement>("#lobby-code [name=code]");
    field?.focus();
  }
}

function bind() {
  const host = document.querySelector<HTMLElement>("#lobby");
  if (!host) return;
  bindListSearch(host, "lobby-find", (value) => {
    query = value.trim();
    page = 1;
    window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(() => void mountLobby(true), 300);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-lobby-map]").forEach((button) => {
    button.addEventListener("click", () => {
      mapFilter = button.dataset.lobbyMap || "";
      page = 1;
      void mountLobby();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-lobby-page]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      page = Math.max(1, Number(button.dataset.lobbyPage) || 1);
      void mountLobby();
    });
  });
  host.querySelector("[data-lobby-create]")?.addEventListener("click", () => {
    void ensureHostName().then(() => {
      draftTitle = defaultTitle();
      draftPrivate = false;
      draftPassword = "";
      creating = false;
      dialog = "create";
      note = "";
      paint();
    });
  });
  const enter = (row: HTMLElement) => {
    const id = row.dataset.lobbyJoin || "";
    if (!id || row.dataset.lobbyFull) {
      note = row.dataset.lobbyFull ? "房间已满" : "";
      if (note) paint();
      return;
    }
    if (row.dataset.lobbyLocked === "1") {
      draftCode = id;
      dialog = "code";
      note = "";
      paint();
      return;
    }
    join(id);
  };
  host.querySelectorAll<HTMLButtonElement>("[data-lobby-join-btn]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const row = button.closest<HTMLElement>("[data-lobby-join]");
      if (row) enter(row);
    });
  });
  host.querySelectorAll<HTMLTableRowElement>("[data-lobby-join]").forEach((row) => {
    row.addEventListener("click", () => enter(row));
  });
  host.querySelector("#lobby-code")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const data = new FormData(form);
    const code = String(data.get("code") || "").trim();
    const password = String(data.get("password") || "").trim();
    if (!code) {
      note = "请输入房间码";
      paint();
      return;
    }
    join(code, password);
  });
  host.querySelectorAll<HTMLInputElement>("#lobby-create [name=privacy]").forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      draftPrivate = input.value === "private";
      const field = host.querySelector<HTMLElement>("[data-lobby-password]");
      if (!draftPrivate) {
        draftPassword = "";
        const box = field?.querySelector("input");
        if (box) box.value = "";
        field?.setAttribute("hidden", "");
        return;
      }
      field?.removeAttribute("hidden");
      field?.querySelector("input")?.focus();
    });
  });
  host.querySelector<HTMLInputElement>("#lobby-create [name=password]")?.addEventListener("input", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) draftPassword = input.value;
  });
  host.querySelector<HTMLInputElement>("#lobby-create [name=title]")?.addEventListener("input", (event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement) draftTitle = input.value;
  });
  host.querySelector("#lobby-create")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (creating) return;
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const data = new FormData(form);
    const title = String(data.get("title") || "").trim();
    const isPrivate = data.get("privacy") === "private";
    const password = String(data.get("password") || "").trim();
    draftTitle = title;
    draftPrivate = isPrivate;
    draftPassword = isPrivate ? password : "";
    if (isPrivate && !password) {
      note = "请输入房间密码";
      paint();
      return;
    }
    creating = true;
    note = "";
    paint();
    window.dispatchEvent(new CustomEvent("zhange-public-room", {
      detail: { title, listed: !isPrivate, password: isPrivate ? password : "" },
    }));
  });
  host.querySelector("[data-lobby-dialog-cancel]")?.addEventListener("click", () => {
    if (creating) return;
    const pass = host.querySelector<HTMLElement>(".lobby-pass");
    const clear = () => {
      dialog = "";
      note = "";
      draftPassword = "";
      draftPrivate = false;
      draftCode = "";
      shownDialog = "";
      paint();
    };
    if (pass) void fadeOut(pass).then(clear);
    else clear();
  });
}

export async function mountLobby(quiet = false) {
  const token = ++seq;
  const host = document.querySelector<HTMLElement>("#lobby");
  if (!host) return;
  if (!quiet) listBusy(host, "正在读取联机大厅", (item) => (item.dataset.lobbyMap || "") === mapFilter);
  void ensureHostName();
  const mode = modeOf();
  const params = new URLSearchParams({ game_mode: mode, page: String(page), page_size: String(PAGE) });
  if (mapFilter) params.set("map", mapFilter);
  if (query) params.set("q", query);
  try {
    const [roomData, mapData] = await Promise.all([
      invoke<{ items?: unknown; rooms?: unknown; total?: number }>("site_get", { path: `/guides/tarkov/raid-rooms?${params.toString()}` }),
      invoke<{ items?: { slug?: string; name?: string; thumb_link?: string; thumbLink?: string }[] }>("site_get", { path: "/guides/tarkov/maps" }).catch(() => ({ items: [] })),
    ]);
    if (token !== seq || !document.querySelector("#lobby")) return;
    maps = (mapData.items || []).flatMap((item) => {
      const slug = str(item.slug);
      const name = str(item.name) || slug;
      return slug ? [{ slug, name, thumb: str(item.thumbLink || item.thumb_link) }] : [];
    });
    const raw = Array.isArray(roomData.items) ? roomData.items : Array.isArray(roomData.rooms) ? roomData.rooms : [];
    rooms = raw.flatMap((item) => {
      const row = rec(item);
      const room = row ? readRoom(row, maps) : null;
      return room ? [room] : [];
    });
    const total = Number(roomData.total);
    pages = Number.isFinite(total) && total >= 0 ? Math.max(1, Math.ceil(total / PAGE)) : 1;
    if (page > pages) page = pages;
    paint();
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector<HTMLElement>("#lobby");
    if (!live) return;
    listFail(live, error instanceof Error ? error.message : "联机大厅读取失败");
  }
}

export function closeLobbyDialog() {
  dialog = "";
  note = "";
  creating = false;
  draftPassword = "";
  draftPrivate = false;
  draftCode = "";
}

export function setLobbyNote(message: string) {
  note = message;
  creating = false;
  if (document.querySelector("#lobby")) paint();
}

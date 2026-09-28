type LobbyRoom = {
  id: string;
  title: string;
  mapSlug: string;
  mapName: string;
  host: string;
  members: number;
  max: number;
  locked: boolean;
  mode: string;
};

type MapOption = { slug: string; name: string };

let seq = 0;
let page = 1;
let note = "";

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

function readRoom(row: Record<string, unknown>, maps: MapOption[]): LobbyRoom | null {
  if (row.listed === false) return null;
  const id = str(row.public_id || row.publicId || row.id);
  if (!id || id === "solo") return null;
  const mapSlug = str(row.map_slug || row.mapSlug);
  const mapName = maps.find((item) => item.slug === mapSlug)?.name || mapSlug || "未选地图";
  const members = Number(row.member_count ?? row.memberCount ?? 0);
  const max = Number(row.max_members ?? row.maxMembers ?? 0);
  return {
    id,
    title: str(row.title) || "房间",
    mapSlug,
    mapName,
    host: str(row.host_display_name || row.hostName || row.host_name),
    members: Number.isFinite(members) ? members : 0,
    max: Number.isFinite(max) ? max : 0,
    locked: row.has_password === true || row.hasPassword === true,
    mode: str(row.game_mode || row.gameMode).toUpperCase(),
  };
}

export function lobbyShell() {
  return `<section class="lobby" id="lobby"><p class="wiki-note">正在读取大厅…</p></section>`;
}

function render(rooms: LobbyRoom[], maps: MapOption[], pages: number, more: boolean) {
  const full = (room: LobbyRoom) => room.max > 0 && room.members >= room.max;
  const cards = rooms.map((room) => `<article class="lobby-card">
    <header><strong>${esc(room.title)}</strong><span>${esc(room.mode || modeOf().toUpperCase())}</span></header>
    <p>${esc(room.mapName)}${room.host ? ` · ${esc(room.host)}` : ""}</p>
    <p>${room.members}${room.max ? ` / ${room.max}` : ""} 人${room.locked ? " · 有密码" : " · 公开"}</p>
    <form class="lobby-join">
      ${room.locked ? `<input name="password" type="password" maxlength="32" placeholder="房间密码" autocomplete="off" />` : ""}
      <button type="submit" data-lobby-join="${esc(room.id)}" ${full(room) ? "disabled" : ""}>${full(room) ? "已满" : "加入"}</button>
    </form>
  </article>`).join("");
  return `
    <form id="lobby-create" class="wiki-tools">
      <select name="map" aria-label="地图">${maps.map((item) => `<option value="${esc(item.slug)}">${esc(item.name)}</option>`).join("")}</select>
      <input name="title" maxlength="40" placeholder="房间标题，可留空" />
      <input name="password" maxlength="32" placeholder="密码，留空则公开" autocomplete="off" />
      <button type="submit">创建公开房间</button>
    </form>
    <p class="wiki-note" id="lobby-note">${esc(note || `当前是 ${modeOf().toUpperCase()} 大厅。`)}</p>
    ${cards ? `<div class="lobby-grid">${cards}</div>` : `<p class="wiki-note">大厅里还没有公开房间。</p>`}
    ${pages > 1 || more || page > 1 ? `<p class="wiki-actions"><button type="button" data-lobby-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button><span>${pages > 1 ? `${page} / ${pages}` : `第 ${page} 页`}</span><button type="button" data-lobby-page="${page + 1}" ${more || page < pages ? "" : "disabled"}>下一页</button></p>` : ""}`;
}

function bind(maps: MapOption[]) {
  const host = document.querySelector<HTMLElement>("#lobby");
  if (!host) return;
  host.querySelector("#lobby-create")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const data = new FormData(form);
    const slug = String(data.get("map") || maps[0]?.slug || "");
    if (!slug) return;
    window.dispatchEvent(new CustomEvent("zhange-public-room", {
      detail: { slug, title: String(data.get("title") || ""), password: String(data.get("password") || "") },
    }));
  });
  host.querySelectorAll("form.lobby-join").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!(form instanceof HTMLFormElement)) return;
      const button = form.querySelector<HTMLButtonElement>("[data-lobby-join]");
      const code = button?.dataset.lobbyJoin || "";
      if (!code || button?.disabled) return;
      const password = String(new FormData(form).get("password") || "");
      window.dispatchEvent(new CustomEvent("zhange-join-room", { detail: { code, password } }));
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-lobby-page]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      page = Math.max(1, Number(button.dataset.lobbyPage) || 1);
      void mountLobby();
    });
  });
}

export async function mountLobby() {
  const token = ++seq;
  const host = document.querySelector<HTMLElement>("#lobby");
  if (!host) return;
  host.innerHTML = `<p class="wiki-note">正在读取大厅…</p>`;
  const mode = modeOf();
  try {
    const [rooms, mapData] = await Promise.all([
      invoke<{ items?: unknown; rooms?: unknown; total?: number }>("site_get", { path: `/guides/tarkov/raid-rooms?game_mode=${mode}&page=${page}&page_size=12` }),
      invoke<{ items?: { slug?: string; name?: string }[] }>("site_get", { path: "/guides/tarkov/maps" }).catch(() => ({ items: [] })),
    ]);
    if (token !== seq || !document.querySelector("#lobby")) return;
    const maps = (mapData.items || []).flatMap((item) => {
      const slug = str(item.slug);
      const name = str(item.name) || slug;
      return slug ? [{ slug, name }] : [];
    });
    const raw = Array.isArray(rooms.items) ? rooms.items : Array.isArray(rooms.rooms) ? rooms.rooms : [];
    const list = raw.flatMap((item) => {
      const row = rec(item);
      const room = row ? readRoom(row, maps) : null;
      return room ? [room] : [];
    });
    const total = Number(rooms.total);
    const knownTotal = Number.isFinite(total) && total > 0;
    if (!knownTotal && page > 1 && list.length === 0) {
      page -= 1;
      note = "没有更多房间";
      void mountLobby();
      return;
    }
    const pages = knownTotal ? Math.max(1, Math.ceil(total / 12)) : page;
    const more = !knownTotal && list.length === 12;
    host.innerHTML = render(list, maps, pages, more);
    bind(maps);
  } catch (error) {
    if (token !== seq) return;
    const live = document.querySelector("#lobby");
    if (!live) return;
    const message = error instanceof Error ? error.message : "大厅读取失败";
    live.innerHTML = `<p class="wiki-note">${esc(message)}</p>`;
  }
}

export function setLobbyNote(message: string) {
  note = message;
  const node = document.querySelector("#lobby-note");
  if (node) node.textContent = message;
}

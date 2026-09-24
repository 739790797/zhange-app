import L from "leaflet";
import "leaflet/dist/leaflet.css";
import rawMaps from "./data/tarkov-dev-maps.json";
import { floorForSpan, markerFloorBands, markerFloorDisplay, spanOnFloor, type FloorBand, type HeightPoint } from "./mapFloor";
import {
  buildQuestOverlays,
  clusterQuestLabels,
  defaultPersonOff,
  filterQuestOverlays,
  locateQuestPoints,
  overlayForLabel,
  parentQuestSelection,
  personKey,
  personQuestSelection,
  questActions,
  questBubbleHtml,
  questColor,
  questLabelHtml,
  questPeople,
  QUEST_OTHER_FLOOR,
  type QuestOverlay,
  type QuestPerson,
  type QuestPoint,
  type QuestTask,
} from "./questOverlay";

type MapLayer = {
  key: string;
  projection: string;
  altMaps?: string[];
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
  transform?: number[];
  coordinateRotation?: number;
  bounds?: number[][];
  svgPath?: string;
  tilePath?: string;
  heightRange?: number[];
  normalizedName?: string;
  layers?: { name: string; tilePath?: string; svgLayer?: string; extents?: { height?: number[]; bounds?: unknown }[] | null }[];
};

type MapGroup = { normalizedName: string; maps: MapLayer[] };

type Point = HeightPoint & { name?: string | null; kind?: string | null; faction?: string | null };

const groups = rawMaps as MapGroup[];
const aliases: Record<string, string> = {
  lab: "the-lab",
  streets: "streets-of-tarkov",
  labyrinth: "the-labyrinth",
  "factory-night": "night-factory",
};

export type FilterPrefs = { off: string[]; style: "tile" | "svg"; floor: string; collapsed: string[] };

const prefsKey = "zhange.map.filters";

function loadPrefs(): FilterPrefs {
  try {
    const raw = sessionStorage.getItem(prefsKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FilterPrefs>;
      return {
        off: parsed.off || [],
        style: parsed.style === "svg" ? "svg" : "tile",
        floor: parsed.floor || "",
        collapsed: parsed.collapsed || [],
      };
    }
  } catch {
    /* 没有记录时全部按默认勾选 */
  }
  return { off: [], style: "tile", floor: "", collapsed: [] };
}

let prefs = loadPrefs();

function savePrefs() {
  sessionStorage.setItem(prefsKey, JSON.stringify(prefs));
}

function layerOn(key: string) {
  return !prefs.off.includes(key);
}

function rememberLayer(key: string, on: boolean) {
  prefs.off = prefs.off.filter((item) => item !== key);
  if (!on) prefs.off.push(key);
  savePrefs();
}

let map: L.Map | null = null;
let token = 0;
let mapSlug = "";
let filterConfig: MapLayer | null = null;
let filterDetail: Record<string, unknown> | null = null;
let labelTimer = 0;
let questToken = 0;
let displayedQuests: QuestOverlay[] = [];
let highlightTaskId = "";
let locateCursor: Record<string, number> = {};
const questCache = new Map<string, QuestTask>();
let questClaimIds: string[] = [];
let questPeopleRows: QuestPerson[] = [];
let questPeopleByTask = new Map<string, QuestPerson[]>();
let questSkipped = new Map<string, Set<string>>();
let questDones: { taskId: string; objectiveId: string; userId: number }[] = [];
let questDoneTasks = new Set<string>();
let questSelfId: number | null = null;
let questPersonOff = new Set<string>();
let questPersonSeeded = false;
let questGuide: ((taskId: string) => void) | null = null;
let questToggle: ((taskId: string, objectiveId: string, done: boolean) => void) | null = null;
const layers = new Map<string, L.LayerGroup>();
const placed: { marker: L.Marker; point: Point }[] = [];
let tileLayer: L.TileLayer | null = null;
let svgLayer: L.ImageOverlay | null = null;
let activeConfig: MapLayer | null = null;

function findInteractive(slug: string): MapLayer | undefined {
  const key = aliases[slug] || slug;
  const group = groups.find((item) => item.normalizedName === key || item.maps.some((layer) => layer.key === key || layer.altMaps?.includes(key)));
  return group?.maps.find((layer) => layer.projection === "interactive");
}

function rotate(lat: number, lng: number, rotation: number) {
  if (!rotation) return L.latLng(lat, lng);
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return L.latLng(lng * sin + lat * cos, lng * cos - lat * sin);
}

function crsFor(layer: MapLayer): L.CRS {
  const transform = layer.transform || [];
  const scaleX = transform.length >= 4 ? transform[0] : 1;
  const marginX = transform.length >= 4 ? transform[1] : 0;
  const scaleY = transform.length >= 4 ? transform[2] * -1 : -1;
  const marginY = transform.length >= 4 ? transform[3] : 0;
  const rotation = layer.coordinateRotation || 0;
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (latLng: L.LatLng) => L.Projection.LonLat.project(rotate(latLng.lat, latLng.lng, rotation)),
      unproject: (point: L.Point) => rotate(L.Projection.LonLat.unproject(point).lat, L.Projection.LonLat.unproject(point).lng, -rotation),
    }),
  }) as L.CRS;
}

function boundsFor(layer: MapLayer) {
  const bounds = layer.bounds;
  if (!bounds || bounds.length < 2) return null;
  const a = bounds[0];
  const b = bounds[1];
  if (!a || !b) return null;
  return L.latLngBounds([a[1], a[0]], [b[1], b[0]]);
}

const ICON = "/tarkov/map-icons";

function iconMarker(url: string, title: string, point: Point, anchor: [number, number] = [12, 12]) {
  if (point.x == null || point.z == null) return null;
  return L.marker([point.z, point.x], {
    icon: L.icon({ iconUrl: url, iconSize: [24, 24], iconAnchor: anchor }),
    title,
  }).bindTooltip(title, { direction: "top" });
}

function extractMarker(kind: string, title: string, point: Point) {
  if (point.x == null || point.z == null) return null;
  const color = extractColor(kind);
  return L.marker([point.z, point.x], {
    icon: L.divIcon({
      className: "map-extract",
      html: `<span class="map-extract-row"><img src="${ICON}/extract_${kind}.png" alt="" width="24" height="24"/><span style="color:${color}">${title}</span></span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    }),
    title,
  });
}

function finiteCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function placeHtml(name: string) {
  return name
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch))
    .join("<br>");
}

function placePoint(row: Record<string, unknown>): Point | null {
  const name = String(row.name || "");
  const labelX = row.label_x ?? row.labelX;
  const labelZ = row.label_z ?? row.labelZ;
  const x = finiteCoord(labelX) && finiteCoord(labelZ) ? labelX : row.x;
  const z = finiteCoord(labelX) && finiteCoord(labelZ) ? labelZ : row.z;
  const x2 = row.x2;
  const z2 = row.z2;
  const pointX = row.kind === "box" && finiteCoord(x) && finiteCoord(z) && finiteCoord(x2) && finiteCoord(z2) && !finiteCoord(labelX)
    ? (x + x2) / 2
    : x;
  const pointZ = row.kind === "box" && finiteCoord(x) && finiteCoord(z) && finiteCoord(x2) && finiteCoord(z2) && !finiteCoord(labelX)
    ? (z + z2) / 2
    : z;
  if (!finiteCoord(pointX) || !finiteCoord(pointZ)) return null;
  return {
    name,
    x: pointX,
    z: pointZ,
    y: finiteCoord(row.y) ? row.y : undefined,
    top: finiteCoord(row.top) ? row.top : undefined,
    bottom: finiteCoord(row.bottom) ? row.bottom : undefined,
  };
}

function label(point: Point, title: string) {
  if (!finiteCoord(point.x) || !finiteCoord(point.z) || !title) return null;
  return L.marker([point.z, point.x], {
    interactive: false,
    icon: L.divIcon({ className: "map-place", html: title, iconSize: [80, 16], iconAnchor: [40, 8] }),
  });
}

function add(key: string, marker: L.Marker | null, host: L.Map, point: Point) {
  if (!marker) return;
  let group = layers.get(key);
  if (!group) {
    group = L.layerGroup().addTo(host);
    layers.set(key, group);
  }
  marker.addTo(group);
  placed.push({ marker, point });
}

function applyFloorFade() {
  const bands = markerFloorBands(activeConfig);
  for (const item of placed) {
    const view = markerFloorDisplay(item.point, prefs.floor, bands);
    item.marker.setOpacity(view.opacity);
    item.marker.setZIndexOffset(view.zBoost);
  }
}

function extractKind(faction: string) {
  const key = faction.trim().toLowerCase();
  if (key.includes("transit") || key.includes("转")) return "transit";
  if (key === "shared" || key === "all" || key === "any" || key.includes("通用")) return "shared";
  if (key.includes("scav")) return "scav";
  return "pmc";
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

function showTile(path: string | undefined) {
  if (!map || !activeConfig) return;
  tileLayer?.remove();
  svgLayer?.remove();
  tileLayer = null;
  svgLayer = null;
  const bounds = boundsFor(activeConfig);
  if (!bounds) return;
  if (path) {
    tileLayer = L.tileLayer(path, {
      tileSize: activeConfig.tileSize || 256,
      bounds,
      maxZoom: Math.max(7, activeConfig.maxZoom ?? 5),
      maxNativeZoom: activeConfig.maxZoom ?? 5,
    }).addTo(map);
    return;
  }
  if (activeConfig.svgPath) {
    svgLayer = L.imageOverlay(activeConfig.svgPath, bounds).addTo(map);
  }
}

function applyRememberedBase() {
  if (!activeConfig) return;
  if (prefs.style === "svg" && activeConfig.svgPath) {
    showTile(undefined);
    return;
  }
  const floor = activeConfig.layers?.find((item) => item.name === prefs.floor && item.tilePath);
  showTile(floor?.tilePath || activeConfig.tilePath);
}

export function setMapStyle(style: "tile" | "svg") {
  prefs.style = style;
  savePrefs();
  applyRememberedBase();
}

export function setMapFloor(name: string) {
  prefs.floor = name;
  prefs.style = "tile";
  savePrefs();
  applyRememberedBase();
  applyFloorFade();
  paintQuests();
}

export function toggleFold(id: string) {
  const collapsed = prefs.collapsed.includes(id);
  prefs.collapsed = collapsed ? prefs.collapsed.filter((item) => item !== id) : [...prefs.collapsed, id];
  savePrefs();
  return !collapsed;
}

function applyLayer(key: string) {
  const group = layers.get(key);
  if (!map || !group) return;
  if (layerOn(key)) group.addTo(map);
  else group.remove();
  if (key === "tasks") {
    const labels = layers.get("quest-labels");
    if (!labels) return;
    if (layerOn(key)) labels.addTo(map);
    else labels.remove();
  }
}

export function setLayerVisible(key: string, on: boolean) {
  rememberLayer(key, on);
  applyLayer(key);
}

export function snapshotPrefs(): FilterPrefs {
  return { off: [...prefs.off], style: prefs.style, floor: prefs.floor, collapsed: [...prefs.collapsed] };
}

export function replacePrefs(next: Partial<FilterPrefs>) {
  prefs = {
    off: next.off || [],
    style: next.style === "svg" ? "svg" : "tile",
    floor: next.floor || "",
    collapsed: next.collapsed || [],
  };
  savePrefs();
  applyRememberedBase();
  for (const key of layers.keys()) applyLayer(key);
  applyFloorFade();
}

export function liveMapCamera(): { lat: number; lng: number; zoom: number } | null {
  if (!map) return null;
  const center = map.getCenter();
  return { lat: center.lat, lng: center.lng, zoom: map.getZoom() };
}

export function setLiveMapCamera(lat: number, lng: number, zoom: number) {
  map?.setView([lat, lng], zoom, { animate: false });
}

export function fitLiveMap() {
  if (!map || !activeConfig) return;
  const bounds = boundsFor(activeConfig);
  if (bounds) map.fitBounds(bounds);
}

export function watchLiveMapCamera(listener: () => void) {
  map?.on("moveend zoomend", listener);
}

export function invalidateLiveMap() {
  map?.invalidateSize();
}

export function destroyLiveMap() {
  token += 1;
  questToken += 1;
  window.clearTimeout(labelTimer);
  map?.remove();
  map = null;
  layers.clear();
  placed.length = 0;
  tileLayer = null;
  svgLayer = null;
  activeConfig = null;
  filterConfig = null;
  filterDetail = null;
  mapSlug = "";
  displayedQuests = [];
  highlightTaskId = "";
  questCache.clear();
  locateCursor = {};
}

export async function mountLiveMap(slug: string, fit = true) {
  const myToken = ++token;
  const config = findInteractive(slug);
  const host = document.querySelector<HTMLElement>("#map-root");
  const panel = document.querySelector("#filter-body");
  if (!config || !host || !boundsFor(config)) {
    if (panel) panel.innerHTML = "<p>这张图没有网站同款的交互地图。</p>";
    return;
  }
  activeConfig = config;
  const bounds = boundsFor(config)!;
  map = L.map(host, {
    crs: crsFor(config),
    zoomSnap: 0.1,
    attributionControl: false,
    zoomControl: false,
    minZoom: config.minZoom ?? 1,
    maxZoom: Math.max(7, config.maxZoom ?? 5),
  });
  if (fit) map.fitBounds(bounds);
  applyRememberedBase();
  if (myToken !== token) return;
  try {
    const detail = await invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/maps/${slug}?loot_loose=true&loot_containers=true` });
    if (myToken !== token || !map) return;
    mapSlug = slug;
    filterConfig = config;
    filterDetail = detail;
    ensureQuestGroups();
    paintMarkers(detail);
    for (const key of layers.keys()) applyLayer(key);
    paintFilters(config, detail);
    map.on("zoomend", () => {
      window.clearTimeout(labelTimer);
      labelTimer = window.setTimeout(paintQuestLabels, 80);
    });
    void reloadQuestGeometry();
  } catch (error) {
    if (panel) panel.textContent = error instanceof Error ? error.message : "地图数据读取失败";
  }
}

function paintMarkers(detail: Record<string, unknown>) {
  if (!map) return;
  const host = map;
  for (const row of (detail.extracts as Point[]) || []) {
    const kind = extractKind(String(row.faction || ""));
    add(`extracts:${kind}`, extractMarker(kind, String(row.name || "撤离点"), row), host, row);
  }
  for (const row of (detail.spawns as Point[]) || []) {
    const kind = String(row.kind || "pmc").toLowerCase();
    const key = kind === "sniper" ? "spawns:sniper" : kind === "scav" ? "spawns:scav" : "spawns:pmc";
    const file = kind === "sniper" ? "spawn_sniper_scav" : `spawn_${key.split(":")[1]}`;
    add(key, iconMarker(`${ICON}/${file}.png`, kind.toUpperCase(), row, kind === "pmc" ? [12, 24] : [12, 12]), host, row);
  }
  for (const boss of (detail.bosses as { name?: string; locations?: { positions?: Point[] }[] }[]) || []) {
    for (const location of boss.locations || []) {
      for (const point of location.positions || []) add("spawns:boss", iconMarker(`${ICON}/spawn_boss.png`, boss.name || "Boss", point), host, point);
    }
  }
  for (const row of Array.isArray(detail.places) ? detail.places : []) {
    if (!row || typeof row !== "object") continue;
    try {
      const point = placePoint(row as Record<string, unknown>);
      const html = placeHtml(String((row as { name?: unknown }).name || ""));
      if (!point || !html) continue;
      add("places", label(point, html), host, point);
    } catch {
      /* 单条标注数据不完整时跳过，避免整张图停掉 */
    }
  }
  for (const row of (detail.locks as Point[]) || []) add("locks", iconMarker(`${ICON}/lock.png`, String(row.name || "锁"), row), host, row);
  for (const row of (detail.stationary_weapons as Point[]) || []) add("stationary", iconMarker(`${ICON}/stationarygun.png`, String(row.name || "固定机枪"), row), host, row);
  for (const row of (detail.switches as Point[]) || []) add("switches", iconMarker(`${ICON}/switch.png`, String(row.name || "开关"), row), host, row);
  for (const row of (detail.btr_stops as Point[]) || []) add("btr", iconMarker(`${ICON}/btr_stop.png`, String(row.name || "BTR 停车点"), row), host, row);
  for (const row of (detail.hazards as { hazard_type?: string; name?: string; x?: number; z?: number }[]) || []) {
    const kind = String(row.hazard_type || "hazard");
    const file = kind === "mortar" ? "hazard_mortar" : "hazard";
    add(`hazards:${kind}`, iconMarker(`${ICON}/${file}.png`, hazardLabel(kind, row.name || ""), row), host, row);
  }
  for (const row of (detail.loot_containers as { normalized_name?: string; name?: string; x?: number; z?: number; y?: number; top?: number; bottom?: number }[]) || []) {
    const kind = containerKind(String(row.normalized_name || ""));
    add(`loot:${kind}`, iconMarker(containerIcon(kind), containerLabel(kind, row.name), row), host, row);
  }
  for (const row of (detail.loot_loose as LoosePile[]) || []) {
    const kind = looseKind(row);
    add(`loose:${kind}`, iconMarker(looseIcon(kind, row), "散落物", row), host, row);
  }
  applyFloorFade();
  paintQuests();
}

function hazardLabel(kind: string, name: string) {
  if (kind === "minefield") return "雷区";
  if (kind === "sniper") return "狙击";
  if (kind === "mortar") return "迫击炮";
  return name || "危险区";
}

const CONTAINER_FILES: Record<string, string> = {
  "bank-cash-register": "container_cash-register",
  "bank-safe": "container_safe",
  "buried-barrel-cache": "container_buried-barrel-cache",
  "cash-register": "container_cash-register",
  "dead-civilian": "container_dead-scav",
  "dead-scav": "container_dead-scav",
  "pmc-body": "container_dead-scav",
  "scav-body": "container_dead-scav",
  drawer: "container_drawer",
  "duffle-bag": "container_duffle-bag",
  "grenade-box": "container_grenade-box",
  "ground-cache": "container_ground-cache",
  jacket: "container_jacket",
  medbag: "container_medbag-smu06",
  "medbag-smu06": "container_medbag-smu06",
  medcase: "container_medcase",
  "pc-block": "container_pc-block",
  "plastic-suitcase": "container_plastic-suitcase",
  safe: "container_safe",
  toolbox: "container_toolbox",
  "weapon-box": "container_weapon-box",
  "wooden-ammo-box": "container_wooden-ammo-box",
  "wooden-crate": "container_wooden-crate",
};

const CONTAINER_LABELS: Record<string, string> = {
  "buried-barrel-cache": "埋藏桶",
  "cash-register": "收银机",
  "dead-scav": "死去的Scav",
  "pmc-body": "死去的Scav",
  drawer: "抽屉",
  "duffle-bag": "旅行包",
  "grenade-box": "手雷箱",
  "ground-cache": "地面藏匿处",
  jacket: "夹克",
  medbag: "SMU06医疗包",
  "medbag-smu06": "SMU06医疗包",
  medcase: "医药箱",
  "medical-supply-crate": "医疗物资箱",
  "pc-block": "电脑机箱",
  "ration-supply-crate": "配给物资箱",
  safe: "保险箱",
  "technical-supply-crate": "技术物资箱",
  toolbox: "工具箱",
  "weapon-box": "武器箱",
  "wooden-ammo-box": "木制弹药箱",
  "wooden-crate": "木制板条箱",
};

const LOOSE_ORDER = [
  "5b47574386f77428ca22b2f1",
  "5b5f6fa186f77409407a7eb7",
  "5b47574386f77428ca22b341",
  "5c518ed586f774119a772aee",
  "5b47574386f77428ca22b2ef",
  "5b47574386f77428ca22b2ed",
  "5b47574386f77428ca22b33a",
  "5b47574386f77428ca22b335",
  "5b47574386f77428ca22b2f4",
  "5b47574386f77428ca22b2f2",
  "5c518ec986f7743b68682ce2",
  "5b47574386f77428ca22b345",
  "5b47574386f77428ca22b2f3",
];

const LOOSE_LABELS: Record<string, string> = {
  "5b47574386f77428ca22b2f1": "贵重物品",
  "5b5f6fa186f77409407a7eb7": "容器",
  "5b47574386f77428ca22b341": "情报物品",
  "5c518ed586f774119a772aee": "电子钥匙",
  "5b47574386f77428ca22b2ef": "电子产品",
  "5b47574386f77428ca22b2ed": "能源物品",
  "5b47574386f77428ca22b33a": "注射器",
  "5b47574386f77428ca22b335": "饮品",
  "5b47574386f77428ca22b2f4": "其他",
  "5b47574386f77428ca22b2f2": "易燃物品",
  "5c518ec986f7743b68682ce2": "机械钥匙",
  "5b47574386f77428ca22b345": "特殊装备",
  "5b47574386f77428ca22b2f3": "医疗用品",
};

type LoosePile = Point & { items?: { handbook_ids?: string[] }[] };

function containerKind(name: string) {
  return name.trim() || "other";
}

function containerLabel(kind: string, name?: string) {
  return CONTAINER_LABELS[kind] || name || kind;
}

function containerIcon(name: string) {
  return `${ICON}/${CONTAINER_FILES[name] || "container_crate"}.png`;
}

function looseKind(row: LoosePile) {
  const ids = (row.items || []).flatMap((item) => item.handbook_ids || []);
  for (const id of LOOSE_ORDER) {
    if (ids.includes(id)) return id;
  }
  return "5b47574386f77428ca22b2f4";
}

function looseIcon(kind: string, row: LoosePile) {
  const kinds = new Set((row.items || []).flatMap((item) => item.handbook_ids || []).filter((id) => LOOSE_LABELS[id]));
  if (kinds.size > 1) return `${ICON}/loose_loot.png`;
  return `https://assets.tarkov.dev/handbook-category-${kind}-icon.webp`;
}

function extractColor(kind: string) {
  if (kind === "scav") return "#ff7800";
  if (kind === "shared") return "#00e4e5";
  if (kind === "transit") return "#e53500";
  return "#00e599";
}


function row(key: string, label: string, icon = "", child = false) {
  if (!layers.has(key)) return "";
  const image = icon ? `<img src="${icon}" alt="" />` : "";
  return `<label class="filter-row${child ? " filter-child" : ""}"><input type="checkbox" ${layerOn(key) ? "checked" : ""} data-layer="${key}" />${image}<span>${label}</span></label>`;
}

function group(id: string, title: string, icon: string, keys: string[], body: string) {
  const present = keys.filter((key) => layers.has(key));
  if (!body || !present.length) return "";
  const image = icon ? `<img src="${icon}" alt="" />` : "";
  const parentOn = present.every((key) => layerOn(key));
  const collapsed = prefs.collapsed.includes(id);
  return `<div class="filter-block"><div class="filter-head"><label class="filter-row"><input type="checkbox" ${parentOn ? "checked" : ""} data-group="${present.join(",")}" />${image}<span>${title}</span></label><button type="button" class="filter-fold" data-fold="${id}">${collapsed ? "＋" : "－"}</button></div><div class="filter-children" data-children="${id}" ${collapsed ? "hidden" : ""}>${body}</div></div>`;
}

function paintFilters(config: MapLayer, detail: Record<string, unknown>) {
  const panel = document.querySelector("#filter-body");
  if (!panel) return;
  const floors = (config.layers || []).filter((item) => item.tilePath);
  const floorNames: Record<string, string> = { "1st Floor": "1 层", "2nd Floor": "2 层", "3rd Floor": "3 层", "4th Floor": "4 层", "5th Floor": "5 层", Underground: "地下", Garage: "车库" };
  const floorOnMap = floors.some((floor) => floor.name === prefs.floor);
  const hazards = (detail.hazards as { hazard_type?: string }[]) || [];
  const hazardKinds = [...new Set(hazards.map((row) => String(row.hazard_type || "hazard")))];
  const containers = (detail.loot_containers as { normalized_name?: string }[]) || [];
  const containerKinds = [...new Set(containers.map((row) => containerKind(String(row.normalized_name || ""))))];
  const looseRows = (detail.loot_loose as LoosePile[]) || [];
  const looseKinds = LOOSE_ORDER.filter((kind) => looseRows.some((row) => looseKind(row) === kind));
  const html = [
    `<div class="filter-block"><p class="filter-title">底图样式</p>${config.tilePath ? `<label class="filter-row"><input type="radio" name="map-style" ${prefs.style !== "svg" ? "checked" : ""} data-style="tile" /><span>卫星图</span></label>` : ""}${config.svgPath ? `<label class="filter-row"><input type="radio" name="map-style" ${prefs.style === "svg" ? "checked" : ""} data-style="svg" /><span>抽象图</span></label>` : ""}</div>`,
    floors.length ? `<div class="filter-block"><p class="filter-title">层级</p><label class="filter-row"><input type="radio" name="map-floor" ${floorOnMap ? "" : "checked"} data-floor="" /><span>地面</span></label>${floors.map((floor) => `<label class="filter-row"><input type="radio" name="map-floor" ${prefs.floor === floor.name ? "checked" : ""} data-floor="${floor.name}" /><span>${floorNames[floor.name] || floor.name}</span></label>`).join("")}</div>` : "",
    row("places", "地名"),
    group("extracts", "撤离点", "", ["extracts:pmc", "extracts:scav", "extracts:shared", "extracts:transit"], [
      row("extracts:pmc", "PMC", `${ICON}/extract_pmc.png`, true),
      row("extracts:scav", "Scav", `${ICON}/extract_scav.png`, true),
      row("extracts:shared", "共享", `${ICON}/extract_shared.png`, true),
      row("extracts:transit", "转移点", `${ICON}/extract_transit.png`, true),
    ].join("")),
    group("spawns", "出生点", "", ["spawns:pmc", "spawns:scav", "spawns:sniper", "spawns:boss"], [
      row("spawns:pmc", "PMC", `${ICON}/spawn_pmc.png`, true),
      row("spawns:scav", "Scav", `${ICON}/spawn_scav.png`, true),
      row("spawns:sniper", "狙击 Scav", `${ICON}/spawn_sniper_scav.png`, true),
      row("spawns:boss", "Boss", `${ICON}/spawn_boss.png`, true),
    ].join("")),
    group("usable", "可使用", "", ["locks", "stationary", "switches", "btr"], [
      row("locks", "锁", `${ICON}/lock.png`, true),
      row("stationary", "固定机枪", `${ICON}/stationarygun.png`, true),
      row("switches", "开关", `${ICON}/switch.png`, true),
      row("btr", "BTR 停车点", `${ICON}/btr_stop.png`, true),
    ].join("")),
    group("hazards", "危险区", `${ICON}/hazard.png`, hazardKinds.map((kind) => `hazards:${kind}`), hazardKinds.map((kind) => row(`hazards:${kind}`, hazardLabel(kind, kind), `${ICON}/${kind === "mortar" ? "hazard_mortar" : "hazard"}.png`, true)).join("")),
    group("loot", "可搜刮物品", `${ICON}/container_crate.png`, containerKinds.map((kind) => `loot:${kind}`), containerKinds.map((kind) => row(`loot:${kind}`, containerLabel(kind), containerIcon(kind), true)).join("")),
    group("loose", "散落物", `${ICON}/loose_loot.png`, looseKinds.map((kind) => `loose:${kind}`), looseKinds.map((kind) => row(`loose:${kind}`, LOOSE_LABELS[kind] || "其他", `https://assets.tarkov.dev/handbook-category-${kind}-icon.webp`, true)).join("")),
    questFilterHtml(),
  ];
  panel.innerHTML = html.filter(Boolean).join("");
  const parent = panel.querySelector<HTMLInputElement>("[data-quest-parent]");
  if (parent) {
    const keys = questPeopleRows.map(personKey);
    const show = layerOn("tasks");
    const selected = keys.filter((key) => show && !questPersonOff.has(key));
    parent.indeterminate = show && selected.length > 0 && selected.length < keys.length;
  }
}

export type QuestRoomInput = {
  claims: { taskId: string; userId: number; name: string }[];
  dones: { taskId: string; objectiveId: string; userId: number }[];
  accountObjectives: { taskId: string; objectiveId: string }[];
  doneTaskIds: string[];
  selfUserId: number | null;
  selfName: string;
};

export function bindQuestActions(guide: (taskId: string) => void, toggle: (taskId: string, objectiveId: string, done: boolean) => void) {
  questGuide = guide;
  questToggle = toggle;
}

export function setQuestRoom(input: QuestRoomInput) {
  const byTask = new Map<string, QuestPerson[]>();
  const flat: QuestPerson[] = [];
  for (const claim of input.claims) {
    const person = { name: claim.name || `用户${claim.userId}`, userId: claim.userId };
    flat.push(person);
    const list = byTask.get(claim.taskId) || [];
    if (!list.some((item) => item.userId === person.userId)) list.push(person);
    byTask.set(claim.taskId, list);
  }
  const self = input.selfName.trim() || "我";
  questPeopleRows = questPeople(flat.length ? flat : [{ name: self, userId: input.selfUserId }]);
  if (!questPeopleRows.length) questPeopleRows = [{ name: self, userId: input.selfUserId ?? undefined }];
  questPeopleByTask = byTask;
  questDones = input.dones;
  questDoneTasks = new Set(input.doneTaskIds);
  questSelfId = input.selfUserId;
  const skipped = new Map<string, Set<string>>();
  for (const row of input.accountObjectives) {
    const taskId = row.taskId.trim();
    const objectiveId = row.objectiveId.trim();
    if (!taskId || !objectiveId) continue;
    const bucket = skipped.get(taskId) || new Set<string>();
    bucket.add(objectiveId);
    skipped.set(taskId, bucket);
  }
  if (input.selfUserId != null) {
    for (const row of input.dones) {
      if (row.userId !== input.selfUserId) continue;
      const bucket = skipped.get(row.taskId) || new Set<string>();
      bucket.add(row.objectiveId);
      skipped.set(row.taskId, bucket);
    }
  }
  questSkipped = skipped;
  if (!questPersonSeeded) {
    const off = defaultPersonOff(questPeopleRows, input.selfUserId);
    if (off) {
      questPersonOff = new Set(off);
      questPersonSeeded = true;
    }
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const claim of input.claims) {
    const id = claim.taskId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const same = ids.join("\0") === questClaimIds.join("\0");
  questClaimIds = ids;
  if (filterConfig && filterDetail) paintFilters(filterConfig, filterDetail);
  if (!same || ids.some((id) => !questCache.has(id))) void reloadQuestGeometry();
  else paintQuests();
}

let highlightWatch: ((taskId: string) => void) | null = null;

export function bindQuestHighlight(listener: (taskId: string) => void) {
  highlightWatch = listener;
}

export function questSwatch(taskId: string) {
  const index = questClaimIds.indexOf(taskId);
  return index < 0 ? "" : questColor(index);
}

export async function locateQuest(taskId: string) {
  const id = taskId.trim();
  if (!id) return;
  if (!questCache.has(id) && mapSlug) {
    const myToken = ++questToken;
    try {
      const detailed = await invoke<{ items?: QuestTask[] }>("site_get", {
        path: `/guides/tarkov/raid-prep?map=${encodeURIComponent(mapSlug)}&geometry=true&ids=${encodeURIComponent(id)}`,
      });
      if (myToken !== questToken) return;
      for (const item of detailed.items || []) {
        if (item?.id) questCache.set(item.id, item);
      }
    } catch {
      return;
    }
  }
  focusQuest(id);
}

export function focusQuest(taskId: string) {
  const id = taskId.trim();
  if (!id || !map) return;
  const task = questCache.get(id);
  if (!task) return;
  const skipped = questDoneTasks.has(id) ? new Set<string>(["*"]) : questSkipped.get(id) || new Set<string>();
  const points = questDoneTasks.has(id) ? [] : locateQuestPoints(task, mapSlug, skipped);
  if (!points.length) return;
  const index = locateCursor[id] || 0;
  const point = points[index % points.length]!;
  locateCursor[id] = index + 1;
  highlightTaskId = id;
  highlightWatch?.(id);
  const span = point.y == null ? null : { min: point.y, max: point.y };
  const bands = markerFloorBands(activeConfig);
  const floor = floorForSpan(span, bands, point);
  if (floor !== prefs.floor) setMapFloor(floor);
  const zoom = Math.max(map.getZoom(), Math.min(map.getMaxZoom(), (map.getMinZoom() || 1) + 1));
  map.flyTo([point.z, point.x], zoom, { duration: 0.35 });
  paintQuestLabels();
}

export function onQuestFilterClick(target: Element) {
  const label = target.closest("label");
  const person = label?.querySelector<HTMLInputElement>("[data-quest-person]") || target.closest<HTMLInputElement>("[data-quest-person]");
  const parent = label?.querySelector<HTMLInputElement>("[data-quest-parent]") || target.closest<HTMLInputElement>("[data-quest-parent]");
  if (!person && !parent) return false;
  const keys = questPeopleRows.map(personKey);
  if (parent) {
    const next = parentQuestSelection(keys, !parent.checked);
    rememberLayer("tasks", next.show);
    questPersonOff = new Set(next.off);
  } else if (person?.dataset.questPerson) {
    const next = personQuestSelection(keys, questPersonOff, layerOn("tasks"), person.dataset.questPerson);
    rememberLayer("tasks", next.show);
    questPersonOff = new Set(next.off);
  }
  applyLayer("tasks");
  if (filterConfig && filterDetail) paintFilters(filterConfig, filterDetail);
  paintQuests();
  return true;
}

function questFilterHtml() {
  const keys = questPeopleRows.map(personKey);
  const show = layerOn("tasks");
  const selected = keys.filter((key) => show && !questPersonOff.has(key));
  const parentOn = show && (!keys.length || selected.length === keys.length);
  const collapsed = prefs.collapsed.includes("tasks");
  const body = questPeopleRows.map((person) => {
    const key = personKey(person);
    const on = show && !questPersonOff.has(key);
    const mine = questSelfId != null && person.userId === questSelfId;
    return `<label class="filter-row filter-child"><input type="checkbox" ${on ? "checked" : ""} data-quest-person="${key}" /><span>${person.name}${mine ? "（你）" : ""}</span></label>`;
  }).join("");
  return `<div class="filter-block"><div class="filter-head"><label class="filter-row"><input type="checkbox" ${parentOn ? "checked" : ""} data-quest-parent="1" /><span>任务</span></label><button type="button" class="filter-fold" data-fold="tasks">${collapsed ? "＋" : "－"}</button></div><div class="filter-children" data-children="tasks" ${collapsed ? "hidden" : ""}>${body}</div></div>`;
}

function ensureQuestGroups() {
  if (!map) return;
  if (!layers.has("tasks")) layers.set("tasks", L.layerGroup());
  if (!layers.has("quest-labels")) layers.set("quest-labels", L.layerGroup());
}

function selectedQuestKeys() {
  if (!layerOn("tasks")) return new Set<string>();
  return new Set(questPeopleRows.map(personKey).filter((key) => !questPersonOff.has(key)));
}

async function reloadQuestGeometry() {
  const myToken = ++questToken;
  const slug = mapSlug;
  const ids = [...questClaimIds];
  const missing = ids.filter((id) => !questCache.has(id));
  try {
    for (let index = 0; index < missing.length; index += 40) {
      const chunk = missing.slice(index, index + 40);
      const detailed = await invoke<{ items?: QuestTask[] }>("site_get", {
        path: `/guides/tarkov/raid-prep?map=${encodeURIComponent(slug)}&geometry=true&ids=${encodeURIComponent(chunk.join(","))}`,
      });
      if (myToken !== questToken) return;
      for (const item of detailed.items || []) {
        if (item?.id) questCache.set(item.id, item);
      }
    }
  } catch {
    /* 几何失败时保留已有点 */
  }
  if (myToken !== questToken || slug !== mapSlug) return;
  paintQuests();
}

function visibleQuests() {
  const tasks = questClaimIds.map((id) => questCache.get(id)).filter((item): item is QuestTask => Boolean(item));
  const built = buildQuestOverlays(tasks, mapSlug);
  return filterQuestOverlays(built, {
    selectedKeys: selectedQuestKeys(),
    peopleByTask: questPeopleByTask,
    skipped: questSkipped,
    dones: questDones,
    doneTasks: questDoneTasks,
    selfUserId: questSelfId,
  });
}

function floorBands(): FloorBand[] {
  return markerFloorBands(activeConfig);
}

function questAt(row: QuestOverlay): QuestPoint | undefined {
  return row.points[0] || row.outline[0];
}

function bindQuestBubble(layer: L.Layer, row: QuestOverlay) {
  layer.bindTooltip(questBubbleHtml(row, [], questToggle ? "点击后可查看攻略，或标记 / 取消完成" : ""), { direction: "top", opacity: 1, sticky: true, className: "quest-tooltip" });
  layer.on("click", (event: L.LeafletMouseEvent) => {
    L.DomEvent.stopPropagation(event);
    const at = questAt(row);
    const nextFloor = floorForSpan(row.height, floorBands(), at);
    if (nextFloor !== prefs.floor) {
      setMapFloor(nextFloor);
      return;
    }
    const already = Boolean(row.objectiveId && (questDoneTasks.has(row.taskId) || questSkipped.get(row.taskId)?.has(row.objectiveId)));
    const actions = questActions(Boolean(questGuide), Boolean(questToggle), row.objectiveId, already || Boolean(row.done));
    if (!map) return;
    if (actions.length === 1 && actions[0]?.id === "guide") {
      questGuide?.(row.taskId);
      highlightTaskId = row.taskId;
      paintQuestLabels();
      return;
    }
    if (!actions.length) return;
    layer.closeTooltip();
    const popup = L.popup({ className: "quest-popup", closeButton: true, autoPan: true, maxWidth: 360, offset: L.point(0, -8) })
      .setLatLng(event.latlng)
      .setContent(questBubbleHtml(row, actions));
    popup.openOn(map);
    const root = popup.getElement();
    if (!root) return;
    L.DomEvent.disableClickPropagation(root);
    const onClick = (click: Event) => {
      const button = (click.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-quest-action]");
      const action = button?.dataset.questAction;
      if (action !== "guide" && action !== "complete" && action !== "uncomplete") return;
      L.DomEvent.stop(click);
      map?.closePopup(popup);
      if (action === "guide") questGuide?.(row.taskId);
      if ((action === "complete" || action === "uncomplete") && row.objectiveId) questToggle?.(row.taskId, row.objectiveId, action === "complete");
      highlightTaskId = row.taskId;
    };
    root.addEventListener("click", onClick);
    popup.once("remove", () => root.removeEventListener("click", onClick));
  });
}

function paintQuestShapes() {
  const group = layers.get("tasks");
  if (!group) return;
  group.clearLayers();
  for (const row of displayedQuests) {
    const at = questAt(row);
    const onFloor = spanOnFloor(row.height, prefs.floor, floorBands(), at);
    const fade = onFloor ? 1 : QUEST_OTHER_FLOOR;
    const dashed = row.optional || row.done;
    const paint = row.done ? "#8a8878" : row.color;
    if (row.outline.length >= 3) {
      const polygon = L.polygon(row.outline.map((point) => [point.z, point.x] as L.LatLngExpression), {
        color: paint,
        weight: 2,
        dashArray: dashed ? "5 4" : undefined,
        fillColor: paint,
        opacity: fade,
        fillOpacity: (row.optional ? 0.1 : 0.18) * fade,
        className: "quest-hit",
      });
      bindQuestBubble(polygon, row);
      polygon.addTo(group);
    }
    for (const point of row.points) {
      const marker = L.circleMarker([point.z, point.x], {
        radius: row.kind === "spawn" ? 5 : 7,
        color: "#111",
        weight: 1,
        dashArray: dashed ? "3 2" : undefined,
        fillColor: paint,
        opacity: fade,
        fillOpacity: (row.optional ? 0.55 : 0.92) * fade,
        className: "quest-hit",
      });
      bindQuestBubble(marker, row);
      marker.addTo(group);
    }
  }
}

function paintQuestLabels() {
  const group = layers.get("quest-labels");
  if (!group || !map || !(map as L.Map & { _loaded?: boolean })._loaded) return;
  group.clearLayers();
  const labels = clusterQuestLabels(displayedQuests, (point) => {
    const projected = map!.latLngToLayerPoint(L.latLng(point.z, point.x));
    return { x: projected.x, z: projected.y };
  });
  labels.forEach((label) => {
    label.items.forEach((item, index) => {
      const source = overlayForLabel(displayedQuests, item);
      const at = (source && questAt(source)) || { x: label.x, z: label.z };
      const offFloor = !spanOnFloor(item.height, prefs.floor, floorBands(), at);
      const done = Boolean(item.done || source?.done);
      const marker = L.marker([label.z, label.x], {
        icon: L.divIcon({
          className: "quest-icon",
          html: `<span class="quest-label-stack">${questLabelHtml(item, offFloor, done)}</span>`,
          iconSize: [1, 1],
          iconAnchor: [0, -index * 22],
        }),
        interactive: true,
        keyboard: false,
        bubblingMouseEvents: false,
      });
      if (source) bindQuestBubble(marker, { ...source, title: item.title, done });
      marker.on("add", () => {
        const node = marker.getElement();
        if (!node) return;
        for (const row of node.querySelectorAll<HTMLElement>("[data-task-id]")) {
          if (highlightTaskId && row.dataset.taskId === highlightTaskId) row.dataset.on = "true";
          else delete row.dataset.on;
        }
      });
      marker.addTo(group);
    });
  });
}

function paintQuests() {
  ensureQuestGroups();
  displayedQuests = visibleQuests();
  paintQuestShapes();
  paintQuestLabels();
  applyLayer("tasks");
}

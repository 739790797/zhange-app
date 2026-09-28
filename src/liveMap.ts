import L from "leaflet";
import "leaflet/dist/leaflet.css";
import rawMaps from "./data/tarkov-dev-maps.json";
import {
  adoptAccount,
  collapsedAppIds,
  copyAccount,
  currentAccount,
  ensureAccountFilters,
  floorForMap,
  layerVisible,
  noteArrivedLoot,
  onAccountApplied,
  setAccountFloor,
  setAccountLayer,
  setAccountStyle,
  toggleAccountCollapsed,
} from "./mapFilterAccount";
import { loadOwnedKeyIds } from "./keys";
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
  setOwnedQuestKeys,
  ownedKeyState,
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
  svgLayer?: string;
  svgBounds?: number[][];
  tilePath?: string;
  heightRange?: number[];
  normalizedName?: string;
  layers?: { name: string; show?: boolean; tilePath?: string; svgLayer?: string; extents?: { height?: number[]; bounds?: unknown }[] | null }[];
};

type MapGroup = { normalizedName: string; maps: MapLayer[] };

type Point = HeightPoint & { name?: string | null; kind?: string | null; faction?: string | null };
type MapPlace = {
  id: string;
  name: string;
  kind: string;
  x: number;
  z: number;
  x2?: number;
  z2?: number;
  labelX?: number;
  labelZ?: number;
  floor: string;
  y?: number;
  top?: number;
  bottom?: number;
};

const groups = rawMaps as MapGroup[];
const aliases: Record<string, string> = {
  lab: "the-lab",
  streets: "streets-of-tarkov",
  labyrinth: "the-labyrinth",
  "factory-night": "night-factory",
};

export type FilterPrefs = { off: string[]; style: "tile" | "svg"; floor: string; collapsed: string[] };

const prefsKey = "zhange.map.filters";

let prefs: FilterPrefs = {
  off: [],
  style: currentAccount().style,
  floor: "",
  collapsed: collapsedAppIds(),
};

function mapFilterKey() {
  return activeConfig?.key || "";
}

function applyAccountView() {
  const saved = currentAccount();
  prefs.style = saved.style;
  prefs.floor = floorForMap(mapFilterKey(), activeConfig?.layers);
  prefs.collapsed = collapsedAppIds();
  prefs.off = derivedOff();
}

function derivedOff() {
  const keys = new Set<string>(["places", "tasks", "locks", "stationary", "switches", "btr", "extracts:pmc", "extracts:scav", "extracts:shared", "extracts:transit", "spawns:pmc", "spawns:scav", "spawns:sniper", "spawns:boss"]);
  for (const key of layers.keys()) keys.add(key);
  return [...keys].filter((key) => !layerVisible(key));
}

function savePrefs() {
  applyAccountView();
  try {
    sessionStorage.setItem(prefsKey, JSON.stringify(prefs));
  } catch {
    /* 会话写不进时账号记录仍会上传 */
  }
}

function refreshFromAccount() {
  applyAccountView();
  applyRememberedBase();
  for (const key of layers.keys()) applyLayer(key);
  if (filterConfig && filterDetail) paintFilters(filterConfig, filterDetail);
}

onAccountApplied(refreshFromAccount);

function layerOn(key: string) {
  return layerVisible(key);
}

function rememberLayer(key: string, on: boolean) {
  setAccountLayer(key, on);
  savePrefs();
}

let map: L.Map | null = null;
let token = 0;
let mapSlug = "";
let placeRows: MapPlace[] = [];
let placeEditing = false;
let placeSelected = "";
let placeDraft = false;
let placeShape: "point" | "box" = "point";
let placeNote = "";
let placeSaving = false;
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
const placed: { marker: L.Layer; point: Point; key: string }[] = [];
const cullItems: { key: string; layer: L.Layer; bounds: L.LatLngBounds }[] = [];
const CULL_PAD = 0.8;
let cullQueued = false;
/** 与网页端 MAP_OFF_LEVEL_OPACITY 相同：不在当前高度时压暗地面，而不是整张换成楼层图。 */
const MAP_OFF_LEVEL_OPACITY = 0.4;
let tileLayer: L.TileLayer | null = null;
const floorTiles = new Map<string, L.TileLayer>();
let svgLayer: L.Layer | null = null;
let svgRoot: SVGSVGElement | null = null;
let svgLoad = 0;
let rasterTimer = 0;
let rasterToken = 0;
let rasterUrl = "";
let rasterBounds: L.LatLngBounds | null = null;
let rasterZoom = Number.NaN;
let rasterBroken = false;
let mapMotion = false;
const RASTER_PAD = 1;
const RASTER_MAX = 4096;
let activeConfig: MapLayer | null = null;

export type PlayerMark = {
  key: string;
  userId: number;
  name: string;
  color: string;
  x: number;
  y: number;
  z: number;
  yaw: number | null;
  self: boolean;
};

export type PulseLine = { x1: number; z1: number; x2: number; z2: number; color: string; opacity: number };

let playerGroup: L.LayerGroup | null = null;
const playerLayers = new Map<string, L.Marker>();
let playerMarks: PlayerMark[] = [];
let shotNote = "战局里按游戏截图键，位置会同步到房间";
let userDragging = false;
let playerHooked = false;
let mapReady: (() => void) | null = null;
let pulseLayer: L.LayerGroup | null = null;
let pulsePending: PulseLine[] = [];
const pulseEntries = new Map<string, { line: L.Polyline; opacity: number }>();
const playerIconSig = new Map<string, string>();

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

function latLngBounds(raw?: number[][]) {
  if (!raw || raw.length < 2) return null;
  const a = raw[0];
  const b = raw[1];
  if (!a || !b) return null;
  return L.latLngBounds([a[1], a[0]], [b[1], b[0]]);
}

function boundsFor(layer: MapLayer) {
  return latLngBounds(layer.bounds);
}

const ICON = "/tarkov/map-icons";

function iconMarker(url: string, title: string, point: Point, anchor: [number, number] = [12, 12], html = "") {
  if (point.x == null || point.z == null) return null;
  const marker = L.marker([point.z, point.x], {
    icon: L.icon({ iconUrl: url, iconSize: [24, 24], iconAnchor: anchor }),
    title,
  });
  if (html) marker.bindTooltip(html, { direction: "top", opacity: 1, className: "map-tip" });
  else marker.bindTooltip(title, { direction: "top" });
  return marker;
}

function extractMarker(kind: string, title: string, point: Point, popup = "") {
  if (point.x == null || point.z == null) return null;
  const color = extractColor(kind);
  const marker = L.marker([point.z, point.x], {
    icon: L.divIcon({
      className: "map-extract",
      html: `<span class="map-extract-row"><img src="${ICON}/extract_${kind}.png" alt="" width="24" height="24"/><span style="color:${color}">${title}</span></span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    }),
    title,
  });
  if (popup) marker.bindPopup(popup, { className: "map-popup", maxWidth: 320, autoPan: true });
  return marker;
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

function label(point: Point, title: string, editing = false) {
  if (!finiteCoord(point.x) || !finiteCoord(point.z) || !title) return null;
  return L.marker([point.z, point.x], {
    interactive: editing,
    draggable: editing,
    icon: L.divIcon({ className: `map-place${editing ? " editing" : ""}`, html: title, iconSize: [80, 16], iconAnchor: [40, 8] }),
  });
}

function cleanPlaceName(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n");
}

function readPlaces(value: unknown): MapPlace[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id || "").trim();
    const x = Number(row.x);
    const z = Number(row.z);
    if (!id || !Number.isFinite(x) || !Number.isFinite(z)) return [];
    const x2 = Number(row.x2);
    const z2 = Number(row.z2);
    const labelX = Number(row.label_x ?? row.labelX);
    const labelZ = Number(row.label_z ?? row.labelZ);
    return [{
      id,
      name: String(row.name || ""),
      kind: String(row.kind || "point"),
      x,
      z,
      x2: Number.isFinite(x2) ? x2 : undefined,
      z2: Number.isFinite(z2) ? z2 : undefined,
      labelX: Number.isFinite(labelX) ? labelX : undefined,
      labelZ: Number.isFinite(labelZ) ? labelZ : undefined,
      floor: String(row.floor || ""),
      y: finiteCoord(row.y) ? row.y : undefined,
      top: finiteCoord(row.top) ? row.top : undefined,
      bottom: finiteCoord(row.bottom) ? row.bottom : undefined,
    }];
  });
}

function placeAnchor(place: MapPlace): Point {
  const height = { y: place.y, top: place.top, bottom: place.bottom };
  if (place.labelX != null && place.labelZ != null) return { name: place.name, x: place.labelX, z: place.labelZ, ...height };
  if (place.kind === "box" && place.x2 != null && place.z2 != null) return { name: place.name, x: (place.x + place.x2) / 2, z: (place.z + place.z2) / 2, ...height };
  return { name: place.name, x: place.x, z: place.z, ...height };
}

function redrawPlaces() {
  if (!map) return;
  untrackCull("places");
  for (let index = placed.length - 1; index >= 0; index -= 1) {
    if (placed[index].key === "places") placed.splice(index, 1);
  }
  layers.get("places")?.clearLayers();
  for (const place of placeRows) {
    if (place.kind === "box" && place.x2 != null && place.z2 != null) {
      const selected = place.id === placeSelected;
      const rect = L.rectangle(L.latLngBounds([place.z, place.x], [place.z2, place.x2]), {
        color: selected ? "#e8b84a" : "#c8932a",
        weight: selected ? 2 : 1,
        fillColor: "#c8932a",
        fillOpacity: selected ? 0.18 : 0.08,
        interactive: placeEditing,
        className: "place-box",
      });
      if (placeEditing) {
        rect.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          placeSelected = place.id;
          placeDraft = false;
          placeNote = "";
          renderPlaceBar();
          redrawPlaces();
        });
      }
      add("places", rect, map, placeAnchor(place));
    }
    const point = placeAnchor(place);
    const html = placeHtml(place.name);
    if (!html) continue;
    const marker = label(point, html, placeEditing);
    if (!marker) continue;
    if (placeEditing) {
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        placeSelected = place.id;
        placeDraft = false;
        placeNote = "";
        renderPlaceBar();
        redrawPlaces();
      });
      marker.on("dragend", () => {
        const at = marker.getLatLng();
        void movePlace(place, at.lng, at.lat);
      });
    }
    add("places", marker, map, point);
    if (place.id === placeSelected) marker.on("add", () => marker.getElement()?.classList.add("on"));
  }
  applyFloorFade();
}

function selectedPlace() {
  return placeRows.find((place) => place.id === placeSelected) || null;
}

function renderPlaceBar() {
  const host = document.querySelector("#place-bar");
  if (!host) return;
  const place = selectedPlace();
  const editing = placeEditing;
  const form = editing && (place || (placeDraft && placeShape === "point") || draftBox) ? `<form id="place-form">
        <textarea name="name" rows="4" placeholder="地点名称，回车换行">${escPlayer(place?.name || "")}</textarea>
        <div>
          <button type="submit" ${placeSaving ? "disabled" : ""}>保存</button>
          ${place ? `<button type="button" data-place-delete ${placeSaving ? "disabled" : ""}>删除</button>` : ""}
        </div>
      </form>` : "";
  const note = placeNote ? `<p>${escPlayer(placeNote)}</p>` : "";
  host.innerHTML = form || note ? `<div class="place-bar">${note}${form}</div>` : "";
  host.querySelector("#place-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = host.querySelector<HTMLTextAreaElement>("[name=name]");
    void savePlace(input?.value || "");
  });
  host.querySelector("[data-place-delete]")?.addEventListener("click", () => {
    void deletePlace();
  });
}

async function savePlace(rawName: string) {
  const name = cleanPlaceName(rawName);
  if (!name) {
    placeNote = "请填写地点名称";
    renderPlaceBar();
    return;
  }
  if (!mapSlug) return;
  placeSaving = true;
  placeNote = "正在保存…";
  renderPlaceBar();
  try {
    const current = selectedPlace();
    if (current) {
      const saved = await invoke<Record<string, unknown>>("site_patch", {
        path: `/guides/tarkov/maps/${encodeURIComponent(mapSlug)}/places/${encodeURIComponent(current.id)}`,
        body: { name, floor: current.floor || prefs.floor },
      });
      const next = adoptPlace(saved, { ...current, name });
      placeRows = placeRows.map((place) => place.id === current.id ? next : place);
      placeNote = "已保存";
    } else if (placeDraft && placeShape === "box") {
      if (!draftBox) {
        placeNote = "先在地图上拖出区域";
        return;
      }
      const box = draftBox;
      const saved = await invoke<Record<string, unknown>>("site_post", {
        path: `/guides/tarkov/maps/${encodeURIComponent(mapSlug)}/places`,
        body: { kind: "box", name, x: box.x, z: box.z, x2: box.x2, z2: box.z2, floor: prefs.floor },
      });
      const next = adoptPlace(saved, { id: "", name, kind: "box", x: box.x, z: box.z, x2: box.x2, z2: box.z2, floor: prefs.floor });
      if (next.id) placeRows = [...placeRows, next];
      placeSelected = next.id;
      stopPlaceDraft();
      placeNote = next.id ? "已保存" : "已提交，但没有返回地点编号";
    } else if (placeDraft && draftPoint) {
      const saved = await invoke<Record<string, unknown>>("site_post", {
        path: `/guides/tarkov/maps/${encodeURIComponent(mapSlug)}/places`,
        body: { kind: "point", name, x: draftPoint.x, z: draftPoint.z, floor: prefs.floor },
      });
      const next = adoptPlace(saved, { id: "", name, kind: "point", x: draftPoint.x, z: draftPoint.z, floor: prefs.floor });
      if (next.id) placeRows = [...placeRows, next];
      placeSelected = next.id;
      placeDraft = false;
      draftPoint = null;
      placeNote = next.id ? "已保存" : "已提交，但没有返回地点编号";
    }
  } catch (error) {
    placeNote = error instanceof Error ? error.message : "保存地点失败";
  } finally {
    placeSaving = false;
    renderPlaceBar();
    redrawPlaces();
  }
}

let draftPoint: { x: number; z: number } | null = null;
let draftBox: { x: number; z: number; x2: number; z2: number } | null = null;
let draftRect: L.Rectangle | null = null;
let boxDrag: { x: number; z: number } | null = null;
let boxListen = false;

function clearDraftRect() {
  draftRect?.remove();
  draftRect = null;
}

function showDraftRect(box: { x: number; z: number; x2: number; z2: number }) {
  if (!map) return;
  const bounds = L.latLngBounds([box.z, box.x], [box.z2, box.x2]);
  if (draftRect) draftRect.setBounds(bounds);
  else draftRect = L.rectangle(bounds, { color: "#e8b84a", weight: 1, fillColor: "#c8932a", fillOpacity: 0.12, interactive: false }).addTo(map);
}

function stopPlaceDraft() {
  placeDraft = false;
  placeShape = "point";
  draftPoint = null;
  draftBox = null;
  boxDrag = null;
  clearDraftRect();
  map?.dragging.enable();
}

function onBoxPointerDown(event: PointerEvent) {
  if (!map || !placeEditing || !placeDraft || placeShape !== "box" || boxDrag) return;
  const target = event.target;
  if (target instanceof Element && target.closest(".leaflet-marker-icon, .leaflet-popup, .leaflet-control, .place-box")) return;
  const start = map.mouseEventToLatLng(event);
  boxDrag = { x: start.lng, z: start.lat };
  map.dragging.disable();
  event.preventDefault();
  event.stopPropagation();
}

function onBoxPointerMove(event: PointerEvent) {
  if (!map || !boxDrag) return;
  const at = map.mouseEventToLatLng(event);
  showDraftRect({ x: boxDrag.x, z: boxDrag.z, x2: at.lng, z2: at.lat });
}

function onBoxPointerUp(event: PointerEvent) {
  if (!map || !boxDrag) return;
  const start = boxDrag;
  const at = map.mouseEventToLatLng(event);
  boxDrag = null;
  map.dragging.enable();
  const box = { x: start.x, z: start.z, x2: at.lng, z2: at.lat };
  if (Math.abs(box.x2 - box.x) < 0.5 || Math.abs(box.z2 - box.z) < 0.5) {
    clearDraftRect();
    draftBox = null;
    placeNote = "区域太小，再拖一次。";
    renderPlaceBar();
    return;
  }
  draftBox = box;
  draftPoint = null;
  placeSelected = "";
  showDraftRect(box);
  placeNote = "填写名称后保存。回车会换行。";
  renderPlaceBar();
}

function bindBoxDraw() {
  if (!map || boxListen) return;
  const container = map.getContainer();
  container.addEventListener("pointerdown", onBoxPointerDown, true);
  container.addEventListener("pointermove", onBoxPointerMove, true);
  window.addEventListener("pointerup", onBoxPointerUp, true);
  window.addEventListener("pointercancel", onBoxPointerUp, true);
  boxListen = true;
}

function unbindBoxDraw() {
  if (!boxListen) return;
  const container = map?.getContainer();
  container?.removeEventListener("pointerdown", onBoxPointerDown, true);
  container?.removeEventListener("pointermove", onBoxPointerMove, true);
  window.removeEventListener("pointerup", onBoxPointerUp, true);
  window.removeEventListener("pointercancel", onBoxPointerUp, true);
  boxListen = false;
  boxDrag = null;
}

function adoptPlace(saved: Record<string, unknown>, fallback: MapPlace): MapPlace {
  const row = (saved.place && typeof saved.place === "object" ? saved.place : saved) as Record<string, unknown>;
  const parsed = readPlaces([row])[0];
  return parsed ? { ...fallback, ...parsed, name: parsed.name || fallback.name } : { ...fallback, id: String(row.id || fallback.id) };
}

async function movePlace(place: MapPlace, x: number, z: number) {
  const body = place.kind === "box" ? { label_x: x, label_z: z } : { x, z };
  try {
    const saved = await invoke<Record<string, unknown>>("site_patch", {
      path: `/guides/tarkov/maps/${encodeURIComponent(mapSlug)}/places/${encodeURIComponent(place.id)}`,
      body,
    });
    const next = adoptPlace(saved, place.kind === "box" ? { ...place, labelX: x, labelZ: z } : { ...place, x, z });
    placeRows = placeRows.map((item) => item.id === place.id ? next : item);
    placeNote = "位置已保存";
  } catch (error) {
    placeNote = error instanceof Error ? error.message : "更新地点失败";
  }
  renderPlaceBar();
  redrawPlaces();
}

async function deletePlace() {
  const place = selectedPlace();
  if (!place || !mapSlug) return;
  placeSaving = true;
  placeNote = "正在删除…";
  renderPlaceBar();
  try {
    await invoke("site_delete", { path: `/guides/tarkov/maps/${encodeURIComponent(mapSlug)}/places/${encodeURIComponent(place.id)}` });
    placeRows = placeRows.filter((item) => item.id !== place.id);
    placeSelected = "";
    placeNote = "已删除";
  } catch (error) {
    placeNote = error instanceof Error ? error.message : "删除地点失败";
  } finally {
    placeSaving = false;
    renderPlaceBar();
    redrawPlaces();
  }
}

function onPlaceMapClick(event: L.LeafletMouseEvent) {
  if (!placeEditing || !placeDraft || placeShape !== "point") return;
  const target = event.originalEvent.target;
  if (target instanceof Element && target.closest(".leaflet-marker-icon, .leaflet-popup")) return;
  draftPoint = { x: event.latlng.lng, z: event.latlng.lat };
  placeSelected = "";
  placeNote = "填写名称后保存。回车会换行。";
  renderPlaceBar();
}

function layerBounds(layer: L.Layer, point: Point) {
  if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
    const at = layer.getLatLng();
    return L.latLngBounds(at, at);
  }
  if (layer instanceof L.Polyline) {
    const bounds = layer.getBounds();
    if (bounds.isValid()) return bounds;
  }
  const at = L.latLng(point.z ?? 0, point.x ?? 0);
  return L.latLngBounds(at, at);
}

function untrackCull(key: string) {
  for (let index = cullItems.length - 1; index >= 0; index -= 1) {
    if (cullItems[index].key === key) cullItems.splice(index, 1);
  }
}

function trackCull(key: string, layer: L.Layer, bounds: L.LatLngBounds) {
  cullItems.push({ key, layer, bounds });
  scheduleCull();
}

function scheduleCull() {
  if (!map || cullQueued) return;
  cullQueued = true;
  queueMicrotask(() => {
    cullQueued = false;
    syncCulling();
  });
}

function syncCulling() {
  if (!map || !(map as L.Map & { _loaded?: boolean })._loaded) return;
  const view = map.getBounds().pad(CULL_PAD);
  for (const item of cullItems) {
    const group = layers.get(item.key);
    if (!group) continue;
    const show = map.hasLayer(group) && view.intersects(item.bounds);
    const mounted = group.hasLayer(item.layer);
    if (show && !mounted) item.layer.addTo(group);
    else if (!show && mounted) group.removeLayer(item.layer);
  }
}

function add(key: string, marker: L.Layer | null, host: L.Map, point: Point) {
  if (!marker || host !== map) return;
  let group = layers.get(key);
  if (!group) {
    group = L.layerGroup();
    layers.set(key, group);
  }
  placed.push({ marker, point, key });
  trackCull(key, marker, layerBounds(marker, point));
}

function applyFloorFade() {
  const bands = markerFloorBands(activeConfig);
  for (const item of placed) {
    const view = markerFloorDisplay(item.point, prefs.floor, bands);
    if (item.marker instanceof L.Marker) {
      item.marker.setOpacity(view.opacity);
      item.marker.setZIndexOffset(view.zBoost);
    } else if (item.marker instanceof L.Path) {
      item.marker.setStyle({ opacity: view.opacity, fillOpacity: view.opacity * 0.16 });
    }
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

function mapBaseOffLevel(selectedFloorId: string, keepBaseOpaque: boolean) {
  return Boolean(selectedFloorId) && !keepBaseOpaque;
}

function isSvgBaseFloorGroup(id: string, keepWith: string | undefined, baseId: string) {
  if (!id || !baseId) return false;
  return id === baseId || keepWith === baseId;
}

function setSvgFloor(root: SVGSVGElement | undefined, baseId: string, floorId: string, keepBaseOpaque: boolean) {
  const inner = root?.children[0];
  if (!root || !inner) return;
  root.classList.toggle("off-level", mapBaseOffLevel(floorId, keepBaseOpaque));
  for (const child of Array.from(inner.children)) {
    if (child.nodeName.toLowerCase() !== "g") continue;
    const group = child as SVGGElement;
    if (!group.id) continue;
    const base = isSvgBaseFloorGroup(group.id, group.dataset.keepWithGroup, baseId);
    group.classList.toggle("base-layer", base);
    group.classList.toggle("overlay-layer", !base);
    group.classList.toggle("hidden-layer", base ? false : group.id !== floorId);
  }
}

function svgFallbackUrl(svgPath: string) {
  const file = svgPath.split("/").pop() || "";
  if (!file) return svgPath;
  return `https://raw.githubusercontent.com/the-hideout/tarkov-dev-svg-maps/refs/heads/main/${file}`;
}

async function loadSvgElement(svgPath: string) {
  const urls = [svgPath, svgFallbackUrl(svgPath)];
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      const holder = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      holder.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      holder.innerHTML = text;
      const inner = holder.children[0];
      if (inner?.getAttribute("viewBox")) holder.setAttribute("viewBox", inner.getAttribute("viewBox") || "");
      return holder;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法加载 SVG 地图");
}

function ensureFloorTiles() {
  if (!activeConfig) return;
  const bounds = boundsFor(activeConfig);
  if (!bounds) return;
  const tileSize = activeConfig.tileSize || 256;
  const maxZoom = Math.max(7, activeConfig.maxZoom ?? 5);
  const nativeZoom = activeConfig.maxZoom ?? 5;
  const tileOptions = {
    tileSize,
    bounds,
    maxZoom,
    maxNativeZoom: nativeZoom,
    updateWhenIdle: true,
  };
  if (!tileLayer && activeConfig.tilePath) {
    tileLayer = L.tileLayer(activeConfig.tilePath, { ...tileOptions, zIndex: 1 });
  }
  for (const floor of activeConfig.layers || []) {
    if (!floor.tilePath || floorTiles.has(floor.name)) continue;
    floorTiles.set(floor.name, L.tileLayer(floor.tilePath, { ...tileOptions, zIndex: 2 }));
  }
}

function showTiles(keepBaseOpaque: boolean) {
  if (!map || !activeConfig) return;
  window.clearTimeout(rasterTimer);
  rasterToken += 1;
  svgLayer?.remove();
  svgLayer = null;
  releaseRasterUrl();
  invalidateRaster();
  ensureFloorTiles();
  if (tileLayer) {
    tileLayer.addTo(map);
    tileLayer.setOpacity(mapBaseOffLevel(prefs.floor, keepBaseOpaque) ? MAP_OFF_LEVEL_OPACITY : 1);
  }
  for (const [name, tile] of floorTiles) {
    if (name === prefs.floor) tile.addTo(map);
    else tile.remove();
  }
}

type ViewBox = { x: number; y: number; width: number; height: number };

function usingSvgBase() {
  if (!svgRoot || rasterBroken || !activeConfig?.svgPath) return false;
  return prefs.style === "svg" || !activeConfig.tilePath;
}

function releaseRasterUrl() {
  if (!rasterUrl) return;
  URL.revokeObjectURL(rasterUrl);
  rasterUrl = "";
}

function invalidateRaster() {
  rasterBounds = null;
  rasterZoom = Number.NaN;
}

function boundsClose(a: L.LatLngBounds, b: L.LatLngBounds) {
  return Math.abs(a.getSouth() - b.getSouth()) < 1e-3
    && Math.abs(a.getNorth() - b.getNorth()) < 1e-3
    && Math.abs(a.getWest() - b.getWest()) < 1e-3
    && Math.abs(a.getEast() - b.getEast()) < 1e-3;
}

function intersectBounds(view: L.LatLngBounds, limit: L.LatLngBounds) {
  const south = Math.max(view.getSouth(), limit.getSouth());
  const north = Math.min(view.getNorth(), limit.getNorth());
  const west = Math.max(view.getWest(), limit.getWest());
  const east = Math.min(view.getEast(), limit.getEast());
  if (south > north || west > east) return null;
  return L.latLngBounds([south, west], [north, east]);
}

function paddedViewBounds() {
  if (!map) return null;
  const size = map.getSize();
  if (size.x < 2 || size.y < 2) return null;
  const nw = map.containerPointToLatLng(L.point(-size.x * RASTER_PAD, -size.y * RASTER_PAD));
  const se = map.containerPointToLatLng(L.point(size.x * (1 + RASTER_PAD), size.y * (1 + RASTER_PAD)));
  return L.latLngBounds(nw, se);
}

function readViewBox(svg: SVGSVGElement): ViewBox | null {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { x: box.x, y: box.y, width: box.width, height: box.height };
  const parts = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function svgGraphic(root: SVGSVGElement) {
  const inner = root.children[0];
  const node = inner instanceof SVGSVGElement ? inner : root;
  const box = readViewBox(node) || (node !== root ? readViewBox(root) : null);
  return box ? { node, box } : null;
}

function bakeSvgStyles(svg: SVGSVGElement, offLevel: boolean) {
  for (const node of svg.querySelectorAll("g.hidden-layer")) node.setAttribute("display", "none");
  if (!offLevel) return;
  for (const node of svg.querySelectorAll("g.base-layer")) node.setAttribute("opacity", String(MAP_OFF_LEVEL_OPACITY));
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("地图栅格化失败"));
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    const fail = () => reject(new Error("地图栅格化失败"));
    try {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        try {
          canvas.toBlob((png) => (png ? resolve(png) : fail()), "image/png");
        } catch (error) {
          reject(error instanceof Error ? error : new Error("地图栅格化失败"));
        }
      }, "image/webp", 0.92);
    } catch (error) {
      reject(error instanceof Error ? error : new Error("地图栅格化失败"));
    }
  });
}

async function drawSvgSlice(graphic: SVGSVGElement, box: ViewBox, full: L.LatLngBounds, target: L.LatLngBounds, offLevel: boolean) {
  if (!map) return null;
  const fullNw = map.latLngToLayerPoint(full.getNorthWest());
  const fullSe = map.latLngToLayerPoint(full.getSouthEast());
  const originX = Math.min(fullNw.x, fullSe.x);
  const originY = Math.min(fullNw.y, fullSe.y);
  const fullW = Math.abs(fullSe.x - fullNw.x);
  const fullH = Math.abs(fullSe.y - fullNw.y);
  const viewNw = map.latLngToLayerPoint(target.getNorthWest());
  const viewSe = map.latLngToLayerPoint(target.getSouthEast());
  const viewX = Math.min(viewNw.x, viewSe.x);
  const viewY = Math.min(viewNw.y, viewSe.y);
  const viewW = Math.abs(viewSe.x - viewNw.x);
  const viewH = Math.abs(viewSe.y - viewNw.y);
  if (fullW < 1 || fullH < 1 || viewW < 1 || viewH < 1) return null;
  const crop = {
    x: box.x + ((viewX - originX) / fullW) * box.width,
    y: box.y + ((viewY - originY) / fullH) * box.height,
    width: (viewW / fullW) * box.width,
    height: (viewH / fullH) * box.height,
  };
  if (crop.width <= 0 || crop.height <= 0) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const limit = Math.min(1, RASTER_MAX / Math.ceil(viewW * dpr), RASTER_MAX / Math.ceil(viewH * dpr));
  const width = Math.max(1, Math.floor(viewW * dpr * limit));
  const height = Math.max(1, Math.floor(viewH * dpr * limit));
  const clone = graphic.cloneNode(true) as SVGSVGElement;
  bakeSvgStyles(clone, offLevel);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", `${crop.x} ${crop.y} ${crop.width} ${crop.height}`);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("preserveAspectRatio", "none");
  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function useVectorSvg(bounds: L.LatLngBounds) {
  if (!map || !svgRoot) return;
  if (svgLayer && map.hasLayer(svgLayer) && svgLayer instanceof L.SVGOverlay) return;
  svgLayer?.remove();
  releaseRasterUrl();
  invalidateRaster();
  svgLayer = L.svgOverlay(svgRoot, bounds, { interactive: false }).addTo(map);
}

function mountRaster(url: string, bounds: L.LatLngBounds, zoom: number, token: number) {
  if (!map || token !== rasterToken) {
    URL.revokeObjectURL(url);
    return;
  }
  const overlay = L.imageOverlay(url, bounds, { interactive: false, pane: "tilePane", zIndex: 1 });
  const previous = svgLayer;
  const previousUrl = rasterUrl;
  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    if (token !== rasterToken || !map) {
      overlay.remove();
      URL.revokeObjectURL(url);
      return;
    }
    if (previous && previous !== overlay) previous.remove();
    if (previousUrl && previousUrl !== url) URL.revokeObjectURL(previousUrl);
    svgLayer = overlay;
    rasterUrl = url;
    rasterBounds = bounds;
    rasterZoom = zoom;
  };
  overlay.once("load", commit);
  overlay.once("error", () => {
    if (settled) return;
    settled = true;
    overlay.remove();
    URL.revokeObjectURL(url);
    if (token !== rasterToken || !map || !activeConfig) return;
    rasterBroken = true;
    const full = latLngBounds(activeConfig.svgBounds) || boundsFor(activeConfig);
    if (full) useVectorSvg(full);
  });
  overlay.addTo(map);
}

function scheduleRaster() {
  if (!usingSvgBase()) return;
  window.clearTimeout(rasterTimer);
  rasterTimer = window.setTimeout(() => { void rasterizeBase(); }, 80);
}

function hookMapMotion() {
  if (!map || mapMotion) return;
  mapMotion = true;
  map.on("moveend", () => {
    scheduleCull();
    scheduleRaster();
  });
}

async function rasterizeBase() {
  const config = activeConfig;
  if (!map || !svgRoot || !config || !usingSvgBase()) return;
  const full = latLngBounds(config.svgBounds) || boundsFor(config);
  const padded = paddedViewBounds();
  if (!full || !padded) return;
  const target = intersectBounds(padded, full) ?? full;
  const zoom = map.getZoom();
  const view = map.getBounds();
  if (rasterBounds && rasterZoom === zoom && (rasterBounds.contains(view) || boundsClose(rasterBounds, target))) return;
  const graphic = svgGraphic(svgRoot);
  if (!graphic) {
    rasterBroken = true;
    useVectorSvg(full);
    return;
  }
  const token = ++rasterToken;
  const offLevel = svgRoot.classList.contains("off-level");
  try {
    const canvas = await drawSvgSlice(graphic.node, graphic.box, full, target, offLevel);
    if (token !== rasterToken || !map || !usingSvgBase()) return;
    if (!canvas) throw new Error("地图栅格化失败");
    const blob = await canvasToBlob(canvas);
    if (token !== rasterToken || !map || !usingSvgBase()) return;
    mountRaster(URL.createObjectURL(blob), target, zoom, token);
  } catch {
    if (token !== rasterToken || !map || !usingSvgBase()) return;
    rasterBroken = true;
    useVectorSvg(full);
  }
}

async function showSvg(floorId: string, keepBaseOpaque: boolean) {
  if (!map || !activeConfig?.svgPath) return;
  const bounds = latLngBounds(activeConfig.svgBounds) || boundsFor(activeConfig);
  if (!bounds) return;
  const generation = ++svgLoad;
  rasterToken += 1;
  const path = activeConfig.svgPath;
  const baseId = activeConfig.svgLayer || "";
  tileLayer?.remove();
  for (const tile of floorTiles.values()) tile.remove();
  if (!svgRoot) {
    try {
      svgRoot = await loadSvgElement(path);
    } catch {
      if (generation !== svgLoad || !map) return;
      svgLayer?.remove();
      svgLayer = L.imageOverlay(path, bounds, { interactive: false, pane: "tilePane" }).addTo(map);
      return;
    }
    if (generation !== svgLoad || !map) return;
  }
  if (!svgRoot || generation !== svgLoad) return;
  setSvgFloor(svgRoot, baseId, floorId, keepBaseOpaque);
  if (rasterBroken) {
    useVectorSvg(bounds);
    return;
  }
  invalidateRaster();
  scheduleRaster();
}

function applyRememberedBase() {
  if (!map || !activeConfig) return;
  const floorLayer = activeConfig.layers?.find((item) => item.name === prefs.floor);
  const keepBaseOpaque = floorLayer?.show === true;
  const useSvg = Boolean(activeConfig.svgPath) && (prefs.style === "svg" || !activeConfig.tilePath);
  if (useSvg) {
    void showSvg(floorLayer?.svgLayer || "", keepBaseOpaque);
    return;
  }
  svgLoad += 1;
  showTiles(keepBaseOpaque);
}

export function setMapStyle(style: "tile" | "svg") {
  setAccountStyle(style);
  savePrefs();
  applyRememberedBase();
}

let floorApply = false;

export function setMapFloor(name: string) {
  if (floorApply) return;
  floorApply = true;
  try {
    setAccountFloor(mapFilterKey(), name);
    savePrefs();
    applyRememberedBase();
    applyFloorFade();
    paintQuests();
    drawPlayers(false);
  } finally {
    floorApply = false;
  }
}

export function toggleFold(id: string) {
  const collapsed = toggleAccountCollapsed(id);
  savePrefs();
  return collapsed;
}

function applyLayer(key: string) {
  const group = layers.get(key);
  if (!map || !group) return;
  if (layerOn(key)) group.addTo(map);
  else group.remove();
  if (key === "tasks") {
    const labels = layers.get("quest-labels");
    if (labels) {
      if (layerOn(key)) labels.addTo(map);
      else labels.remove();
    }
  }
  scheduleCull();
}

export function setLayerVisible(key: string, on: boolean) {
  rememberLayer(key, on);
  applyLayer(key);
}

export function snapshotPrefs(): FilterPrefs {
  applyAccountView();
  return { off: [...prefs.off], style: prefs.style, floor: prefs.floor, collapsed: [...prefs.collapsed] };
}

export function snapshotAccount() {
  return copyAccount();
}

export function replacePrefs(next: Partial<FilterPrefs>) {
  const merged = copyAccount();
  if (next.style === "svg" || next.style === "tile") merged.style = next.style;
  const key = mapFilterKey();
  if (key && typeof next.floor === "string") merged.floorsByMap[key] = next.floor;
  adoptAccount(merged);
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

export function onLiveMapReady(listener: () => void) {
  mapReady = listener;
}

export function currentMapSlug() {
  return mapSlug;
}

export function setShotNote(text: string) {
  shotNote = text;
  const node = document.querySelector("#shot-note");
  if (node) node.textContent = text;
}

export function setPlayerMarks(marks: PlayerMark[], follow: false | "fly" | "pan" = false) {
  playerMarks = marks;
  drawPlayers(follow);
}

function pulseKey(line: PulseLine) {
  return `${line.x1}:${line.z1}:${line.x2}:${line.z2}:${line.color}`;
}

function applyPulses() {
  if (!map) return;
  if (!pulseLayer) pulseLayer = L.layerGroup().addTo(map);
  const next = new Map<string, PulseLine>();
  for (const line of pulsePending) {
    if (line.opacity <= 0) continue;
    next.set(pulseKey(line), line);
  }
  for (const [key, entry] of pulseEntries) {
    const line = next.get(key);
    if (!line) {
      pulseLayer.removeLayer(entry.line);
      pulseEntries.delete(key);
      continue;
    }
    if (Math.abs(entry.opacity - line.opacity) > 0.015) {
      entry.line.setStyle({ opacity: line.opacity });
      entry.opacity = line.opacity;
    }
  }
  for (const [key, line] of next) {
    if (pulseEntries.has(key)) continue;
    const drawn = L.polyline([[line.z1, line.x1], [line.z2, line.x2]], {
      color: line.color,
      weight: 2,
      opacity: line.opacity,
      interactive: false,
    }).addTo(pulseLayer);
    pulseEntries.set(key, { line: drawn, opacity: line.opacity });
  }
}

export function setPulseLines(lines: PulseLine[]) {
  pulsePending = lines;
  if (!map || userDragging) return;
  applyPulses();
}

function hookPlayers() {
  if (!map || playerHooked) return;
  playerHooked = true;
  map.on("zoomend", () => drawPlayers(false));
  map.on("dragstart", () => { userDragging = true; });
  map.on("dragend", () => {
    userDragging = false;
    applyPulses();
  });
}

function headingDeg(x: number, z: number, yaw: number) {
  if (!map) return null;
  const rad = (yaw * Math.PI) / 180;
  const from = map.latLngToLayerPoint(L.latLng(z, x));
  const to = map.latLngToLayerPoint(L.latLng(z + Math.cos(rad), x + Math.sin(rad)));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!dx && !dy) return null;
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

function escPlayer(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function drawPlayers(follow: false | "fly" | "pan") {
  if (!map) return;
  hookPlayers();
  if (!playerGroup) playerGroup = L.layerGroup().addTo(map);
  const keep = new Set(playerMarks.map((mark) => mark.key));
  for (const [key, marker] of [...playerLayers]) {
    if (keep.has(key)) continue;
    playerGroup.removeLayer(marker);
    playerLayers.delete(key);
    playerIconSig.delete(key);
  }
  const bands = markerFloorBands(activeConfig);
  for (const mark of playerMarks) {
    const yaw = mark.yaw == null ? null : headingDeg(mark.x, mark.z, mark.yaw);
    const view = markerFloorDisplay({ x: mark.x, z: mark.z, y: mark.y }, prefs.floor, bands);
    const pip = yaw == null
      ? `<span class="player-dot"></span>`
      : `<span class="player-arrow" style="transform:rotate(${yaw}deg)"></span>`;
    const name = escPlayer(mark.name.trim());
    const label = name ? `<span class="player-name">${name}</span>` : "";
    const html = `<span class="player-mark" style="color:${escPlayer(mark.color)};opacity:${view.opacity}"><span class="player-glow"></span>${pip}${label}</span>`;
    const tall = Boolean(name);
    const sig = `${html}\0${tall ? 1 : 0}`;
    let marker = playerLayers.get(mark.key);
    if (!marker) {
      marker = L.marker([mark.z, mark.x], {
        icon: L.divIcon({ className: "player-icon", html, iconSize: [32, tall ? 44 : 32], iconAnchor: [16, 16] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: mark.self ? 920 : 900,
      });
      marker.addTo(playerGroup);
      playerLayers.set(mark.key, marker);
      playerIconSig.set(mark.key, sig);
    } else {
      const at = L.latLng(mark.z, mark.x);
      const current = marker.getLatLng();
      if (current.lat !== at.lat || current.lng !== at.lng) marker.setLatLng(at);
      if (playerIconSig.get(mark.key) !== sig) {
        marker.setIcon(L.divIcon({ className: "player-icon", html, iconSize: [32, tall ? 44 : 32], iconAnchor: [16, 16] }));
        playerIconSig.set(mark.key, sig);
      }
    }
  }
  setPulseLines(pulsePending);
  if (!follow || userDragging) return;
  const self = playerMarks.find((mark) => mark.self);
  if (!self || !map) return;
  const floor = floorForSpan(
    Number.isFinite(self.y) ? { min: self.y, max: self.y } : null,
    bands,
    { x: self.x, z: self.z },
  );
  if (floor !== prefs.floor) setMapFloor(floor);
  if (follow === "fly") {
    const zoom = Math.max(map.getZoom(), (map.getMinZoom() || 1) + 1);
    map.flyTo([self.z, self.x], zoom, { animate: true, duration: 0.35 });
    return;
  }
  map.panTo([self.z, self.x], { animate: true, duration: 0.2 });
}

export function invalidateLiveMap() {
  map?.invalidateSize();
}

export function destroyLiveMap() {
  token += 1;
  questToken += 1;
  rasterToken += 1;
  window.clearTimeout(labelTimer);
  window.clearTimeout(rasterTimer);
  clearDraftRect();
  unbindBoxDraw();
  map?.remove();
  map = null;
  releaseRasterUrl();
  invalidateRaster();
  rasterBroken = false;
  mapMotion = false;
  cullItems.length = 0;
  cullQueued = false;
  playerGroup = null;
  pulseLayer = null;
  pulseEntries.clear();
  playerIconSig.clear();
  playerLayers.clear();
  playerHooked = false;
  userDragging = false;
  layers.clear();
  placed.length = 0;
  placeRows = [];
  placeEditing = false;
  placeSelected = "";
  placeDraft = false;
  placeShape = "point";
  placeNote = "";
  draftPoint = null;
  draftBox = null;
  svgLoad += 1;
  tileLayer = null;
  floorTiles.clear();
  svgLayer = null;
  svgRoot = null;
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
    zoomSnap: 0.5,
    attributionControl: false,
    zoomControl: false,
    minZoom: config.minZoom ?? 1,
    maxZoom: Math.max(7, config.maxZoom ?? 5),
  });
  hookMapMotion();
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  map.on("click", onPlaceMapClick);
  bindBoxDraw();
  map.on("popupopen", (event) => {
    const root = event.popup.getElement();
    if (!root) return;
    const onClick = (click: Event) => {
      const node = (click.target as Element | null)?.closest?.("[data-wiki]");
      if (!(node instanceof HTMLElement) || !node.dataset.wiki || !node.dataset.wikiId) return;
      L.DomEvent.stop(click);
      window.dispatchEvent(new CustomEvent("zhange-wiki", { detail: { kind: node.dataset.wiki, id: node.dataset.wikiId } }));
      map?.closePopup();
    };
    root.addEventListener("click", onClick);
    event.popup.once("remove", () => root.removeEventListener("click", onClick));
  });
  mapSlug = slug;
  if (fit) map.fitBounds(bounds);
  await ensureAccountFilters(config.key);
  if (myToken !== token || !map) return;
  applyAccountView();
  applyRememberedBase();
  hookPlayers();
  if (myToken !== token) return;
  mapReady?.();
  try {
    const detail = await invoke<Record<string, unknown>>("site_get", { path: `/guides/tarkov/maps/${slug}?loot_loose=true&loot_containers=true` });
    const owned = await loadOwnedKeyIds();
    setOwnedQuestKeys(owned);
    if (myToken !== token || !map) return;
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
    if (myToken !== token || !map) return;
    if (panel) panel.textContent = error instanceof Error ? error.message : "地图数据读取失败";
  }
}

type ExtractRow = Point & {
  switches?: { name?: string; id?: string }[];
  transfer_item?: { id?: string; name?: string; short_name?: string; count?: number; icon_link?: string };
  outline?: { x?: number; z?: number }[];
};

type LootItem = {
  id?: string;
  name?: string;
  short_name?: string;
  shortName?: string;
  icon_link?: string;
  iconLink?: string;
  count?: number;
  types?: string[];
  handbook_ids?: string[];
};

function lootIcon(item: LootItem) {
  const id = String(item.id || "");
  return String(item.icon_link || item.iconLink || "") || (/^[a-f0-9]{24}$/i.test(id) ? `https://assets.tarkov.dev/${id}-icon.webp` : "");
}

function lootJump(item: LootItem) {
  const id = String(item.id || "").trim();
  const name = String(item.name || item.short_name || item.shortName || "物品").trim();
  const count = Number(item.count || 1);
  const qty = count > 1 ? ` ×${count}` : "";
  const icon = lootIcon(item);
  const image = icon ? `<img src="${escPlayer(icon)}" alt="" width="28" height="28" />` : "";
  const label = `${escPlayer(name)}${escPlayer(qty)}`;
  if (!id) return `<span class="map-loot">${image}<strong>${label}</strong></span>`;
  return `<button type="button" class="map-loot" data-wiki="item" data-wiki-id="${escPlayer(id)}">${image}<strong>${label}</strong></button>`;
}

function extractPopup(row: ExtractRow, kind: string) {
  const color = extractColor(kind);
  const name = escPlayer(String(row.name || "撤离点"));
  const switches = (row.switches || []).map((item) => String(item.name || item.id || "").trim()).filter(Boolean);
  const item = row.transfer_item;
  const carryId = String(item?.id || "").trim();
  const carryName = String(item?.name || item?.short_name || "").trim();
  const carryCount = Number(item?.count || 1);
  const owned = carryId ? ownedKeyState(carryId) : null;
  const own = owned == null ? "" : owned ? " · 已有" : "";
  const carry = carryId && carryName
    ? `<button type="button" class="map-jump" data-wiki="item" data-wiki-id="${escPlayer(carryId)}">需携带 ${carryCount > 1 ? `${carryCount} × ` : ""}${escPlayer(carryName)}${own}</button>`
    : "";
  const activated = switches.length ? `<p>由 ${escPlayer(switches.join("、"))} 激活</p>` : "";
  if (!carry && !activated) return "";
  return `<div class="map-extract-pop"><strong style="color:${color}">${name}</strong>${activated}${carry}</div>`;
}

function loosePopup(items: LootItem[]) {
  const cards = items.map(lootJump).join("");
  return cards ? `<div class="map-loot-list">${cards}</div>` : "";
}

function paintMarkers(detail: Record<string, unknown>) {
  if (!map) return;
  const host = map;
  for (const row of (detail.extracts as ExtractRow[]) || []) {
    const kind = extractKind(String(row.faction || ""));
    const popup = extractPopup(row, kind);
    add(`extracts:${kind}`, extractMarker(kind, String(row.name || "撤离点"), row, popup), host, row);
    const outline = (row.outline || []).filter((point) => point.x != null && point.z != null);
    if (outline.length >= 3) {
      const color = extractColor(kind);
      add(`extracts:${kind}`, L.polygon(outline.map((point) => [point.z, point.x] as L.LatLngExpression), {
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.14,
        interactive: false,
      }), host, row);
    }
  }
  for (const row of (detail.spawns as Point[]) || []) {
    const kind = String(row.kind || "pmc").toLowerCase();
    const key = kind === "sniper" ? "spawns:sniper" : kind === "scav" ? "spawns:scav" : "spawns:pmc";
    const file = kind === "sniper" ? "spawn_sniper_scav" : `spawn_${key.split(":")[1]}`;
    add(key, iconMarker(`${ICON}/${file}.png`, kind.toUpperCase(), row, kind === "pmc" ? [12, 24] : [12, 12]), host, row);
  }
  for (const boss of (detail.bosses as { id?: string; slug?: string; name?: string; spawn_chance?: number; spawnChance?: number; locations?: { name?: string; positions?: Point[] }[] }[]) || []) {
    const chance = Number(boss.spawn_chance ?? boss.spawnChance);
    const rate = Number.isFinite(chance) && chance > 0 ? `${chance}%` : "";
    const bossId = String(boss.slug || boss.id || "").trim();
    for (const location of boss.locations || []) {
      const place = String(location.name || "").trim();
      const title = boss.name || "Boss";
      const tip = `<div class="map-boss-tip"><strong>${escPlayer(title)}</strong>${rate ? `<div>出生率 ${escPlayer(rate)}</div>` : ""}${place && place !== title ? `<div>${escPlayer(place)}</div>` : ""}</div>`;
      const open = bossId ? `<button type="button" class="map-jump" data-wiki="boss" data-wiki-id="${escPlayer(bossId)}">查看档案</button>` : "";
      for (const point of location.positions || []) {
        const marker = iconMarker(`${ICON}/spawn_boss.png`, title, point, [12, 12], tip);
        if (marker && open) marker.bindPopup(`${tip}${open}`, { className: "map-popup", maxWidth: 260, autoPan: true });
        add("spawns:boss", marker, host, point);
      }
    }
  }
  placeRows = readPlaces(detail.places);
  redrawPlaces();
  renderPlaceBar();
  for (const row of (detail.locks as (Point & { key_id?: string })[]) || []) {
    const keyId = String(row.key_id || "").trim();
    const owned = keyId ? ownedKeyState(keyId) : null;
    const title = `${String(row.name || "锁")}${owned == null ? "" : owned ? " · 已有" : " · 未有"}`;
    add("locks", iconMarker(`${ICON}/lock.png`, title, row), host, row);
  }
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
    const popup = loosePopup(row.items || []);
    const marker = iconMarker(looseIcon(kind, row), "散落物", row);
    if (marker && popup) marker.bindPopup(popup, { className: "map-popup", maxWidth: 280, autoPan: true });
    add(`loose:${kind}`, marker, host, row);
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

type LoosePile = Point & { items?: LootItem[] };

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

const FLOOR_ZH: Record<string, string> = {
  "1st Floor": "1 层", "2nd Floor": "2 层", "3rd Floor": "3 层", "4th Floor": "4 层", "5th Floor": "5 层",
  Underground: "地下", "Second Level": "2 层", "Technical Level": "技术层", Technical: "技术层", Garage: "车库",
  Tunnels: "隧道", Bunkers: "地堡", Infirmary: "医务室", Helipad: "停机坪", "Gym/Canteen": "健身房 / 食堂",
  "Accommodation (lower)": "住宿（下层）", "Accommodation (mid)": "住宿（中层）", "Accommodation (upper)": "住宿（上层）",
  "Officers' Deck": "军官甲板", "Stairs (blocked)": "楼梯（封死）", Bridge: "舰桥", "Bridge Roof": "舰桥顶",
  "Control Room": "控制室", "Engine Room": "轮机舱", "Engine Room (upper)": "轮机舱（上层）",
  "Fuel Pumps (lower)": "燃油泵（下层）", "Fuel Pumps": "燃油泵", "Storage/Security": "仓储 / 安保",
};

function floorLabel(name: string) {
  return FLOOR_ZH[name] || name;
}

function foldBlock(id: string, title: string, body: string) {
  if (!body) return "";
  const collapsed = prefs.collapsed.includes(id);
  return `<div class="filter-block"><div class="filter-head"><span class="filter-title">${title}</span><button type="button" class="filter-fold" data-fold="${id}">${collapsed ? "＋" : "－"}</button></div><div class="filter-children" data-children="${id}" ${collapsed ? "hidden" : ""}>${body}</div></div>`;
}

function landmarksBlock() {
  const places = layers.has("places");
  const btr = layers.has("btr");
  const btrRow = row("btr", "BTR 停车点", `${ICON}/btr_stop.png`, places);
  if (places && btr) {
    const collapsed = prefs.collapsed.includes("landmarks");
    return `<div class="filter-block"><div class="filter-head"><label class="filter-row"><input type="checkbox" ${layerOn("places") ? "checked" : ""} data-layer="places" /><span>地名</span></label><button type="button" class="filter-fold" data-fold="landmarks">${collapsed ? "＋" : "－"}</button></div><div class="filter-children" data-children="landmarks" ${collapsed ? "hidden" : ""}>${btrRow}</div></div>`;
  }
  return `${places ? row("places", "地名") : ""}${btr ? row("btr", "BTR 停车点", `${ICON}/btr_stop.png`) : ""}`;
}

function paintFilters(config: MapLayer, detail: Record<string, unknown>) {
  const panel = document.querySelector("#filter-body");
  if (!panel) return;
  const floors = (config.layers || []).filter((item) => item.tilePath || item.svgLayer);
  const floorOnMap = floors.some((floor) => floor.name === prefs.floor);
  const hazards = (detail.hazards as { hazard_type?: string }[]) || [];
  const hazardKinds = [...new Set(hazards.map((item) => String(item.hazard_type || "hazard")))];
  const containers = (detail.loot_containers as { normalized_name?: string }[]) || [];
  const containerKinds = [...new Set(containers.map((item) => containerKind(String(item.normalized_name || ""))))];
  const looseRows = (detail.loot_loose as LoosePile[]) || [];
  const looseKinds = LOOSE_ORDER.filter((kind) => looseRows.some((item) => looseKind(item) === kind));
  noteArrivedLoot(containerKinds, looseKinds);
  const shownStyle = prefs.style === "svg" && config.svgPath ? "svg" : prefs.style === "tile" && config.tilePath ? "tile" : config.svgPath ? "svg" : "tile";
  const style = [
    config.tilePath ? `<label class="filter-row"><input type="radio" name="map-style" ${shownStyle === "tile" ? "checked" : ""} data-style="tile" /><span>卫星图</span></label>` : "",
    config.svgPath ? `<label class="filter-row"><input type="radio" name="map-style" ${shownStyle === "svg" ? "checked" : ""} data-style="svg" /><span>抽象图</span></label>` : "",
  ].join("");
  const levels = floors.length ? foldBlock("levels", "层级", [
    `<label class="filter-row filter-child"><input type="radio" name="map-floor" ${floorOnMap ? "" : "checked"} data-floor="" /><span>地面</span></label>`,
    ...floors.map((floor) => `<label class="filter-row filter-child"><input type="radio" name="map-floor" ${prefs.floor === floor.name ? "checked" : ""} data-floor="${floor.name}" /><span>${floorLabel(floor.name)}</span></label>`),
  ].join("")) : "";
  const html = [
    style ? `<div class="filter-block">${style}</div>` : "",
    style && levels ? `<span class="filter-split"></span>` : "",
    levels,
    landmarksBlock(),
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
    group("usable", "可使用", "", ["locks", "stationary", "switches"], [
      row("locks", "锁", `${ICON}/lock.png`, true),
      row("stationary", "固定机枪", `${ICON}/stationarygun.png`, true),
      row("switches", "开关", `${ICON}/switch.png`, true),
    ].join("")),
    group("hazards", "危险区", `${ICON}/hazard.png`, hazardKinds.map((kind) => `hazards:${kind}`), hazardKinds.map((kind) => row(`hazards:${kind}`, hazardLabel(kind, kind), `${ICON}/${kind === "mortar" ? "hazard_mortar" : "hazard"}.png`, true)).join("")),
    group("loot", "可搜刮物品", `${ICON}/container_crate.png`, containerKinds.map((kind) => `loot:${kind}`), containerKinds.map((kind) => row(`loot:${kind}`, containerLabel(kind), containerIcon(kind), true)).join("")),
    group("loose", "散落物", `${ICON}/loose_loot.png`, looseKinds.map((kind) => `loose:${kind}`), looseKinds.map((kind) => row(`loose:${kind}`, LOOSE_LABELS[kind] || "其他", `https://assets.tarkov.dev/handbook-category-${kind}-icon.webp`, true)).join("")),
    questFilterHtml(),
    `<div class="filter-block"><p class="filter-title">位置同步</p><p class="filter-note" id="shot-note">${escPlayer(shotNote)}</p></div>`,
  ];
  panel.innerHTML = html.filter(Boolean).join("");
  for (const box of panel.querySelectorAll<HTMLInputElement>("[data-group]")) {
    const keys = (box.dataset.group || "").split(",").filter(Boolean);
    const selected = keys.filter((key) => layerOn(key)).length;
    box.indeterminate = selected > 0 && selected < keys.length;
  }
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
  untrackCull("tasks");
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
      trackCull("tasks", polygon, polygon.getBounds());
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
      const at = marker.getLatLng();
      trackCull("tasks", marker, L.latLngBounds(at, at));
    }
  }
}

function paintQuestLabels() {
  const group = layers.get("quest-labels");
  if (!group || !map || !(map as L.Map & { _loaded?: boolean })._loaded) return;
  untrackCull("quest-labels");
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
      const anchor = marker.getLatLng();
      trackCull("quest-labels", marker, L.latLngBounds(anchor, anchor));
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

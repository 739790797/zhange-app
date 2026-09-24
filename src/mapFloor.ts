/** 与网页端 tarkovMarkerFloorDisplay 相同：当前高度不透明，其它高度变淡但仍显示。 */

export type HeightPoint = {
  x?: number | null;
  y?: number | null;
  z?: number | null;
  top?: number | null;
  bottom?: number | null;
};

type Span = { min: number; max: number };
type At = { x: number; z: number };
type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };
type Extent = { min: number; max: number; bounds?: Bounds[] };
export type FloorBand = { name: string; min: number; max: number; extents?: Extent[] };

type FloorLayer = {
  key?: string;
  normalizedName?: string;
  heightRange?: number[];
  layers?: { name?: string; extents?: { height?: number[]; bounds?: unknown }[] | null }[];
};

const OTHER = 0.42;
const BOOST = 80;
const STREETS = new Set(["streets-of-tarkov", "streets"]);
const STORY: Record<string, Span> = {
  "": { min: -6, max: 2.5 },
  "2nd Floor": { min: 2.5, max: 5.5 },
  "3rd Floor": { min: 5.5, max: 8.5 },
  "4th Floor": { min: 8.5, max: 12 },
  "5th Floor": { min: 12, max: 10000 },
  Underground: { min: -10000, max: -6 },
};

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function spanOf(row: HeightPoint): Span | null {
  if (finite(row.y)) return { min: row.y, max: row.y };
  if (!finite(row.top) && !finite(row.bottom)) return null;
  const lo = finite(row.bottom) ? row.bottom : row.top!;
  const hi = finite(row.top) ? row.top : row.bottom!;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

function parseHeight(height?: number[]): Span | null {
  if (!height || height.length < 2 || !Number.isFinite(height[0]) || !Number.isFinite(height[1])) return null;
  return { min: Math.min(height[0], height[1]), max: Math.max(height[0], height[1]) };
}

function parseBounds(raw: unknown): Bounds[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Bounds[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const a = item[0];
    const b = item[1];
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) continue;
    const x1 = Number(a[0]);
    const z1 = Number(a[1]);
    const x2 = Number(b[0]);
    const z2 = Number(b[1]);
    if (![x1, z1, x2, z2].every(Number.isFinite)) continue;
    out.push({ minX: Math.min(x1, x2), maxX: Math.max(x1, x2), minZ: Math.min(z1, z2), maxZ: Math.max(z1, z2) });
  }
  return out.length ? out : undefined;
}

function extentsOf(band: FloorBand): Extent[] {
  return band.extents?.length ? band.extents : [{ min: band.min, max: band.max }];
}

function inside(at: At, box: Bounds) {
  return at.x >= box.minX && at.x <= box.maxX && at.z >= box.minZ && at.z <= box.maxZ;
}

function overlap(a: Span, b: Span) {
  return a.min <= b.max && b.min <= a.max;
}

function boundsOk(extent: Extent, at?: At | null) {
  if (!extent.bounds?.length) return true;
  if (!at) return false;
  return extent.bounds.some((box) => inside(at, box));
}

function matches(band: FloorBand, span: Span, at?: At | null) {
  return extentsOf(band).some((extent) => overlap(span, extent) && boundsOk(extent, at));
}

function contains(band: FloorBand, span: Span, at?: At | null) {
  return extentsOf(band).some((extent) => extent.min <= span.min && span.max <= extent.max && boundsOk(extent, at));
}

function duplicatesGround(band: FloorBand, ground: FloorBand) {
  if (!band.name) return false;
  const extents = extentsOf(band);
  if (extents.some((extent) => extent.bounds?.length)) return false;
  return extents.every((extent) => extent.min === ground.min && extent.max === ground.max);
}

export function markerFloorBands(layer: FloorLayer | null | undefined): FloorBand[] {
  if (!layer) return [];
  const bands: FloorBand[] = [];
  const range = layer.heightRange;
  if (range && range.length >= 2 && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
    const min = Math.min(range[0], range[1]);
    const max = Math.max(range[0], range[1]);
    bands.push({ name: "", min, max, extents: [{ min, max }] });
  }
  for (const floor of layer.layers || []) {
    const name = (floor.name || "").trim();
    if (!name) continue;
    const extents: Extent[] = [];
    for (const raw of floor.extents || []) {
      const height = parseHeight(raw.height);
      if (!height) continue;
      const bounds = parseBounds(raw.bounds);
      extents.push(bounds ? { ...height, bounds } : height);
    }
    if (!extents.length) continue;
    bands.push({
      name,
      min: Math.min(...extents.map((item) => item.min)),
      max: Math.max(...extents.map((item) => item.max)),
      extents,
    });
  }
  const key = String(layer.normalizedName || layer.key || "").trim().toLowerCase();
  if (!STREETS.has(key)) return bands;
  return bands.map((band) => {
    const height = STORY[band.name];
    if (!height) return band;
    return { ...band, min: height.min, max: height.max, extents: [{ min: height.min, max: height.max }] };
  });
}

export function spanOnFloor(span: Span | null, floor: string, bands: FloorBand[], at?: At | null) {
  if (!bands.length) return true;
  if (!floor) {
    if (!span) return true;
    const ground = bands.find((band) => !band.name);
    if (bands.some((band) => band.name && !(ground && duplicatesGround(band, ground)) && contains(band, span, at))) return false;
    if (!ground) return true;
    return matches(ground, span, at);
  }
  if (!span) return false;
  const named = bands.find((band) => band.name === floor);
  if (!named) return true;
  return matches(named, span, at);
}

function nearestDist(band: FloorBand, mid: number, at?: At | null) {
  let best = Infinity;
  let hit = false;
  for (const extent of extentsOf(band)) {
    if (extent.bounds?.length && !boundsOk(extent, at)) continue;
    const clamped = Math.min(extent.max, Math.max(extent.min, mid));
    best = Math.min(best, Math.abs(mid - clamped));
    hit = true;
  }
  return hit ? best : null;
}

function overlapLen(band: FloorBand, span: Span, at?: At | null) {
  let best = 0;
  let hit = false;
  for (const extent of extentsOf(band)) {
    if (!overlap(span, extent) || !boundsOk(extent, at)) continue;
    const len = Math.min(span.max, extent.max) - Math.max(span.min, extent.min);
    if (len >= best) best = len;
    hit = true;
  }
  return hit ? best : null;
}

/** 点位应对齐的楼层；空字符串是地面。与网页端 overlayFloorForSpan 相同。 */
export function floorForSpan(span: Span | null, bands: FloorBand[], at?: At | null) {
  if (!bands.length || !span) return "";
  const mid = (span.min + span.max) / 2;
  const contained = bands.filter((band) => band.name && contains(band, span, at));
  const pool = contained.length ? contained : bands.filter((band) => overlapLen(band, span, at) != null);
  if (pool.length) {
    let best = pool[0];
    let bestOverlap = overlapLen(best, span, at) ?? 0;
    let bestDist = nearestDist(best, mid, at) ?? Infinity;
    for (const band of pool.slice(1)) {
      const len = overlapLen(band, span, at) ?? 0;
      const dist = nearestDist(band, mid, at) ?? Infinity;
      if (len < bestOverlap) continue;
      if (len === bestOverlap && dist >= bestDist) continue;
      best = band;
      bestOverlap = len;
      bestDist = dist;
    }
    return best.name;
  }
  let name = "";
  let bestDist = Infinity;
  for (const band of bands) {
    const dist = nearestDist(band, mid, at);
    if (dist == null || dist >= bestDist) continue;
    bestDist = dist;
    name = band.name;
  }
  return name;
}

function onFloor(row: HeightPoint, floor: string, bands: FloorBand[]) {
  const span = spanOf(row);
  const at = finite(row.x) && finite(row.z) ? { x: row.x, z: row.z } : undefined;
  return spanOnFloor(span, floor, bands, at);
}

export function markerFloorDisplay(row: HeightPoint, floor: string, bands: FloorBand[]) {
  const current = onFloor(row, floor, bands);
  return { opacity: current ? 1 : OTHER, zBoost: current ? BOOST : 0 };
}

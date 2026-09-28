export type KindFlags = Record<string, boolean>;

export type AccountMapFilters = {
  style: "svg" | "tile";
  filterPanelOpen: boolean;
  filterGroupsCollapsed: Record<string, boolean>;
  floorsByMap: Record<string, string>;
  extractKinds: Record<"pmc" | "scav" | "shared" | "transit", boolean>;
  spawnKinds: Record<"pmc" | "scav" | "sniper" | "boss", boolean>;
  showLabels: boolean;
  showQuests: boolean;
  showLocks: boolean;
  showHazards: boolean;
  showSwitches: boolean;
  showStationary: boolean;
  showBtrStops: boolean;
  showLootContainers: boolean;
  showLootLoose: boolean;
  hazardKinds: KindFlags;
  lootContainerKinds: KindFlags;
  lootLooseKinds: KindFlags;
};

const ACCOUNT_KEY = "zhange.map.filters.account";
const LEGACY_KEY = "zhange.map.filters";
const TO_WEB: Record<string, string> = { loot: "lootable", loose: "lootLoose" };
const FROM_WEB: Record<string, string> = { lootable: "loot", lootLoose: "loose" };

export function defaultAccountMapFilters(): AccountMapFilters {
  return {
    style: "svg",
    filterPanelOpen: true,
    filterGroupsCollapsed: {},
    floorsByMap: {},
    extractKinds: { pmc: true, scav: true, shared: true, transit: true },
    spawnKinds: { pmc: true, scav: true, sniper: true, boss: true },
    showLabels: true,
    showQuests: true,
    showLocks: true,
    showHazards: true,
    showSwitches: true,
    showStationary: true,
    showBtrStops: true,
    showLootContainers: false,
    showLootLoose: false,
    hazardKinds: {},
    lootContainerKinds: {},
    lootLooseKinds: {},
  };
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function kindFlags(raw: unknown): KindFlags {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: KindFlags = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || typeof value !== "boolean") continue;
    out[key] = value;
  }
  return out;
}

export function normalizeAccountMapFilters(raw: unknown): AccountMapFilters {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const base = defaultAccountMapFilters();
  const floors: Record<string, string> = {};
  if (row.floorsByMap && typeof row.floorsByMap === "object" && !Array.isArray(row.floorsByMap)) {
    for (const [key, value] of Object.entries(row.floorsByMap as Record<string, unknown>)) {
      if (key && typeof value === "string") floors[key] = value;
    }
  }
  const collapsed: Record<string, boolean> = {};
  if (row.filterGroupsCollapsed && typeof row.filterGroupsCollapsed === "object" && !Array.isArray(row.filterGroupsCollapsed)) {
    for (const [key, value] of Object.entries(row.filterGroupsCollapsed as Record<string, unknown>)) {
      if (value === true) collapsed[key] = true;
    }
  }
  const extracts = row.extractKinds && typeof row.extractKinds === "object" ? row.extractKinds as Record<string, unknown> : {};
  const spawns = row.spawnKinds && typeof row.spawnKinds === "object" ? row.spawnKinds as Record<string, unknown> : {};
  return {
    ...base,
    style: row.style === "tile" ? "tile" : "svg",
    filterPanelOpen: bool(row.filterPanelOpen, true),
    filterGroupsCollapsed: collapsed,
    floorsByMap: floors,
    extractKinds: {
      pmc: bool(extracts.pmc, true),
      scav: bool(extracts.scav, true),
      shared: bool(extracts.shared, true),
      transit: bool(extracts.transit, true),
    },
    spawnKinds: {
      pmc: bool(spawns.pmc, true),
      scav: bool(spawns.scav, true),
      sniper: bool(spawns.sniper, true),
      boss: bool(spawns.boss, true),
    },
    showLabels: bool(row.showLabels, true),
    showQuests: bool(row.showQuests, true),
    showLocks: bool(row.showLocks, true),
    showHazards: bool(row.showHazards, true),
    showSwitches: bool(row.showSwitches, true),
    showStationary: bool(row.showStationary, true),
    showBtrStops: bool(row.showBtrStops, true),
    showLootContainers: bool(row.showLootContainers, false),
    showLootLoose: bool(row.showLootLoose, false),
    hazardKinds: kindFlags(row.hazardKinds),
    lootContainerKinds: kindFlags(row.lootContainerKinds),
    lootLooseKinds: kindFlags(row.lootLooseKinds),
  };
}

let account = readCachedAccount() ?? defaultAccountMapFilters();
let pushEnabled = false;
let dirty = false;
let revision = 0;
let preferLocal = false;
let ready: Promise<void> | null = null;
let pushTimer = 0;
let applied: (() => void) | null = null;

function readCachedAccount() {
  try {
    const raw = sessionStorage.getItem(ACCOUNT_KEY);
    return raw ? normalizeAccountMapFilters(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function readLegacy() {
  try {
    const raw = sessionStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { off?: string[]; style?: string; floor?: string; collapsed?: string[] };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function legacyAccount(raw: { off?: string[]; style?: string; floor?: string; collapsed?: string[] }, mapKey: string) {
  const next = defaultAccountMapFilters();
  next.style = raw.style === "svg" ? "svg" : "tile";
  const off = new Set(raw.off || []);
  next.showLabels = !off.has("places");
  next.showQuests = !off.has("tasks");
  next.showLocks = !off.has("locks");
  next.showStationary = !off.has("stationary");
  next.showSwitches = !off.has("switches");
  next.showBtrStops = !off.has("btr");
  next.extractKinds = {
    pmc: !off.has("extracts:pmc"),
    scav: !off.has("extracts:scav"),
    shared: !off.has("extracts:shared"),
    transit: !off.has("extracts:transit"),
  };
  next.spawnKinds = {
    pmc: !off.has("spawns:pmc"),
    scav: !off.has("spawns:scav"),
    sniper: !off.has("spawns:sniper"),
    boss: !off.has("spawns:boss"),
  };
  next.showHazards = true;
  next.showLootContainers = true;
  next.showLootLoose = true;
  for (const key of off) {
    if (key.startsWith("hazards:")) next.hazardKinds[key.slice("hazards:".length)] = false;
    if (key.startsWith("loot:")) next.lootContainerKinds[key.slice("loot:".length)] = false;
    if (key.startsWith("loose:")) next.lootLooseKinds[key.slice("loose:".length)] = false;
  }
  for (const id of raw.collapsed || []) {
    const webId = TO_WEB[id] || id;
    next.filterGroupsCollapsed[webId] = true;
  }
  if (mapKey && raw.floor) next.floorsByMap[mapKey] = raw.floor;
  return next;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("请在战鸽助手窗口里操作");
  return internals.invoke(command, args);
}

export function currentAccount() {
  return account;
}

export function copyAccount(): AccountMapFilters {
  return normalizeAccountMapFilters(JSON.parse(JSON.stringify(account)));
}

export function onAccountApplied(fn: () => void) {
  applied = fn;
}

export function layerVisible(key: string) {
  if (key === "places") return account.showLabels;
  if (key === "tasks") return account.showQuests;
  if (key === "locks") return account.showLocks;
  if (key === "stationary") return account.showStationary;
  if (key === "switches") return account.showSwitches;
  if (key === "btr") return account.showBtrStops;
  if (key.startsWith("extracts:")) {
    const kind = key.slice("extracts:".length) as keyof AccountMapFilters["extractKinds"];
    return account.extractKinds[kind] !== false;
  }
  if (key.startsWith("spawns:")) {
    const kind = key.slice("spawns:".length) as keyof AccountMapFilters["spawnKinds"];
    return account.spawnKinds[kind] !== false;
  }
  if (key.startsWith("hazards:")) return account.showHazards && account.hazardKinds[key.slice("hazards:".length)] !== false;
  if (key.startsWith("loot:")) return account.showLootContainers && account.lootContainerKinds[key.slice("loot:".length)] === true;
  if (key.startsWith("loose:")) return account.showLootLoose && account.lootLooseKinds[key.slice("loose:".length)] === true;
  return true;
}

function touch(push: boolean) {
  try {
    sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch {
    /* 会话写不进时仍保留内存里的喜好 */
  }
  if (!push) return;
  revision += 1;
  dirty = true;
  if (pushEnabled) scheduleAccountPush();
}

export function setAccountLayer(key: string, on: boolean) {
  if (key === "places") account.showLabels = on;
  else if (key === "tasks") account.showQuests = on;
  else if (key === "locks") account.showLocks = on;
  else if (key === "stationary") account.showStationary = on;
  else if (key === "switches") account.showSwitches = on;
  else if (key === "btr") account.showBtrStops = on;
  else if (key.startsWith("extracts:")) {
    const kind = key.slice("extracts:".length) as keyof AccountMapFilters["extractKinds"];
    if (kind in account.extractKinds) account.extractKinds[kind] = on;
  } else if (key.startsWith("spawns:")) {
    const kind = key.slice("spawns:".length) as keyof AccountMapFilters["spawnKinds"];
    if (kind in account.spawnKinds) account.spawnKinds[kind] = on;
  } else if (key.startsWith("hazards:")) {
    account.hazardKinds[key.slice("hazards:".length)] = on;
    if (on) account.showHazards = true;
  } else if (key.startsWith("loot:")) {
    account.lootContainerKinds[key.slice("loot:".length)] = on;
    if (on) account.showLootContainers = true;
  } else if (key.startsWith("loose:")) {
    account.lootLooseKinds[key.slice("loose:".length)] = on;
    if (on) account.showLootLoose = true;
  }
  touch(true);
}

export function setAccountStyle(style: "svg" | "tile") {
  account.style = style;
  touch(true);
}

export function setAccountFloor(mapKey: string, floor: string) {
  if (!mapKey) return;
  account.floorsByMap[mapKey] = floor;
  touch(true);
}

export function toggleAccountCollapsed(appId: string) {
  const webId = TO_WEB[appId] || appId;
  if (account.filterGroupsCollapsed[webId]) delete account.filterGroupsCollapsed[webId];
  else account.filterGroupsCollapsed[webId] = true;
  touch(true);
  return Boolean(account.filterGroupsCollapsed[webId]);
}

export function collapsedAppIds() {
  return Object.entries(account.filterGroupsCollapsed)
    .filter(([, on]) => on)
    .map(([id]) => FROM_WEB[id] || id);
}

export function floorForMap(mapKey: string, layers?: { name?: string; show?: boolean }[]) {
  const names = (layers || []).map((item) => item.name || "").filter(Boolean);
  if (!mapKey || !Object.prototype.hasOwnProperty.call(account.floorsByMap, mapKey)) {
    const shown = (layers || []).find((item) => item.show && item.name && names.includes(item.name));
    return shown?.name || "";
  }
  const saved = account.floorsByMap[mapKey] || "";
  return !saved || names.includes(saved) ? saved : "";
}

export function noteArrivedLoot(containerKinds: string[], looseKinds: string[]) {
  let changed = false;
  if (account.showLootContainers) {
    for (const kind of containerKinds) {
      if (account.lootContainerKinds[kind] === undefined) {
        account.lootContainerKinds[kind] = true;
        changed = true;
      }
    }
  }
  if (account.showLootLoose) {
    for (const kind of looseKinds) {
      if (account.lootLooseKinds[kind] === undefined) {
        account.lootLooseKinds[kind] = true;
        changed = true;
      }
    }
  }
  if (changed) touch(true);
  return changed;
}

export function adoptAccount(next: unknown) {
  account = normalizeAccountMapFilters(next);
  revision += 1;
  preferLocal = true;
  dirty = false;
  touch(false);
  applied?.();
}

export function scheduleAccountPush() {
  if (!pushEnabled) return;
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    const prefs = copyAccount();
    void invoke("site_put", { path: "/guides/tarkov/map-filters", body: { prefs } }).catch(() => undefined);
  }, 400);
}

export function ensureAccountFilters(mapKey = "") {
  if (!ready) {
    const hadCache = Boolean(readCachedAccount());
    ready = pullAccount(hadCache, mapKey).catch(() => {
      ready = null;
    });
  }
  return ready;
}

async function pullAccount(hadCache: boolean, mapKey: string) {
  const seen = revision;
  try {
    const row = await invoke<{ saved?: boolean; prefs?: unknown }>("site_get", { path: "/guides/tarkov/map-filters" });
    if (dirty || preferLocal || seen !== revision) {
      preferLocal = false;
      pushEnabled = true;
      scheduleAccountPush();
      return;
    }
    if (row?.saved && row.prefs) {
      account = normalizeAccountMapFilters(row.prefs);
      touch(false);
      pushEnabled = true;
      applied?.();
      if (dirty) scheduleAccountPush();
    } else if (!hadCache) {
      const legacy = readLegacy();
      if (legacy) {
        account = legacyAccount(legacy, mapKey);
        dirty = true;
        pushEnabled = true;
        touch(false);
        scheduleAccountPush();
        applied?.();
        return;
      }
    } else {
      pushEnabled = true;
      scheduleAccountPush();
      return;
    }
  } catch {
    /* 未登录时沿用本机这次会话里的记录 */
  }
  pushEnabled = true;
  if (dirty) scheduleAccountPush();
}

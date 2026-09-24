/** 与网页端 buildRaidPrepOverlays / 标签聚类 / 按勾选过滤同一套规则。 */

export const QUEST_COLORS = ["#e8c36a", "#6cb6ff", "#6fbf4a", "#e08a2c", "#d44a4a", "#c77dff", "#4ab8b8", "#f0a3c2"] as const;
export const QUEST_HELP_COLOR = "#8a8878";
export const QUEST_OTHER_FLOOR = 0.28;
const LABEL_PX = 48;

const MAP_EQUIV = [
  ["streets", "streets-of-tarkov"],
  ["lab", "the-lab"],
  ["labyrinth", "the-labyrinth"],
  ["night-factory", "factory-night"],
  ["ground-zero", "ground-zero-21", "ground-zero-tutorial"],
  ["customs", "bigmap"],
];

const TYPE_LABEL: Record<string, string> = {
  shoot: "击杀",
  findItem: "找到",
  findQuestItem: "找到",
  giveItem: "上交",
  giveQuestItem: "上交",
  plantItem: "藏匿",
  plantQuestItem: "藏匿",
  mark: "标记",
  visit: "前往",
  extract: "撤离",
  useItem: "使用",
  buildWeapon: "改装",
  sellItem: "出售",
  haveItem: "持有",
  skill: "技能",
  traderLevel: "忠诚",
  traderStanding: "声望",
  experience: "状态",
};

export type QuestPoint = { x: number; z: number; y?: number };
export type QuestSpan = { min: number; max: number };
export type QuestStep = { id: string; text: string; optional: boolean; active: boolean };
export type QuestPerson = { name: string; userId?: number };

export type QuestOverlay = {
  key: string;
  taskId: string;
  kind: "zone" | "spawn";
  color: string;
  title: string;
  subtitle: string;
  steps: QuestStep[];
  traderSlug: string;
  keyNames: string[];
  showNoKey: boolean;
  optional: boolean;
  objectiveId: string;
  done?: boolean;
  neededBy?: QuestPerson[];
  outline: QuestPoint[];
  points: QuestPoint[];
  height: QuestSpan | null;
};

export type QuestLabelItem = {
  taskId: string;
  title: string;
  color: string;
  traderSlug: string;
  subtitle: string;
  keyNames: string[];
  showNoKey: boolean;
  optional: boolean;
  done?: boolean;
  height: QuestSpan | null;
};

export type QuestLabel = { x: number; z: number; items: QuestLabelItem[] };

type Named = { id?: string | null; name?: string | null; slug?: string | null };
type Zone = {
  id?: string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  top?: number | null;
  bottom?: number | null;
  map_slug?: string | null;
  map_name?: string | null;
  outline?: Array<{ x?: number | null; y?: number | null; z?: number | null }> | null;
};
type Objective = {
  id?: string | null;
  type?: string | null;
  description?: string | null;
  optional?: boolean | null;
  count?: number | null;
  maps?: Named[] | null;
  zones?: Zone[] | null;
  possible_locations?: Array<{ map_slug?: string | null; map_name?: string | null; positions?: Array<{ x?: number | null; y?: number | null; z?: number | null }> | null }> | null;
  required_keys?: Named[][] | null;
};

export type QuestTask = {
  id: string;
  name?: string | null;
  normalized_name?: string | null;
  trader_slug?: string | null;
  objectives?: Objective[] | null;
};

export function questColor(index: number) {
  return QUEST_COLORS[Math.abs(index) % QUEST_COLORS.length];
}

/** 与网页端 colorForTaskId 相同的 FNV-1a。 */
export function colorForTaskId(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return QUEST_COLORS[Math.abs(hash) % QUEST_COLORS.length];
}

export function colorForUserId(userId: number) {
  return colorForTaskId(`user:${userId}`);
}

export function paintColor(color: string, help?: boolean) {
  return help ? QUEST_HELP_COLOR : color;
}

export function personKey(person: { name: string; userId?: number | null }) {
  return person.userId != null ? `id:${person.userId}` : `name:${person.name}`;
}

export function questPeople(rows: readonly { name?: string | null; userId?: number | null }[]) {
  const seen = new Set<string>();
  const out: QuestPerson[] = [];
  for (const row of rows) {
    const name = (row.name || "").trim();
    if (!name) continue;
    const userId = typeof row.userId === "number" && Number.isFinite(row.userId) ? row.userId : undefined;
    const person = userId != null ? { name, userId } : { name };
    const key = personKey(person);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(person);
  }
  return out;
}

export function defaultPersonOff(people: readonly QuestPerson[], selfUserId: number | null) {
  if (people.length < 2 || selfUserId == null || selfUserId <= 0) return null;
  const self = people.find((person) => person.userId === selfUserId);
  if (!self) return null;
  const mine = personKey(self);
  return people.map(personKey).filter((key) => key !== mine);
}

export function parentQuestSelection(keys: readonly string[], parentOn: boolean) {
  if (parentOn) return { show: false, off: [...keys] };
  return { show: true, off: [] as string[] };
}

export function personQuestSelection(keys: readonly string[], off: ReadonlySet<string>, show: boolean, toggled: string) {
  if (!show) return { show: true, off: keys.filter((key) => key && key !== toggled) };
  const next = new Set(off);
  if (next.has(toggled)) next.delete(toggled);
  else next.add(toggled);
  return { show: true, off: [...next] };
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
}

function mapKeys(slug: string) {
  const key = slug.trim().toLowerCase();
  const keys = new Set(key ? [key] : []);
  for (const group of MAP_EQUIV) {
    if (group.includes(key)) group.forEach((item) => keys.add(item));
  }
  return keys;
}

function hitsMap(loc: { map_slug?: string | null; map_name?: string | null }, keys: Set<string>) {
  const slug = (loc.map_slug || "").trim().toLowerCase();
  if (slug && keys.has(slug)) return true;
  const name = (loc.map_name || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return Boolean(name && keys.has(name));
}

function readable(name: string | null | undefined, id?: string | null) {
  const text = (name || "").trim();
  if (!text) return "";
  if (id && text === id) return "";
  if (/^[a-f0-9]{24}$/i.test(text)) return "";
  return text;
}

function stepText(obj: Objective) {
  const text = readable(obj.description, obj.id) || TYPE_LABEL[(obj.type || "").trim()] || "";
  if (!text) return "";
  const count = (obj.type || "").trim() === "shoot" && finite(obj.count) && obj.count > 1 ? Math.trunc(obj.count) : 0;
  const withCount = count > 1 ? `${text} ×${count}` : text;
  return obj.optional ? `${withCount}（可选）` : withCount;
}

function applies(obj: Objective, keys: Set<string>) {
  const maps = obj.maps || [];
  const zones = obj.zones || [];
  const locs = obj.possible_locations || [];
  const located = maps.some((map) => (map.slug || "").trim()) || zones.length > 0 || locs.length > 0;
  if (!located) return true;
  if (maps.some((map) => keys.has((map.slug || "").trim().toLowerCase()))) return true;
  if (zones.some((zone) => hitsMap(zone, keys))) return true;
  if (locs.some((loc) => hitsMap(loc, keys))) return true;
  return false;
}

function keyNames(obj: Objective) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of obj.required_keys || []) {
    for (const key of group || []) {
      const name = readable(key.name, key.id);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function pointsOf(rows: Array<{ x?: number | null; y?: number | null; z?: number | null }> | null | undefined) {
  const out: QuestPoint[] = [];
  for (const row of rows || []) {
    if (!finite(row.x) || !finite(row.z)) continue;
    const point: QuestPoint = { x: row.x, z: row.z };
    if (finite(row.y)) point.y = row.y;
    out.push(point);
  }
  return out;
}

function pointKey(point: QuestPoint) {
  const y = finite(point.y) ? `:${Math.round(point.y)}` : "";
  return `${Math.round(point.x)}:${Math.round(point.z)}${y}`;
}

function uniquePoints(points: QuestPoint[]) {
  const seen = new Set<string>();
  const out: QuestPoint[] = [];
  for (const point of points) {
    const key = pointKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return out;
}

function zoneSpan(zone: Zone): QuestSpan | null {
  if (finite(zone.top) && finite(zone.bottom)) return { min: Math.min(zone.top, zone.bottom), max: Math.max(zone.top, zone.bottom) };
  if (finite(zone.y)) return { min: zone.y, max: zone.y };
  return null;
}

function pointsSpan(points: QuestPoint[]): QuestSpan | null {
  const ys = points.map((point) => point.y).filter((value): value is number => finite(value));
  if (!ys.length) return null;
  return { min: Math.min(...ys), max: Math.max(...ys) };
}

function centroid(points: QuestPoint[]): QuestPoint {
  let x = 0;
  let z = 0;
  for (const point of points) {
    x += point.x;
    z += point.z;
  }
  const n = points.length || 1;
  return { x: x / n, z: z / n };
}

function taskName(task: QuestTask) {
  return readable(task.name, task.id) || readable(task.normalized_name, task.id) || (task.normalized_name || "").trim() || task.id;
}

export function buildQuestOverlays(tasks: readonly QuestTask[], mapSlug: string): QuestOverlay[] {
  const keys = mapKeys(mapSlug);
  const overlays: QuestOverlay[] = [];
  tasks.forEach((task, taskIndex) => {
    const color = questColor(taskIndex);
    const title = taskName(task);
    const traderSlug = (task.trader_slug || "").trim();
    const steps = (task.objectives || []).flatMap((obj, index) => {
      if (!applies(obj, keys)) return [];
      const text = stepText(obj);
      if (!text) return [];
      const id = (obj.id || "").trim() || `i:${index}`;
      return [{ id, text, optional: Boolean(obj.optional), active: false }];
    });
    (task.objectives || []).forEach((obj, objIndex) => {
      const objId = (obj.id || "").trim() || `i:${objIndex}`;
      const marked = steps.map((step) => ({ ...step, active: step.id === objId }));
      const subtitle = marked.find((step) => step.active)?.text || stepText(obj);
      const optional = Boolean(obj.optional);
      const names = keyNames(obj);
      const seenZones = new Set<string>();
      let zoneIdx = 0;
      for (const zone of obj.zones || []) {
        if (!hitsMap(zone, keys)) continue;
        const anchor = finite(zone.x) && finite(zone.z) ? pointKey({ x: zone.x, z: zone.z, ...(finite(zone.y) ? { y: zone.y } : {}) }) : (zone.id || "").trim();
        if (anchor) {
          if (seenZones.has(anchor)) continue;
          seenZones.add(anchor);
        }
        const outline = pointsOf(zone.outline);
        const center = finite(zone.x) && finite(zone.z) ? [{ x: zone.x, z: zone.z, ...(finite(zone.y) ? { y: zone.y } : {}) }] : [];
        const polygon = outline.length >= 3 ? outline : [];
        const points = polygon.length ? center : [...center, ...outline];
        if (!polygon.length && !points.length) continue;
        overlays.push({
          key: `${task.id}:obj:${objId}:zone:${zone.id || zoneIdx}`,
          taskId: task.id,
          kind: "zone",
          color,
          title,
          subtitle,
          steps: marked,
          traderSlug,
          keyNames: names,
          showNoKey: false,
          optional,
          objectiveId: objId,
          outline: polygon,
          points,
          height: zoneSpan(zone) || pointsSpan(points),
        });
        zoneIdx += 1;
      }
      let locIdx = 0;
      for (const loc of obj.possible_locations || []) {
        if (!hitsMap(loc, keys)) continue;
        const positions = uniquePoints(pointsOf(loc.positions));
        if (!positions.length) continue;
        overlays.push({
          key: `${task.id}:obj:${objId}:spawn:${locIdx}`,
          taskId: task.id,
          kind: "spawn",
          color,
          title,
          subtitle: subtitle || "可能刷新点",
          steps: marked,
          traderSlug,
          keyNames: names,
          showNoKey: false,
          optional,
          objectiveId: objId,
          outline: [],
          points: positions,
          height: pointsSpan(positions),
        });
        locIdx += 1;
      }
    });
  });
  const groups = new Map<string, QuestOverlay[]>();
  for (const row of overlays) {
    const list = groups.get(row.taskId);
    if (list) list.push(row);
    else groups.set(row.taskId, [row]);
  }
  for (const list of groups.values()) {
    const anyKey = list.some((row) => row.keyNames.length > 0);
    list.forEach((row, index) => {
      row.title = list.length > 1 ? `${row.title}（第${index + 1}处）` : row.title;
      row.showNoKey = anyKey && row.keyNames.length === 0;
    });
  }
  return overlays;
}

function viewerFinished(taskId: string, objectiveId: string, skipped: ReadonlyMap<string, ReadonlySet<string>>, doneTasks: ReadonlySet<string>) {
  if (doneTasks.has(taskId)) return true;
  const id = objectiveId.trim();
  return Boolean(id && skipped.get(taskId)?.has(id));
}

function personFinished(
  person: QuestPerson,
  taskId: string,
  objectiveId: string,
  dones: readonly { taskId: string; objectiveId: string; userId: number }[],
  skipped: ReadonlyMap<string, ReadonlySet<string>>,
  doneTasks: ReadonlySet<string>,
  selfUserId: number | null,
) {
  const id = objectiveId.trim();
  if (!id) return false;
  if (person.userId != null && dones.some((row) => row.userId === person.userId && row.taskId === taskId && row.objectiveId === id)) return true;
  if (selfUserId != null && person.userId === selfUserId) return viewerFinished(taskId, id, skipped, doneTasks);
  return false;
}

export function filterQuestOverlays(
  overlays: readonly QuestOverlay[],
  opts: {
    selectedKeys: ReadonlySet<string> | null;
    peopleByTask: ReadonlyMap<string, readonly QuestPerson[]>;
    skipped: ReadonlyMap<string, ReadonlySet<string>>;
    dones: readonly { taskId: string; objectiveId: string; userId: number }[];
    doneTasks: ReadonlySet<string>;
    selfUserId: number | null;
  },
): QuestOverlay[] {
  if (opts.selectedKeys && !opts.selectedKeys.size) return [];
  return overlays.flatMap((row) => {
    const people = questPeople(opts.peopleByTask.get(row.taskId) || []);
    if (opts.selectedKeys && people.length && !people.some((person) => opts.selectedKeys!.has(personKey(person)))) return [];
    const id = row.objectiveId.trim();
    const selected = opts.selectedKeys ? people.filter((person) => opts.selectedKeys!.has(personKey(person))) : [];
    if (id && !selected.length && viewerFinished(row.taskId, id, opts.skipped, opts.doneTasks)) return [];
    const needed = selected.filter((person) => !personFinished(person, row.taskId, id, opts.dones, opts.skipped, opts.doneTasks, opts.selfUserId));
    if (id && selected.length && !needed.length) return [];
    const done = Boolean(id && viewerFinished(row.taskId, id, opts.skipped, opts.doneTasks));
    return [{ ...row, done, neededBy: needed }];
  });
}

export function locateQuestPoints(task: QuestTask, mapSlug: string, skipped: ReadonlySet<string>) {
  const keys = mapKeys(mapSlug);
  const required: QuestPoint[] = [];
  const optional: QuestPoint[] = [];
  const seen = new Set<string>();
  const push = (bucket: QuestPoint[], point: QuestPoint) => {
    const key = `${Math.round(point.x)}:${Math.round(point.z)}`;
    if (seen.has(key)) return;
    seen.add(key);
    bucket.push(point);
  };
  (task.objectives || []).forEach((obj, index) => {
    const id = (obj.id || "").trim() || `i:${index}`;
    if (skipped.has(id)) return;
    const bucket = obj.optional ? optional : required;
    for (const zone of obj.zones || []) {
      if (!hitsMap(zone, keys)) continue;
      const outline = pointsOf(zone.outline);
      const center = finite(zone.x) && finite(zone.z) ? { x: zone.x, z: zone.z, ...(finite(zone.y) ? { y: zone.y } : {}) } : outline.length >= 3 ? centroid(outline) : outline[0];
      if (!center) continue;
      const span = zoneSpan(zone);
      push(bucket, span ? { ...center, y: (span.min + span.max) / 2 } : center);
    }
    for (const loc of obj.possible_locations || []) {
      if (!hitsMap(loc, keys)) continue;
      for (const point of pointsOf(loc.positions)) push(bucket, point);
    }
  });
  return [...required, ...optional];
}

function labelSeeds(row: QuestOverlay) {
  if (row.outline.length >= 3) return row.points.length ? [centroid(row.points)] : [centroid(row.outline)];
  return row.points;
}

export function clusterQuestLabels(overlays: readonly QuestOverlay[], project: (point: QuestPoint) => QuestPoint): QuestLabel[] {
  type Seed = QuestPoint & QuestLabelItem;
  const seeds: Seed[] = [];
  for (const row of overlays) {
    const title = row.title.trim();
    if (!title) continue;
    for (const point of labelSeeds(row)) {
      seeds.push({
        x: point.x,
        z: point.z,
        taskId: row.taskId,
        title,
        color: row.color,
        traderSlug: row.traderSlug,
        subtitle: row.subtitle,
        keyNames: row.keyNames,
        showNoKey: row.showNoKey,
        optional: row.optional,
        ...(row.done ? { done: true } : {}),
        height: row.height,
      });
    }
  }
  if (!seeds.length) return [];
  const parent = seeds.map((_, index) => index);
  const find = (index: number): number => {
    let cur = index;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]]!;
      cur = parent[cur]!;
    }
    return cur;
  };
  const pts = seeds.map(project);
  const gap2 = LABEL_PX * LABEL_PX;
  const cell = LABEL_PX;
  const buckets = new Map<string, number[]>();
  pts.forEach((point, index) => {
    const key = `${Math.floor(point.x / cell)}:${Math.floor(point.z / cell)}`;
    const list = buckets.get(key);
    if (list) list.push(index);
    else buckets.set(key, [index]);
  });
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const gx = Math.floor(a.x / cell);
    const gz = Math.floor(a.z / cell);
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oz = -1; oz <= 1; oz += 1) {
        const list = buckets.get(`${gx + ox}:${gz + oz}`);
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const b = pts[j]!;
          const dx = a.x - b.x;
          const dz = a.z - b.z;
          if (dx * dx + dz * dz > gap2) continue;
          const ra = find(i);
          const rb = find(j);
          if (ra !== rb) parent[rb] = ra;
        }
      }
    }
  }
  const groups = new Map<number, Seed[]>();
  seeds.forEach((seed, index) => {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(seed);
    else groups.set(root, [seed]);
  });
  const labels: QuestLabel[] = [];
  for (const group of groups.values()) {
    const projected = group.map(project);
    let cx = 0;
    let cz = 0;
    for (const point of projected) {
      cx += point.x;
      cz += point.z;
    }
    cx /= projected.length;
    cz /= projected.length;
    let best = 0;
    let bestD = Infinity;
    projected.forEach((point, index) => {
      const dist = (point.x - cx) ** 2 + (point.z - cz) ** 2;
      if (dist < bestD) {
        bestD = dist;
        best = index;
      }
    });
    const anchor = group[best]!;
    const byTask = new Map<string, QuestLabelItem & { count: number }>();
    for (const seed of group) {
      const bucket = `${seed.taskId}\0${seed.optional ? "1" : "0"}\0${seed.title}`;
      const item = byTask.get(bucket);
      if (item) {
        item.count += 1;
        item.done = item.done && seed.done ? true : undefined;
        continue;
      }
      byTask.set(bucket, { ...seed, count: 1 });
    }
    const items = [...byTask.values()].sort((a, b) => b.count - a.count);
    labels.push({ x: anchor.x, z: anchor.z, items });
  }
  labels.sort((a, b) => a.z - b.z || a.x - b.x);
  return labels;
}

export function overlayForLabel(overlays: readonly QuestOverlay[], item: QuestLabelItem) {
  return overlays.find((row) => row.taskId === item.taskId && row.optional === item.optional && row.title === item.title);
}

function traderImg(slug: string) {
  const safe = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!safe) return "";
  const icon = esc(`https://tarkov.dev/images/traders/${safe}-icon.jpg`);
  const portrait = esc(`https://tarkov.dev/images/traders/${safe}-portrait.png`);
  return `<img class="quest-trader" src="${icon}" alt="" width="20" height="20" onerror="this.onerror=function(){this.remove()};this.src='${portrait}'">`;
}

function keyLabel(names: readonly string[], showNoKey: boolean) {
  if (showNoKey) return "不需要钥匙";
  const list = names.map((name) => name.trim()).filter(Boolean);
  if (!list.length) return "";
  if (list.length <= 2) return list.join("、");
  return `${list.slice(0, 2).join("、")}…`;
}

export function questLabelHtml(item: QuestLabelItem, offFloor: boolean, done: boolean) {
  const title = item.optional ? `${item.title}（可选）` : item.title;
  const keys = keyLabel(item.keyNames, item.showNoKey);
  const keyMark = keys ? `<span class="${item.showNoKey ? "quest-label-nokey" : "quest-label-key"}">${esc(keys)}</span>` : "";
  const help = done ? `<span class="quest-label-help">帮</span>` : "";
  const paint = paintColor(item.color, done);
  return `<span class="quest-label-row${offFloor ? " quest-label-off" : ""}" data-task-id="${esc(item.taskId)}">${traderImg(item.traderSlug)}<span class="quest-name" style="color:${paint}">${esc(title)}</span>${help}${keyMark}</span>`;
}

export function questBubbleHtml(
  row: Pick<QuestOverlay, "title" | "subtitle" | "steps" | "color" | "traderSlug" | "keyNames" | "showNoKey" | "kind" | "done" | "neededBy">,
  actions: readonly { id: string; label: string }[] = [],
  hint = "",
) {
  const steps = row.steps.length ? row.steps : row.subtitle ? [{ text: row.subtitle, active: true }] : [];
  const stepHtml = steps.length
    ? `<span class="quest-tip-steps">${steps.map((step) => `<span class="quest-tip-step${step.active ? " on" : ""}"${step.active ? ` style="color:${esc(paintColor(row.color, row.done))}"` : ""}>${esc(step.text)}</span>`).join("")}</span>`
    : "";
  const keys = row.keyNames.filter(Boolean).map((name) => `<span class="quest-tip-key">${esc(name)}</span>`).join("");
  const keyRow = keys ? `<span class="quest-tip-keys"><span class="quest-tip-key-label">所需钥匙</span>${keys}</span>` : row.showNoKey ? `<span class="quest-tip-nokey">不需要钥匙</span>` : "";
  const help = row.done ? `<span class="quest-tip-help">你已完成，地图上留给还没勾的队友</span>` : "";
  const people = questPeople(row.neededBy || []);
  const chips = people.length
    ? `<span class="quest-tip-people">${row.done ? `<span class="quest-tip-lead">还需</span>` : ""}${people.map((person) => `<span class="quest-tip-chip"><i style="background:${esc(person.userId != null ? colorForUserId(person.userId) : colorForTaskId(person.name))}"></i>${esc(person.name)}</span>`).join("")}</span>`
    : "";
  const hintHtml = hint ? `<span class="quest-tip-help">${esc(hint)}</span>` : "";
  const actionHtml = actions.length ? `<span class="quest-tip-actions">${actions.map((action) => `<button type="button" class="quest-tip-action" data-quest-action="${esc(action.id)}">${esc(action.label)}</button>`).join("")}</span>` : "";
  const paint = paintColor(row.color, row.done);
  return `<span class="quest-tip"><span class="quest-tip-row">${traderImg(row.traderSlug)}<span class="quest-tip-name" style="color:${paint}">${esc(row.title)}</span></span>${stepHtml}${keyRow}${help}${chips}${hintHtml}${actionHtml}</span>`;
}

export function questActions(canGuide: boolean, canComplete: boolean, objectiveId: string, alreadyDone: boolean) {
  const out: { id: string; label: string }[] = [];
  if (canGuide) out.push({ id: "guide", label: "查看攻略" });
  if (canComplete && objectiveId.trim()) out.push(alreadyDone ? { id: "uncomplete", label: "取消完成该步骤" } : { id: "complete", label: "已完成该步骤" });
  return out;
}

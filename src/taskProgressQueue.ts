export type ObjectiveDone = { task_id: string; objective_id: string; [key: string]: unknown };

export type TaskProgress = {
  done: Set<string>;
  started: Set<string>;
  failed: Set<string>;
  objectives: ObjectiveDone[];
};

export type TaskGameMode = "pvp" | "pve";

export function roomTaskProgressMode(raw: unknown, fallback: TaskGameMode): TaskGameMode {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const value = raw as Record<string, unknown>;
  const mode = String(value.game_mode || value.gameMode || "")
    .trim()
    .toLowerCase();
  return mode === "pvp" || mode === "pve" ? mode : fallback;
}

export function taskProgressPath(mode: TaskGameMode) {
  return `/guides/tarkov/task-dones?game_mode=${mode}`;
}

export function withTaskGameMode(path: string, mode: TaskGameMode) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}game_mode=${mode}`;
}

export function exponentialBackoffMs(attempt: number, initialMs = 1_000, maxMs = 30_000) {
  const safeInitial = Number.isFinite(initialMs) && initialMs > 0 ? initialMs : 1_000;
  const safeMax = Number.isFinite(maxMs) && maxMs >= safeInitial ? maxMs : safeInitial;
  const safeAttempt = Number.isFinite(attempt) ? Math.min(30, Math.max(0, Math.floor(attempt))) : 0;
  return Math.min(safeInitial * 2 ** safeAttempt, safeMax);
}

export function emptyTaskProgress(): TaskProgress {
  return { done: new Set(), started: new Set(), failed: new Set(), objectives: [] };
}

let taskProgressAccountEpoch = 0;

export function currentTaskProgressAccountEpoch() {
  return taskProgressAccountEpoch;
}

export function taskProgressAccountEpochIsCurrent(epoch: number) {
  return epoch === taskProgressAccountEpoch;
}

export function invalidateTaskProgressAccount() {
  taskProgressAccountEpoch += 1;
  return taskProgressAccountEpoch;
}

let progressQueue: Promise<void> = Promise.resolve();

export function serializeTaskProgress<T>(work: () => Promise<T>): Promise<T> {
  const pending = progressQueue.then(work, work);
  progressQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function ids(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      String(item || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

export function readTaskProgress(raw: Record<string, unknown>): TaskProgress {
  const objectives = Array.isArray(raw.objective_dones)
    ? raw.objective_dones
    : Array.isArray(raw.objectiveDones)
      ? raw.objectiveDones
      : [];
  const seen = new Set<string>();
  const normalizedObjectives: ObjectiveDone[] = [];
  for (const value of objectives) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const taskId = String(row.task_id || row.taskId || "").trim();
    const objectiveId = String(row.objective_id || row.objectiveId || "").trim();
    if (!taskId || !objectiveId) continue;
    const key = objectiveKey(taskId, objectiveId);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedObjectives.push({ ...row, task_id: taskId, objective_id: objectiveId });
  }
  return {
    done: new Set(ids(raw.task_ids || raw.taskIds)),
    started: new Set(ids(raw.started_ids || raw.startedIds)),
    failed: new Set(ids(raw.failed_ids || raw.failedIds)),
    objectives: normalizedObjectives,
  };
}

export function cloneTaskProgress(progress: TaskProgress): TaskProgress {
  return {
    done: new Set([...progress.done].map((id) => id.trim().toLowerCase()).filter(Boolean)),
    started: new Set([...progress.started].map((id) => id.trim().toLowerCase()).filter(Boolean)),
    failed: new Set([...progress.failed].map((id) => id.trim().toLowerCase()).filter(Boolean)),
    objectives: progress.objectives.map((item) => ({ ...item })),
  };
}

function taskStatus(progress: TaskProgress, id: string): "done" | "failed" | "started" | "none" {
  if (progress.done.has(id)) return "done";
  if (progress.failed.has(id)) return "failed";
  if (progress.started.has(id)) return "started";
  return "none";
}

function setTaskStatus(progress: TaskProgress, id: string, status: ReturnType<typeof taskStatus>) {
  progress.done.delete(id);
  progress.started.delete(id);
  progress.failed.delete(id);
  if (status === "done") progress.done.add(id);
  else if (status === "failed") progress.failed.add(id);
  else if (status === "started") progress.started.add(id);
}

function objectiveKey(taskId: string, objectiveId: string) {
  return `${taskId.trim().toLowerCase()}\u0000${objectiveId.trim().toLowerCase()}`;
}

function objectiveMap(items: ObjectiveDone[]) {
  return new Map(items.map((item) => [objectiveKey(item.task_id, item.objective_id), item]));
}

export function mergeTaskProgress(
  base: TaskProgress,
  proposed: TaskProgress,
  latest: TaskProgress,
) {
  const merged = cloneTaskProgress(latest);
  let applied = 0;
  const taskIds = new Set([
    ...base.done,
    ...base.started,
    ...base.failed,
    ...proposed.done,
    ...proposed.started,
    ...proposed.failed,
  ]);
  for (const id of taskIds) {
    const before = taskStatus(base, id);
    const next = taskStatus(proposed, id);
    if (next === before || taskStatus(latest, id) !== before) continue;
    setTaskStatus(merged, id, next);
    applied += 1;
  }

  const baseObjectives = objectiveMap(base.objectives);
  const proposedObjectives = objectiveMap(proposed.objectives);
  const latestObjectives = objectiveMap(latest.objectives);
  const mergedObjectives = objectiveMap(merged.objectives);
  const objectiveKeys = new Set([...baseObjectives.keys(), ...proposedObjectives.keys()]);
  for (const key of objectiveKeys) {
    const before = baseObjectives.has(key);
    const next = proposedObjectives.has(key);
    if (next === before || latestObjectives.has(key) !== before) continue;
    if (next) {
      const item = proposedObjectives.get(key);
      if (item) mergedObjectives.set(key, { ...item });
    } else {
      mergedObjectives.delete(key);
    }
    applied += 1;
  }
  merged.objectives = [...mergedObjectives.values()];
  return { progress: merged, applied };
}

export function taskProgressBody(progress: TaskProgress) {
  return {
    task_ids: [...progress.done],
    started_ids: [...progress.started],
    failed_ids: [...progress.failed],
    objective_dones: progress.objectives.map((item) => ({ ...item })),
    replace: true,
  };
}

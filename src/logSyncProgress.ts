import {
  mergeTaskProgress,
  readTaskProgress,
  serializeTaskProgress,
  taskProgressBody,
  type TaskProgress,
} from "./taskProgressQueue.ts";

export type LogSyncCatalog = {
  names: Map<string, string>;
  prereq: Map<string, string[]>;
  mutex: Map<string, string[]>;
};

function stringIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      String(item || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

export function indexLogSyncCatalog(raw: unknown): LogSyncCatalog | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const items = (raw as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;

  const names = new Map<string, string>();
  const prereq = new Map<string, string[]>();
  const mutex = new Map<string, string[]>();
  for (const value of items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const id = String(item.id || "")
      .trim()
      .toLowerCase();
    if (!id) continue;
    names.set(id, String(item.name || id));
    prereq.set(id, stringIds(item.prereq_ids || item.prereqIds));
    mutex.set(id, stringIds(item.mutex_ids || item.mutexIds));
  }
  for (const [id, related] of prereq)
    prereq.set(
      id,
      related.filter((relatedId) => names.has(relatedId)),
    );
  for (const [id, related] of mutex)
    mutex.set(
      id,
      related.filter((relatedId) => names.has(relatedId)),
    );
  return names.size ? { names, prereq, mutex } : null;
}

export type LogSyncCommitResult = {
  cancelled: boolean;
  wrote: boolean;
  latest: TaskProgress;
  progress: TaskProgress;
};

export function commitLogSyncProgress(
  base: TaskProgress,
  proposed: TaskProgress,
  deps: {
    isCurrent: () => boolean;
    readLatest: () => Promise<Record<string, unknown>>;
    writeProgress: (body: ReturnType<typeof taskProgressBody>) => Promise<unknown>;
  },
): Promise<LogSyncCommitResult> {
  return serializeTaskProgress(async () => {
    if (!deps.isCurrent()) return { cancelled: true, wrote: false, latest: base, progress: base };

    const latest = readTaskProgress(await deps.readLatest());
    if (!deps.isCurrent()) return { cancelled: true, wrote: false, latest, progress: latest };

    const merged = mergeTaskProgress(base, proposed, latest);
    if (merged.applied) {
      if (!deps.isCurrent())
        return { cancelled: true, wrote: false, latest, progress: merged.progress };
      await deps.writeProgress(taskProgressBody(merged.progress));
      return { cancelled: !deps.isCurrent(), wrote: true, latest, progress: merged.progress };
    }
    return { cancelled: !deps.isCurrent(), wrote: false, latest, progress: merged.progress };
  });
}

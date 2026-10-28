import assert from "node:assert/strict";
import test from "node:test";
import {
  currentTaskProgressAccountEpoch,
  invalidateTaskProgressAccount,
  readTaskProgress,
  taskProgressAccountEpochIsCurrent,
} from "../src/taskProgressQueue.ts";
import { commitLogSyncProgress, indexLogSyncCatalog } from "../src/logSyncProgress.ts";

test("rejects an unavailable or empty task catalog", () => {
  assert.equal(indexLogSyncCatalog(null), null);
  assert.equal(indexLogSyncCatalog({ items: [] }), null);
  assert.equal(indexLogSyncCatalog({ items: [null, {}, { id: " " }] }), null);
});

test("indexes task ids and their prerequisite and mutex relationships", () => {
  const catalog = indexLogSyncCatalog({
    items: [
      {
        id: " TASK-A ",
        name: "Task A",
        prereq_ids: ["TASK-B", "UNKNOWN"],
        mutexIds: ["TASK-C", "UNKNOWN"],
      },
      { id: "TASK-B", name: "Task B" },
      { id: "TASK-C", name: "Task C" },
    ],
  });

  assert.ok(catalog);
  assert.equal(catalog.names.get("task-a"), "Task A");
  assert.deepEqual(catalog.prereq.get("task-a"), ["task-b"]);
  assert.deepEqual(catalog.mutex.get("task-a"), ["task-c"]);
});

test("does not commit a log sync after its account changes during the latest read", async () => {
  const accountEpoch = currentTaskProgressAccountEpoch();
  const base = readTaskProgress({});
  const proposed = readTaskProgress({ task_ids: ["completed-task"] });
  let markReadStarted;
  let finishRead;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const readGate = new Promise((resolve) => {
    finishRead = resolve;
  });
  let writes = 0;

  const commit = commitLogSyncProgress(base, proposed, {
    isCurrent: () => taskProgressAccountEpochIsCurrent(accountEpoch),
    readLatest: async () => {
      markReadStarted();
      await readGate;
      return {};
    },
    writeProgress: async () => {
      writes += 1;
    },
  });

  await readStarted;
  invalidateTaskProgressAccount();
  finishRead();

  const result = await commit;
  assert.equal(result.cancelled, true);
  assert.equal(result.wrote, false);
  assert.equal(writes, 0);
});

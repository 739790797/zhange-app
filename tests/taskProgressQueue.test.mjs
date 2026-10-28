import assert from "node:assert/strict";
import test from "node:test";
import {
  currentTaskProgressAccountEpoch,
  exponentialBackoffMs,
  invalidateTaskProgressAccount,
  mergeTaskProgress,
  readTaskProgress,
  roomTaskProgressMode,
  serializeTaskProgress,
  taskProgressAccountEpochIsCurrent,
  taskProgressBody,
} from "../src/taskProgressQueue.ts";

test("caps exponential retry delays and handles invalid attempt counts", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 12].map((attempt) => exponentialBackoffMs(attempt)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
  assert.equal(exponentialBackoffMs(-1), 1_000);
  assert.equal(exponentialBackoffMs(Number.NaN), 1_000);
});

test("merges local task changes while keeping newer remote conflicts", () => {
  const base = readTaskProgress({
    task_ids: ["removed"],
    started_ids: ["conflicted"],
    objective_dones: [{ task_id: "local", objective_id: "old" }],
  });
  const proposed = readTaskProgress({
    task_ids: ["local"],
    objective_dones: [{ task_id: "local", objective_id: "new" }],
  });
  const latest = readTaskProgress({
    task_ids: ["removed", "remote"],
    failed_ids: ["conflicted"],
    objective_dones: [
      { task_id: "local", objective_id: "old" },
      { task_id: "remote", objective_id: "kept" },
    ],
  });

  const merged = mergeTaskProgress(base, proposed, latest);

  assert.deepEqual([...merged.progress.done].sort(), ["local", "remote"]);
  assert.deepEqual([...merged.progress.failed], ["conflicted"]);
  assert.deepEqual(
    merged.progress.objectives
      .map(({ task_id, objective_id }) => `${task_id}/${objective_id}`)
      .sort(),
    ["local/new", "remote/kept"],
  );
  assert.equal(merged.applied, 4);
});

test("serializes task progress operations in submission order", async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const first = serializeTaskProgress(async () => {
    events.push("first:start");
    await gate;
    events.push("first:end");
    return 1;
  });
  const second = serializeTaskProgress(async () => {
    events.push("second");
    return 2;
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("cancels a queued progress write after the account epoch changes", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const blocker = serializeTaskProgress(async () => gate);
  const accountEpoch = currentTaskProgressAccountEpoch();
  let writes = 0;
  const queuedWrite = serializeTaskProgress(async () => {
    if (!taskProgressAccountEpochIsCurrent(accountEpoch)) return false;
    writes += 1;
    return true;
  });

  invalidateTaskProgressAccount();
  release();

  await blocker;
  assert.equal(await queuedWrite, false);
  assert.equal(writes, 0);
  assert.equal(taskProgressAccountEpochIsCurrent(accountEpoch), false);
});

test("checks the account epoch again after a progress read and before writing", async () => {
  let finishRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const readGate = new Promise((resolve) => {
    finishRead = resolve;
  });
  const accountEpoch = currentTaskProgressAccountEpoch();
  let writes = 0;
  const save = serializeTaskProgress(async () => {
    if (!taskProgressAccountEpochIsCurrent(accountEpoch)) return false;
    markReadStarted();
    await readGate;
    if (!taskProgressAccountEpochIsCurrent(accountEpoch)) return false;
    writes += 1;
    return true;
  });

  await readStarted;
  invalidateTaskProgressAccount();
  finishRead();

  assert.equal(await save, false);
  assert.equal(writes, 0);
});

test("uses an explicit replacement payload for the room progress API", () => {
  const progress = readTaskProgress({
    task_ids: ["done"],
    failed_ids: ["failed"],
    started_ids: ["active"],
  });
  assert.deepEqual(taskProgressBody(progress), {
    task_ids: ["done"],
    started_ids: ["active"],
    failed_ids: ["failed"],
    objective_dones: [],
    replace: true,
  });
});

test("uses the room game mode for shared room task progress", () => {
  assert.equal(roomTaskProgressMode({ game_mode: "pvp" }, "pve"), "pvp");
  assert.equal(roomTaskProgressMode({ gameMode: "PVE" }, "pvp"), "pve");
  assert.equal(roomTaskProgressMode({ game_mode: "unknown" }, "pvp"), "pvp");
  assert.equal(roomTaskProgressMode(null, "pve"), "pve");
});

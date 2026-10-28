import assert from "node:assert/strict";
import { test } from "node:test";
import { LatestReadGuard } from "../src/snapshotRevision.ts";

test("accepts an initial read until a live update arrives", () => {
  const guard = new LatestReadGuard();
  const read = guard.capture();

  assert.equal(guard.isCurrent(read), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(read), false);
});

test("a later read captures the revision after live updates", () => {
  const guard = new LatestReadGuard();
  const stale = guard.capture();
  guard.invalidate();
  const current = guard.capture();

  assert.equal(guard.isCurrent(stale), false);
  assert.equal(guard.isCurrent(current), true);
});

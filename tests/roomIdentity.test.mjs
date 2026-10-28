import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRoomIdentity, sameRoomIdentity } from "../src/roomIdentity.ts";

test("room identity comparison trims and folds supported ASCII IDs", () => {
  assert.equal(normalizeRoomIdentity(" ABCDEF12 "), "abcdef12");
  assert.equal(sameRoomIdentity("ABCDEF12", "abcdef12"), true);
  assert.equal(sameRoomIdentity(" pve-2 ", "PVE-2"), true);
  assert.equal(sameRoomIdentity("", ""), false);
  assert.equal(sameRoomIdentity("room1", "room2"), false);
});

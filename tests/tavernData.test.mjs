import assert from "node:assert/strict";
import test from "node:test";
import {
  boundTavernBody,
  limitTavernText,
  MAX_TAVERN_BODY_CHARS,
  MAX_TAVERN_COMMENTS,
  normalizeTavernComments,
  orderTavernComments,
} from "../src/tavernData.ts";

test("caps oversized article bodies before parsing or rendering", () => {
  const result = boundTavernBody("x".repeat(MAX_TAVERN_BODY_CHARS + 20));
  assert.equal(result.text.length, MAX_TAVERN_BODY_CHARS);
  assert.equal(result.truncated, true);
  assert.deepEqual(boundTavernBody({ unexpected: true }), { text: "", truncated: false });
});

test("limits untrusted UI text to a bounded string", () => {
  assert.equal(limitTavernText("abcdef", 3), "abc");
  assert.equal(limitTavernText({ unexpected: true }, 10), "");
  assert.equal(limitTavernText("abcdef", -1), "");
});

test("normalizes comment fields and drops malformed or duplicate IDs", () => {
  const result = normalizeTavernComments([
    { id: "1", body: "hello", parent_id: null, author: { display_name: "Reader" } },
    { id: 1, body: "duplicate", parent_id: null },
    { id: "bad", body: "invalid" },
    { id: 2, body: 123, parent_id: "1", created_at: "2026-01-01" },
  ]);

  assert.deepEqual(result, {
    items: [
      { id: 1, body: "hello", parent_id: null, author: { display_name: "Reader" } },
      { id: 2, body: "", parent_id: 1, created_at: "2026-01-01" },
    ],
    truncated: false,
  });
});

test("orders replies in linear grouping order and leaves orphan replies hidden", () => {
  const { items } = normalizeTavernComments([
    { id: 2, body: "reply", parent_id: 1 },
    { id: 3, body: "root two", parent_id: null },
    { id: 1, body: "root one", parent_id: null },
    { id: 4, body: "orphan", parent_id: 88 },
  ]);

  assert.deepEqual(
    orderTavernComments(items).map((item) => item.id),
    [3, 1, 2],
  );
});

test("caps comment rendering input and marks the list as truncated", () => {
  const raw = Array.from({ length: MAX_TAVERN_COMMENTS + 2 }, (_, index) => ({
    id: index + 1,
    body: "x".repeat(2_500),
    parent_id: null,
  }));
  const result = normalizeTavernComments(raw);

  assert.equal(result.items.length, MAX_TAVERN_COMMENTS);
  assert.equal(result.items[0].body.length, 2_000);
  assert.equal(result.truncated, true);
});

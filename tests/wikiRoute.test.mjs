import assert from "node:assert/strict";
import test from "node:test";
import { matchWiki, readWikiHits, wikiHref } from "../src/wikiRoute.ts";

test("matches valid wiki routes and rejects incomplete or unknown routes", () => {
  assert.deepEqual(matchWiki("/主菜单/逃离塔科夫/物品/itm-1"), {
    kind: "item",
    id: "itm-1",
    crumb: "物品",
  });
  assert.equal(matchWiki("/主菜单/逃离塔科夫/未知/id"), null);
  assert.equal(matchWiki("/主菜单/逃离塔科夫/物品"), null);
  assert.equal(matchWiki("/主菜单/逃离塔科夫/物品/id/extra"), null);
});

test("builds wiki links with encoded IDs and rejects unknown kinds", () => {
  assert.equal(wikiHref("task", "任务 A"), "/主菜单/逃离塔科夫/任务/%E4%BB%BB%E5%8A%A1%20A");
  assert.equal(wikiHref("unknown", "id"), "");
});

test("normalizes search hits using kind-specific identifiers", () => {
  assert.deepEqual(
    readWikiHits(
      [
        { name: "Prapor", id: "trader-id", slug: "prapor", iconLink: "/icon.png" },
        { name: "missing id" },
        null,
      ],
      "trader",
    ),
    [
      {
        name: "Prapor",
        extra: "",
        mapSlug: "",
        kind: "trader",
        id: "prapor",
        icon: "/icon.png",
      },
    ],
  );
  assert.deepEqual(readWikiHits({ items: [] }, "item"), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { decodePathname, tavernMatch, TAVERN_BASE } from "../src/routePath.ts";

test("decodes browser paths and removes a trailing slash", () => {
  assert.equal(decodePathname("/%E4%B8%BB%E8%8F%9C%E5%8D%95/"), "/主菜单");
});

test("keeps malformed escapes usable instead of throwing during routing", () => {
  assert.equal(decodePathname("/bad%escape/"), "/bad%escape");
});

test("matches the tavern base and percent-encoded article paths", () => {
  assert.deepEqual(tavernMatch(encodeURI(`${TAVERN_BASE}/記事`)), {
    kind: "article",
    slug: "記事",
  });
  assert.deepEqual(tavernMatch(encodeURI(`${TAVERN_BASE}/`)), { kind: "list" });
  assert.equal(tavernMatch("/other"), null);
});

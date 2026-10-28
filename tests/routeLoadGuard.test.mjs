import assert from "node:assert/strict";
import test from "node:test";
import { createRouteLoadGuard } from "../src/routeLoadGuard.ts";

test("only the latest paint can commit a route module load", () => {
  const guard = createRouteLoadGuard();
  const first = guard.begin("/main/workbench");
  const second = guard.begin("/main/map");

  assert.equal(guard.isCurrent(first, "/main/workbench"), false);
  assert.equal(guard.isCurrent(second, "/main/map"), true);
});

test("a repeated paint invalidates an older load even on the same route", () => {
  const guard = createRouteLoadGuard();
  const first = guard.begin("/main/workbench?gun=one");
  const second = guard.begin("/main/workbench?gun=one");

  assert.equal(guard.isCurrent(first, "/main/workbench?gun=one"), false);
  assert.equal(guard.isCurrent(second, "/main/workbench?gun=one"), true);
  assert.equal(guard.isCurrent(second, "/main/workbench?gun=two"), false);
});

test("a stale dynamic import neither installs a page nor shows its load error", async () => {
  const guard = createRouteLoadGuard();
  const ticket = guard.begin("/main/ammo");
  let resolveImport;
  const imported = new Promise((resolve) => {
    resolveImport = resolve;
  });
  const actions = [];
  const loading = guard.load(
    ticket,
    () => "/main/menu",
    () => imported,
    () => actions.push("install"),
    () => actions.push("error"),
  );
  resolveImport({ mount: () => undefined });

  assert.equal(await loading, false);
  assert.deepEqual(actions, []);
});

test("a superseded route ignores a rejected dynamic import", async () => {
  const guard = createRouteLoadGuard();
  const ticket = guard.begin("/main/keys");
  let rejectImport;
  const imported = new Promise((_resolve, reject) => {
    rejectImport = reject;
  });
  const actions = [];
  const loading = guard.load(
    ticket,
    () => "/main/boss",
    () => imported,
    () => actions.push("install"),
    () => actions.push("error"),
  );
  guard.begin("/main/boss");
  rejectImport(new Error("chunk failed"));

  assert.equal(await loading, false);
  assert.deepEqual(actions, []);
});

test("the latest route load installs once and reports only its own failure", async () => {
  const guard = createRouteLoadGuard();
  const ticket = guard.begin("/main/boss");
  const actions = [];
  const installed = await guard.load(
    ticket,
    () => "/main/boss",
    async () => ({ shell: "boss" }),
    (module) => actions.push(module.shell),
    () => actions.push("error"),
  );

  assert.equal(installed, true);
  assert.deepEqual(actions, ["boss"]);

  const failed = await guard.load(
    ticket,
    () => "/main/boss",
    async () => {
      throw new Error("import failed");
    },
    () => actions.push("stale-install"),
    () => actions.push("error"),
  );
  assert.equal(failed, false);
  assert.deepEqual(actions, ["boss", "error"]);
});

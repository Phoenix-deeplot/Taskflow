import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalStore, normalizeState } from "../scripts/local-store.mjs";
import { decideStartup } from "../scripts/startup-policy.mjs";

function withStore(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-sqlite-"));
  const store = createLocalStore(directory);
  try { run(store); }
  finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("new database reports uninitialized until first save", () => {
  withStore((store) => assert.deepEqual(store.read(), { initialized: false, state: null }));
});

test("state survives store reopen with all workspace collections", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-sqlite-"));
  const expected = {
    schemaVersion: 1,
    items: [{ id: "REQ-1", title: "测试需求" }],
    tasks: [{ id: "TASK-1", featureId: "REQ-1", status: "queued" }],
    events: [{ id: "EV-1", action: "创建需求" }],
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
  let store = createLocalStore(directory);
  store.write(expected);
  store.close();
  store = createLocalStore(directory);
  try {
    assert.equal(store.read().initialized, true);
    assert.deepEqual(store.read().state, expected);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid payloads are rejected rather than clearing the saved state", () => {
  withStore((store) => {
    store.write({ schemaVersion: 1, items: [{ id: "A" }], tasks: [], events: [], updatedAt: "now" });
    assert.throws(() => store.write({ items: "not-an-array" }), /arrays/);
    assert.equal(store.read().state.items[0].id, "A");
  });
});

test("event history is capped and state has a 10 MB limit", () => {
  assert.equal(normalizeState({ items: [], tasks: [], events: Array(2005).fill({ id: "e" }) }).events.length, 2000);
  assert.throws(() => normalizeState({ items: [{ id: "large", text: "x".repeat(10 * 1024 * 1024) }], tasks: [], events: [] }), /10 MB/);
});

const emptyState = { schemaVersion: 1, items: [], tasks: [], events: [], updatedAt: "2026-10-19T00:00:00.000Z" };

test("empty database with no saved browser data remains uninitialized", () => {
  assert.deepEqual(decideStartup({ database: { initialized: false }, local: { present: false } }), {
    action: "start-empty", state: null, writeDatabase: false, backupLocal: false,
  });
});

test("empty local cache does not initialize an empty database", () => {
  assert.equal(decideStartup({ database: { initialized: false }, local: { present: true, valid: true, state: emptyState } }).writeDatabase, false);
});

test("real browser data migrates into an empty database with a backup", () => {
  const state = { ...emptyState, items: [{ id: "REQ-1", title: "Keep me" }] };
  const decision = decideStartup({ database: { initialized: false }, local: { present: true, valid: true, state } });
  assert.equal(decision.action, "migrate-local");
  assert.equal(decision.writeDatabase, true);
  assert.equal(decision.backupLocal, true);
  assert.equal(decision.state.items[0].id, "REQ-1");
});

test("newer local cache requires a user choice instead of being overwritten", () => {
  const databaseState = { ...emptyState, updatedAt: "2026-10-18T00:00:00.000Z", items: [{ id: "REQ-DB", title: "Database" }] };
  const localState = { ...emptyState, items: [{ id: "REQ-CACHE", title: "Cached edit" }] };
  const decision = decideStartup({ database: { initialized: true, state: databaseState }, local: { present: true, valid: true, state: localState } });
  assert.equal(decision.action, "choose-newer-local");
  assert.equal(decision.backupLocal, true);
  assert.equal(decision.databaseState.items[0].id, "REQ-DB");
});

test("non-empty local cache is offered for recovery when the initialized database is empty", () => {
  const databaseState = { ...emptyState, updatedAt: "2026-10-20T00:00:00.000Z" };
  const localState = { ...emptyState, updatedAt: "2026-10-18T00:00:00.000Z", items: [{ id: "REQ-CACHE", title: "Recover me" }] };
  assert.equal(decideStartup({ database: { initialized: true, state: databaseState }, local: { present: true, valid: true, state: localState } }).action, "choose-newer-local");
});

test("different equal-or-older local state is marked for backup before database wins", () => {
  const databaseState = { ...emptyState, items: [{ id: "REQ-DB", title: "Database" }] };
  const localState = { ...emptyState, updatedAt: "2026-10-18T00:00:00.000Z", items: [{ id: "REQ-OLD", title: "Older cache" }] };
  const decision = decideStartup({ database: { initialized: true, state: databaseState }, local: { present: true, valid: true, state: localState } });
  assert.equal(decision.action, "use-database");
  assert.equal(decision.backupLocal, true);
  assert.equal(decision.state.items[0].id, "REQ-DB");
});

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLegacyState } from "../server/legacy-payload.mjs";
import { decideStartup } from "../scripts/startup-policy.mjs";

const emptyState = { schemaVersion: 1, items: [], tasks: [], events: [], updatedAt: "2026-10-19T00:00:00.000Z" };

test("empty database with no saved browser data remains uninitialized", () => {
  assert.deepEqual(decideStartup({ database: { initialized: false }, local: { present: false } }), {
    action: "start-empty", state: null, writeDatabase: false, backupLocal: false,
  });
});

test("empty local cache does not initialize an empty database", () => {
  const result = decideStartup({ database: { initialized: false }, local: { present: true, valid: true, state: emptyState } });
  assert.equal(result.action, "start-empty");
  assert.equal(result.writeDatabase, false);
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

test("non-empty local cache is offered when the initialized database is empty", () => {
  const databaseState = { ...emptyState, updatedAt: "2026-10-20T00:00:00.000Z" };
  const localState = { ...emptyState, updatedAt: "2026-10-18T00:00:00.000Z", items: [{ id: "REQ-CACHE", title: "Recover me" }] };
  assert.equal(decideStartup({ database: { initialized: true, state: databaseState }, local: { present: true, valid: true, state: localState } }).action, "choose-newer-local");
});

test("different older cache is flagged for backup before database wins", () => {
  const databaseState = { ...emptyState, items: [{ id: "REQ-DB", title: "Database" }] };
  const localState = { ...emptyState, updatedAt: "2026-10-18T00:00:00.000Z", items: [{ id: "REQ-OLD", title: "Older cache" }] };
  const decision = decideStartup({ database: { initialized: true, state: databaseState }, local: { present: true, valid: true, state: localState } });
  assert.equal(decision.action, "use-database");
  assert.equal(decision.backupLocal, true);
  assert.equal(decision.state.items[0].id, "REQ-DB");
});

test("identical content ignores updatedAt-only differences", () => {
  const localState = { ...emptyState, updatedAt: "2026-10-20T00:00:00.000Z" };
  assert.equal(decideStartup({ database: { initialized: true, state: emptyState }, local: { present: true, valid: true, state: localState } }).backupLocal, false);
});

test("legacy payload validation caps event history and rejects oversize imports", () => {
  assert.equal(normalizeLegacyState({ items: [], tasks: [], events: Array(2005).fill({ id: "e" }) }).events.length, 2000);
  assert.throws(() => normalizeLegacyState({ items: [{ text: "x".repeat(10 * 1024 * 1024) }], tasks: [], events: [] }), /10 MB/);
  assert.throws(() => normalizeLegacyState({ items: "bad", tasks: [], events: [] }), /arrays/);
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { backupDatabase, listMigrations, openDatabase, schemaVersion } from "../../server/db.mjs";
import { createWorkbench } from "../../server/service.mjs";
import { count, makeClock, memoryWorkbench, tempDirectory } from "./helpers.mjs";

test("fresh database is migrated and seeded with the single local workspace", () => {
  const db = openDatabase(":memory:");
  assert.equal(schemaVersion(db), listMigrations().at(-1).version);
  assert.equal(count(db, "workspaces"), 1);
  assert.equal(db.prepare("SELECT id FROM workspaces").get().id, "WS-LOCAL");
  assert.equal(count(db, "workspace_context_versions"), 1);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

test("data survives closing and reopening the database file; reopening does not reseed", () => {
  const { directory, cleanup } = tempDirectory();
  const file = path.join(directory, "workbench.sqlite");
  try {
    let db = openDatabase(file);
    let wb = createWorkbench(db, { clock: makeClock() });
    const requirement = wb.createRequirement({ title: "刷新后仍在" });
    const task = wb.createTask({ requirementId: requirement.id, taskText: "任务" });
    wb.startTask(task.id);
    db.close();

    db = openDatabase(file);
    wb = createWorkbench(db, { clock: makeClock("2026-10-20T00:00:00.000Z") });
    assert.equal(wb.getRequirement(requirement.id).title, "刷新后仍在");
    assert.equal(wb.getTask(task.id).status, "working");
    assert.equal(wb.getTask(task.id).runs.length, 1);
    assert.equal(count(db, "workspaces"), 1);
    assert.equal(count(db, "workspace_context_versions"), 1);
    db.close();
  } finally { cleanup(); }
});

test("backupDatabase writes a consistent, readable copy", () => {
  const { directory, cleanup } = tempDirectory();
  try {
    const db = openDatabase(path.join(directory, "workbench.sqlite"));
    const wb = createWorkbench(db, { clock: makeClock() });
    const requirement = wb.createRequirement({ title: "备份内容" });
    const target = backupDatabase(db, path.join(directory, "backups"), "manual");
    assert.ok(existsSync(target));
    const copy = openDatabase(target);
    assert.equal(createWorkbench(copy).getRequirement(requirement.id).title, "备份内容");
    copy.close(); db.close();
  } finally { cleanup(); }
});

test("snapshots are immutable and events are append-only at the database level", () => {
  const { db, wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  const { snapshot } = wb.startTask(task.id);
  assert.throws(() => db.prepare("UPDATE task_context_snapshots SET prompt_text = 'x' WHERE id = ?").run(snapshot.id), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM task_context_snapshots WHERE id = ?").run(snapshot.id), /immutable/);
  assert.throws(() => db.prepare("UPDATE events SET event_type = 'x'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM events").run(), /append-only/);
});

test("the database refuses a second running run for the same task", () => {
  const { db, wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  const { snapshot } = wb.startTask(task.id);
  assert.throws(
    () => db.prepare(`INSERT INTO task_runs (id, task_id, snapshot_id, attempt, status, started_at) VALUES ('RUN-X', ?, ?, 2, 'running', 'now')`).run(task.id, snapshot.id),
    /UNIQUE/,
  );
});

test("a non-legacy run cannot exist without a snapshot", () => {
  const { db, wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  assert.throws(
    () => db.prepare(`INSERT INTO task_runs (id, task_id, snapshot_id, attempt, status, started_at) VALUES ('RUN-X', ?, NULL, 1, 'running', 'now')`).run(task.id),
    /CHECK/,
  );
});

test("application timestamps are UTC ISO-8601 with milliseconds and Z", () => {
  const { db, wb } = memoryWorkbench();
  wb.createRequirement({ title: "时间格式" });
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  for (const row of db.prepare("SELECT created_at FROM requirements UNION ALL SELECT created_at FROM events UNION ALL SELECT created_at FROM workspaces").all()) {
    assert.match(row.created_at, iso);
  }
});

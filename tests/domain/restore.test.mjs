import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../../server/db.mjs";
import { commitLegacyImport } from "../../server/legacy-import.mjs";
import { createDatabaseFromExport, previewRestore, restoreFromExport } from "../../server/restore.mjs";
import { createWorkbench } from "../../server/service.mjs";
import { count, makeClock, memoryWorkbench, tempDirectory } from "./helpers.mjs";

/** A workbench with a bit of everything, so a round trip has something to lose. */
function richWorkbench() {
  const { db, wb } = memoryWorkbench();
  commitLegacyImport(db, {
    items: [{ id: "REQ-LEG01", title: "旧需求", module: "旧", decision: "keep", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" }],
    tasks: [{ id: "TASK-LEG01", featureId: "REQ-LEG01", model: "claude", status: "working", task: "旧任务", suggestion: "旧建议" }],
    events: [{ id: 1.5, entityType: "feature", entityId: "REQ-LEG01", action: "新增需求", actor: "我", createdAt: "2026-09-01T00:00:00.000Z" }],
  });
  const requirement = wb.createRequirement({ title: "新需求", description: "说明" });
  const split = wb.splitRequirement(requirement.id, [
    { key: "a", taskText: "A", acceptance: ["ok"] },
    { key: "b", taskText: "B", dependsOn: ["a"], resultNote: "备注" },
  ]);
  const [a] = split.tasks;
  const first = wb.startTask(a.id);
  wb.reportFailure(first.run.id, { message: "失败了" });
  const second = wb.startTask(a.id);
  wb.submitResult(second.run.id, { summary: "好了", evidence: [{ kind: "test", ref: "x", note: "" }] });
  wb.acceptTask(a.id, { note: "同意" });
  wb.appendContextVersion({ rules: ["规则一"] });
  return { db, wb };
}

const withoutTime = (doc) => ({ ...doc, exportedAt: undefined });
const roundTrip = (doc) => JSON.parse(JSON.stringify(doc));

test("a full export restores into an empty database with nothing lost", () => {
  const { wb } = richWorkbench();
  const exported = roundTrip(wb.exportAll());
  const target = memoryWorkbench();
  const report = restoreFromExport(target.db, exported, { recordEvent: false });
  assert.equal(report.status, "restored");
  assert.deepEqual(withoutTime(target.wb.exportAll()), withoutTime(exported));
  assert.equal(target.wb.getContext().revision, 2);
  assert.equal(target.wb.getTask("TASK-LEG01").resultNote, "旧建议");
});

test("a restored database keeps working: new ids, new snapshots and new events continue after the old ones", () => {
  const { wb } = richWorkbench();
  const exported = roundTrip(wb.exportAll());
  const maxEvent = Math.max(...exported.events.map((e) => e.id));
  const target = memoryWorkbench();
  restoreFromExport(target.db, exported, { recordEvent: false });
  const legacy = target.wb.listRuns("TASK-LEG01")[0];
  target.wb.submitResult(legacy.id, { summary: "恢复后继续" });
  const requirement = target.wb.createRequirement({ title: "恢复后新增" });
  assert.ok(target.wb.listEvents({ limit: 1 })[0].id > maxEvent);
  const task = target.wb.createTask({ requirementId: requirement.id, taskText: "t" });
  assert.equal(target.wb.startTask(task.id).run.attempt, 1);
  // Task A was accepted before the export, so B's dependency is satisfied and B can start.
  const b = exported.tasks.find((t) => t.task_text === "B");
  assert.equal(target.wb.getTask(b.id).readiness.ready, true);
  assert.equal(target.wb.startTask(b.id).snapshot.payload.dependencies[0].status, "done");
});

test("preview reports counts and writes nothing", () => {
  const { wb } = richWorkbench();
  const exported = roundTrip(wb.exportAll());
  const target = memoryWorkbench();
  const report = previewRestore(target.db, exported);
  assert.equal(report.status, "ready");
  assert.equal(report.counts.requirements, exported.requirements.length);
  assert.equal(report.counts.events, exported.events.length);
  assert.equal(count(target.db, "requirements"), 0);
  assert.equal(count(target.db, "events"), 0);
});

test("a restore event is recorded by default and backups are taken when asked", () => {
  const { directory, cleanup } = tempDirectory();
  try {
    const { wb } = richWorkbench();
    const exported = roundTrip(wb.exportAll());
    const target = memoryWorkbench();
    const report = restoreFromExport(target.db, exported, { backupDirectory: path.join(directory, "backups") });
    assert.ok(existsSync(report.backupPath));
    assert.equal(readdirSync(path.join(directory, "backups")).length, 1);
    const last = target.wb.listEvents({ limit: 1 })[0];
    assert.equal(last.eventType, "restore.completed");
    assert.equal(last.payload.counts.requirements, exported.requirements.length);
  } finally { cleanup(); }
});

test("restoring into a database that already has data is refused and changes nothing", () => {
  const { wb } = richWorkbench();
  const exported = roundTrip(wb.exportAll());
  const target = memoryWorkbench();
  target.wb.createRequirement({ title: "已有数据" });
  const before = JSON.stringify(withoutTime(target.wb.exportAll()));
  assert.throws(() => restoreFromExport(target.db, exported), (e) => e.code === "NOT_EMPTY" && e.status === 409);
  assert.equal(previewRestore(target.db, exported).status, "not_empty");
  assert.equal(JSON.stringify(withoutTime(target.wb.exportAll())), before);
});

test("unusable exports are rejected with a reason", () => {
  const { wb } = richWorkbench();
  const good = roundTrip(wb.exportAll());
  const target = memoryWorkbench();
  const reason = (doc) => previewRestore(target.db, doc).problems.join(" | ");

  assert.match(reason(null), /不是对象/);
  assert.match(reason([]), /不是对象/);
  assert.match(reason({ schemaVersion: 1, items: [] }), /旧版.*迁移/);
  assert.match(reason({ items: [], tasks: [], events: [] }), /旧版.*迁移/);
  assert.match(reason({ schemaVersion: 9 }), /不支持/);
  assert.match(reason({ ...good, workspace: { id: "WS-OTHER" } }), /工作区/);
  assert.match(reason({ ...good, tasks: undefined }), /缺少数组：tasks/);
  assert.match(reason({ ...good, requirements: [good.requirements[0], good.requirements[0]] }), /id 重复/);
  assert.match(reason({ ...good, tasks: [{ ...good.tasks[0], requirement_id: "REQ-NOPE" }] }), /不存在的需求/);
  assert.match(reason({ ...good, taskDependencies: [{ task_id: "TASK-X", depends_on_task_id: "TASK-Y" }] }), /不存在的任务/);
  assert.match(reason({ ...good, runs: [{ ...good.runs[0], snapshot_id: "SNAP-NOPE" }] }), /不存在的快照/);
  assert.match(reason({ ...good, events: [{ ...good.events[0], workspace_id: "WS-OTHER" }] }), /其他工作区/);
  assert.throws(() => restoreFromExport(target.db, { schemaVersion: 9 }), (e) => e.code === "INVALID_EXPORT");
});

test("a failure part-way through rolls back completely, including the seeded context", () => {
  const { wb } = richWorkbench();
  const broken = roundTrip(wb.exportAll());
  broken.runs[broken.runs.length - 1].status = "exploded"; // violates the CHECK constraint on insert
  const target = memoryWorkbench();
  const seededContext = JSON.stringify(target.wb.listContextVersions());
  assert.throws(() => restoreFromExport(target.db, broken), (e) => e.code === "RESTORE_FAILED" && /数据库未改变/.test(e.message));
  for (const table of ["requirements", "tasks", "task_runs", "task_context_snapshots", "events"]) assert.equal(count(target.db, table), 0, table);
  assert.equal(JSON.stringify(target.wb.listContextVersions()), seededContext);
  assert.equal(previewRestore(target.db, roundTrip(wb.exportAll())).status, "ready");
});

test("unknown columns are ignored with a warning; missing optional sections are fine", () => {
  const { wb } = richWorkbench();
  const doc = roundTrip(wb.exportAll());
  doc.requirements[0].future_field = "x";
  delete doc.migrationSources;
  const target = memoryWorkbench();
  const report = previewRestore(target.db, doc);
  assert.equal(report.status, "ready");
  assert.match(report.warnings.join(), /未知字段/);
  assert.equal(restoreFromExport(target.db, doc, { recordEvent: false }).status, "restored");
  assert.equal(count(target.db, "migration_sources"), 0);
});

test("createDatabaseFromExport builds a new file, reopens cleanly, and never overwrites an existing file", () => {
  const { directory, cleanup } = tempDirectory();
  try {
    const { wb } = richWorkbench();
    const exported = roundTrip(wb.exportAll());
    const file = path.join(directory, "restored.sqlite");
    const { db, report } = createDatabaseFromExport(exported, file, { recordEvent: false });
    assert.equal(report.status, "restored");
    db.close();
    const reopened = openDatabase(file);
    assert.deepEqual(withoutTime(createWorkbench(reopened, { clock: makeClock() }).exportAll()), withoutTime(exported));
    reopened.close();
    assert.throws(() => createDatabaseFromExport(exported, file), (e) => e.code === "FILE_EXISTS");

    const bad = path.join(directory, "bad.sqlite");
    assert.throws(() => createDatabaseFromExport({ schemaVersion: 9 }, bad), (e) => e.code === "INVALID_EXPORT");
  } finally { cleanup(); }
});

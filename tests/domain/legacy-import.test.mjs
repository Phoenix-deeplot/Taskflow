import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { commitLegacyImport, previewLegacyImport } from "../../server/legacy-import.mjs";
import { openDatabase } from "../../server/db.mjs";
import { createWorkbench } from "../../server/service.mjs";
import { count, makeClock, memoryWorkbench, tempDirectory } from "./helpers.mjs";

const T = (n) => `2026-09-${String(n).padStart(2, "0")}T08:00:00.000Z`;

/** Shaped like the localStorage state written by dist/index.html (events are newest-first). */
function legacyState() {
  return {
    schemaVersion: 1,
    updatedAt: T(20),
    items: [
      { id: "REQ-AAAAA", module: "工具", title: "需求一", description: "说明一", sourceVersion: "v0.1", targetVersion: "V1", decision: "keep", decisionNote: "", createdAt: T(1), updatedAt: T(2) },
      { id: "REQ-BBBBB", module: "情报", title: "需求二", description: "", sourceVersion: "v0.1", targetVersion: "V2", decision: "defer", decisionNote: "后面再说", createdAt: T(1), updatedAt: T(3) },
    ],
    tasks: [
      { id: "TASK-QUEUE", featureId: "REQ-AAAAA", model: "claude", status: "queued", assignee: "我", task: "待执行任务", suggestion: "", createdAt: T(4), updatedAt: T(4), featureTitle: "需求一", featureModule: "工具" },
      { id: "TASK-WORK1", featureId: "REQ-AAAAA", model: "chatgpt", status: "working", task: "执行中任务", suggestion: "", createdAt: T(5), updatedAt: T(6) },
      { id: "TASK-REVEW", featureId: "REQ-BBBBB", model: "deepseek", status: "review", task: "待验收任务", suggestion: "建议：做 V2", createdAt: T(5), updatedAt: T(7) },
      { id: "TASK-DONE1", featureId: "REQ-BBBBB", model: "claude", status: "done", task: "完成任务", suggestion: "已完成结论", createdAt: T(5), updatedAt: T(8) },
      { id: "TASK-BLOCK", featureId: "REQ-AAAAA", model: "claude", status: "blocked", blockedReason: "等待账号", task: "阻塞任务", createdAt: T(5), updatedAt: T(9) },
      { id: "TASK-ORPHN", featureId: "REQ-GONE1", model: "claude", status: "queued", task: "孤儿任务", createdAt: T(5), updatedAt: T(9), featureTitle: "已被删除的需求", featureModule: "旧模块" },
      { id: "TASK-SUGGS", featureId: "REQ-AAAAA", model: "claude", status: "queued", task: "有建议的待执行", suggestion: "早先记录的建议", createdAt: T(5), updatedAt: T(9) },
    ],
    events: [
      { id: 1760000003000.5, entityType: "ai_task", entityId: "TASK-DONE1", action: "任务状态：待验收 → 已完成", actor: "我", before: null, after: { status: "done" }, createdAt: T(8) },
      { id: 1760000002000.25, entityType: "feature", entityId: "REQ-BBBBB", action: "更新需求", actor: "我", before: null, after: { title: "需求二" }, createdAt: T(3) },
      { id: 1760000001000.75, entityType: "workspace", entityId: "workspace", action: "载入工具模块样例", actor: "我", before: null, after: { count: 2 }, createdAt: T(1) },
    ],
  };
}

const snapshotCounts = (db) => Object.fromEntries(
  ["requirements", "tasks", "task_runs", "events", "migration_sources", "task_context_snapshots"].map((table) => [table, count(db, table)]),
);

test("preview reports what would happen and writes nothing", () => {
  const { db } = memoryWorkbench();
  const before = snapshotCounts(db);
  const report = previewLegacyImport(db, legacyState());
  assert.equal(report.status, "ready");
  assert.deepEqual(report.counts.requirements, { total: 2, new: 2, identical: 0, conflicts: 0, invalid: 0 });
  assert.deepEqual(report.counts.tasks, { total: 7, new: 7, identical: 0, conflicts: 0, invalid: 0 });
  assert.equal(report.counts.events.new, 3);
  assert.equal(report.counts.legacyRuns, 3); // working, review and done; a note on a queued task is not a run
  assert.deepEqual(report.orphanTasks.map((t) => t.id), ["TASK-ORPHN"]);
  assert.match(report.sourceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(snapshotCounts(db), before);
});

test("commit imports everything, keeps ids, takes a backup and keeps the raw payload", () => {
  const { directory, cleanup } = tempDirectory();
  try {
    const db = openDatabase(path.join(directory, "workbench.sqlite"));
    const wb = createWorkbench(db, { clock: makeClock() });
    const state = legacyState();
    const result = commitLegacyImport(db, state, { origin: "http://127.0.0.1:4179", backupDirectory: path.join(directory, "backups") });
    assert.equal(result.committed, true);
    assert.equal(result.status, "imported");
    assert.ok(existsSync(result.backupPath));
    assert.equal(readdirSync(path.join(directory, "backups")).length, 1);

    assert.deepEqual(wb.listRequirements({ includeDeleted: true }).map((r) => r.id).sort(), ["REQ-AAAAA", "REQ-BBBBB"]);
    assert.equal(wb.getRequirement("REQ-BBBBB").decisionNote, "后面再说");
    assert.equal(wb.getRequirement("REQ-AAAAA").createdAt, T(1));
    assert.equal(wb.listTasks().length, 7);

    const source = db.prepare("SELECT * FROM migration_sources").get();
    assert.equal(source.origin, "http://127.0.0.1:4179");
    assert.deepEqual(JSON.parse(source.raw_json), state);

    const queued = wb.getTask("TASK-QUEUE");
    assert.equal(queued.provider, "claude");
    assert.equal(queued.executorType, "manual_handoff");
    assert.equal(queued.assignee, "我");
    assert.equal(queued.taskText, "待执行任务");
    assert.equal(wb.getTask("TASK-BLOCK").blockedReason, "等待账号");
    db.close();
  } finally { cleanup(); }
});

test("orphan tasks are kept without a requirement and remember the old title", () => {
  const { db, wb } = memoryWorkbench();
  commitLegacyImport(db, legacyState());
  const orphan = wb.getTask("TASK-ORPHN");
  assert.equal(orphan.requirementId, null);
  assert.equal(orphan.legacyRequirementTitle, "已被删除的需求");
  assert.equal(orphan.legacyRequirementModule, "旧模块");
  assert.equal(wb.startTask("TASK-ORPHN").task.status, "working");
});

test("legacy runs carry over suggestions and statuses without inventing snapshots", () => {
  const { db, wb } = memoryWorkbench();
  commitLegacyImport(db, legacyState());
  const runOf = (id) => wb.listRuns(id);
  assert.equal(runOf("TASK-QUEUE").length, 0);
  assert.equal(runOf("TASK-BLOCK").length, 0);
  assert.deepEqual(runOf("TASK-WORK1").map((r) => [r.status, r.isLegacy, r.snapshotId]), [["running", true, null]]);
  const review = runOf("TASK-REVEW")[0];
  assert.deepEqual([review.status, review.resultSummary, review.reviewDecision], ["succeeded", "建议：做 V2", null]);
  const done = runOf("TASK-DONE1")[0];
  assert.deepEqual([done.status, done.reviewDecision], ["succeeded", "accepted"]);
  // A suggestion on a task that never ran is kept as the task's note, not as an invented run.
  assert.equal(runOf("TASK-SUGGS").length, 0);
  assert.equal(wb.getTask("TASK-SUGGS").resultNote, "早先记录的建议");
  assert.equal(wb.startTask("TASK-SUGGS").run.attempt, 1);
});

test("imported legacy tasks keep working in the new state machine", () => {
  const { db, wb } = memoryWorkbench();
  commitLegacyImport(db, legacyState());
  const running = wb.listRuns("TASK-WORK1")[0];
  wb.submitResult(running.id, { summary: "迁移后提交" });
  assert.equal(wb.getTask("TASK-WORK1").status, "review");
  wb.acceptTask("TASK-WORK1");
  assert.equal(wb.getTask("TASK-WORK1").status, "done");
  wb.acceptTask("TASK-REVEW", { note: "旧任务验收" });
  assert.equal(wb.getTask("TASK-REVEW").status, "done");
  wb.transitionTask("TASK-BLOCK", "queued");
  assert.equal(wb.getTask("TASK-BLOCK").blockedReason, "");
  assert.throws(() => wb.transitionTask("TASK-DONE1", "queued", { reason: "x" }), (e) => e.code === "ILLEGAL_TRANSITION");
  assert.equal(wb.reopenTask("TASK-DONE1", { reason: "迁移后重开" }).status, "queued");
});

test("events are written oldest-first with mapped entity types and the original data preserved", () => {
  const { db, wb } = memoryWorkbench();
  commitLegacyImport(db, legacyState());
  const legacy = db.prepare("SELECT * FROM events WHERE event_type = 'legacy.import' ORDER BY id").all();
  assert.deepEqual(legacy.map((e) => [e.entity_type, e.entity_id]), [["workspace", "workspace"], ["requirement", "REQ-BBBBB"], ["task", "TASK-DONE1"]]);
  assert.deepEqual(legacy.map((e) => e.created_at), [T(1), T(3), T(8)]);
  const payload = JSON.parse(legacy[2].payload_json);
  assert.equal(payload.action, "任务状态：待验收 → 已完成");
  assert.equal(payload.actor, "我");
  assert.equal(payload.legacyId, 1760000003000.5);
  assert.deepEqual(payload.after, { status: "done" });
  assert.equal(wb.listEvents({ entityId: "workspace" }).some((e) => e.eventType === "migration.legacy_import"), false);
  assert.equal(wb.listEvents({ entityId: "WS-LOCAL" })[0].eventType, "migration.legacy_import");
});

test("running the same migration again changes nothing", () => {
  const { db } = memoryWorkbench();
  commitLegacyImport(db, legacyState());
  const before = snapshotCounts(db);
  const again = commitLegacyImport(db, legacyState());
  assert.equal(again.status, "already_imported");
  assert.equal(again.committed, false);
  assert.deepEqual(snapshotCounts(db), before);
  assert.equal(previewLegacyImport(db, legacyState()).status, "already_imported");
});

test("re-importing a re-saved copy (only updatedAt differs) is still a no-op", () => {
  const { db } = memoryWorkbench();
  commitLegacyImport(db, legacyState());
  const before = snapshotCounts(db);
  const resaved = { ...legacyState(), updatedAt: T(28) };
  assert.equal(commitLegacyImport(db, resaved).status, "already_imported");
  assert.deepEqual(snapshotCounts(db), before);
});

test("a later export with extra records only adds the new ones and never duplicates events", () => {
  const { db, wb } = memoryWorkbench();
  commitLegacyImport(db, legacyState());
  const later = legacyState();
  later.items.push({ id: "REQ-CCCCC", module: "新", title: "新需求", description: "", sourceVersion: "v0.1", targetVersion: "V1", decision: "pending", createdAt: T(10), updatedAt: T(10) });
  later.events.unshift({ id: 1760000009000.5, entityType: "feature", entityId: "REQ-CCCCC", action: "新增需求", actor: "我", before: null, after: { title: "新需求" }, createdAt: T(10) });
  const preview = previewLegacyImport(db, later);
  assert.deepEqual(preview.counts.requirements, { total: 3, new: 1, identical: 2, conflicts: 0, invalid: 0 });
  assert.deepEqual(preview.counts.tasks, { total: 7, new: 0, identical: 7, conflicts: 0, invalid: 0 });
  assert.deepEqual(preview.counts.events, { total: 4, new: 1, alreadyImported: 3, invalid: 0 });
  const result = commitLegacyImport(db, later);
  assert.equal(result.committed, true);
  assert.equal(wb.listRequirements().length, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'legacy.import'").get().n, 4);
});

test("changed records are reported as conflicts and are never overwritten", () => {
  const { db, wb } = memoryWorkbench();
  commitLegacyImport(db, legacyState());
  wb.updateRequirement("REQ-AAAAA", { title: "在新版里改过的标题" });
  const stale = legacyState();
  stale.items[1].decisionNote = "旧数据里的另一个备注";
  stale.tasks[0].task = "旧数据里改过的任务说明";
  const preview = previewLegacyImport(db, stale);
  assert.equal(preview.counts.requirements.conflicts, 2);
  assert.equal(preview.counts.tasks.conflicts, 1);
  assert.deepEqual(preview.conflicts.map((c) => [c.kind, c.id, c.fields]).sort(),
    [["requirement", "REQ-AAAAA", ["title"]], ["requirement", "REQ-BBBBB", ["decision_note"]], ["task", "TASK-QUEUE", ["task_text"]]]);
  commitLegacyImport(db, stale);
  assert.equal(wb.getRequirement("REQ-AAAAA").title, "在新版里改过的标题");
  assert.equal(wb.getRequirement("REQ-BBBBB").decisionNote, "后面再说");
  assert.equal(wb.getTask("TASK-QUEUE").taskText, "待执行任务");
});

test("invalid payloads are rejected without touching the database", () => {
  const { db } = memoryWorkbench();
  const before = snapshotCounts(db);
  for (const bad of [null, [], "text", {}, { items: "x" }, { items: {} }]) {
    assert.equal(previewLegacyImport(db, bad).status, "invalid");
    const result = commitLegacyImport(db, bad);
    assert.equal(result.committed, false);
  }
  assert.deepEqual(snapshotCounts(db), before);
});

test("bad rows are skipped and reported while good rows still import", () => {
  const { db, wb } = memoryWorkbench();
  const state = legacyState();
  state.items.push({ id: "", title: "无 ID" }, { id: "REQ-NOTIT", title: "  " }, null, { id: "REQ-AAAAA", title: "载荷内重复" });
  state.tasks.push({ model: "claude" }, { id: "TASK-QUEUE", task: "载荷内重复" });
  state.events.push({ id: 1, entityType: "feature" }, "garbage");
  const report = previewLegacyImport(db, state);
  assert.equal(report.counts.requirements.invalid, 4);
  assert.equal(report.counts.tasks.invalid, 2);
  assert.equal(report.counts.events.invalid, 2);
  assert.equal(commitLegacyImport(db, state).committed, true);
  assert.equal(wb.getRequirement("REQ-AAAAA").title, "需求一");
  assert.equal(wb.listRequirements().length, 2);
});

test("unknown values are normalised with a warning instead of corrupting the data", () => {
  const { db, wb } = memoryWorkbench();
  const state = {
    items: [{ id: "REQ-ODD01", title: "奇怪的决策", decision: "maybe" }],
    tasks: [
      { id: "TASK-ODD01", featureId: "REQ-ODD01", status: "archived", task: "t" },
      { id: "TASK-ODD02", featureId: "REQ-ODD01", status: "blocked", task: "t" },
    ],
    events: [],
  };
  const report = previewLegacyImport(db, state);
  assert.equal(report.warnings.length, 3);
  commitLegacyImport(db, state);
  assert.equal(wb.getRequirement("REQ-ODD01").decision, "pending");
  assert.equal(wb.getTask("TASK-ODD01").status, "queued");
  assert.match(wb.getTask("TASK-ODD02").blockedReason, /未记录/);
});

test("a failure during import rolls everything back and says the database is unchanged", () => {
  const { db } = memoryWorkbench();
  const before = snapshotCounts(db);
  db.exec(`CREATE TRIGGER sabotage BEFORE INSERT ON events WHEN NEW.event_type = 'migration.legacy_import'
           BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  assert.throws(() => commitLegacyImport(db, legacyState()), /数据库未改变.*boom/);
  assert.deepEqual(snapshotCounts(db), before);
  db.exec("DROP TRIGGER sabotage");
  assert.equal(commitLegacyImport(db, legacyState()).committed, true);
});

test("an empty export is reported as nothing to import", () => {
  const { db } = memoryWorkbench();
  const report = previewLegacyImport(db, { items: [], tasks: [], events: [] });
  assert.equal(report.status, "nothing_to_import");
});

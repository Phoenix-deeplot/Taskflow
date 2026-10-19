import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { listMigrations, openDatabase, schemaVersion } from "../../server/db.mjs";
import { createWorkbench } from "../../server/service.mjs";
import { commitLegacyImport } from "../../server/legacy-import.mjs";
import { makeClock, memoryWorkbench, tempDirectory, taskInStatus } from "./helpers.mjs";

const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code, `expected ${code}`);

test("a version-1 database is upgraded in place, keeps its data and is backed up first", () => {
  const { directory, cleanup } = tempDirectory();
  try {
    const file = path.join(directory, "requirements.sqlite");
    const old = new DatabaseSync(file);
    old.exec("PRAGMA foreign_keys = ON");
    old.exec(listMigrations().find((m) => m.version === 1).sql);
    old.exec("PRAGMA user_version = 1");
    old.prepare(`INSERT INTO tasks (id, workspace_id, status, task_text, created_at, updated_at) VALUES ('TASK-OLD01', 'WS-LOCAL', 'queued', '旧任务', 'x', 'x')`).run();
    old.close();

    const backups = path.join(directory, "backups");
    const db = openDatabase(file, { backupDirectory: backups });
    assert.equal(schemaVersion(db), 2);
    const wb = createWorkbench(db, { clock: makeClock() });
    assert.equal(wb.getTask("TASK-OLD01").taskText, "旧任务");
    assert.equal(wb.getTask("TASK-OLD01").resultNote, "");
    const [backup] = readdirSync(backups);
    assert.match(backup, /^pre-migration-v1-/);
    const copy = new DatabaseSync(path.join(backups, backup), { readOnly: true });
    assert.equal(copy.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
    copy.close(); db.close();
  } finally { cleanup(); }
});

test("opening an up-to-date database does not create another backup", () => {
  const { directory, cleanup } = tempDirectory();
  try {
    const file = path.join(directory, "requirements.sqlite");
    const backups = path.join(directory, "backups");
    openDatabase(file, { backupDirectory: backups }).close();
    openDatabase(file, { backupDirectory: backups }).close();
    assert.equal(existsSync(backups), false);
  } finally { cleanup(); }
});

test("result notes can be set on create and update, survive status changes and never block anything", () => {
  const { wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "t", resultNote: "手动记录的建议" });
  assert.equal(task.resultNote, "手动记录的建议");
  const updated = wb.updateTask(task.id, { resultNote: "改过的建议" });
  assert.equal(updated.resultNote, "改过的建议");
  assert.equal(updated.status, "queued");
  const { run } = wb.startTask(task.id);
  wb.submitResult(run.id, { summary: "正式结果" });
  assert.equal(wb.getTask(task.id).resultNote, "改过的建议");
  assert.equal(wb.listRuns(task.id)[0].resultSummary, "正式结果");
  rejects(() => wb.updateTask(task.id, { resultNote: 42 }), "INVALID");
  rejects(() => wb.createTask({ taskText: "t", resultNote: {} }), "INVALID");
});

test("legacy import keeps the old suggestion as the task's result note", () => {
  const { db, wb } = memoryWorkbench();
  commitLegacyImport(db, {
    items: [], events: [],
    tasks: [
      { id: "TASK-AAAAA", model: "claude", status: "queued", task: "t", suggestion: "早先的建议" },
      { id: "TASK-BBBBB", model: "claude", status: "review", task: "t", suggestion: "待验收的结论" },
    ],
  });
  assert.equal(wb.getTask("TASK-AAAAA").resultNote, "早先的建议");
  assert.equal(wb.getTask("TASK-BBBBB").resultNote, "待验收的结论");
  assert.equal(wb.listRuns("TASK-BBBBB")[0].resultSummary, "待验收的结论");
});

test("splitting a requirement creates all tasks and dependencies atomically", () => {
  const { db, wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "大需求" });
  const result = wb.splitRequirement(requirement.id, [
    { key: "design", taskText: "设计", acceptance: ["有方案"] },
    { key: "build", taskText: "实现", dependsOn: ["design"], provider: "claude" },
    { key: "verify", taskText: "验证", dependsOn: ["build", "design"], status: "clarification" },
  ]);
  assert.equal(result.tasks.length, 3);
  assert.ok(result.tasks.every((task) => task.requirementId === requirement.id));
  assert.equal(result.dependencies.length, 3);
  const [design, build, verify] = result.tasks;
  assert.deepEqual(build.dependencies.map((d) => d.id), [design.id]);
  assert.deepEqual(verify.dependencies.map((d) => d.id).sort(), [build.id, design.id].sort());
  assert.equal(verify.status, "clarification");
  assert.equal(wb.getReadiness(build.id).ready, false);
  assert.ok(wb.listEvents({ entityId: requirement.id }).some((e) => e.eventType === "requirement.split" && e.payload.taskIds.length === 3));

  const events = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  rejects(() => wb.splitRequirement(requirement.id, [
    { key: "a", taskText: "A", dependsOn: ["b"] },
    { key: "b", taskText: "B", dependsOn: ["a"] },
  ]), "INVALID");
  assert.equal(wb.listTasks({ requirementId: requirement.id }).length, 3, "a failed split must not leave partial tasks");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, events);
});

test("split input is validated", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  rejects(() => wb.splitRequirement(requirement.id, []), "INVALID");
  rejects(() => wb.splitRequirement(requirement.id, [{ key: "a", taskText: "A" }, { key: "a", taskText: "B" }]), "INVALID");
  rejects(() => wb.splitRequirement(requirement.id, [{ key: "a", taskText: "A", dependsOn: ["zzz"] }]), "INVALID");
  rejects(() => wb.splitRequirement(requirement.id, [{ key: "a", taskText: "A", dependsOn: ["a"] }]), "INVALID");
  rejects(() => wb.splitRequirement(requirement.id, [{ key: "a", taskText: "" }]), "INVALID");
  rejects(() => wb.splitRequirement("REQ-NOPE", [{ taskText: "A" }]), "NOT_FOUND");
  wb.deleteRequirement(requirement.id);
  rejects(() => wb.splitRequirement(requirement.id, [{ taskText: "A" }]), "CONFLICT");
  assert.equal(wb.listTasks().length, 0);
});

test("requirement progress is derived from task statuses", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "有进度" });
  const empty = wb.createRequirement({ title: "无任务" });
  assert.deepEqual(wb.requirementProgress(empty.id), { requirementId: empty.id, total: 0, done: 0, open: 0, percent: 0, byStatus: { clarification: 0, queued: 0, working: 0, review: 0, done: 0, blocked: 0 } });
  for (const status of ["done", "done", "review", "queued"]) taskInStatus(wb, status, { requirementId: requirement.id });
  const progress = wb.requirementProgress(requirement.id);
  assert.equal(progress.total, 4);
  assert.equal(progress.done, 2);
  assert.equal(progress.open, 2);
  assert.equal(progress.percent, 50);
  assert.deepEqual(progress.byStatus, { clarification: 0, queued: 1, working: 0, review: 1, done: 2, blocked: 0 });
  const all = wb.requirementProgress();
  assert.deepEqual(Object.keys(all), [requirement.id]);
  assert.equal(all[requirement.id].percent, 50);
  rejects(() => wb.requirementProgress("REQ-NOPE"), "NOT_FOUND");
});

test("global context is versioned append-only and shows up in later snapshots only", () => {
  const { db, wb } = memoryWorkbench();
  assert.equal(wb.getContext().revision, 1);
  const task = wb.createTask({ taskText: "t" });
  const first = wb.startTask(task.id);
  wb.transitionTask(task.id, "queued", { reason: "重来" });

  const next = wb.appendContextVersion({ rules: ["不得扩大范围"], constraints: ["只用本地数据"], glossary: [{ term: "Run", definition: "一次执行" }] });
  assert.equal(next.revision, 2);
  assert.deepEqual(wb.listContextVersions().map((v) => v.revision), [2, 1]);
  assert.deepEqual(wb.getContext().rules.rules, ["不得扩大范围"]);
  assert.equal(db.prepare("SELECT revision FROM workspaces").get().revision, 2);

  const second = wb.startTask(task.id);
  assert.equal(wb.getSnapshot(first.snapshot.id).payload.workspace.context_revision, 1);
  assert.equal(second.snapshot.payload.workspace.context_revision, 2);
  assert.match(second.snapshot.promptText, /不得扩大范围/);
  assert.match(second.snapshot.promptText, /只用本地数据/);
  assert.doesNotMatch(first.snapshot.promptText, /不得扩大范围/);
  assert.equal(wb.listContextVersions()[1].rules.rules.length, 0, "the old version is untouched");
  assert.ok(wb.listEvents({ entityType: "workspace" }).some((e) => e.eventType === "context.versioned"));
});

test("context updates are validated and no-op updates are refused", () => {
  const { wb } = memoryWorkbench();
  rejects(() => wb.appendContextVersion(null), "INVALID");
  rejects(() => wb.appendContextVersion([]), "INVALID");
  rejects(() => wb.appendContextVersion({ rules: "no" }), "INVALID");
  rejects(() => wb.appendContextVersion({ rules: [1] }), "INVALID");
  rejects(() => wb.appendContextVersion({ rules: ["x".repeat(2001)] }), "INVALID");
  rejects(() => wb.appendContextVersion({}), "INVALID");
  wb.appendContextVersion({ rules: ["a"] });
  rejects(() => wb.appendContextVersion({ rules: ["a"] }), "INVALID");
  assert.equal(wb.getContext().revision, 2);
});

test("a deleted requirement can be restored, optionally with new content, and the history says so", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "原标题" });
  rejects(() => wb.restoreRequirement(requirement.id), "CONFLICT");
  wb.deleteRequirement(requirement.id, { reason: "误删" });
  assert.equal(wb.listRequirements().length, 0);
  const restored = wb.restoreRequirement(requirement.id, { title: "从备份带回的标题", decision: "keep" });
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.title, "从备份带回的标题");
  assert.equal(restored.decision, "keep");
  assert.equal(wb.listRequirements().length, 1);
  assert.deepEqual(wb.listEvents({ entityId: requirement.id }).map((e) => e.eventType).slice(0, 2), ["requirement.restored", "requirement.updated"]);
  wb.deleteRequirement(requirement.id);
  assert.equal(wb.restoreRequirement(requirement.id).title, "从备份带回的标题");
  rejects(() => wb.restoreRequirement("REQ-NOPE"), "NOT_FOUND");
  wb.deleteRequirement(requirement.id);
  rejects(() => wb.restoreRequirement(requirement.id, { title: " " }), "INVALID");
  assert.equal(wb.listRequirements().length, 0, "a rejected restore must not half-apply");
});

test("stateVersion rises with every change and never on reads or rejected calls", () => {
  const { wb } = memoryWorkbench();
  const v0 = wb.stateVersion();
  assert.equal(v0, 0);
  const requirement = wb.createRequirement({ title: "r" });
  const v1 = wb.stateVersion();
  assert.ok(v1 > v0);
  wb.listRequirements(); wb.getRequirement(requirement.id); wb.exportAll();
  assert.equal(wb.stateVersion(), v1);
  rejects(() => wb.createRequirement({ title: "" }), "INVALID");
  assert.equal(wb.stateVersion(), v1);
  const task = wb.createTask({ requirementId: requirement.id, taskText: "t" });
  const v2 = wb.stateVersion();
  assert.ok(v2 > v1);
  wb.startTask(task.id);
  assert.ok(wb.stateVersion() > v2);
});

test("every migration file is a four-digit numbered .sql file and versions are consecutive", () => {
  const migrations = listMigrations();
  assert.deepEqual(migrations.map((m) => m.version), migrations.map((_, i) => i + 1));
  assert.ok(readFileSync(new URL("../../server/migrations/0002_task_result_note.sql", import.meta.url), "utf8").includes("result_note"));
});

import assert from "node:assert/strict";
import test from "node:test";
import { TASK_STATUSES, TASK_TRANSITIONS } from "../../server/state-machine.mjs";
import { canonicalJson, sha256 } from "../../server/util.mjs";
import { count, memoryWorkbench, taskInStatus } from "./helpers.mjs";

const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code, `expected ${code}`);

test("transition matrix: only listed generic transitions succeed; failures change nothing", () => {
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      const { db, wb } = memoryWorkbench();
      const task = taskInStatus(wb, from);
      const events = count(db, "events");
      const runs = count(db, "task_runs");
      const rule = TASK_TRANSITIONS.find((r) => r.from === from && r.to === to && r.via === "transition");
      if (rule) {
        const result = wb.transitionTask(task.id, to, { reason: "测试原因" });
        assert.equal(result.status, to, `${from} -> ${to}`);
        assert.equal(result.revision, task.revision + 1);
      } else {
        rejects(() => wb.transitionTask(task.id, to, { reason: "测试原因" }), "ILLEGAL_TRANSITION");
        const after = wb.getTask(task.id);
        assert.equal(after.status, from, `${from} -> ${to} must not change status`);
        assert.equal(after.revision, task.revision);
        assert.equal(count(db, "events"), events);
        assert.equal(count(db, "task_runs"), runs);
      }
    }
  }
});

test("working, review and done can only be reached through their dedicated operations", () => {
  const { wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  assert.throws(() => wb.transitionTask(task.id, "working"), (e) => e.code === "ILLEGAL_TRANSITION" && /startTask/.test(e.message));
  const blocked = wb.transitionTask(task.id, "blocked", { reason: "等待" });
  rejects(() => wb.transitionTask(blocked.id, "working"), "ILLEGAL_TRANSITION");
  const review = taskInStatus(wb, "review");
  assert.throws(() => wb.transitionTask(review.id, "done"), (e) => /acceptTask/.test(e.message));
  assert.throws(() => wb.transitionTask(review.id, "queued", { reason: "x" }), (e) => /rejectTask/.test(e.message));
  const done = taskInStatus(wb, "done");
  assert.throws(() => wb.transitionTask(done.id, "queued", { reason: "x" }), (e) => /reopenTask/.test(e.message));
});

test("reasons are mandatory for blocked, cancel, reject and reopen", () => {
  const { wb } = memoryWorkbench();
  const queued = taskInStatus(wb, "queued");
  rejects(() => wb.transitionTask(queued.id, "blocked", { reason: "  " }), "REASON_REQUIRED");
  const working = taskInStatus(wb, "working");
  rejects(() => wb.transitionTask(working.id, "queued"), "REASON_REQUIRED");
  const review = taskInStatus(wb, "review");
  rejects(() => wb.rejectTask(review.id, { note: "" }), "REASON_REQUIRED");
  rejects(() => wb.rejectTask(review.id), "REASON_REQUIRED");
  const done = taskInStatus(wb, "done");
  rejects(() => wb.reopenTask(done.id, {}), "REASON_REQUIRED");
  assert.equal(wb.getTask(review.id).status, "review");
  assert.equal(wb.getTask(done.id).status, "done");
});

test("startTask creates snapshot, run and events atomically and moves the task to working", () => {
  const { db, wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "需求A", description: "说明", module: "工具" });
  const task = wb.createTask({ requirementId: requirement.id, taskText: "做点事", acceptance: ["可运行", "有测试"], assignee: "我" });
  const result = wb.startTask(task.id);
  assert.equal(result.task.status, "working");
  assert.equal(result.task.revision, task.revision + 1);
  assert.equal(result.run.attempt, 1);
  assert.equal(result.run.status, "running");
  assert.equal(result.run.snapshotId, result.snapshot.id);
  assert.equal(count(db, "task_context_snapshots"), 1);
  assert.match(result.snapshot.promptText, /需求A/);
  assert.match(result.snapshot.promptText, /1\. 可运行/);
  const types = wb.listEvents({ entityId: task.id }).map((e) => e.eventType);
  assert.ok(types.includes("task.transition") && types.includes("task.created"));
  assert.equal(wb.listEvents({ entityType: "run" })[0].eventType, "run.started");
});

test("a second start of the same task is refused and leaves exactly one run", () => {
  const { db, wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  wb.startTask(task.id);
  rejects(() => wb.startTask(task.id), "NOT_READY");
  assert.equal(count(db, "task_runs"), 1);
});

test("snapshots do not change when the requirement or task is edited later", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "原标题", description: "原说明" });
  const task = wb.createTask({ requirementId: requirement.id, taskText: "原任务" });
  const { snapshot } = wb.startTask(task.id);
  const before = wb.getSnapshot(snapshot.id);
  wb.updateRequirement(requirement.id, { title: "新标题", description: "新说明" });
  wb.updateTask(task.id, { taskText: "新任务" });
  const after = wb.getSnapshot(snapshot.id);
  assert.deepEqual(after, before);
  assert.equal(after.payload.requirement.title, "原标题");
  assert.equal(after.payload.task.task_text, "原任务");
  assert.equal(after.requirementRevision, 1);
  assert.equal(after.payloadHash, sha256(canonicalJson(after.payload)));
});

test("failure leaves the old run failed and a retry creates attempt 2", () => {
  const { wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  const first = wb.startTask(task.id);
  const failed = wb.reportFailure(first.run.id, { message: "编译失败", errorCode: "BUILD" });
  assert.equal(failed.task.status, "queued");
  assert.equal(failed.run.status, "failed");
  const second = wb.startTask(task.id);
  assert.equal(second.run.attempt, 2);
  const runs = wb.listRuns(task.id);
  assert.deepEqual(runs.map((r) => [r.attempt, r.status]), [[1, "failed"], [2, "running"]]);
  assert.equal(runs[0].errorMessage, "编译失败");
  assert.notEqual(second.snapshot.id, first.snapshot.id);
});

test("cancelling a working task closes its run and a later start is a new attempt", () => {
  const { wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  const { run } = wb.startTask(task.id);
  const result = wb.transitionTask(task.id, "queued", { reason: "换个思路" });
  assert.equal(result.status, "queued");
  const runs = wb.listRuns(task.id);
  assert.equal(runs[0].id, run.id);
  assert.equal(runs[0].status, "cancelled");
  assert.equal(runs[0].errorMessage, "换个思路");
  assert.equal(wb.startTask(task.id).run.attempt, 2);
});

test("a finished run cannot receive another result or failure", () => {
  const { wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  const { run } = wb.startTask(task.id);
  rejects(() => wb.submitResult(run.id, { summary: "" }), "INVALID");
  wb.submitResult(run.id, { summary: "好了", evidence: [{ kind: "test", ref: "npm test", note: "通过" }] });
  rejects(() => wb.submitResult(run.id, { summary: "再来一次" }), "CONFLICT");
  rejects(() => wb.reportFailure(run.id, { message: "晚了" }), "CONFLICT");
  assert.deepEqual(wb.listRuns(task.id)[0].evidence, [{ kind: "test", ref: "npm test", note: "通过" }]);
});

test("review flow: accept marks the run accepted; reject keeps the note and allows a new attempt; reopen needs a reason", () => {
  const { wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  const first = wb.startTask(task.id);
  wb.submitResult(first.run.id, { summary: "初版" });
  const rejected = wb.rejectTask(task.id, { note: "缺少错误处理" });
  assert.equal(rejected.task.status, "queued");
  assert.equal(rejected.run.reviewDecision, "rejected");
  assert.equal(rejected.run.reviewNote, "缺少错误处理");
  const second = wb.startTask(task.id);
  wb.submitResult(second.run.id, { summary: "修正版" });
  const accepted = wb.acceptTask(task.id, { note: "OK" });
  assert.equal(accepted.task.status, "done");
  assert.equal(accepted.run.reviewDecision, "accepted");
  rejects(() => wb.acceptTask(task.id), "ILLEGAL_TRANSITION");
  const reopened = wb.reopenTask(task.id, { reason: "需求变了" });
  assert.equal(reopened.status, "queued");
  assert.deepEqual(wb.listRuns(task.id).map((r) => [r.attempt, r.reviewDecision]), [[1, "rejected"], [2, "accepted"]]);
  assert.ok(wb.listEvents({ entityId: task.id }).some((e) => e.eventType === "task.reopened" && e.payload.reason === "需求变了"));
});

test("dependencies: self, duplicate and circular links are refused", () => {
  const { wb } = memoryWorkbench();
  const [a, b, c] = ["A", "B", "C"].map((name) => wb.createTask({ taskText: name }));
  rejects(() => wb.addDependency(a.id, a.id), "INVALID");
  wb.addDependency(b.id, a.id);
  rejects(() => wb.addDependency(b.id, a.id), "CONFLICT");
  wb.addDependency(c.id, b.id);
  rejects(() => wb.addDependency(a.id, c.id), "INVALID");
  rejects(() => wb.addDependency(a.id, b.id), "INVALID");
  assert.deepEqual(wb.getTask(c.id).dependencies.map((d) => d.id), [b.id]);
});

test("unfinished dependencies block start unless a reason is given; the reason is recorded", () => {
  const { wb } = memoryWorkbench();
  const upstream = wb.createTask({ taskText: "上游" });
  const downstream = wb.createTask({ taskText: "下游" });
  wb.addDependency(downstream.id, upstream.id);
  const readiness = wb.getReadiness(downstream.id);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.blockers[0].code, "DEPENDENCY_NOT_DONE");
  assert.deepEqual(readiness.blockers[0].taskIds, [upstream.id]);
  rejects(() => wb.startTask(downstream.id), "NOT_READY");
  rejects(() => wb.startTask(downstream.id, { overrideReason: "  " }), "NOT_READY");
  const forced = wb.startTask(downstream.id, { overrideReason: "先行验证" });
  assert.equal(forced.run.overrideReason, "先行验证");
  assert.equal(forced.snapshot.payload.override_reason, "先行验证");
  assert.match(forced.snapshot.promptText, /先行验证/);
  assert.equal(forced.snapshot.payload.dependencies[0].status, "queued");
});

test("a finished dependency unblocks the downstream task and its result is part of the snapshot", () => {
  const { wb } = memoryWorkbench();
  const upstream = wb.createTask({ taskText: "上游" });
  const downstream = wb.createTask({ taskText: "下游" });
  wb.addDependency(downstream.id, upstream.id);
  const { run } = wb.startTask(upstream.id);
  wb.submitResult(run.id, { summary: "接口已定义为 /v1/x" });
  wb.acceptTask(upstream.id);
  assert.equal(wb.getReadiness(downstream.id).ready, true);
  const { snapshot } = wb.startTask(downstream.id);
  assert.deepEqual(snapshot.payload.dependencies, [{ id: upstream.id, status: "done", result_summary: "接口已定义为 /v1/x" }]);
});

test("only a queued task is ready; warnings do not block", () => {
  const { wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  const readiness = wb.getReadiness(task.id);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.warnings.map((w) => w.code).sort(), ["NO_ACCEPTANCE", "NO_ASSIGNEE"]);
  const clarification = taskInStatus(wb, "clarification");
  assert.equal(wb.getReadiness(clarification.id).blockers[0].code, "NOT_QUEUED");
  rejects(() => wb.startTask(clarification.id, { overrideReason: "硬来" }), "NOT_READY");
});

test("a failure in the middle of startTask rolls everything back", () => {
  const { db, wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "任务" });
  db.exec(`CREATE TRIGGER sabotage BEFORE INSERT ON events WHEN NEW.event_type = 'run.started'
           BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  const events = count(db, "events");
  assert.throws(() => wb.startTask(task.id), /boom/);
  assert.equal(wb.getTask(task.id).status, "queued");
  assert.equal(wb.getTask(task.id).revision, task.revision);
  assert.equal(count(db, "task_runs"), 0);
  assert.equal(count(db, "task_context_snapshots"), 0);
  assert.equal(count(db, "events"), events);
  db.exec("DROP TRIGGER sabotage");
  assert.equal(wb.startTask(task.id).run.attempt, 1);
});

test("stale revisions are rejected instead of silently overwriting", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "v1" });
  wb.updateRequirement(requirement.id, { title: "v2" }, { expectedRevision: 1 });
  assert.throws(() => wb.updateRequirement(requirement.id, { title: "v3" }, { expectedRevision: 1 }),
    (e) => e.code === "CONFLICT" && e.details.currentRevision === 2);
  assert.equal(wb.getRequirement(requirement.id).title, "v2");
  const task = wb.createTask({ taskText: "t" });
  wb.updateTask(task.id, { assignee: "我" });
  rejects(() => wb.transitionTask(task.id, "blocked", { reason: "x", expectedRevision: 1 }), "CONFLICT");
  rejects(() => wb.startTask(task.id, { expectedRevision: 1 }), "CONFLICT");
});

test("task status cannot be edited through updateTask and invalid input is refused", () => {
  const { wb } = memoryWorkbench();
  const task = wb.createTask({ taskText: "t" });
  rejects(() => wb.updateTask(task.id, { status: "done" }), "INVALID");
  rejects(() => wb.createTask({ taskText: "  " }), "INVALID");
  rejects(() => wb.createTask({ taskText: "t", status: "working" }), "INVALID");
  rejects(() => wb.createRequirement({ title: "" }), "INVALID");
  rejects(() => wb.createRequirement({ title: "x", decision: "maybe" }), "INVALID");
  rejects(() => wb.createRequirement({ title: "x", targetVersion: "V9" }), "INVALID");
  rejects(() => wb.updateTask(task.id, { acceptance: "not-an-array" }), "INVALID");
  rejects(() => wb.getTask("TASK-NOPE"), "NOT_FOUND");
});

test("deleting a requirement is soft: tasks and history stay, and new work on it is blocked", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "将被删除" });
  const task = wb.createTask({ requirementId: requirement.id, taskText: "t" });
  wb.deleteRequirement(requirement.id, { reason: "不做了" });
  assert.equal(wb.listRequirements().length, 0);
  assert.equal(wb.listRequirements({ includeDeleted: true })[0].title, "将被删除");
  assert.equal(wb.getTask(task.id).requirementId, requirement.id);
  const deleteEvent = wb.listEvents({ entityId: requirement.id })[0];
  assert.equal(deleteEvent.eventType, "requirement.deleted");
  assert.equal(deleteEvent.payload.affectedTasks, 1);
  rejects(() => wb.createTask({ requirementId: requirement.id, taskText: "新" }), "CONFLICT");
  rejects(() => wb.updateRequirement(requirement.id, { title: "x" }), "CONFLICT");
  assert.equal(wb.getReadiness(task.id).blockers[0].code, "REQUIREMENT_DELETED");
  assert.equal(wb.startTask(task.id, { overrideReason: "历史任务仍要做" }).task.status, "working");
});

test("full lifecycle leaves a traceable record", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "支付比较", decision: "keep" });
  const task = wb.createTask({ requirementId: requirement.id, taskText: "分析", acceptance: ["给出结论"], provider: "claude", assignee: "我" });
  const { run, snapshot } = wb.startTask(task.id, { executorId: "manual" });
  wb.submitResult(run.id, { summary: "结论：先做 V1", evidence: [{ kind: "note", ref: "doc", note: "" }] });
  wb.acceptTask(task.id, { note: "同意" });
  const full = wb.getTask(task.id);
  assert.equal(full.status, "done");
  assert.equal(full.runs[0].snapshotId, snapshot.id);
  assert.equal(full.runs[0].reviewDecision, "accepted");
  const history = wb.listEvents({ entityId: task.id }).map((e) => e.eventType).reverse();
  assert.deepEqual(history, ["task.created", "task.transition", "task.transition", "task.accepted", "task.transition"]);
  assert.equal(wb.getSnapshot(snapshot.id).payload.requirement.id, requirement.id);
});

test("export v2 contains every table and no secret-looking values", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "导出" });
  const task = wb.createTask({ requirementId: requirement.id, taskText: "t" });
  wb.startTask(task.id);
  const exported = wb.exportAll();
  assert.equal(exported.schemaVersion, 2);
  assert.equal(exported.requirements.length, 1);
  assert.equal(exported.tasks.length, 1);
  assert.equal(exported.snapshots.length, 1);
  assert.equal(exported.runs.length, 1);
  assert.ok(exported.events.length >= 4);
  assert.doesNotMatch(JSON.stringify(exported), /sk-[A-Za-z0-9]{10,}|api[_-]?key|secret/i);
});

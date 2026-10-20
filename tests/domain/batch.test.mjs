import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ANALYSIS_TEMPLATE } from "../../server/analysis.mjs";
import { restoreFromExport } from "../../server/restore.mjs";
import { count, manualWorkbench, memoryWorkbench } from "./helpers.mjs";

const rejects = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);
const CODEX = ["codex_cli"];
const task = (wb, extra = {}) => wb.createTask({ taskText: "t", executorType: "codex_cli", ...extra });

// ---------- task kind and analysis ----------
test("tasks default to execution; only execution and analysis exist", () => {
  const { wb } = memoryWorkbench();
  assert.equal(wb.createTask({ taskText: "t" }).kind, "execution");
  assert.equal(wb.createTask({ taskText: "t", kind: "analysis" }).kind, "analysis");
  rejects(() => wb.createTask({ taskText: "t", kind: "magic" }), "INVALID");
});

test("an analysis task is built from the template plus the requirement details", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "支付比较", module: "工具", description: "按国家比较支付工具", targetVersion: "V2", decision: "keep", decisionNote: "先做核心" });
  const created = wb.createAnalysisTask(requirement.id, { executorType: "claude_code", provider: "claude", assignee: "Claude Code" });
  assert.equal(created.kind, "analysis");
  assert.equal(created.status, "queued");
  assert.equal(created.requirementId, requirement.id);
  assert.equal(created.executorType, "claude_code");
  assert.ok(created.taskText.startsWith(DEFAULT_ANALYSIS_TEMPLATE));
  for (const part of ["需求：支付比较", "模块：工具", "目标版本：V2", "当前决策：keep（先做核心）", "说明：按国家比较支付工具"]) {
    assert.ok(created.taskText.includes(part), part);
  }
  assert.equal(created.acceptance.length, 3);
  assert.equal(wb.createAnalysisTask(requirement.id).executorType, "manual_handoff");
});

test("a custom template replaces the default one, and bad input is refused", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const custom = wb.createAnalysisTask(requirement.id, { template: "  只评估安全风险  " });
  assert.ok(custom.taskText.startsWith("只评估安全风险\n\n—— 需求 ——"));
  assert.ok(!custom.taskText.includes(DEFAULT_ANALYSIS_TEMPLATE));
  assert.ok(wb.createAnalysisTask(requirement.id, { template: "   " }).taskText.startsWith(DEFAULT_ANALYSIS_TEMPLATE));
  rejects(() => wb.createAnalysisTask(requirement.id, { template: "x".repeat(20001) }), "INVALID");
  rejects(() => wb.createAnalysisTask("REQ-NOPE"), "NOT_FOUND");
  wb.deleteRequirement(requirement.id);
  rejects(() => wb.createAnalysisTask(requirement.id), "CONFLICT");
});

test("an analysis run is told to stay read-only; execution runs are unchanged", () => {
  const { wb } = manualWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const analysis = wb.dispatchTask(wb.createAnalysisTask(requirement.id, { executorType: "claude_code" }).id);
  assert.equal(analysis.snapshot.payload.task.kind, "analysis");
  assert.equal(analysis.snapshot.payload.prompt_template_version, "task-analysis-v1");
  assert.match(analysis.snapshot.promptText, /只做只读分析/);
  assert.match(analysis.snapshot.promptText, /不要创建、修改或删除任何文件/);
  assert.doesNotMatch(analysis.snapshot.promptText, /涉及文件\/产物/);
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: ["claude_code"] }).task.kind, "analysis");

  const execution = wb.dispatchTask(task(wb).id);
  assert.equal(execution.snapshot.payload.task.kind, "execution");
  assert.equal(execution.snapshot.payload.prompt_template_version, "task-exec-v1");
  assert.match(execution.snapshot.promptText, /执行 Agent/);
  assert.match(execution.snapshot.promptText, /涉及文件\/产物/);
});

test("an analysis result lands like any other result and waits for acceptance", () => {
  const { wb } = manualWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const created = wb.createAnalysisTask(requirement.id, { executorType: "claude_code" });
  wb.dispatchTask(created.id);
  const claim = wb.claimRun({ runnerId: "r", capabilities: ["claude_code"] });
  const done = wb.submitResult(claim.run.id, { summary: "结论：做。用户价值高……", leaseToken: claim.leaseToken });
  assert.equal(done.task.status, "review");
  assert.equal(done.run.resultSummary, "结论：做。用户价值高……");
  assert.equal(wb.getRequirement(requirement.id).decision, "pending", "the analysis never changes the decision by itself");
});

// ---------- analysis result check ----------
const FULL_ANSWER = "结论：做。\n用户价值：高。\n实现复杂度：中。\n关键风险与依赖：依赖支付接口。\n建议的 V1 范围：只做核心比较。\n需要我确认的问题：是否覆盖东南亚？";
function runAnalysis(wb, template, summary) {
  const requirement = wb.createRequirement({ title: "r" });
  const created = wb.createAnalysisTask(requirement.id, { executorType: "claude_code", template });
  wb.dispatchTask(created.id);
  const claim = wb.claimRun({ runnerId: "r", capabilities: ["claude_code"] });
  return wb.submitResult(claim.run.id, { summary, leaseToken: claim.leaseToken });
}

test("an analysis answer in the built-in format gets a passing format check as evidence", () => {
  const { wb } = manualWorkbench();
  const done = runAnalysis(wb, undefined, FULL_ANSWER);
  assert.equal(done.task.status, "review");
  assert.deepEqual(done.run.evidence, [{ kind: "check", name: "分析格式", passed: true, missing: [] }]);
  assert.deepEqual(wb.listEvents({ entityType: "run", limit: 5 }).find((e) => e.eventType === "run.succeeded").payload.analysisCheck, { passed: true, missing: [] });
});

test("an incomplete analysis answer is flagged for the reviewer but is never refused", () => {
  const { wb } = manualWorkbench();
  const done = runAnalysis(wb, undefined, "结论：做。用户价值：高。");
  assert.equal(done.task.status, "review");
  assert.deepEqual(done.run.evidence[0].missing, ["实现复杂度", "关键风险与依赖", "建议的 V1 范围", "需要我确认的问题"]);
  assert.equal(done.run.evidence[0].passed, false);
});

test("the format check ignores spacing, and skips custom templates and execution tasks", () => {
  const { wb } = manualWorkbench();
  assert.equal(runAnalysis(wb, undefined, FULL_ANSWER.replace("V1 范围", "V1范围")).run.evidence[0].passed, true);
  assert.deepEqual(runAnalysis(wb, "只评估安全风险", "随便写").run.evidence, [], "a custom template has no built-in format to compare with");
  const exec = wb.dispatchTask(task(wb).id);
  const claim = wb.claimRun({ runnerId: "r2", capabilities: CODEX });
  assert.deepEqual(wb.submitResult(claim.run.id, { summary: "好了", evidence: [{ kind: "test" }], leaseToken: claim.leaseToken }).run.evidence, [{ kind: "test" }]);
  assert.ok(exec);
});

// ---------- workspace contract for runners ----------
test("claiming a run tells the runner where to work, on which branch and with what access", () => {
  const { wb } = manualWorkbench();
  const exec = task(wb);
  wb.dispatchTask(exec.id);
  let claim = wb.claimRun({ runnerId: "r", capabilities: CODEX });
  assert.deepEqual(claim.workspace, { projectPath: null, access: "write-on-branch", branch: `wb/${exec.id.toLowerCase()}-a1`, autoApprove: false });

  wb.setSetting("project.path", "E:\\Ztree\\repo");
  const requirement = wb.createRequirement({ title: "r" });
  const analysis = wb.createAnalysisTask(requirement.id, { executorType: "claude_code" });
  wb.dispatchTask(analysis.id);
  claim = wb.claimRun({ runnerId: "r2", capabilities: ["claude_code"] });
  assert.deepEqual(claim.workspace, { projectPath: "E:\\Ztree\\repo", access: "read-only", branch: null, autoApprove: false });
});

test("every retry gets its own branch and branch names are always valid git refs", () => {
  const { wb } = manualWorkbench();
  const t = task(wb);
  wb.dispatchTask(t.id);
  const first = wb.claimRun({ runnerId: "r", capabilities: CODEX });
  wb.reportFailure(first.run.id, { message: "x", leaseToken: first.leaseToken });
  wb.dispatchTask(t.id);
  const second = wb.claimRun({ runnerId: "r", capabilities: CODEX });
  assert.deepEqual([first.workspace.branch.endsWith("-a1"), second.workspace.branch.endsWith("-a2")], [true, true]);
  assert.notEqual(first.workspace.branch, second.workspace.branch);

  const odd = wb.createTask({ id: "TASK A/../B~^:?*[x]", taskText: "t", executorType: "codex_cli" });
  wb.dispatchTask(odd.id);
  const branch = wb.claimRun({ runnerId: "r", capabilities: CODEX }).workspace.branch;
  assert.match(branch, /^wb\/[a-z0-9._-]+-a1$/);
  assert.ok(!branch.includes(".."), branch);
  assert.ok(!/[\s~^:?*[\\]/.test(branch), branch);
});

test("run detail shows the expected branch and what the adapter reported back", () => {
  const { wb } = manualWorkbench();
  const t = task(wb);
  wb.dispatchTask(t.id);
  const claim = wb.claimRun({ runnerId: "r", capabilities: CODEX });
  let detail = wb.getRunDetail(claim.run.id);
  assert.deepEqual([detail.workspace.access, detail.workspace.branch, detail.workspace.reportedBranch, detail.workspace.diff], ["write-on-branch", claim.workspace.branch, null, null]);
  wb.addArtifact(claim.run.id, claim.leaseToken, { kind: "branch", uri: `git:${claim.workspace.branch}`, metadata: { base: "main", commit: "abc1234" } });
  wb.addArtifact(claim.run.id, claim.leaseToken, { kind: "diff", uri: "file:///data/artifacts/run.diff", sizeBytes: 2048 });
  detail = wb.getRunDetail(claim.run.id);
  assert.deepEqual(detail.workspace.reportedBranch, { uri: `git:${claim.workspace.branch}`, base: "main", commit: "abc1234" });
  assert.deepEqual([detail.workspace.diff.uri, detail.workspace.diff.sizeBytes], ["file:///data/artifacts/run.diff", 2048]);
});

// ---------- batch dispatch ----------
test("dispatchTasks gives every task its own result and one refusal never blocks the rest", () => {
  const { db, wb } = manualWorkbench();
  const ok1 = task(wb); const ok2 = task(wb);
  const upstream = task(wb); const blocked = task(wb);
  wb.addDependency(blocked.id, upstream.id);
  const manual = wb.createTask({ taskText: "m" });
  const clarify = wb.createTask({ taskText: "c", executorType: "codex_cli", status: "clarification" });

  const out = wb.dispatchTasks([ok1.id, blocked.id, manual.id, clarify.id, "TASK-NOPE", ok2.id, ok1.id]);
  assert.equal(out.results.length, 6, "a repeated id counts once");
  assert.deepEqual([out.dispatched, out.skipped], [2, 4]);
  const byId = Object.fromEntries(out.results.map((r) => [r.taskId, r]));
  assert.equal(byId[ok1.id].ok, true);
  assert.match(byId[ok1.id].runId, /^RUN-/);
  assert.equal(byId[ok2.id].ok, true);
  assert.equal(byId[blocked.id].code, "NOT_READY");
  assert.equal(byId[blocked.id].blockers[0].code, "DEPENDENCY_NOT_DONE");
  assert.equal(byId[manual.id].code, "INVALID");
  assert.equal(byId[clarify.id].code, "NOT_READY");
  assert.equal(byId["TASK-NOPE"].code, "NOT_FOUND");
  assert.equal(count(db, "task_runs"), 2);
  assert.equal(wb.getTask(blocked.id).status, "queued", "a skipped task is left untouched");
  assert.equal(wb.listEvents({ entityType: "workspace" })[0].eventType, "batch.dispatched");
});

test("dispatchTasks can pick the executor for tasks that have none, and validates its input", () => {
  const { wb } = manualWorkbench();
  const a = wb.createTask({ taskText: "a" }); const b = wb.createTask({ taskText: "b" });
  const out = wb.dispatchTasks([a.id, b.id], { executorType: "claude_code" });
  assert.equal(out.dispatched, 2);
  assert.deepEqual(wb.claimRun({ runnerId: "r", capabilities: ["claude_code"] }) !== null, true);
  rejects(() => wb.dispatchTasks([]), "INVALID");
  rejects(() => wb.dispatchTasks("TASK-1"), "INVALID");
  rejects(() => wb.dispatchTasks(Array.from({ length: 201 }, (_, i) => `TASK-${i}`)), "INVALID");
});

test("dispatchAll runs every queued task oldest first and reports what is still waiting", () => {
  const { wb, clock } = manualWorkbench();
  const first = task(wb); clock.advance(1);
  const second = task(wb); clock.advance(1);
  const clarification = wb.createTask({ taskText: "c", executorType: "codex_cli", status: "clarification" });
  const blockedTask = wb.transitionTask(task(wb).id, "blocked", { reason: "等人" });
  const running = wb.startTask(task(wb).id);
  const review = (() => { const t = task(wb); const { run } = wb.startTask(t.id); wb.submitResult(run.id, { summary: "x" }); return t; })();
  const done = (() => { const t = task(wb); const { run } = wb.startTask(t.id); wb.submitResult(run.id, { summary: "x" }); wb.acceptTask(t.id); return t; })();

  const out = wb.dispatchAll();
  assert.deepEqual(out.results.map((r) => r.taskId), [first.id, second.id]);
  assert.deepEqual([out.dispatched, out.skipped], [2, 0]);
  assert.deepEqual(out.waiting, { clarification: 1, working: 1, review: 1, blocked: 1 });
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: CODEX }).task.id, first.id, "the oldest task is taken first");
  assert.equal(wb.getTask(clarification.id).status, "clarification");
  assert.equal(wb.getTask(blockedTask.id).status, "blocked");
  assert.equal(wb.getTask(running.task.id).status, "working");
  assert.equal(wb.getTask(review.id).status, "review");
  assert.equal(wb.getTask(done.id).status, "done");
});

test("dispatchAll with nothing queued is a calm no-op", () => {
  const { wb } = manualWorkbench();
  assert.deepEqual(wb.dispatchAll(), { results: [], dispatched: 0, skipped: 0, waiting: { clarification: 0, working: 0, review: 0, blocked: 0 } });
});

test("dispatchAll starts what is ready now and picks up the rest after its dependency is accepted", () => {
  const { wb } = manualWorkbench();
  const a = task(wb); const b = task(wb);
  wb.addDependency(b.id, a.id);
  const round1 = wb.dispatchAll();
  assert.deepEqual([round1.dispatched, round1.skipped], [1, 1]);
  assert.equal(round1.results.find((r) => r.taskId === b.id).code, "NOT_READY");
  const claim = wb.claimRun({ runnerId: "r", capabilities: CODEX });
  wb.submitResult(claim.run.id, { summary: "好了", leaseToken: claim.leaseToken });
  wb.acceptTask(a.id);
  const round2 = wb.dispatchAll();
  assert.deepEqual(round2.results.map((r) => [r.taskId, r.ok]), [[b.id, true]]);
});

test("dispatchAll can be limited to one requirement or one kind of task", () => {
  const { wb } = manualWorkbench();
  const r1 = wb.createRequirement({ title: "r1" }); const r2 = wb.createRequirement({ title: "r2" });
  const a = task(wb, { requirementId: r1.id }); const b = task(wb, { requirementId: r2.id });
  const analysis = wb.createAnalysisTask(r1.id, { executorType: "claude_code" });
  assert.deepEqual(wb.dispatchAll({ requirementId: r2.id }).results.map((r) => r.taskId), [b.id]);
  assert.deepEqual(wb.dispatchAll({ kinds: ["analysis"] }).results.map((r) => r.taskId), [analysis.id]);
  assert.deepEqual(wb.dispatchAll({ kinds: ["execution"] }).results.map((r) => r.taskId), [a.id]);
});

// ---------- settings ----------
test("the project directory is a setting: empty by default, validated, changed on record", () => {
  const { wb } = memoryWorkbench();
  assert.deepEqual(wb.listSettings(), { "project.path": null });
  assert.equal(wb.getSetting("project.path"), null);
  assert.equal(wb.getSetting("project.path", "D:/default"), "D:/default");
  assert.equal(wb.setSetting("project.path", "  E:\\Ztree\\chuhaila\\requirements-workbench  "), "E:\\Ztree\\chuhaila\\requirements-workbench");
  assert.equal(wb.getSetting("project.path"), "E:\\Ztree\\chuhaila\\requirements-workbench");
  wb.setSetting("project.path", "E:\\Ztree\\other");
  const changes = wb.listEvents({ entityType: "workspace" }).filter((e) => e.eventType === "setting.changed");
  assert.deepEqual(changes.map((e) => [e.payload.before, e.payload.after]), [["E:\\Ztree\\chuhaila\\requirements-workbench", "E:\\Ztree\\other"], [null, "E:\\Ztree\\chuhaila\\requirements-workbench"]]);
  wb.setSetting("project.path", "E:\\Ztree\\other");
  assert.equal(wb.listEvents({ entityType: "workspace" }).filter((e) => e.eventType === "setting.changed").length, 2, "setting the same value again records nothing");
  assert.equal(wb.clearSetting("project.path"), null);
  assert.equal(wb.getSetting("project.path"), null);
  for (const bad of ["", "   ", 5, null, "x".repeat(501), "a\0b"]) rejects(() => wb.setSetting("project.path", bad), "INVALID");
  rejects(() => wb.setSetting("secret.key", "x"), "INVALID");
  rejects(() => wb.clearSetting("secret.key"), "INVALID");
});

test("settings and task kind survive export and restore", () => {
  const { wb } = memoryWorkbench();
  wb.setSetting("project.path", "E:\\repo");
  const requirement = wb.createRequirement({ title: "r" });
  const analysis = wb.createAnalysisTask(requirement.id);
  const exported = JSON.parse(JSON.stringify(wb.exportAll()));
  assert.deepEqual(exported.settings.map((s) => s.key), ["project.path"]);
  const target = memoryWorkbench();
  restoreFromExport(target.db, exported, { recordEvent: false });
  assert.equal(target.wb.getSetting("project.path"), "E:\\repo");
  assert.equal(target.wb.getTask(analysis.id).kind, "analysis");
  assert.deepEqual({ ...JSON.parse(JSON.stringify(target.wb.exportAll())), exportedAt: 0 }, { ...exported, exportedAt: 0 });
});

// ---------- progress contract and run detail ----------
test("progress events keep to the contract: pct 0..100 and a short step", () => {
  const { wb } = manualWorkbench();
  const sent = wb.dispatchTask(task(wb).id);
  const claim = wb.claimRun({ runnerId: "r", capabilities: CODEX });
  const send = (data, id) => wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId: id, type: "progress", message: "m", data });
  assert.equal(send({ step: "编译", pct: 0 }, "p0").duplicate, false);
  assert.equal(send({ pct: 100 }, "p1").duplicate, false);
  for (const [i, bad] of [{ pct: -1 }, { pct: 101 }, { pct: "50" }, { pct: NaN }, { step: 5 }, { step: "x".repeat(121) }].entries()) rejects(() => send(bad, `bad${i}`), "INVALID");
  assert.equal(wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId: "l1", type: "log", message: "任何内容", data: { pct: 500 } }).duplicate, false, "other event types are free-form");
  assert.ok(sent);
});

test("run detail for a run waiting for a runner", () => {
  const { wb } = manualWorkbench();
  const sent = wb.dispatchTask(task(wb).id);
  const detail = wb.getRunDetail(sent.run.id);
  assert.equal(detail.phase, "等待 Runner 领取");
  assert.equal(detail.run.status, "pending");
  assert.equal(detail.heartbeat, null);
  assert.equal(detail.progress, null);
  assert.equal(detail.error, null);
  assert.equal(detail.logTail, "");
  assert.deepEqual(detail.timeline.map((t) => t.summary), ["任务 queued → working", "已派发，等待 Runner 领取"]);
  assert.deepEqual(detail.attempts.map((a) => [a.attempt, a.status]), [[1, "pending"]]);
  assert.equal(detail.task.kind, "execution");
  rejects(() => wb.getRunDetail("RUN-NOPE"), "NOT_FOUND");
});

test("run detail shows progress, log tail, heartbeat health and artifacts while a runner works", () => {
  const { wb, clock } = manualWorkbench();
  const sent = wb.dispatchTask(task(wb).id);
  const claim = wb.claimRun({ runnerId: "runner-1", capabilities: CODEX, leaseSeconds: 120 });
  const progress = (eventId, step, pct, message) => wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId, type: "progress", message, data: { step, pct } });
  const log = (eventId, message) => wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId, type: "log", message });
  progress("p1", "读取代码", 10, "扫描目录"); log("l1", "line one"); log("l2", "line two"); progress("p2", "修改文件", 60, "改 3 个文件");
  wb.addArtifact(claim.run.id, claim.leaseToken, { kind: "log", uri: "file:///x.log", sizeBytes: 10 });

  let detail = wb.getRunDetail(sent.run.id);
  assert.equal(detail.phase, "修改文件");
  assert.deepEqual([detail.progress.step, detail.progress.pct, detail.progress.message], ["修改文件", 60, "改 3 个文件"]);
  assert.equal(detail.logTail, "line one\nline two");
  assert.deepEqual([detail.heartbeat.state, detail.heartbeat.ageSeconds, detail.heartbeat.runnerId], ["ok", 0, "runner-1"]);
  assert.equal(detail.artifacts.length, 1);
  assert.deepEqual(detail.timeline.map((t) => t.summary).slice(2), ["Runner runner-1 已领取", "读取代码：扫描目录", "日志：line one", "日志：line two", "修改文件：改 3 个文件", "新增产物：log"]);

  clock.advance(45);
  assert.equal(wb.getRunDetail(sent.run.id).heartbeat.state, "slow");
  clock.advance(100);
  detail = wb.getRunDetail(sent.run.id);
  assert.deepEqual([detail.heartbeat.state, detail.phase], ["lost", "Runner 失联"]);
});

test("run detail keeps only the tail of a long log", () => {
  const { wb } = manualWorkbench();
  wb.dispatchTask(task(wb).id);
  const claim = wb.claimRun({ runnerId: "r", capabilities: CODEX });
  for (let i = 0; i < 40; i += 1) wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId: `l${i}`, type: "log", message: `${i}:${"x".repeat(900)}` });
  const { logTail } = wb.getRunDetail(claim.run.id);
  assert.ok(logTail.length <= 8000);
  assert.ok(logTail.includes("39:"), "the newest line is kept");
  assert.ok(!logTail.includes("\n0:"), "the oldest lines are dropped");
});

test("run detail explains failures, cancellations and lost runners, and lists every attempt", () => {
  const { wb, clock } = manualWorkbench();
  const t = task(wb);
  wb.dispatchTask(t.id);
  let claim = wb.claimRun({ runnerId: "r1", capabilities: CODEX });
  wb.reportFailure(claim.run.id, { message: "编译失败：缺少依赖", errorCode: "BUILD", leaseToken: claim.leaseToken });
  let detail = wb.getRunDetail(claim.run.id);
  assert.deepEqual([detail.phase, detail.error, detail.heartbeat.state], ["执行失败", { code: "BUILD", message: "编译失败：缺少依赖" }, "ended"]);
  assert.match(detail.timeline.at(-2).summary, /执行失败：编译失败/);

  wb.dispatchTask(t.id);
  claim = wb.claimRun({ runnerId: "r2", capabilities: CODEX });
  clock.advance(500);
  wb.expireLeases();
  detail = wb.getRunDetail(claim.run.id);
  assert.deepEqual([detail.phase, detail.error.code], ["Runner 失联，已回收", "WORKER_LOST"]);
  assert.ok(detail.timeline.some((x) => x.summary === "Runner 失联，租约过期，已回收"));

  const sent = wb.dispatchTask(t.id);
  wb.cancelRun(sent.run.id, { reason: "不做了" });
  detail = wb.getRunDetail(sent.run.id);
  assert.deepEqual([detail.phase, detail.error.message], ["已取消", "不做了"]);
  assert.deepEqual(detail.attempts.map((a) => [a.attempt, a.status, a.errorCode]), [[1, "failed", "BUILD"], [2, "worker_lost", "WORKER_LOST"], [3, "cancelled", "CANCELLED"]]);
});

test("run detail for a hand-off run and for accepted work", () => {
  const { wb } = manualWorkbench();
  const t = wb.createTask({ taskText: "m" });
  const { run } = wb.startTask(t.id);
  let detail = wb.getRunDetail(run.id);
  assert.deepEqual([detail.phase, detail.heartbeat], ["已手动启动，等待你提交结果", null]);
  wb.submitResult(run.id, { summary: "好了" });
  assert.equal(wb.getRunDetail(run.id).phase, "已提交结果，待验收");
  wb.acceptTask(t.id);
  assert.equal(wb.getRunDetail(run.id).phase, "已验收通过");
  const t2 = wb.createTask({ taskText: "n" });
  const second = wb.startTask(t2.id);
  wb.submitResult(second.run.id, { summary: "不行" });
  wb.rejectTask(t2.id, { note: "重做" });
  assert.equal(wb.getRunDetail(second.run.id).phase, "已退回");
});

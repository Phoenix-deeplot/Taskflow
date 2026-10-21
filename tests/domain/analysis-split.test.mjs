import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeWithModel, buildAnalysisRequest, normalizeAnalysisResult, renderAnalysisText } from "../../server/analyze.mjs";
import { createScriptedProvider, ProviderError } from "../../server/provider.mjs";
import { readProjectOverview } from "../../server/project-overview.mjs";
import { assessSplit, evaluateSplit } from "../../server/split.mjs";
import { memoryWorkbench } from "./helpers.mjs";

const rejects = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);
const rejectsAsync = (promise, code) => assert.rejects(promise, (e) => e.code === code, `expected ${code}`);

const goodAnalysis = (extra = {}) => ({
  conclusion: "改后做：先只做导出 CSV，不做定时导出。", userValue: "运营每周要手工整理表格，导出可省半天。",
  complexity: "低：只涉及 server/export.mjs 和一个按钮。", risks: ["大表导出会占内存"], v1Scope: "只导出当前筛选结果的 CSV。",
  openQuestions: ["是否需要 Excel 格式？"], needsSplit: { value: false, reason: "一个任务就能交付和验收。" },
  refinedTaskText: "在需求清单加“导出 CSV”按钮，导出当前筛选结果；不做定时导出，不改数据库。", acceptance: ["点击后下载含表头的 CSV", "筛选后导出的行数与列表一致"],
  ...extra,
});

// ---------- judging a split ----------

test("a sensible split has no findings that need attention", () => {
  const result = evaluateSplit([
    { key: "api", taskText: "实现导出接口，返回当前筛选结果的 CSV 内容", acceptance: ["返回含表头的 CSV"], fileScope: ["server/export.mjs"], dependsOn: [] },
    { key: "ui", taskText: "在需求清单页面加“导出 CSV”按钮并下载文件", acceptance: ["点击后浏览器下载 CSV"], fileScope: ["dist/index.html"], dependsOn: ["api"] },
  ]);
  assert.equal(result.verdict, "good");
  assert.deepEqual(result.findings, []);
});

test("an unnecessary or badly shaped split is called out, piece by piece", () => {
  const codes = (tasks) => evaluateSplit(tasks).findings.map((f) => f.code);
  const okTask = (key, extra = {}) => ({ key, taskText: `实现 ${key} 这一部分的具体工作，写清楚范围和边界`, acceptance: ["可验证"], fileScope: [], dependsOn: [], ...extra });

  assert.deepEqual(evaluateSplit([]).verdict, "bad");
  assert.ok(codes([okTask("only")]).includes("SINGLE"), "one task means the split was not needed");
  assert.ok(codes(Array.from({ length: 9 }, (_, i) => okTask(`t${i}`, { taskText: `第 ${i} 部分完全不同的工作内容 ${"abcdefghij"[i]}${i * 7919}`, dependsOn: i ? ["t0"] : [] }))).includes("TOO_MANY"));
  assert.ok(codes([okTask("a", { acceptance: [] }), okTask("b")]).includes("NO_ACCEPTANCE"));
  assert.ok(codes([okTask("a", { taskText: "改一下" }), okTask("b")]).includes("VAGUE"));
  assert.ok(codes([okTask("a", { taskText: "x".repeat(1600) }), okTask("b")]).includes("TOO_BIG"));
  assert.ok(codes([okTask("a", { taskText: "实现导出接口并返回当前筛选结果的 CSV 内容" }), okTask("b", { taskText: "实现导出接口，并返回当前筛选结果的 CSV 内容。" })]).includes("DUPLICATE"));
  assert.ok(codes([okTask("a", { fileScope: ["server/**"] }), okTask("b", { fileScope: ["server/export.mjs"] })]).includes("OVERLAP"), "same files, no order");
  assert.ok(!codes([okTask("a", { fileScope: ["server/**"] }), okTask("b", { fileScope: ["server/export.mjs"], dependsOn: ["a"] })]).includes("OVERLAP"), "an order removes the conflict");
  assert.ok(!codes([okTask("a", { fileScope: ["server/**"] }), okTask("b", { dependsOn: ["a"] }), okTask("c", { fileScope: ["server/x.mjs"], dependsOn: ["b"] })]).includes("OVERLAP"), "an indirect order counts too");
  const unordered = evaluateSplit([okTask("a"), okTask("b"), okTask("c")]);
  assert.deepEqual([unordered.verdict, unordered.findings.map((f) => f.code)], ["good", ["NO_ORDER"]], "a missing order is a hint, not a warning");
});

// ---------- what the model is given, and what comes back ----------

test("the model sees the requirement, its neighbours, existing work and the project — and no credentials", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "导出 CSV", module: "报表", description: "运营要导出当前筛选结果" });
  wb.createRequirement({ title: "定时报表", module: "报表" });
  wb.createRequirement({ title: "别的模块", module: "账号" });
  wb.createTask({ requirementId: requirement.id, taskText: "先调研导出格式" });
  const provider = createScriptedProvider({ name: "deepseek", replies: [goodAnalysis()] });
  const project = { name: "demo", readme: "# demo", tree: ["server/", "server/export.mjs"], scripts: ["test"], dependencies: [] };

  const result = await analyzeWithModel(wb, requirement.id, provider, { project });

  const sent = provider.calls[0];
  assert.equal(sent.input.requirement.title, "导出 CSV");
  assert.deepEqual(sent.input.sameModuleRequirements.map((r) => r.title), ["定时报表"], "only its own module");
  assert.equal(sent.input.existingTasks.length, 1);
  assert.deepEqual(sent.input.project, project);
  assert.match(sent.system, /不要泛泛而谈/);
  assert.equal(sent.schema.required.includes("needsSplit"), true);
  assert.equal(result.structured.needsSplit.value, false);
  for (const heading of ["结论", "用户价值", "实现复杂度", "关键风险与依赖", "建议的 V1 范围", "需要我确认的问题", "是否需要拆分", "细化后的任务说明", "验收标准"]) {
    assert.ok(result.text.includes(heading), heading);
  }
  assert.match(result.inputHash, /^[0-9a-f]{64}$/);
});

test("text that looks like a credential never reaches the model, and the refusal is on record", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "接入支付", description: "测试密钥 sk-abcdefghijklmnopqrstuvwxyz123456 先放这里" });
  const provider = createScriptedProvider({ name: "deepseek", replies: [goodAnalysis()] });
  await rejectsAsync(analyzeWithModel(wb, requirement.id, provider), "SECRET_IN_INPUT");
  assert.equal(provider.calls.length, 0);
  assert.equal(wb.listEvents({ entityId: requirement.id }).some((e) => e.eventType === "analysis.model_failed"), true);
});

test("a failed or unusable model answer leaves a trace but no analysis", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const broken = createScriptedProvider({ name: "deepseek", replies: [{ conclusion: "" }, new ProviderError("AUTH", "认证失败", { status: 401 })] });
  await rejectsAsync(analyzeWithModel(wb, requirement.id, broken), "BAD_RESPONSE");
  await rejectsAsync(analyzeWithModel(wb, requirement.id, broken), "AUTH");
  const failures = wb.listEvents({ entityId: requirement.id }).filter((e) => e.eventType === "analysis.model_failed");
  assert.deepEqual(failures.map((e) => e.payload.code).sort(), ["AUTH", "BAD_RESPONSE"]);
  assert.equal(wb.listTasks({ requirementId: requirement.id }).length, 0);
});

test("the model's answer is cleaned into a predictable shape", () => {
  const cleaned = normalizeAnalysisResult({ conclusion: " 做 ", refinedTaskText: "细化", risks: ["a", "", 5, " b "], needsSplit: "yes" });
  assert.deepEqual([cleaned.conclusion, cleaned.risks, cleaned.needsSplit.value, cleaned.acceptance], ["做", ["a", "b"], false, []]);
  assert.throws(() => normalizeAnalysisResult({ conclusion: "x" }), /细化后的任务说明/);
  assert.throws(() => normalizeAnalysisResult(null));
  assert.match(renderAnalysisText(cleaned), /是否需要拆分\n不需要/);
  assert.ok(buildAnalysisRequest({ context: null, requirement: { id: "R" } }).inputHash.length === 64);
});

// ---------- analysis becomes a task a person confirms, then assigns ----------

test("a model analysis is stored like an agent's: an analysis task waiting for a person", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "导出 CSV" });
  const result = await analyzeWithModel(wb, requirement.id, createScriptedProvider({ name: "deepseek", model: "deepseek-chat", replies: [goodAnalysis()] }));
  const { task, run } = wb.recordModelAnalysis(requirement.id, { provider: result.provider, model: result.model, usage: result.usage, inputHash: result.inputHash, summary: result.text, structured: result.structured });
  assert.deepEqual([task.kind, task.status, task.executorType, run.status, run.claimedBy], ["analysis", "review", "model:deepseek", "succeeded", ""]);
  const kinds = run.evidence.map((e) => e.kind);
  assert.deepEqual(kinds, ["model", "analysis-json", "check"]);
  assert.equal(run.evidence.find((e) => e.kind === "check").passed, true, "the built-in format check accepts it");
  assert.equal(run.evidence.find((e) => e.kind === "analysis-json").data.needsSplit.value, false);
  assert.equal(wb.getRequirement(requirement.id).decision, "pending", "an analysis never changes the decision by itself");
});

test("confirming an analysis accepts it and creates the task that carries it out", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "导出 CSV" });
  const { task: analysis } = wb.recordModelAnalysis(requirement.id, { provider: "deepseek", summary: "结论\n做", structured: goodAnalysis() });

  const assigned = wb.assignFromAnalysis(analysis.id, { taskText: "导出 CSV（已确认的分析：只做导出，不做定时）", acceptance: ["CSV 含表头"], executorType: "codex", provider: "codex" });
  assert.equal(assigned.analysisTask.status, "done");
  assert.deepEqual([assigned.task.kind, assigned.task.status, assigned.task.executorType, assigned.task.requirementId], ["execution", "queued", "codex", requirement.id]);
  assert.deepEqual(assigned.task.acceptance, ["CSV 含表头"]);
  assert.equal(wb.listEvents({ entityId: analysis.id }).some((e) => e.eventType === "analysis.assigned"), true);

  rejects(() => wb.assignFromAnalysis(analysis.id, { taskText: "再来一次" }), "CONFLICT");
  rejects(() => wb.assignFromAnalysis(assigned.task.id, { taskText: "x" }), "INVALID");
  const fresh = wb.recordModelAnalysis(requirement.id, { provider: "deepseek", summary: "结论\n做" }).task;
  rejects(() => wb.assignFromAnalysis(fresh.id, { taskText: "  " }), "INVALID");
  wb.deleteRequirement(requirement.id);
  rejects(() => wb.assignFromAnalysis(fresh.id, { taskText: "晚了" }), "CONFLICT");
});

test("an analysis that is not waiting for review cannot be confirmed", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const analysis = wb.createAnalysisTask(requirement.id);
  rejects(() => wb.assignFromAnalysis(analysis.id, { taskText: "x" }), "CONFLICT");
});

// ---------- "does this need splitting?" ----------

const splitReply = (needsSplit, tasks = []) => ({ assessment: { needsSplit, reason: needsSplit ? "有两个可独立验收的部分" : "一个任务就够" }, tasks });
const piece = (key, extra = {}) => ({ key, taskText: `实现 ${key} 部分：具体做什么、不做什么都写清楚`, acceptance: ["可验证"], fileScope: [], dependsOn: [], ...extra });
test("'no split needed' is a normal answer and creates nothing", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "改个文案" });
  const provider = createScriptedProvider({ name: "deepseek", replies: [splitReply(false)] });
  const result = await assessSplit(wb, requirement.id, provider, { project: { name: "demo" } });
  assert.deepEqual([result.needsSplit, result.draft, result.evaluation, result.reason], [false, null, null, "一个任务就够"]);
  assert.equal(wb.listSplitDrafts({ requirementId: requirement.id }).length, 0);
  assert.deepEqual(provider.calls[0].input.project, { name: "demo" });
  assert.match(provider.calls[0].system, /多数需求一个任务就能交付/);
});

test("a proposed split is stored as a draft together with its evaluation, and becomes tasks only when confirmed", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "导出 CSV" });
  const provider = createScriptedProvider({ name: "deepseek", replies: [splitReply(true, [piece("api"), piece("ui", { dependsOn: ["api"] })])] });
  const result = await assessSplit(wb, requirement.id, provider);
  assert.equal(result.needsSplit, true);
  assert.equal(result.draft.status, "draft");
  assert.equal(result.evaluation.verdict, "good");
  assert.equal(wb.listTasks({ requirementId: requirement.id }).length, 0, "nothing is a task yet");
  const confirmed = wb.confirmSplitDraft(result.draft.id);
  assert.equal(confirmed.tasks.length, 2);
});

test("a split answer that cannot be used is refused and recorded", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const provider = createScriptedProvider({ name: "deepseek", replies: [{ tasks: [] }, splitReply(true, []), splitReply(true, [piece("a", { dependsOn: ["ghost"] })])] });
  for (let i = 0; i < 3; i += 1) await rejectsAsync(assessSplit(wb, requirement.id, provider), "BAD_RESPONSE");
  assert.equal(wb.listSplitDrafts({ requirementId: requirement.id }).length, 0);
  assert.equal(wb.listEvents({ entityId: requirement.id }).filter((e) => e.eventType === "split.proposal_failed").length, 3);
});

// ---------- the project picture ----------

test("the project overview shows layout, README and scripts — and skips what could hold credentials", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "overview-"));
  try {
    mkdirSync(path.join(dir, "server"));
    mkdirSync(path.join(dir, "node_modules/x"), { recursive: true });
    mkdirSync(path.join(dir, ".git"));
    writeFileSync(path.join(dir, "README.md"), "# 演示项目\n用来导出报表。");
    writeFileSync(path.join(dir, "server/export.mjs"), "export {}");
    writeFileSync(path.join(dir, ".env"), "KEY=secret-value");
    writeFileSync(path.join(dir, "id_rsa"), "private");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "x", build: "y" }, dependencies: { next: "1" }, devDependencies: { vitest: "2" } }));
    const overview = readProjectOverview(dir);
    assert.equal(overview.name, "demo");
    assert.match(overview.readme, /用来导出报表/);
    assert.deepEqual(overview.scripts, ["test", "build"]);
    assert.deepEqual(overview.dependencies, ["next", "vitest"]);
    assert.ok(overview.tree.includes("server/export.mjs"));
    for (const hidden of [".env", "id_rsa", "node_modules/", ".git/"]) assert.ok(!overview.tree.some((entry) => entry.startsWith(hidden)), `${hidden} must not be listed`);
    assert.equal(readProjectOverview(path.join(dir, "missing")), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a README that contains a credential is left out; the rest of the overview still goes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "overview-"));
  try {
    writeFileSync(path.join(dir, "README.md"), "key: sk-abcdefghijklmnopqrstuvwxyz123456");
    writeFileSync(path.join(dir, "main.mjs"), "export {}");
    const overview = readProjectOverview(dir);
    assert.equal(overview.readme, "");
    assert.match(overview.omitted, /README/);
    assert.ok(overview.tree.includes("main.mjs"));
    assert.equal(JSON.stringify(overview).includes("sk-abc"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

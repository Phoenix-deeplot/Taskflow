import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSecretStore } from "../server/agent-config.mjs";
import { openDatabase } from "../server/db.mjs";
import { createApiHandler } from "../server/http-api.mjs";
import { createScriptedProvider } from "../server/provider.mjs";

const analysis = (extra = {}) => ({
  conclusion: "做", userValue: "有用", complexity: "低", risks: [], v1Scope: "只做导出", openQuestions: [],
  needsSplit: { value: false, reason: "一个任务够" }, refinedTaskText: "加导出按钮", acceptance: ["能下载"], ...extra,
});
const piece = (key, text, extra = {}) => ({ key, taskText: text, acceptance: ["可验证"], fileScope: [], dependsOn: [], ...extra });

async function withApi(run, { replies = [], keys = {}, projectDirectory } = {}) {
  const db = openDatabase(":memory:");
  const secretStore = createSecretStore();
  for (const [slot, value] of Object.entries(keys)) secretStore.set(slot, value);
  const provider = createScriptedProvider({ name: "deepseek", model: "deepseek-chat", replies });
  const handle = createApiHandler({ db, secretStore, providerGateway: { get: () => provider }, projectDirectory });
  const server = createServer(async (request, response) => {
    if (!await handle(request, response, new URL(request.url, "http://localhost").pathname)) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (pathname, method = "GET", body) => {
    const response = await fetch(base + pathname, { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  try { await run(call, { provider, db }); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
}
const KEYS = { "deepseek-api-key": "ds-test-key-123456789", "deepseek-model": "deepseek-chat" };
const newRequirement = async (call, title = "导出 CSV") => (await call("/api/requirements", "POST", { title, module: "报表" })).body.id;

test("the default engine is a model when one is set up, otherwise an Agent", async () => {
  await withApi(async (call) => {
    assert.deepEqual((await call("/api/analysis/engines")).body, { models: [], defaultEngine: "agent" });
  });
  await withApi(async (call) => {
    const engines = (await call("/api/analysis/engines")).body;
    assert.deepEqual(engines.models, [{ name: "deepseek", label: "DeepSeek", model: "deepseek-chat" }]);
    assert.equal(engines.defaultEngine, "deepseek");
  }, { keys: KEYS });
  // A key without a model name (or the reverse) is not usable, so it does not count.
  await withApi(async (call) => assert.equal((await call("/api/analysis/engines")).body.defaultEngine, "agent"), { keys: { "deepseek-api-key": "ds-test-key-123456789" } });
});

test("analysing with a model stores an analysis for a person to confirm; without a key it says so", async () => {
  await withApi(async (call) => {
    const id = await newRequirement(call);
    const noKey = await call(`/api/requirements/${id}/analysis/model`, "POST", { engine: "openai" });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.code, "NO_MODEL");
  }, { keys: KEYS, replies: [] });

  await withApi(async (call, { provider }) => {
    const id = await newRequirement(call);
    const done = await call(`/api/requirements/${id}/analysis/model`, "POST", { engine: "deepseek", includeProject: false });
    assert.equal(done.status, 201);
    assert.deepEqual([done.body.task.kind, done.body.task.status, done.body.task.executorType], ["analysis", "review", "model:deepseek"]);
    assert.match(done.body.text, /细化后的任务说明\n加导出按钮/);
    assert.equal(done.body.structured.needsSplit.value, false);
    assert.equal(done.body.projectUsed, false);
    assert.equal(provider.calls[0].input.project, undefined, "the person can keep the project out");
    assert.equal(done.text.includes("ds-test-key"), false);
  }, { keys: KEYS, replies: [analysis()] });
});

test("the model is told about the project the requirement belongs to", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "project-"));
  try {
    mkdirSync(path.join(dir, "server"));
    writeFileSync(path.join(dir, "README.md"), "# 报表系统");
    writeFileSync(path.join(dir, "server/export.mjs"), "export {}");
    await withApi(async (call, { provider }) => {
      const id = await newRequirement(call);
      const done = await call(`/api/requirements/${id}/analysis/model`, "POST", { engine: "deepseek" });
      assert.equal(done.body.projectUsed, true);
      assert.match(provider.calls[0].input.project.readme, /报表系统/);
      assert.ok(provider.calls[0].input.project.tree.includes("server/export.mjs"));
    }, { keys: KEYS, replies: [analysis()], projectDirectory: dir });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("record: false returns the analysis text without creating a task", async () => {
  await withApi(async (call) => {
    const id = await newRequirement(call);
    const preview = await call(`/api/requirements/${id}/analysis/model`, "POST", { engine: "deepseek", record: false, includeProject: false });
    assert.equal(preview.status, 200);
    assert.match(preview.body.text, /结论/);
    assert.equal((await call(`/api/tasks?requirementId=${id}`)).body.length ?? (await call(`/api/tasks?requirementId=${id}`)).body.tasks?.length, 0);
  }, { keys: KEYS, replies: [analysis()] });
});

test("after reading an analysis, confirming it creates the task to carry it out", async () => {
  await withApi(async (call) => {
    const id = await newRequirement(call);
    const done = (await call(`/api/requirements/${id}/analysis/model`, "POST", { engine: "deepseek", includeProject: false })).body;
    const assigned = await call(`/api/tasks/${done.task.id}/assign-from-analysis`, "POST", { taskText: "加导出按钮（已确认）", acceptance: ["能下载"], executorType: "codex", provider: "codex" });
    assert.equal(assigned.status, 201);
    assert.deepEqual([assigned.body.analysisTask.status, assigned.body.task.kind, assigned.body.task.status, assigned.body.task.executorType], ["done", "execution", "queued", "codex"]);
    assert.equal((await call(`/api/tasks/${done.task.id}/assign-from-analysis`, "POST", { taskText: "again" })).status, 409, "an analysis is confirmed once");
    assert.equal((await call(`/api/tasks/${assigned.body.task.id}/assign-from-analysis`, "POST", { taskText: "x" })).status, 400, "only analyses");
  }, { keys: KEYS, replies: [analysis()] });
});

test("splitting: 'no need' is an answer; a proposal is a draft that can be edited, judged, confirmed or dropped", async () => {
  await withApi(async (call) => {
    const id = await newRequirement(call);
    const no = await call(`/api/requirements/${id}/split/assess`, "POST", { engine: "deepseek", includeProject: false });
    assert.deepEqual([no.status, no.body.needsSplit, no.body.draft], [200, false, null]);
    assert.match(no.body.reason, /不用拆/);

    const yes = await call(`/api/requirements/${id}/split/assess`, "POST", { engine: "deepseek", includeProject: false });
    assert.equal(yes.body.needsSplit, true);
    assert.equal(yes.body.evaluation.verdict, "good");
    const draft = yes.body.draft;
    assert.equal((await call(`/api/requirements/${id}/split-drafts`)).body.length, 1);

    // Editing one piece into something vague is caught by the evaluation that comes back with the save.
    const edited = await call(`/api/split-drafts/${draft.id}`, "PUT", { tasks: [piece("api", "改一下"), draft.tasks[1]], expectedRevision: draft.revision });
    assert.equal(edited.status, 200);
    assert.ok(edited.body.evaluation.findings.some((f) => f.code === "VAGUE"));

    const fixed = await call(`/api/split-drafts/${draft.id}`, "PUT", { tasks: draft.tasks, expectedRevision: edited.body.revision });
    const confirmed = await call(`/api/split-drafts/${draft.id}/confirm`, "POST", { expectedRevision: fixed.body.revision });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.tasks.length, 2);
    assert.equal((await call(`/api/split-drafts/${draft.id}/confirm`, "POST", {})).status, 409, "a draft is confirmed once");

    const second = (await call(`/api/requirements/${id}/split-drafts`, "POST", { tasks: [piece("solo", "单独做完整件事，范围写得足够清楚")] })).body;
    assert.equal(second.source, "manual");
    assert.ok(second.evaluation.findings.some((f) => f.code === "SINGLE"));
    const dropped = await call(`/api/split-drafts/${second.id}/discard`, "POST", { reason: "不用拆" });
    assert.equal(dropped.body.status, "discarded");
  }, {
    keys: KEYS,
    replies: [
      { assessment: { needsSplit: false, reason: "一个任务就够，不用拆" }, tasks: [] },
      { assessment: { needsSplit: true, reason: "有两个可独立验收的部分" }, tasks: [piece("api", "实现导出接口，返回当前筛选结果的 CSV 内容"), piece("ui", "在需求清单页面加导出按钮并下载文件", { dependsOn: ["api"] })] },
    ],
  });
});

test("a split can be judged while it is still being typed, even when half-finished", async () => {
  await withApi(async (call) => {
    const result = await call("/api/split/evaluate", "POST", { tasks: [{ key: "", taskText: "x" }, { key: "b", taskText: 5, acceptance: "not-a-list" }, null] });
    assert.equal(result.status, 200);
    assert.ok(result.body.findings.length > 0);
    assert.equal((await call("/api/split/evaluate", "POST", { tasks: "nope" })).body.verdict, "bad");
  });
});

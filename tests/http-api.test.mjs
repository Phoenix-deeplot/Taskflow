import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { openDatabase } from "../server/db.mjs";
import { createApiHandler } from "../server/http-api.mjs";
import { createScriptedProvider } from "../server/provider.mjs";

async function withApi(run, db = openDatabase(":memory:"), workbench, providerGateway, detectAgents) {
  const handle = createApiHandler({ db, workbench, providerGateway, detectAgents });
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!await handle(request, response, pathname)) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try { await run(base, db); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
}

async function json(base, pathname, options = {}) {
  const response = await fetch(base + pathname, options);
  return { status: response.status, body: await response.json() };
}

const send = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Runner routes forward lifecycle calls, require lease tokens, and reject browser callbacks", async () => {
  const calls = [];
  const workbench = Object.fromEntries([
    ["dispatchTask", (...args) => { calls.push(["dispatchTask", ...args]); return { run: { id: "RUN-1", status: "pending" } }; }],
    ["claimRun", (input) => { calls.push(["claimRun", input]); return null; }],
    ["heartbeat", (...args) => { calls.push(["heartbeat", ...args]); return { leaseUntil: "later", cancelRequested: false }; }],
    ["appendRunEvent", (...args) => { calls.push(["appendRunEvent", ...args]); return { inserted: true }; }],
    ["submitResult", (...args) => { calls.push(["submitResult", ...args]); return { status: "review" }; }],
    ["reportFailure", (...args) => { calls.push(["reportFailure", ...args]); return { status: "failed" }; }],
    ["cancelRun", (...args) => { calls.push(["cancelRun", ...args]); return { status: "cancelled" }; }],
    ["ackCancel", (...args) => { calls.push(["ackCancel", ...args]); return { status: "cancelled" }; }],
    ["addArtifact", (...args) => { calls.push(["addArtifact", ...args]); return { id: "ART-1" }; }],
    ["listArtifacts", (id) => { calls.push(["listArtifacts", id]); return [{ id: "ART-1" }]; }],
  ]);

  await withApi(async (base) => {
    const dispatch = await json(base, "/api/tasks/TASK-RUN/dispatch", send("POST", { expectedRevision: 4 }));
    assert.equal(dispatch.status, 202);
    assert.deepEqual(calls.at(-1), ["dispatchTask", "TASK-RUN", { expectedRevision: 4 }]);

    const claim = await json(base, "/api/runner/claim", send("POST", { runnerId: "runner-test", leaseSeconds: 30 }));
    assert.equal(claim.status, 200);
    assert.deepEqual(calls.at(-1), ["claimRun", { runnerId: "runner-test", leaseSeconds: 30 }]);

    const unauthorized = await json(base, "/api/runs/RUN-1/heartbeat", send("POST", {}));
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.code, "RUNNER_TOKEN_REQUIRED");

    const browserCallback = await fetch(`${base}/api/runs/RUN-1/heartbeat`, {
      ...send("POST", {}), headers: { ...send("POST", {}).headers, Authorization: "Bearer secret", Origin: base },
    });
    assert.equal(browserCallback.status, 403);
    assert.equal((await browserCallback.json()).code, "RUNNER_CALLBACK_BROWSER_BLOCKED");

    const authSend = (body) => ({ ...send("POST", body), headers: { ...send("POST", body).headers, Authorization: "Bearer lease-secret" } });
    assert.equal((await json(base, "/api/runs/RUN-1/heartbeat", authSend({ leaseSeconds: 20 }))).status, 200);
    assert.equal((await json(base, "/api/runs/RUN-1/events", authSend({ eventId: "evt-1", type: "progress", message: "working" }))).status, 201);
    await json(base, "/api/runs/RUN-1/result", authSend({ summary: "done", idempotencyKey: "result-1" }));
    await json(base, "/api/runs/RUN-1/failure", authSend({ errorMessage: "failed", idempotencyKey: "failure-1" }));
    await json(base, "/api/runs/RUN-1/artifacts", authSend({ kind: "log", uri: "file:///tmp/run.log", sizeBytes: 12 }));
    await json(base, "/api/runs/RUN-1/ack-cancel", authSend({}));
    const artifacts = await json(base, "/api/runs/RUN-1/artifacts");
    assert.deepEqual(artifacts.body, [{ id: "ART-1" }]);
    await json(base, "/api/runs/RUN-1/cancel", send("POST", { reason: "用户取消" }));

    assert.equal(calls.find(([name]) => name === "heartbeat")[2], "lease-secret");
    assert.equal(calls.find(([name]) => name === "appendRunEvent")[2], "lease-secret");
    assert.equal(calls.find(([name]) => name === "submitResult")[2].leaseToken, "lease-secret");
    assert.equal(calls.find(([name]) => name === "submitResult")[2].idempotencyKey, "result-1");
    assert.equal(calls.find(([name]) => name === "reportFailure")[2].leaseToken, "lease-secret");
    assert.equal(calls.find(([name]) => name === "addArtifact")[2], "lease-secret");
    assert.equal(calls.find(([name]) => name === "ackCancel")[2], "lease-secret");
    assert.deepEqual(calls.find(([name]) => name === "cancelRun").slice(1), ["RUN-1", { reason: "用户取消" }]);
  }, openDatabase(":memory:"), workbench);
});

test("settings, agent detection, analysis tasks, batch dispatch, and run detail are exposed over HTTP", async () => {
  const calls = [];
  const workbench = {
    getSetting: (key) => key === "project.path" ? "C:/repo" : null,
    setSetting: (key, value) => { calls.push(["setSetting", key, value]); return value; },
    createAnalysisTask: (id, body) => { calls.push(["createAnalysisTask", id, body]); return { id: "TASK-ANALYSIS" }; },
    dispatchTasks: (ids, body) => { calls.push(["dispatchTasks", ids, body]); return { dispatched: ids.length, skipped: 0 }; },
    dispatchAll: (body) => { calls.push(["dispatchAll", body]); return { dispatched: 1, waiting: {} }; },
    getRunDetail: (id) => ({ run: { id }, phase: "执行中", logTail: "latest" }),
  };
  await withApi(async (base) => {
    assert.deepEqual((await json(base, "/api/settings")).body, { projectPath: "C:/repo" });
    const invalidProject = await json(base, "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath: "__missing_project_for_settings_test__" }) });
    assert.equal(invalidProject.status, 400);
    assert.equal((await json(base, "/api/analysis-template")).status, 200);
    assert.deepEqual((await json(base, "/api/agents")).body, { claude: { available: true }, codex: { available: false }, custom: [] });
    assert.equal((await json(base, "/api/requirements/REQ-1/analysis", send("POST", { template: "only read" }))).body.id, "TASK-ANALYSIS");
    assert.equal((await json(base, "/api/tasks/dispatch", send("POST", { taskIds: ["T1", "T2"], executorType: "codex" }))).body.dispatched, 2);
    assert.equal((await json(base, "/api/tasks/dispatch-all", send("POST", { executorType: "claude" }))).body.dispatched, 1);
    assert.equal((await json(base, "/api/runs/RUN-DETAIL")).body.logTail, "latest");
    assert.deepEqual(calls, [
      ["createAnalysisTask", "REQ-1", { template: "only read" }],
      ["dispatchTasks", ["T1", "T2"], { taskIds: ["T1", "T2"], executorType: "codex" }],
      ["dispatchAll", { executorType: "claude" }],
    ]);
  }, openDatabase(":memory:"), workbench, { get() {} }, async () => ({ claude: { available: true }, codex: { available: false } }));
});

test("AI split proposal route uses the server provider and returns a draft without creating tasks", async () => {
  const provider = createScriptedProvider({ replies: [{ tasks: [{ key: "step", taskText: "拆分后的任务", acceptance: ["可验收"] }] }] });
  const providerGateway = { get(name) { assert.equal(name, "deepseek"); return provider; } };
  await withApi(async (base) => {
    await json(base, "/api/requirements", send("POST", { id: "REQ-SPLIT-ROUTE", title: "AI 拆分" }));
    const response = await json(base, "/api/requirements/REQ-SPLIT-ROUTE/split/propose", send("POST", { provider: "deepseek", apiKey: "must-not-be-used" }));
    assert.equal(response.status, 201);
    assert.equal(response.body.status, "draft");
    assert.equal(response.body.tasks[0].taskText, "拆分后的任务");
    assert.equal(provider.calls.length, 1);
    assert.equal(JSON.stringify(provider.calls[0]).includes("must-not-be-used"), false);
    assert.deepEqual((await json(base, "/api/tasks?requirementId=REQ-SPLIT-ROUTE")).body, []);
    assert.equal((await json(base, "/api/export")).body.splitDrafts[0].id, response.body.id);
  }, undefined, undefined, providerGateway);
});

test("empty relational workspace stays uninitialized and does not create an empty import", async () => {
  await withApi(async (base, db) => {
    const result = await json(base, "/api/state");
    assert.equal(result.body.initialized, false);
    assert.deepEqual(result.body.state.items, []);
    const emptyWrite = await json(base, "/api/state", send("PUT", { state: { schemaVersion: 1, items: [], tasks: [], events: [] } }));
    assert.equal(emptyWrite.body.initialized, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migration_sources").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM requirements").get().n, 0);
  });
});

test("legacy state compatibility API writes data into normalized tables and reads it back", async () => {
  await withApi(async (base, db) => {
    const legacy = {
      schemaVersion: 1,
      items: [{ id: "REQ-HTTP", module: "工具", title: "HTTP 需求", description: "测试", sourceVersion: "v0.1", targetVersion: "V1", decision: "keep", decisionNote: "" }],
      tasks: [{ id: "TASK-HTTP", featureId: "REQ-HTTP", model: "claude", assignee: "Claude", status: "queued", task: "验证 HTTP API", suggestion: "", createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" }],
      events: [], updatedAt: "2026-10-19T00:00:00.000Z",
    };
    const saved = await json(base, "/api/state", send("PUT", { state: legacy }));
    assert.equal(saved.status, 200);
    assert.equal(saved.body.initialized, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM requirements").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'workbench_state'").get().n, 0);
    const loaded = await json(base, "/api/state");
    assert.equal(loaded.body.state.items[0].id, "REQ-HTTP");
    assert.equal(loaded.body.state.tasks[0].featureTitle, "HTTP 需求");
  });
});

test("HTTP task lifecycle is server-validated and persists snapshot, run, result and acceptance", async () => {
  await withApi(async (base, db) => {
    await json(base, "/api/requirements", send("POST", { id: "REQ-LIFE", title: "生命周期需求", decision: "keep" }));
    const created = await json(base, "/api/tasks", send("POST", { id: "TASK-LIFE", requirementId: "REQ-LIFE", provider: "codex", assignee: "Codex", taskText: "验证端到端生命周期", acceptance: ["有数据库证据"] }));
    assert.equal(created.status, 201);
    const illegal = await json(base, "/api/tasks/TASK-LIFE/transition", send("POST", { target: "working" }));
    assert.equal(illegal.status, 409);
    assert.match(illegal.body.error, /startTask/);

    const started = await json(base, "/api/tasks/TASK-LIFE/start", send("POST", {}));
    assert.equal(started.status, 200);
    assert.ok(started.body.snapshot.payloadHash);
    const snapshot = await json(base, `/api/snapshots/${started.body.snapshot.id}`);
    assert.equal(snapshot.body.payloadHash, started.body.snapshot.payloadHash);
    assert.equal(started.body.task.status, "working");
    const result = await json(base, `/api/runs/${started.body.run.id}/result`, send("POST", { summary: "测试通过", evidence: [{ kind: "test", name: "HTTP lifecycle" }] }));
    assert.equal(result.body.task.status, "review");
    const accepted = await json(base, "/api/tasks/TASK-LIFE/accept", send("POST", { note: "证据充分" }));
    assert.equal(accepted.body.task.status, "done");
    assert.equal(accepted.body.run.reviewDecision, "accepted");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_context_snapshots").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE status = 'succeeded'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n >= 6, true);
    const visible = await json(base, "/api/state");
    assert.equal(visible.body.state.tasks[0].status, "done");
  });
});

test("state compatibility API rejects completion without an execution result", async () => {
  await withApi(async (base) => {
    const initial = {
      schemaVersion: 1,
      items: [{ id: "REQ-GUARD", title: "服务端状态机" }],
      tasks: [{ id: "TASK-GUARD", featureId: "REQ-GUARD", status: "queued", task: "不可直接完成" }],
      events: [],
    };
    const seeded = await json(base, "/api/state", send("PUT", { state: initial }));
    const invalidState = structuredClone(initial);
    invalidState.stateVersion = seeded.body.state.stateVersion;
    invalidState.tasks[0].status = "done";
    const rejected = await json(base, "/api/state", send("PUT", { state: invalidState }));
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, "INVALID");
    const stored = await json(base, "/api/state");
    assert.equal(stored.body.state.tasks[0].status, "queued");
  });
});

test("the version endpoint is tiny and moves whenever the workspace changes", async () => {
  await withApi(async (base) => {
    const first = await json(base, "/api/version");
    assert.deepEqual(Object.keys(first.body), ["stateVersion"]);
    assert.equal(first.body.stateVersion, 0);
    await json(base, "/api/requirements", send("POST", { title: "变化" }));
    const second = await json(base, "/api/version");
    assert.ok(second.body.stateVersion > first.body.stateVersion);
    assert.equal((await json(base, "/api/version")).body.stateVersion, second.body.stateVersion, "reading never moves it");
  });
});

test("a newer local cache can replay completed work through legal server lifecycle steps", async () => {
  await withApi(async (base, db) => {
    const cached = {
      schemaVersion: 1,
      items: [{ id: "REQ-CACHE", title: "离线期间完成的需求" }],
      tasks: [{ id: "TASK-CACHE", featureId: "REQ-CACHE", status: "queued", task: "离线执行", suggestion: "", createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" }],
      events: [],
    };
    const seeded = await json(base, "/api/state", send("PUT", { state: cached }));
    const newerCache = structuredClone(cached);
    newerCache.stateVersion = seeded.body.state.stateVersion;
    newerCache.tasks[0].status = "done";
    newerCache.tasks[0].suggestion = "离线执行结果和验收证据摘要";
    newerCache.tasks[0].updatedAt = "2026-10-19T01:00:00.000Z";
    const recovered = await json(base, "/api/state", send("PUT", { state: newerCache }));
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.state.tasks[0].status, "done");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_context_snapshots").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE status = 'succeeded'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE review_decision = 'accepted'").get().n, 1);
  });
});

test("HTTP routes expose split, progress, context versions and empty-database restore", async () => {
  await withApi(async (base) => {
    const req = await json(base, "/api/requirements", send("POST", { id: "REQ-ROUTES", title: "API 路由" }));
    assert.equal(req.status, 201);
    const split = await json(base, "/api/requirements/REQ-ROUTES/split", send("POST", { tasks: [
      { key: "a", taskText: "先做 A", acceptance: ["A 验收"] },
      { key: "b", taskText: "再做 B", acceptance: ["B 验收"], dependsOn: ["a"] },
    ] }));
    assert.equal(split.status, 201);
    assert.equal(split.body.tasks.length, 2);
    assert.equal(split.body.dependencies.length, 1);
    const progress = await json(base, "/api/requirements/REQ-ROUTES/progress");
    assert.equal(progress.body.total, 2);
    assert.equal(progress.body.open, 2);

    const appended = await json(base, "/api/context", send("POST", { rules: { rules: ["必须人工验收"], glossary: [], constraints: [] } }));
    assert.equal(appended.status, 201);
    const context = await json(base, "/api/context");
    assert.equal(context.body.current.revision, appended.body.revision);
    assert.equal(context.body.versions.length, 2);

    const exported = await json(base, "/api/export");
    const previewFull = await json(base, "/api/restore/preview", send("POST", { document: exported.body }));
    assert.equal(previewFull.body.status, "not_empty");
    await withApi(async (emptyBase) => {
      const previewEmpty = await json(emptyBase, "/api/restore/preview", send("POST", { document: exported.body }));
      assert.equal(previewEmpty.status, 200);
      assert.equal(previewEmpty.body.status, "ready");
      const restored = await json(emptyBase, "/api/restore/commit", send("POST", { document: exported.body }));
      assert.equal(restored.body.status, "restored");
    });
  });
});

test("legacy import preview and commit skip conflicts without reverting accepted work", async () => {
  await withApi(async (base) => {
    await json(base, "/api/requirements", send("POST", { id: "REQ-IMPORT-CONFLICT", title: "当前标题" }));
    await json(base, "/api/tasks", send("POST", { id: "TASK-IMPORT-CONFLICT", requirementId: "REQ-IMPORT-CONFLICT", taskText: "当前任务" }));
    const started = await json(base, "/api/tasks/TASK-IMPORT-CONFLICT/start", send("POST", {}));
    await json(base, `/api/runs/${started.body.run.id}/result`, send("POST", { summary: "已验收成果" }));
    await json(base, "/api/tasks/TASK-IMPORT-CONFLICT/accept", send("POST", { note: "确认完成" }));

    const legacy = { schemaVersion: 1, items: [{ id: "REQ-IMPORT-CONFLICT", title: "旧标题" }], tasks: [{ id: "TASK-IMPORT-CONFLICT", featureId: "REQ-IMPORT-CONFLICT", task: "旧任务", status: "queued" }], events: [] };
    const preview = await json(base, "/api/import/preview", send("POST", { state: legacy }));
    assert.equal(preview.body.counts.requirements.conflicts, 1);
    assert.equal(preview.body.counts.tasks.conflicts, 1);
    const committed = await json(base, "/api/import/commit", send("POST", { state: legacy, origin: "test-conflict" }));
    assert.equal(committed.body.status, "imported");
    assert.equal((await json(base, "/api/requirements/REQ-IMPORT-CONFLICT")).body.title, "当前标题");
    assert.equal((await json(base, "/api/tasks/TASK-IMPORT-CONFLICT")).body.status, "done");
  });
});

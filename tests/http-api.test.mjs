import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { openDatabase } from "../server/db.mjs";
import { createApiHandler } from "../server/http-api.mjs";

async function withApi(run) {
  const db = openDatabase(":memory:");
  const handle = createApiHandler({ db });
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

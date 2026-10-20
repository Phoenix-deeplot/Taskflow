import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import test from "node:test";
import { createFakeAdapter } from "../../runner/fake-adapter.mjs";
import { runClaimedRun } from "../../runner/runner-core.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function tempDirectory() {
  const directory = path.join(projectRoot, "work");
  await mkdir(directory, { recursive: true });
  return mkdtemp(path.join(directory, "runner-test-"));
}

async function fakeApi(runRequest) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const entry = { method: request.method, url: request.url, headers: request.headers, body: body ? JSON.parse(body) : {} };
    requests.push(entry);
    const result = await runRequest(entry);
    response.writeHead(result.status || 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  return { apiBase, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function assertMissing(filePath) {
  await assert.rejects(access(filePath));
}

test("fake Runner executes in a git worktree and reports result plus a log artifact", async () => {
  const directory = await tempDirectory();
  const repositoryPath = projectRoot;
  const runnerDirectory = path.join(directory, "runner-data");
  const api = await fakeApi(async ({ url, headers }) => {
    assert.equal(headers.authorization, "Bearer one-time-lease");
    if (url.endsWith("/heartbeat")) return { body: { cancelRequested: false, leaseUntil: "later" } };
    if (url.endsWith("/events")) return { status: 201, body: { inserted: true } };
    if (url.endsWith("/artifacts")) return { status: 201, body: { id: "ART-1" } };
    if (url.endsWith("/result")) return { body: { status: "review" } };
    throw new Error(`Unexpected Runner request ${url}`);
  });
  try {
    const result = await runClaimedRun({
      apiBase: api.apiBase,
      claim: { run: { id: "RUN-TEST" }, task: { id: "TASK-TEST", taskText: "fake work" }, snapshot: {}, leaseToken: "one-time-lease" },
      repositoryPath,
      runnerDirectory,
      adapter: createFakeAdapter(),
      heartbeatMs: 5,
      timeoutMs: 1_000,
    });
    assert.equal(result.status, "succeeded");
    assert.ok(api.requests.some((request) => request.url.endsWith("/result")));
    const artifact = api.requests.find((request) => request.url.endsWith("/artifacts"));
    assert.equal(artifact.body.kind, "log");
    assert.match(artifact.body.uri, /^file:/);
    const logPath = path.join(runnerDirectory, "artifacts", "RUN-TEST", "runner.log");
    assert.match(await readFile(logPath, "utf8"), /executor.completed/);
    await assertMissing(path.join(runnerDirectory, "worktrees", "RUN-TEST"));
  } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Runner stops executing after a lease heartbeat is rejected", async () => {
  const directory = await tempDirectory();
  const repositoryPath = projectRoot;
  const api = await fakeApi(async ({ url }) => url.endsWith("/heartbeat")
    ? { status: 409, body: { code: "LEASE_LOST", error: "lease lost" } }
    : { body: {} });
  try {
    const result = await runClaimedRun({
      apiBase: api.apiBase,
      claim: { run: { id: "RUN-LOST" }, task: { id: "TASK-LOST" }, leaseToken: "expired" },
      repositoryPath,
      runnerDirectory: path.join(directory, "runner-data"),
      adapter: createFakeAdapter({ delayMs: 100 }),
      heartbeatMs: 5,
      timeoutMs: 1_000,
    });
    assert.equal(result.status, "lease_lost");
    assert.equal(api.requests.some((request) => request.url.endsWith("/result")), false);
  } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
});

test("fake Runner reports an executor timeout as a failed Run", async () => {
  const directory = await tempDirectory();
  const repositoryPath = projectRoot;
  const api = await fakeApi(async ({ url }) => url.endsWith("/failure")
    ? { body: { status: "failed" } }
    : { body: {} });
  try {
    const result = await runClaimedRun({
      apiBase: api.apiBase,
      claim: { run: { id: "RUN-TIMEOUT" }, task: { id: "TASK-TIMEOUT" }, leaseToken: "valid" },
      repositoryPath,
      runnerDirectory: path.join(directory, "runner-data"),
      adapter: createFakeAdapter({ delayMs: 100 }),
      heartbeatMs: 1_000,
      timeoutMs: 5,
    });
    assert.equal(result.status, "failed");
    assert.ok(api.requests.some((request) => request.url.endsWith("/failure")));
  } finally { await api.close(); await rm(directory, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";
import { createFakeAdapter } from "../../runner/fake-adapter.mjs";
import { runClaimedRun } from "../../runner/runner-core.mjs";

const execFileAsync = promisify(execFile);
async function tempDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "runner-test-"));
}

/** A throwaway git repository: tests must never create worktrees or branches in the real project. */
async function demoRepository(directory) {
  const repo = path.join(directory, "repo");
  await mkdir(repo, { recursive: true });
  const git = async (...args) => (await execFileAsync("git", ["-C", repo, "-c", "user.name=tester", "-c", "user.email=tester@example.com", ...args])).stdout.trim();
  await execFileAsync("git", ["init", "-q", repo]);
  await git("symbolic-ref", "HEAD", "refs/heads/main");
  await writeFile(path.join(repo, "math.mjs"), "export const one = 1;\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
  return { repo, git };
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
  const { repo: repositoryPath } = await demoRepository(directory);
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

/** Runs one claimed run against a fake API and returns what was reported. */
async function runWith({ directory, repositoryPath, adapter, task, workspace }) {
  const api = await fakeApi(async ({ url }) => {
    if (url.endsWith("/heartbeat")) return { body: { cancelRequested: false, leaseUntil: "later" } };
    if (url.endsWith("/events")) return { status: 201, body: { inserted: true } };
    if (url.endsWith("/artifacts")) return { status: 201, body: { id: "ART-1" } };
    if (url.endsWith("/result")) return { body: { status: "review" } };
    throw new Error(`Unexpected Runner request ${url}`);
  });
  try {
    const result = await runClaimedRun({
      apiBase: api.apiBase,
      claim: { run: { id: "RUN-X1" }, task, workspace, snapshot: {}, leaseToken: "lease" },
      repositoryPath, runnerDirectory: path.join(directory, "runner-data"), adapter, heartbeatMs: 5, timeoutMs: 5_000,
    });
    return { result, artifacts: api.requests.filter((r) => r.url.endsWith("/artifacts")).map((r) => r.body) };
  } finally { await api.close(); }
}

const editingAdapter = (file, content) => ({
  name: "editor",
  async execute({ workspace }) {
    await writeFile(path.join(workspace, file), content);
    return { summary: "改好了", evidence: [] };
  },
});

test("a run that changes files commits them on its branch, reports the branch, and cleans up the worktree", async () => {
  const directory = await tempDirectory();
  const { repo, git } = await demoRepository(directory);
  try {
    const mainBefore = await git("rev-parse", "main");
    const { result, artifacts } = await runWith({
      directory, repositoryPath: repo, adapter: editingAdapter("math.mjs", "export const one = 1;\nexport const two = 2;\n"),
      task: { id: "TASK-1", kind: "execution", taskText: "请改\n\n—— 需求 ——\n需求：加 two 常量" }, workspace: { branch: "wb/task-1-a1" },
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(artifacts.map((a) => a.kind), ["log", "diff", "branch"]);
    const branch = artifacts.find((a) => a.kind === "branch");
    assert.equal(branch.uri, "git:wb/task-1-a1");
    assert.equal(branch.metadata.commit, await git("rev-parse", "wb/task-1-a1"));
    assert.equal(branch.metadata.base, mainBefore);
    assert.equal(await git("show", "wb/task-1-a1:math.mjs"), "export const one = 1;\nexport const two = 2;");
    assert.match(await git("log", "-1", "--format=%s", "wb/task-1-a1"), /^workbench: 加 two 常量$/);
    assert.equal(await git("rev-parse", "main"), mainBefore, "the main branch is never touched");
    assert.equal(await git("status", "--porcelain"), "", "nor is the project's own working directory");
    assert.equal(await readFile(path.join(repo, "math.mjs"), "utf8"), "export const one = 1;\n");
    await assertMissing(path.join(directory, "runner-data", "worktrees", "RUN-X1"));
    assert.match(await git("worktree", "list"), /^[^\n]*repo[^\n]*\[main\]\s*$/, "only the main worktree is left");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a read-only analysis run changes nothing: no commit, no branch left behind", async () => {
  const directory = await tempDirectory();
  const { repo, git } = await demoRepository(directory);
  try {
    const { artifacts } = await runWith({
      directory, repositoryPath: repo, adapter: createFakeAdapter(),
      task: { id: "TASK-2", kind: "analysis", taskText: "分析" }, workspace: { branch: null },
    });
    assert.deepEqual(artifacts.map((a) => a.kind), ["log"]);
    assert.equal(await git("branch", "--format=%(refname:short)"), "main");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an unusable or already-taken branch name falls back to a unique one instead of failing the run", async () => {
  for (const preferred of ["main", "bad name~^:", ""]) {
    const directory = await tempDirectory();
    const { repo } = await demoRepository(directory);
    try {
      const { result, artifacts } = await runWith({
        directory, repositoryPath: repo, adapter: editingAdapter("math.mjs", "export const one = 1;\nexport const three = 3;\n"),
        task: { id: "TASK-3", kind: "execution", taskText: "改" }, workspace: { branch: preferred },
      });
      assert.equal(result.status, "succeeded", `preferred "${preferred}"`);
      const branch = artifacts.find((a) => a.kind === "branch");
      assert.match(branch.uri, /^git:workbench\/RUN-X1-[0-9a-f]{8}$/, `preferred "${preferred}"`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("Runner stops executing after a lease heartbeat is rejected", async () => {
  const directory = await tempDirectory();
  const { repo: repositoryPath } = await demoRepository(directory);
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
  const { repo: repositoryPath } = await demoRepository(directory);
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

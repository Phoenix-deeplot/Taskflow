import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function freePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function createRepository(repoPath) {
  await mkdir(repoPath, { recursive: true });
  execFileSync("git", ["init", repoPath], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Runner E2E"]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "runner-e2e@example.invalid"]);
  await writeFile(path.join(repoPath, "README.md"), "temporary runner repository\n");
  execFileSync("git", ["-C", repoPath, "add", "README.md"]);
  execFileSync("git", ["-C", repoPath, "commit", "-m", "initial"], { stdio: "ignore" });
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}

async function stopChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}

async function postJson(base, route, body) {
  const response = await fetch(new URL(route, base), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.ok(response.ok, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

test("a killed local Runner is reaped as worker_lost and its task is queued again", async () => {
  const workRoot = path.join(projectRoot, "work");
  await mkdir(workRoot, { recursive: true });
  const directory = await mkdtemp(path.join(workRoot, "runner-e2e-"));
  const dataDirectory = path.join(directory, "data");
  const repositoryPath = path.join(directory, "repo");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server;
  let runner;
  let serverOutput = "";
  try {
    await createRepository(repositoryPath);
    server = spawn(process.execPath, ["scripts/serve-local.mjs", "--port", String(port)], {
      cwd: projectRoot,
      env: { ...process.env, WORKBENCH_DATA_DIR: dataDirectory },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
    await waitFor(async () => {
      if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}`);
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, "local workbench server starts");

    await postJson(base, "/api/requirements", { id: "REQ-RUNNER-E2E", title: "Runner recovery" });
    await postJson(base, "/api/tasks", { id: "TASK-RUNNER-E2E", requirementId: "REQ-RUNNER-E2E", taskText: "simulate a killed executor" });
    const dispatched = await postJson(base, "/api/tasks/TASK-RUNNER-E2E/dispatch", { executorType: "fake" });
    assert.equal(dispatched.run.status, "pending");

    runner = spawn(process.execPath, ["scripts/run-runner.mjs"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        WORKBENCH_RUNNER_API: base,
        WORKBENCH_RUNNER_ID: "e2e-runner",
        WORKBENCH_RUNNER_ADAPTER: "fake",
        WORKBENCH_RUNNER_LEASE_SECONDS: "5",
        WORKBENCH_FAKE_DELAY_MS: "20000",
        WORKBENCH_REPOSITORY: repositoryPath,
        WORKBENCH_RUNNER_DIR: path.join(directory, "runner-state"),
      },
      stdio: "ignore",
    });
    await waitFor(async () => {
      const task = await fetch(`${base}/api/tasks/TASK-RUNNER-E2E`).then((response) => response.json());
      return task.runs?.find((run) => run.id === dispatched.run.id)?.claimedBy ? task : null;
    }, "Runner claims the pending Run");
    await stopChild(runner, "SIGKILL");

    const recovered = await waitFor(async () => {
      const task = await fetch(`${base}/api/tasks/TASK-RUNNER-E2E`).then((response) => response.json());
      const run = task.runs?.find((entry) => entry.id === dispatched.run.id);
      return run?.status === "worker_lost" ? task : null;
    }, `expired lease moves Run to worker_lost (server output: ${serverOutput})`, 9_000);
    assert.equal(recovered.status, "queued");
    assert.equal(recovered.runs.find((run) => run.id === dispatched.run.id).status, "worker_lost");
  } finally {
    await stopChild(runner, "SIGKILL");
    await stopChild(server, "SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});

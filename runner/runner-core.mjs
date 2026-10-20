import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

function safeSegment(value) {
  const segment = String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!segment || segment === "." || segment === "..") throw new Error("Invalid Run ID for workspace path");
  return segment;
}

function runCommand(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`)));
  });
}

/**
 * Creates the isolated worktree on a new branch. The branch name comes from the workbench (`claim.workspace.branch`,
 * stable per task and attempt, so you can find it by task number); if that name is unusable or taken, a unique
 * fallback is used. Returns `{ branch, remove }`.
 */
async function createWorktree(repositoryPath, workspacePath, runId, preferredBranch) {
  const fallback = `workbench/${safeSegment(runId)}-${randomUUID().slice(0, 8)}`;
  await mkdir(workspacePath, { recursive: true });
  let branchName = preferredBranch || fallback;
  try { await runCommand("git", ["-C", repositoryPath, "worktree", "add", "-b", branchName, workspacePath, "HEAD"]); }
  catch (error) {
    if (branchName === fallback) throw error;
    branchName = fallback;
    await runCommand("git", ["-C", repositoryPath, "worktree", "add", "-b", branchName, workspacePath, "HEAD"]);
  }
  return {
    branch: branchName,
    /**
     * By default a worktree with uncommitted work is kept for recovery, never force-removed. `discard` is for a run the
     * person stopped on purpose: everything it did is thrown away, worktree and branch both. On Windows a program that was
     * just killed can hold its folder open for a moment, so removal is retried before giving up.
     */
    remove: async ({ discard = false } = {}) => {
      const git = (...args) => runCommand("git", ["-C", repositoryPath, ...args]);
      let lastError = null;
      for (let attempt = 0; attempt < (discard ? 6 : 1); attempt += 1) {
        try { await git("worktree", "remove", ...(discard ? ["--force"] : []), workspacePath); lastError = null; break; }
        catch (error) {
          lastError = error;
          // Git may already have taken the folder out of its list while the (now empty) directory is still held open.
          if (discard && !(await git("worktree", "list", "--porcelain")).toLowerCase().includes(workspacePath.replaceAll("\\", "/").toLowerCase())) {
            await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
            if (!(await stat(workspacePath).catch(() => null))) { lastError = null; break; }
          }
          if (attempt < 5 && discard) await sleep(300 * (attempt + 1));
        }
      }
      if (lastError) { console.warn(`Keeping Runner worktree ${workspacePath}: ${lastError.message}`); return; }
      // Without `discard` the branch is removed only if Git confirms nothing was committed on it.
      await git("branch", discard ? "-D" : "-d", branchName).catch(() => {});
    },
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function runClaimedRun({
  apiBase,
  claim,
  repositoryPath,
  runnerDirectory,
  adapter,
  fetchImpl = fetch,
  heartbeatMs = 15_000,
  timeoutMs = 30 * 60_000,
  signal,
}) {
  const runId = claim?.run?.id;
  const leaseToken = claim?.leaseToken;
  if (!runId || !leaseToken || !claim?.task) throw new Error("Claim response is missing run, task, or leaseToken");
  if (!adapter || typeof adapter.execute !== "function") throw new Error("Runner adapter must implement execute()");

  const runKey = safeSegment(runId);
  const workspacePath = path.resolve(runnerDirectory, "worktrees", runKey);
  const artifactDirectory = path.resolve(runnerDirectory, "artifacts", runKey);
  const logPath = path.join(artifactDirectory, "runner.log");
  await mkdir(artifactDirectory, { recursive: true });
  const { branch: branchName, remove: removeWorktree } = await createWorktree(repositoryPath, workspacePath, runId, claim.workspace?.branch);
  const controller = new AbortController();
  const stopWithParent = () => controller.abort(signal.reason || new Error("Runner process is stopping"));
  signal?.addEventListener("abort", stopWithParent, { once: true });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${leaseToken}` };
  let heartbeatFailure = null;
  let cancelRequested = false;
  let heartbeatBusy = false;
  let stopped = false;
  let wakeHeartbeat;

  async function callApi(pathname, body, { authenticated = true } = {}) {
    const response = await fetchImpl(new URL(pathname, apiBase), {
      method: "POST",
      headers: authenticated ? headers : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Runner API failed (${response.status})`);
      error.status = response.status;
      error.code = result.code;
      throw error;
    }
    return result;
  }

  async function onEvent(event) {
    const record = { at: new Date().toISOString(), ...event };
    await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
    await callApi(`/api/runs/${encodeURIComponent(runId)}/events`, {
      eventId: event.eventId || `${runId}:${record.at}:${event.type}`,
      type: event.type,
      message: event.message || "",
      data: event.data,
    });
  }

  async function heartbeatLoop() {
    while (!stopped) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, heartbeatMs);
        wakeHeartbeat = () => { clearTimeout(timer); resolve(); };
      });
      wakeHeartbeat = null;
      if (stopped || heartbeatBusy) continue;
      heartbeatBusy = true;
      try {
        const status = await callApi(`/api/runs/${encodeURIComponent(runId)}/heartbeat`, {});
        if (status.cancelRequested) {
          cancelRequested = true;
          controller.abort(new Error("Run cancelled by user"));
        }
      } catch (error) {
        heartbeatFailure = error;
        controller.abort(error);
        return;
      } finally { heartbeatBusy = false; }
    }
  }

  const heartbeatTask = heartbeatLoop();
  let timeout;
  let outcome;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`Run exceeded timeout (${timeoutMs} ms)`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const abortPromise = new Promise((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason || new Error("Run aborted"));
      else controller.signal.addEventListener("abort", () => reject(controller.signal.reason || new Error("Run aborted")), { once: true });
    });
    outcome = await Promise.race([
      adapter.execute({ run: claim.run, task: claim.task, snapshot: claim.snapshot, workspace: workspacePath, artifactDirectory, signal: controller.signal, onEvent }),
      timeoutPromise,
      abortPromise,
    ]);
  } catch (error) {
    if (cancelRequested) outcome = { cancelled: true };
    else if (heartbeatFailure) outcome = { lost: true, error: heartbeatFailure };
    else outcome = { error };
  } finally {
    clearTimeout(timeout);
    stopped = true;
    wakeHeartbeat?.();
    await heartbeatTask;
    signal?.removeEventListener("abort", stopWithParent);
  }

  if (outcome?.cancelled || cancelRequested) {
    if (cancelRequested) {
      try { await callApi(`/api/runs/${encodeURIComponent(runId)}/ack-cancel`, {}); }
      catch (error) { if (error.status !== 409 && error.status !== 401) throw error; }
    }
    await removeWorktree({ discard: true }); // the person stopped it: nothing of it is kept
    return { status: "cancelled", runId };
  }
  if (outcome?.lost || heartbeatFailure) {
    await removeWorktree();
    return { status: "lease_lost", runId, error: (outcome?.error || heartbeatFailure)?.message };
  }

  let callbackError = null;
  try {
    if (outcome?.error) {
      const content = await readFile(logPath, "utf8").catch(() => "");
      const digest = createHash("sha256").update(content).digest("hex");
      const info = await stat(logPath).catch(() => ({ size: 0 }));
      await callApi(`/api/runs/${encodeURIComponent(runId)}/artifacts`, { kind: "log", uri: pathToFileURL(logPath).href, checksum: digest, sizeBytes: info.size, metadata: { fileName: "runner.log" } });
      await callApi(`/api/runs/${encodeURIComponent(runId)}/failure`, { errorCode: "EXECUTOR_FAILED", message: outcome.error.message, idempotencyKey: `${runId}:failure` });
      return { status: "failed", runId, error: outcome.error.message };
    }
    const content = await readFile(logPath, "utf8").catch(() => "");
    const digest = createHash("sha256").update(content).digest("hex");
    const info = await stat(logPath).catch(() => ({ size: 0 }));
    await callApi(`/api/runs/${encodeURIComponent(runId)}/artifacts`, { kind: "log", uri: pathToFileURL(logPath).href, checksum: digest, sizeBytes: info.size, metadata: { fileName: "runner.log" } });
    for (const artifact of (outcome?.evidence || []).filter((item) => typeof item.uri === "string")) {
      let artifactText = "";
      try { artifactText = await readFile(new URL(artifact.uri), "utf8"); } catch { continue; }
      const artifactBytes = Buffer.byteLength(artifactText, "utf8");
      await callApi(`/api/runs/${encodeURIComponent(runId)}/artifacts`, {
        kind: artifact.kind || "agent-output", uri: artifact.uri,
        checksum: createHash("sha256").update(artifactText).digest("hex"), sizeBytes: artifactBytes,
        metadata: { fileName: artifact.name || path.basename(new URL(artifact.uri).pathname) },
      });
    }
    const diffPath = path.join(artifactDirectory, "changes.patch");
    await runCommand("git", ["-C", workspacePath, "add", "-N", "--", "."]).catch(() => "");
    const diff = await runCommand("git", ["-C", workspacePath, "diff", "--binary", "HEAD"]).catch(() => "");
    if (diff) {
      await (await import("node:fs/promises")).writeFile(diffPath, diff, "utf8");
      await callApi(`/api/runs/${encodeURIComponent(runId)}/artifacts`, {
        kind: "diff", uri: pathToFileURL(diffPath).href,
        checksum: createHash("sha256").update(diff).digest("hex"), sizeBytes: Buffer.byteLength(diff, "utf8"),
        metadata: { fileName: "changes.patch" },
      });
      // Keep the work: commit it on the run's branch, so "merge this branch" is all it takes to adopt the change, and
      // report the branch so the run detail can name it. Read-only (analysis) runs never reach here with a diff.
      if (claim.task.kind !== "analysis") {
        try {
          const subject = (claim.task.taskText || "").split(/\r?\n/).find((line) => line.startsWith("需求："))?.slice(3).trim() || claim.task.id;
          await runCommand("git", ["-C", workspacePath, "add", "-A"]);
          await runCommand("git", ["-C", workspacePath, "-c", "user.name=Requirements Workbench", "-c", "user.email=workbench@localhost", "commit", "--no-verify", "-m", `workbench: ${subject}\n\nTask ${claim.task.id}, run ${runId}`]);
          const commit = await runCommand("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
          const base = await runCommand("git", ["-C", workspacePath, "rev-parse", "HEAD~1"]);
          await callApi(`/api/runs/${encodeURIComponent(runId)}/artifacts`, { kind: "branch", uri: `git:${branchName}`, checksum: commit, sizeBytes: 0, metadata: { base, commit } });
        } catch (error) {
          await onEvent({ type: "log", message: `改动没能提交到分支 ${branchName}（diff 仍可用）：${error.message}` }).catch(() => {});
        }
      }
    }
    await callApi(`/api/runs/${encodeURIComponent(runId)}/result`, { summary: outcome?.summary || "Executor returned no summary", evidence: outcome?.evidence || [], idempotencyKey: `${runId}:result` });
  } catch (error) { callbackError = error; }
  finally { await removeWorktree(); }
  if (callbackError) {
    if (callbackError.status === 409 || callbackError.status === 401) return { status: "lease_lost", runId, error: callbackError.message };
    throw callbackError;
  }
  return { status: "succeeded", runId, runner: os.hostname() };
}

/**
 * Asks the server for what this run needs to start: credentials set on the settings page for its executor and, for an
 * agent the person added, how to launch it. Held in memory for this run only. An older server without the endpoint
 * simply means "nothing extra".
 */
export async function fetchLaunchConfig({ apiBase, claim, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(new URL(`/api/runs/${encodeURIComponent(claim.run.id)}/launch-config`, apiBase), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${claim.leaseToken}` }, body: "{}",
    });
    if (!response.ok) return {};
    return (await response.json().catch(() => ({}))) || {};
  } catch { return {}; }
}

export async function runRunner({
  apiBase,
  runnerId = `${os.hostname()}-${process.pid}`,
  repositoryPath,
  runnerDirectory,
  adapter,
  resolveRepositoryPath,
  capabilities,
  leaseSeconds = 60,
  pollMs = 2_000,
  fetchImpl = fetch,
  signal,
}) {
  if (!apiBase || !repositoryPath || !runnerDirectory) throw new Error("apiBase, repositoryPath, and runnerDirectory are required");
  const runnerCapabilities = capabilities?.length ? capabilities : [adapter?.name].filter(Boolean);
  if (!runnerCapabilities.length) throw new Error("Runner adapter must expose a name or capabilities must be provided");
  while (!signal?.aborted) {
    try {
      const response = await fetchImpl(new URL("/api/runner/claim", apiBase), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runnerId, capabilities: runnerCapabilities, leaseSeconds }),
      });
      const claim = await response.json().catch(() => null);
      if (!response.ok) throw new Error(claim?.error || `claim failed (${response.status})`);
      if (!claim) { await sleep(pollMs); continue; }
      const activeRepositoryPath = resolveRepositoryPath ? await resolveRepositoryPath(claim) : repositoryPath;
      const launch = typeof adapter === "function" ? await fetchLaunchConfig({ apiBase, claim, fetchImpl }) : {};
      const activeAdapter = typeof adapter === "function" ? await adapter(claim, launch) : adapter;
      // A short heartbeat is also how a "stop" from the page reaches this process, so keep it well under the lease.
      const outcome = await runClaimedRun({ apiBase, claim, repositoryPath: activeRepositoryPath, runnerDirectory, adapter: activeAdapter, fetchImpl, heartbeatMs: Math.min(5_000, Math.max(1_000, Math.floor(leaseSeconds * 1000 / 3))), signal });
      console.log(`[runner] ${outcome.status}: ${claim.run?.id}${outcome.error ? ` — ${outcome.error}` : ""}`);
    } catch (error) {
      console.error(`[runner] ${error.message}`);
      await sleep(pollMs);
    }
  }
}

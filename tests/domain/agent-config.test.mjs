import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createSecretStore, environmentForExecutor, launchConfigFor, normalizeCustomAgents, providerEnvironment } from "../../server/agent-config.mjs";
import { exportLegacyState } from "../../server/legacy-state.mjs";
import { manualWorkbench, tempDirectory } from "./helpers.mjs";

const rejects = (fn, code, status) => assert.throws(fn, (e) => (code === undefined || e.code === code) && (status === undefined || e.status === status), `expected ${code}`);
const dispatchedTask = (wb, requirementId, extra = {}) => {
  const task = wb.createTask({ requirementId, taskText: "改一下", executorType: "codex", ...extra });
  return { task, ...wb.dispatchTask(task.id) };
};

// ---------- deleting a requirement stops its work ----------

test("deleting a requirement cancels a run nobody has claimed and hides its tasks", () => {
  const { db, wb } = manualWorkbench();
  const requirement = wb.createRequirement({ title: "要删的需求" });
  const { task, run } = dispatchedTask(wb, requirement.id);
  assert.equal(run.status, "pending");

  wb.deleteRequirement(requirement.id, { reason: "不要了" });

  const after = wb.listRuns(task.id)[0];
  assert.equal(after.status, "cancelled");
  assert.equal(after.errorMessage, "需求已删除");
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: ["codex"] }), null, "nothing is left for a Runner to pick up");
  assert.equal(exportLegacyState(db, wb).tasks.length, 0, "tasks of a deleted requirement are not shown");
  assert.equal(wb.getTask(task.id).id, task.id, "…but they are still in the database as history");
});

test("deleting a requirement asks a running run to stop", () => {
  const { wb } = manualWorkbench();
  const requirement = wb.createRequirement({ title: "进行中的需求" });
  const { task } = dispatchedTask(wb, requirement.id);
  const claim = wb.claimRun({ runnerId: "r1", capabilities: ["codex"] });

  wb.deleteRequirement(requirement.id);

  const beat = wb.heartbeat(claim.run.id, claim.leaseToken);
  assert.equal(beat.cancelRequested, true);
  assert.equal(beat.cancelReason, "需求已删除");
  wb.ackCancel(claim.run.id, claim.leaseToken);
  assert.equal(wb.listRuns(task.id)[0].status, "cancelled");
});

test("while a stop is under way the run detail says so, and the page can offer no second stop", () => {
  const { wb } = manualWorkbench();
  dispatchedTask(wb, null);
  const claim = wb.claimRun({ runnerId: "r1", capabilities: ["codex"] });
  assert.equal(wb.getRunDetail(claim.run.id).run.cancelRequested, false);
  wb.cancelRun(claim.run.id, { reason: "用户在页面终止" });
  const detail = wb.getRunDetail(claim.run.id);
  assert.equal(detail.run.cancelRequested, true);
  assert.match(detail.phase, /正在终止/);
});

test("tasks of a deleted requirement are not dispatched without a stated reason, and 'run everything' leaves them alone", () => {
  const { wb } = manualWorkbench();
  const gone = wb.createRequirement({ title: "已删除" });
  const kept = wb.createRequirement({ title: "保留" });
  const queuedGone = wb.createTask({ requirementId: gone.id, taskText: "a", executorType: "codex" });
  const queuedKept = wb.createTask({ requirementId: kept.id, taskText: "b", executorType: "codex" });
  wb.deleteRequirement(gone.id);

  rejects(() => wb.dispatchTask(queuedGone.id), "NOT_READY");
  const all = wb.dispatchAll({ executorType: "codex" });
  assert.deepEqual(all.results.map((entry) => entry.taskId), [queuedKept.id], "history is not work to do, and is not even listed as skipped");
  assert.equal(all.dispatched, 1);
  assert.equal(wb.dispatchTask(queuedGone.id, { overrideReason: "历史任务仍要做" }).task.status, "working", "a person can still insist");
});

test("restoring a requirement brings its tasks back into view", () => {
  const { db, wb } = manualWorkbench();
  const requirement = wb.createRequirement({ title: "又要了" });
  wb.createTask({ requirementId: requirement.id, taskText: "x", executorType: "codex" });
  wb.deleteRequirement(requirement.id);
  assert.equal(exportLegacyState(db, wb).tasks.length, 0);
  wb.restoreRequirement(requirement.id);
  assert.equal(exportLegacyState(db, wb).tasks.length, 1);
});

// ---------- claiming custom agents ----------

test("a Runner that lists 'custom:*' claims runs of any custom agent, and only those", () => {
  const { wb } = manualWorkbench();
  const custom = wb.createTask({ taskText: "c", executorType: "custom:aider" });
  const builtin = wb.createTask({ taskText: "d", executorType: "codex" });
  wb.dispatchTask(custom.id);
  wb.dispatchTask(builtin.id);

  const first = wb.claimRun({ runnerId: "r", capabilities: ["custom:*"] });
  assert.equal(first.task.id, custom.id);
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: ["custom:*"] }), null, "the built-in agent's run is not theirs");
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: ["codex"] }).task.id, builtin.id);
  rejects(() => wb.claimRun({ runnerId: "r", capabilities: ["*"] }), "INVALID");
});

test("only the holder of a run's lease can learn which executor it is for", () => {
  const { wb } = manualWorkbench();
  dispatchedTask(wb, null);
  const claim = wb.claimRun({ runnerId: "r", capabilities: ["codex"] });
  assert.deepEqual(wb.leaseHolderInfo(claim.run.id, claim.leaseToken), { runId: claim.run.id, executorType: "codex" });
  rejects(() => wb.leaseHolderInfo(claim.run.id, "wrong"), "LEASE_INVALID", 401);
  rejects(() => wb.leaseHolderInfo(claim.run.id, ""), "LEASE_INVALID", 401);
});

// ---------- the secret store ----------

test("keys are stored, described without their value, and cleared", () => {
  const store = createSecretStore();
  store.set("openai-api-key", "  sk-test-1234567890abcd  ");
  store.set("openai-model", "gpt-test");
  const described = store.describe();
  assert.equal(described["openai-api-key"].configured, true);
  assert.equal(described["openai-api-key"].hint, "…abcd");
  assert.equal(JSON.stringify(described).includes("sk-test"), false, "the key itself never appears in what the page may see");
  assert.equal(described["openai-model"].value, "gpt-test", "a model name is not a secret");
  assert.equal(described["deepseek-api-key"].configured, false);
  assert.equal(store.get("openai-api-key"), "sk-test-1234567890abcd");
  store.clear("openai-api-key");
  assert.equal(store.has("openai-api-key"), false);
});

test("a key that looks like a pasted command or file is refused", () => {
  const store = createSecretStore();
  for (const bad of ["", "   ", "sk-abc def", "line1\nline2", "x".repeat(501), 42, null]) rejects(() => store.set("openai-api-key", bad), "INVALID");
  rejects(() => store.set("not-a-slot", "abc"), "INVALID");
  rejects(() => store.set("openai-model", "a".repeat(101)), "INVALID");
  store.set("custom:aider", "abc123");
  rejects(() => store.set("custom:Bad Slot", "abc"), "INVALID");
});

test("secrets are saved to their own file and survive a restart", () => {
  const { directory, cleanup } = tempDirectory();
  try {
    const file = path.join(directory, "agent-secrets.json");
    const first = createSecretStore({ file });
    assert.equal(existsSync(file), false, "nothing is written until a key is set");
    first.set("claude-code-token", "token-value-abcdef123456");
    assert.equal(createSecretStore({ file }).get("claude-code-token"), "token-value-abcdef123456");
    first.clear("claude-code-token");
    assert.equal(createSecretStore({ file }).has("claude-code-token"), false);
    assert.equal(readFileSync(file, "utf8").includes("token-value"), false);
  } finally { cleanup(); }
});

test("on Windows the secrets file stays this user's alone, after every save", { skip: process.platform !== "win32" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { directory, cleanup } = tempDirectory();
  try {
    const file = path.join(directory, "agent-secrets.json");
    const store = createSecretStore({ file });
    for (const [slot, value] of [["deepseek-api-key", "ds-key-value-123456"], ["deepseek-model", "deepseek-chat"], ["openai-api-key", "oa-key-value-123456"]]) {
      store.set(slot, value);
      const listing = execFileSync("icacls", [file], { encoding: "utf8" });
      assert.doesNotMatch(listing, /\(I\)/, `inherited permissions came back after saving ${slot}`);
      assert.equal(store.get(slot), value, "and the owner can still read it");
    }
    execFileSync("icacls", [file, "/reset"], { stdio: "ignore" }); // so the temp folder can be removed
  } finally { cleanup(); }
});

test("a key set on the page wins over the process environment for the model gateway", () => {
  const store = createSecretStore();
  const base = { OPENAI_API_KEY: "from-env", DEEPSEEK_API_KEY: "ds-env", UNRELATED: "x" };
  const view = providerEnvironment(store, base);
  assert.equal(view.OPENAI_API_KEY, "from-env");
  store.set("openai-api-key", "from-page-123456789");
  store.set("anthropic-model", "claude-test");
  assert.equal(view.OPENAI_API_KEY, "from-page-123456789");
  assert.equal(view.ANTHROPIC_MODEL, "claude-test");
  assert.equal(view.DEEPSEEK_API_KEY, "ds-env");
  assert.equal(view.UNRELATED, "x");
  // Claude Code's own credentials are a different slot and never leak into the model gateway.
  store.set("claude-code-api-key", "claude-code-only-123456");
  assert.equal(view.ANTHROPIC_API_KEY, undefined);
});

// ---------- custom agents and what a Runner is handed ----------

test("custom agent definitions are validated", () => {
  const ok = normalizeCustomAgents([{ id: "aider", name: "Aider", command: "aider", args: ["--yes", "{promptFile}"], secretEnv: "OPENAI_API_KEY" }]);
  assert.deepEqual(ok, [{ id: "aider", name: "Aider", command: "aider", args: ["--yes", "{promptFile}"], secretEnv: "OPENAI_API_KEY" }]);
  assert.deepEqual(normalizeCustomAgents([{ id: "x1", command: "tool" }]), [{ id: "x1", name: "x1", command: "tool", args: [], secretEnv: "" }]);
  assert.deepEqual(normalizeCustomAgents([]), []);
  const bad = (entry) => rejects(() => normalizeCustomAgents(Array.isArray(entry) ? entry : [entry]), "INVALID");
  bad({ id: "Aider", command: "a" });
  bad({ id: "1abc", command: "a" });
  bad({ id: "codex", command: "a" });
  bad({ id: "claude", command: "a" });
  bad({ id: "a", command: "" });
  bad({ id: "a", command: "x\ny" });
  bad({ id: "a", command: "x", args: "not-a-list" });
  bad({ id: "a", command: "x", args: Array(21).fill("v") });
  bad({ id: "a", command: "x", secretEnv: "path" });
  bad({ id: "a", command: "x", secretEnv: "PATH" });
  bad({ id: "a", command: "x", secretEnv: "NODE_OPTIONS" });
  bad([{ id: "a", command: "x" }, { id: "a", command: "y" }]);
  bad(Array.from({ length: 11 }, (_, index) => ({ id: `a${index}`, command: "x" })));
  rejects(() => normalizeCustomAgents("nope"), "INVALID");
});

test("each executor is handed only its own credentials", () => {
  const store = createSecretStore();
  const agents = normalizeCustomAgents([{ id: "aider", command: "aider", secretEnv: "OPENAI_API_KEY" }, { id: "plain", command: "plain" }]);
  store.set("claude-code-api-key", "api-key-value-123456");
  store.set("custom:aider", "aider-secret-123456");
  store.set("openai-api-key", "gateway-only-123456");

  assert.deepEqual(environmentForExecutor("claude", store, agents), { ANTHROPIC_API_KEY: "api-key-value-123456" });
  store.set("claude-code-token", "subscription-token-123456");
  assert.deepEqual(environmentForExecutor("claude-code", store, agents), { CLAUDE_CODE_OAUTH_TOKEN: "subscription-token-123456" }, "a subscription token wins over an API key");
  assert.deepEqual(environmentForExecutor("custom:aider", store, agents), { OPENAI_API_KEY: "aider-secret-123456" });
  assert.deepEqual(environmentForExecutor("custom:plain", store, agents), {});
  assert.deepEqual(environmentForExecutor("codex", store, agents), {}, "Codex signs in on its own");
  assert.deepEqual(environmentForExecutor("custom:unknown", store, agents), {});

  assert.deepEqual(launchConfigFor("custom:aider", store, agents), {
    env: { OPENAI_API_KEY: "aider-secret-123456" }, custom: { id: "aider", name: "aider", command: "aider", args: [] },
  });
  assert.equal(launchConfigFor("claude", store, agents).custom, null);
});

test("custom agent list is a stored setting and is part of the export, without any credential", () => {
  const { wb } = manualWorkbench();
  assert.equal(wb.getSetting("agents.custom"), null);
  const saved = wb.setSetting("agents.custom", [{ id: "aider", command: "aider", secretEnv: "OPENAI_API_KEY" }]);
  assert.equal(saved[0].name, "aider");
  assert.deepEqual(wb.getSetting("agents.custom"), saved);
  rejects(() => wb.setSetting("agents.custom", [{ id: "codex", command: "x" }]), "INVALID");
  assert.equal(JSON.stringify(wb.exportAll()).includes("secret-"), false);
});

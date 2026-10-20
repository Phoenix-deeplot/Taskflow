import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createAgentAdapter, createClaudeCodeAdapter, detectLocalAgents } from "../../runner/agent-adapters.mjs";
import { createCodexStoreAdapter } from "../../runner/codex-store-adapter.mjs";

function fakeSpawn(versionByCommand) {
  return (command) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (versionByCommand[command]) {
        child.stdout.emit("data", `${versionByCommand[command]}\n`);
        child.emit("close", 0);
      } else {
        const error = new Error("not found"); error.code = "ENOENT"; child.emit("error", error);
      }
    });
    return child;
  };
}

test("agent availability probes distinguish installed CLIs and report versions", async () => {
  const original = { claude: process.env.CLAUDE_CLI, codex: process.env.CODEX_CLI };
  process.env.CLAUDE_CLI = "claude-test";
  process.env.CODEX_CLI = "codex-test";
  try {
    const result = await detectLocalAgents({ spawnImpl: fakeSpawn({ "claude-test": "Claude Code 2.1.0" }) });
    assert.deepEqual(result.claude, { available: true, version: "Claude Code 2.1.0", reason: null });
    assert.equal(result.codex.available, false);
    assert.equal(result.codex.reason, "未安装或不在 PATH");
  } finally {
    if (original.claude === undefined) delete process.env.CLAUDE_CLI; else process.env.CLAUDE_CLI = original.claude;
    if (original.codex === undefined) delete process.env.CODEX_CLI; else process.env.CODEX_CLI = original.codex;
  }
});

test("agent adapter selection supports Claude and does not silently use fake execution", async () => {
  assert.equal(createClaudeCodeAdapter().name, "claude");
  assert.equal((await createAgentAdapter("claude")).name, "claude");
  if (process.platform !== "win32") {
    await assert.rejects(createCodexStoreAdapter().execute({ run: { id: "RUN-1" }, task: { taskText: "task" }, workspace: ".", onEvent: async () => {} }), /仅支持 Windows/);
  }
});

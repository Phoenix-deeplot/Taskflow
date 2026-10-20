import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import test from "node:test";
import { codexExecArgs, createAgentAdapter, createClaudeCodeAdapter, detectLocalAgents, resolveExecutable } from "../../runner/agent-adapters.mjs";
import { createCodexStoreAdapter, detectScript } from "../../runner/codex-store-adapter.mjs";

/** A fake process table: `{ command: { "--version": "text", "auth status": '{"loggedIn":true}' } }`. */
function fakeSpawn(table) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      const answers = table[command];
      const reply = answers?.[args.join(" ")];
      if (!answers) { const error = new Error("not found"); error.code = "ENOENT"; child.emit("error", error); return; }
      if (reply === undefined) { child.emit("close", 1); return; }
      child.stdout.emit("data", `${reply}\n`);
      child.emit("close", 0);
    });
    return child;
  };
}

async function withCli(claude, codex, run) {
  const original = { claude: process.env.CLAUDE_CLI, codex: process.env.CODEX_CLI };
  process.env.CLAUDE_CLI = claude;
  process.env.CODEX_CLI = codex;
  try { return await run(); }
  finally {
    if (original.claude === undefined) delete process.env.CLAUDE_CLI; else process.env.CLAUDE_CLI = original.claude;
    if (original.codex === undefined) delete process.env.CODEX_CLI; else process.env.CODEX_CLI = original.codex;
  }
}

test("detection reports installed, signed in, and version separately", async () => {
  await withCli("claude-test", "codex-test", async () => {
    const result = await detectLocalAgents({
      spawnImpl: fakeSpawn({
        "claude-test": { "--version": "2.1.0 (Claude Code)", "auth status": '{"loggedIn":true,"authMethod":"oauth"}' },
        "codex-test": { "--version": "codex-cli 0.158.0", "login status": "Logged in using ChatGPT" },
      }),
    });
    assert.deepEqual(result.claude, { installed: true, version: "2.1.0 (Claude Code)", loggedIn: true, available: true, reason: null });
    assert.deepEqual(result.codex, { installed: true, version: "codex-cli 0.158.0", loggedIn: true, available: true, reason: null });
  });
});

test("an installed but signed-out agent is reported as such, not as missing", async () => {
  await withCli("claude-test", "codex-test", async () => {
    const result = await detectLocalAgents({
      spawnImpl: fakeSpawn({
        "claude-test": { "--version": "2.1.0 (Claude Code)", "auth status": '{"loggedIn":false,"authMethod":"none"}' },
        "codex-test": { "--version": "codex-cli 0.158.0" },
      }),
    });
    assert.deepEqual([result.claude.installed, result.claude.loggedIn, result.claude.available], [true, false, false]);
    assert.match(result.claude.reason, /尚未登录.*\/login/);
    assert.deepEqual([result.codex.installed, result.codex.loggedIn, result.codex.available], [true, false, false]);
    assert.match(result.codex.reason, /codex login/);
  });
});

test("a program that does not exist is reported as not installed; unknown login state does not block", async () => {
  await withCli("claude-test", "codex-test", async () => {
    const result = await detectLocalAgents({
      spawnImpl: fakeSpawn({ "claude-test": { "--version": "2.0.0" } }), // no "auth status" answer: an old version without that command
      exists: () => false,
    });
    assert.deepEqual([result.claude.installed, result.claude.loggedIn, result.claude.available], [true, null, true]);
    if (process.platform !== "win32") assert.deepEqual([result.codex.installed, result.codex.available], [false, false]);
    assert.equal(result.codex.reason?.length > 0, true);
  });
});

// ---------- launching programs on Windows ----------
const win = (files, env = {}) => ({
  platform: "win32", env: { PATH: "C:\\bin;C:\\npm", ...env },
  exists: (p) => p in files, read: (p) => files[p],
});
const SHIM = '@ECHO off\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\n';

test("a Windows npm .cmd shim is resolved to the real program, never started through a shell", () => {
  const opts = win({ "C:\\npm\\claude.cmd": SHIM, "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe": "" });
  assert.deepEqual(resolveExecutable("claude", opts), { command: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", prefixArgs: [] });
});

test("an .exe on PATH wins over a shim, and a shim that runs a script uses this Node", () => {
  assert.equal(resolveExecutable("tool", win({ "C:\\bin\\tool.exe": "", "C:\\npm\\tool.cmd": SHIM })).command, "C:\\bin\\tool.exe");
  const script = '@ECHO off\n"%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\n';
  const resolved = resolveExecutable("x", win({ "C:\\npm\\x.cmd": script, "C:\\npm\\node_modules\\x\\cli.js": "" }));
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.prefixArgs, ["C:\\npm\\node_modules\\x\\cli.js"]);
});

test("explicit paths are honoured, unknown programs fall through to a normal not-found, and other systems are untouched", () => {
  assert.equal(resolveExecutable("D:\\tools\\agent.exe", win({ "D:\\tools\\agent.exe": "" })).command, "D:\\tools\\agent.exe");
  assert.deepEqual(resolveExecutable("nothing", win({})), { command: "nothing", prefixArgs: [] });
  assert.deepEqual(resolveExecutable("claude", { platform: "linux" }), { command: "claude", prefixArgs: [] });
  const broken = win({ "C:\\npm\\claude.cmd": "@echo off\nsomething unusual\n" });
  assert.deepEqual(resolveExecutable("claude", broken), { command: "claude", prefixArgs: [] }, "a shim we cannot understand is not guessed at");
});

test("the Claude adapter sends the prompt on stdin, not on the command line", () => {
  const adapter = createClaudeCodeAdapter({ command: "claude-test" });
  assert.equal(adapter.name, "claude");
});

test("codex exec is given only options it accepts: no approval flag, read-only for analysis, prompt on stdin", () => {
  const analysis = codexExecArgs({ workspace: "W", resultPath: "R", kind: "analysis" });
  const execution = codexExecArgs({ workspace: "W", resultPath: "R", kind: "execution" });
  assert.deepEqual(analysis, ["exec", "--cd", "W", "--sandbox", "read-only", "--ephemeral", "--output-last-message", "R", "-"]);
  assert.equal(execution[execution.indexOf("--sandbox") + 1], "workspace-write");
  for (const args of [analysis, execution]) {
    assert.ok(!args.includes("--ask-for-approval"), "`codex exec` rejects this flag: unexpected argument");
    assert.ok(!args.some((a) => /dangerously|full-auto/.test(a)), "never switch on the 'do everything' flags");
    assert.equal(args.at(-1), "-");
  }
});

test("the Codex store launcher writes the prompt as raw UTF-8 bytes, not through the console code page", async () => {
  const source = readFileSync(new URL("../../runner/codex-store-adapter.mjs", import.meta.url), "utf8");
  assert.match(source, /ReadAllBytes\(\$d\.prompt\)/);
  assert.match(source, /StandardInput\.BaseStream\.Write/);
  assert.doesNotMatch(source, /StandardInput\.Write\(/, "StandardInput.Write encodes with the OEM code page (GBK on Chinese Windows) and corrupts Chinese prompts");
});

test("the Codex store detection script has real backslashes in the executable path", () => {
  const script = detectScript();
  assert.ok(script.includes("'app\\resources\\codex.exe'"), script);
  assert.ok(!script.includes("\r"), "a carriage return in the path is the bug this guards against");
  assert.match(script, /OpenAI\.Codex_/);
});

test("agent adapter selection supports Claude and does not silently use fake execution", async () => {
  assert.equal(createClaudeCodeAdapter().name, "claude");
  assert.equal((await createAgentAdapter("claude")).name, "claude");
  if (process.platform !== "win32") {
    await assert.rejects(createCodexStoreAdapter().execute({ run: { id: "RUN-1" }, task: { taskText: "task" }, workspace: ".", onEvent: async () => {} }), /仅支持 Windows/);
  }
});

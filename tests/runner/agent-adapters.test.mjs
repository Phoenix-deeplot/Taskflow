import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { codexExecArgs, commandExists, createAgentAdapter, createClaudeCodeAdapter, createCustomAgentAdapter, detectLocalAgents, resolveExecutable, startClaudeLogin } from "../../runner/agent-adapters.mjs";
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
    assert.match(result.claude.reason, /还没登录.*桌面应用.*登录 Claude Code.*令牌/);
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

// ---------- agents the person adds ----------

/** Runs a custom agent made of `node -e <script>` and returns what it reported. */
async function runCustom({ script, extraArgs = [], prompt = "请改 math.mjs", env, signal }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "custom-agent-"));
  try {
    const adapter = createCustomAgentAdapter({ id: "tool", name: "工具", command: process.execPath, args: ["-e", script, ...extraArgs] }, { env });
    const events = [];
    const result = await adapter.execute({ run: { id: "RUN-C1" }, task: { kind: "execution" }, snapshot: { promptText: prompt }, workspace, artifactDirectory: workspace, signal, onEvent: async (event) => { events.push(event); } });
    return { result, events, workspace };
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

test("a custom agent gets the prompt on stdin by default, and what it prints is the result", async () => {
  const { result } = await runCustom({ script: "process.stdin.pipe(process.stdout)", prompt: "请改 math.mjs，加 multiply" });
  assert.equal(result.summary, "请改 math.mjs，加 multiply");
  assert.deepEqual(result.evidence.map((entry) => entry.kind), ["agent-output", "agent-log"]);
});

test("a custom agent can take the prompt as an argument, from a file, and learn the workspace", async () => {
  const viaArgument = await runCustom({ script: "console.log(process.argv[1])", extraArgs: ["{prompt}"], prompt: "多行\n中文 prompt" });
  assert.equal(viaArgument.result.summary, "多行\n中文 prompt");
  const viaFile = await runCustom({ script: "console.log(require('fs').readFileSync(process.argv[1], 'utf8'))", extraArgs: ["{promptFile}"], prompt: "来自文件" });
  assert.equal(viaFile.result.summary, "来自文件");
  const where = await runCustom({ script: "console.log(process.argv[1] === process.cwd())", extraArgs: ["{workspace}"] });
  assert.equal(where.result.summary, "true");
});

test("a custom agent's credential reaches that program only", async () => {
  const withKey = await runCustom({ script: "console.log(process.env.MY_AGENT_KEY || 'none')", env: { MY_AGENT_KEY: "abc-123" } });
  assert.equal(withKey.result.summary, "abc-123");
  assert.equal(process.env.MY_AGENT_KEY, undefined, "the Runner's own environment is not changed");
  const without = await runCustom({ script: "console.log(process.env.MY_AGENT_KEY || 'none')" });
  assert.equal(without.result.summary, "none");
});

test("stopping a custom agent really stops the program", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "custom-agent-"));
  try {
    const pidFile = path.join(workspace, "pid.txt");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const adapter = createCustomAgentAdapter({ id: "slow", name: "慢", command: process.execPath, args: ["-e", script] });
    const controller = new AbortController();
    const running = adapter.execute({ run: { id: "RUN-C2" }, task: { kind: "execution" }, snapshot: { promptText: "p" }, workspace, artifactDirectory: workspace, signal: controller.signal, onEvent: async () => {} });
    const outcome = running.then(() => "finished", (error) => error.message);
    for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    const started = Date.now();
    controller.abort(new Error("Run cancelled by user"));
    assert.equal(await outcome, "Run cancelled by user");
    assert.ok(Date.now() - started < 5000, "stopping is quick");
    let alive = true;
    for (let i = 0; i < 30 && alive; i += 1) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, "the process is gone, not left running in the background");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("selecting a custom agent needs its definition from the server", async () => {
  await assert.rejects(createAgentAdapter("custom:tool", {}), /自定义 Agent“tool”的配置读不到/);
  const adapter = await createAgentAdapter("custom:tool", { custom: { id: "tool", name: "工具", command: "tool", args: [] }, env: {} });
  assert.equal(adapter.name, "工具");
});

test("command lookup tells a real command from a typo", () => {
  const win = (files) => ({ platform: "win32", env: { PATH: "C:\\bin;C:\\tools" }, exists: (p) => files.includes(p) });
  assert.equal(commandExists("aider", win(["C:\\tools\\aider.exe"])), true);
  assert.equal(commandExists("aider", win(["C:\\tools\\aider.cmd"])), true);
  assert.equal(commandExists("aider", win([])), false);
  assert.equal(commandExists("C:\\x\\aider.exe", win(["C:\\x\\aider.exe"])), true);
  assert.equal(commandExists("C:\\x\\aider", win(["C:\\x\\aider.exe"])), true);
  assert.equal(commandExists("aider", { platform: "linux", env: { PATH: "/a:/b" }, exists: (p) => p === "/b/aider" }), true);
  assert.equal(commandExists("aider", { platform: "linux", env: { PATH: "/a" }, exists: () => false }), false);
});

// ---------- signing in from the page ----------

test("sign-in starts 'claude auth login' once, and reports a missing program plainly", async () => {
  const spawned = [];
  const children = [];
  const spawnImpl = (command, args) => {
    spawned.push([command, ...args]);
    const child = new EventEmitter();
    child.exitCode = null; child.killed = false; child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  };
  const first = await startClaudeLogin({ spawnImpl, command: "claude-test", timeoutMs: 60_000 });
  assert.equal(first.started, true);
  assert.deepEqual(spawned[0].slice(-3), ["auth", "login", "--claudeai"]);
  const again = await startClaudeLogin({ spawnImpl, command: "claude-test", timeoutMs: 60_000 });
  assert.deepEqual([again.started, again.running], [false, true]);
  assert.equal(spawned.length, 1, "no second browser window");
  children[0].exitCode = 0; children[0].emit("exit", 0); // the person finished signing in
  assert.equal((await startClaudeLogin({ spawnImpl, command: "claude-test", timeoutMs: 60_000 })).started, true, "a new sign-in can start once the first is over");
  children[1].exitCode = 0; children[1].emit("exit", 0);
});

test("sign-in reports 'not installed' instead of hanging", async () => {
  const missing = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" }))); child.exitCode = null; return child; };
  await assert.rejects(startClaudeLogin({ spawnImpl: missing, command: "claude-nowhere" }), /找不到 claude 命令/);
});

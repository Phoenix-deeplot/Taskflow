import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexStoreAdapter, detectCodexStore } from "./codex-store-adapter.mjs";

// ---------- launching programs on Windows ----------

/**
 * Node cannot start `claude` on Windows: there is no claude.exe on PATH (ENOENT) and a `.cmd` shim cannot be
 * spawned without a shell (EINVAL). A shell would also glue a multi-line prompt into one command line.
 * So a `.cmd` shim is read and the program it points at (an .exe, or a .js run by this Node) is started directly.
 */
function shimTarget(shimPath, { read, exists }) {
  let text;
  try { text = read(shimPath); } catch { return null; }
  const dir = path.dirname(shimPath);
  const exe = /"%dp0%\\([^"]+?\.exe)"/i.exec(text);
  if (exe && exists(path.join(dir, exe[1]))) return { command: path.join(dir, exe[1]), prefixArgs: [] };
  const script = /"%dp0%\\([^"]+?\.(?:c|m)?js)"/i.exec(text);
  if (script && exists(path.join(dir, script[1]))) return { command: process.execPath, prefixArgs: [path.join(dir, script[1])] };
  return null;
}

export function resolveExecutable(command, { platform = process.platform, env = process.env, exists = existsSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  if (platform !== "win32") return { command, prefixArgs: [] };
  const hasDirectory = /[\\/]/.test(command);
  const hasExtension = /\.[a-z0-9]{2,4}$/i.test(command);
  const names = hasExtension ? [command] : [`${command}.exe`, `${command}.cmd`, `${command}.bat`];
  const directories = hasDirectory ? [""] : String(env.PATH || env.Path || "").split(";").filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = hasDirectory ? name : path.join(directory, name);
      if (!exists(candidate)) continue;
      if (/\.(exe|com)$/i.test(candidate)) return { command: candidate, prefixArgs: [] };
      const target = shimTarget(candidate, { read, exists });
      if (target) return target;
    }
  }
  return { command, prefixArgs: [] }; // let spawn report ENOENT
}

/** Stops a program and everything it started. `child.kill()` alone leaves a Windows agent's helper processes running. */
export function killProcessTree(child, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform === "win32" && child.pid) {
    try { spawnImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("error", () => child.kill()); return; }
    catch { /* fall through */ }
  }
  child.kill("SIGTERM");
}

/** Is there a program with this name (or path) to run? Used to tell the person that a custom agent's command is wrong. */
export function commandExists(command, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const windows = platform === "win32";
  const join = windows ? path.win32.join : path.posix.join;
  const extensions = windows && !/\.[a-z0-9]{2,4}$/i.test(command) ? [".exe", ".cmd", ".bat"].map((ext) => command + ext) : [command];
  if (/[\\/]/.test(command)) return extensions.some((candidate) => exists(candidate));
  const directories = String(env.PATH || env.Path || "").split(windows ? ";" : ":").filter(Boolean);
  return directories.some((directory) => extensions.some((name) => exists(join(directory, name))));
}

export async function detectCustomAgent(agent, options) {
  return commandExists(agent.command, options) ? { available: true, reason: null } : { available: false, reason: `找不到命令：${agent.command}` };
}

function execute(command, args, { cwd, signal, onChunk, env = process.env, input = "" } = {}) {
  const target = resolveExecutable(command, { env });
  return new Promise((resolve, reject) => {
    const child = spawn(target.command, [...target.prefixArgs, ...args], { cwd, env, windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; onChunk?.("stdout", chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; onChunk?.("stderr", chunk); });
    const abort = () => killProcessTree(child);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    if (input) child.stdin.end(input, "utf8");
    child.once("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code, signalName) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason || new Error("Agent execution cancelled"));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code ?? signalName}: ${(stderr || stdout).trim().slice(-2000)}`));
    });
  });
}

function promptFor({ task, snapshot }) {
  const prompt = snapshot?.promptText || task?.taskText || task?.task || "";
  if (!prompt.trim()) throw new Error("任务没有可执行的 prompt");
  return prompt;
}

function createLocalCliAdapter({ name, command, argsFor, parseOutput, inputFor, env, needsPromptFile = false }) {
  return {
    name,
    async execute({ run, task, snapshot, workspace, artifactDirectory = workspace, signal, onEvent }) {
      const prompt = promptFor({ task, snapshot });
      const outputDirectory = path.resolve(artifactDirectory);
      await mkdir(outputDirectory, { recursive: true });
      const resultPath = path.join(outputDirectory, `${run.id}.result.txt`);
      const logPath = path.join(outputDirectory, `${run.id}.cli.log`);
      const promptFile = path.join(outputDirectory, `${run.id}.prompt.txt`);
      if (needsPromptFile) await writeFile(promptFile, prompt, "utf8");
      await onEvent({ type: "progress", message: `${name} 正在启动`, data: { step: "启动 Agent", pct: 3 } });
      let pending = "";
      let lastFlush = Date.now();
      const { stdout, stderr } = await execute(command, argsFor({ prompt, workspace, resultPath, promptFile, task }), {
        cwd: workspace,
        signal,
        // Credentials set on the settings page reach only this program, on top of the Runner's own environment.
        env: env && Object.keys(env).length ? { ...process.env, ...env } : process.env,
        input: inputFor?.({ prompt }) || "",
        onChunk: async (stream, chunk) => {
          pending += chunk;
          await appendFile(logPath, chunk, "utf8").catch(() => {});
          if (pending.length >= 1200 || Date.now() - lastFlush >= 1500) {
            const batch = pending.slice(-4000);
            pending = "";
            lastFlush = Date.now();
            void onEvent({ type: "log", message: `[${stream}] ${batch}` }).catch(() => {});
          }
        },
      });
      if (pending) await onEvent({ type: "log", message: pending.slice(-4000) });
      const parsed = await parseOutput({ stdout, stderr, resultPath });
      await onEvent({ type: "progress", message: `${name} 已完成生成`, data: { step: "整理执行结果", pct: 95 } });
      return {
        summary: parsed.summary || `${name} 已完成任务。`,
        evidence: [
          { kind: "agent-output", name: `${name} 输出`, uri: pathToFileURL(resultPath).href },
          { kind: "agent-log", name: `${name} 执行日志`, uri: pathToFileURL(logPath).href },
        ],
      };
    },
  };
}

export function createClaudeCodeAdapter({ command = process.env.CLAUDE_CLI || "claude", env } = {}) {
  return createLocalCliAdapter({
    name: "claude",
    command,
    env,
    // The prompt goes in on stdin: no command-line length limit and no quoting problems with multi-line or Chinese text.
    argsFor: ({ task }) => ["-p", "--permission-mode", task.kind === "analysis" ? "plan" : "acceptEdits", "--output-format", "text", "--append-system-prompt", "仅在当前独立工作树中完成任务。遵循任务自身的验收要求；不得访问或修改工作树之外的文件，不要自动批准高风险命令。"],
    inputFor: ({ prompt }) => prompt,
    async parseOutput({ stdout, resultPath }) {
      await writeFile(resultPath, stdout, "utf8");
      return { summary: stdout.trim().slice(-6000) };
    },
  });
}

/** Arguments for a non-interactive Codex run; the prompt is read from stdin ("-"). Shared by the CLI and store adapters. */
export function codexExecArgs({ workspace, resultPath, kind }) {
  return ["exec", "--cd", workspace, "--sandbox", kind === "analysis" ? "read-only" : "workspace-write", "--ephemeral", "--output-last-message", resultPath, "-"];
}

export function createCodexCliAdapter({ command = process.env.CODEX_CLI || "codex" } = {}) {
  return createLocalCliAdapter({
    name: "codex",
    command,
    // `codex exec` is non-interactive and has no approval flag (that belongs to the interactive CLI; passing it fails
    // with "unexpected argument"). It never asks to escalate, so anything outside the sandbox is simply refused.
    argsFor: ({ workspace, resultPath, task }) => codexExecArgs({ workspace, resultPath, kind: task.kind }),
    inputFor: ({ prompt }) => prompt,
    async parseOutput({ stdout, resultPath }) {
      let summary = "";
      try { summary = (await readFile(resultPath, "utf8")).trim(); }
      catch { summary = stdout.trim().slice(-6000); await writeFile(resultPath, summary, "utf8"); }
      return { summary };
    },
  });
}

/**
 * An agent the person added on the settings page. The prompt goes in on stdin, unless an argument says otherwise:
 * `{prompt}` is replaced by the text itself, `{promptFile}` by the path of a file holding it, `{workspace}` by the
 * working directory. What the program prints is the result.
 */
export function createCustomAgentAdapter(definition, { env } = {}) {
  const { id, name, command, args = [] } = definition;
  const viaArgument = args.some((arg) => arg.includes("{prompt}"));
  const viaFile = args.some((arg) => arg.includes("{promptFile}"));
  const fill = (arg, values) => arg.replaceAll("{promptFile}", values.promptFile).replaceAll("{workspace}", values.workspace).replaceAll("{prompt}", values.prompt);
  return createLocalCliAdapter({
    name: name || id,
    command,
    env,
    needsPromptFile: viaFile,
    argsFor: (values) => args.map((arg) => fill(arg, values)),
    inputFor: viaArgument || viaFile ? undefined : ({ prompt }) => prompt,
    async parseOutput({ stdout, resultPath }) {
      await writeFile(resultPath, stdout, "utf8");
      return { summary: stdout.trim().slice(-6000) };
    },
  });
}

/** `launch` is what the server handed the Runner for this run: extra environment and, for a custom agent, its definition. */
export async function createAgentAdapter(provider, launch = {}) {
  if (provider === "claude" || provider === "claude-code") return createClaudeCodeAdapter({ env: launch.env });
  if (String(provider).startsWith("custom:")) {
    if (!launch.custom) throw new Error(`自定义 Agent“${String(provider).slice(7)}”的配置读不到（可能已在设置页删除）`);
    return createCustomAgentAdapter(launch.custom, { env: launch.env });
  }
  if (provider === "codex") {
    const command = process.env.CODEX_CLI || "codex";
    const status = await probeCommand(command);
    if (status.installed) return createCodexCliAdapter({ command });
    const store = await detectCodexStore();
    if (store.installed) return createCodexStoreAdapter();
    throw new Error(`未检测到 Codex CLI 或 Windows 商店版：${status.reason || store.reason || "不可用"}`);
  }
  throw new Error(`Unsupported local agent '${provider || "(missing)"}'`);
}

// ---------- detection: installed? logged in? ----------

function runOnce(target, args, spawnImpl, timeoutMs) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try { child = spawnImpl(target.command, [...target.prefixArgs, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ error }); return; }
    const timer = setTimeout(() => { child.kill?.(); resolve({ timedOut: true }); }, timeoutMs);
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ error }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

/**
 * Is the program installed, and (when `loginArgs` says how to ask) is it signed in?
 * `available` means "can run a task now": installed and not known to be signed out.
 */
export async function probeCommand(command, spawnImpl = spawn, { loginArgs, parseLogin, resolve = resolveExecutable } = {}) {
  const target = resolve(command);
  const version = await runOnce(target, ["--version"], spawnImpl, 8000);
  if (version.error) return { installed: false, loggedIn: null, available: false, version: null, reason: version.error.code === "ENOENT" ? "未安装或不在 PATH" : version.error.message };
  if (version.timedOut) return { installed: false, loggedIn: null, available: false, version: null, reason: "检测超时" };
  if (version.code !== 0) return { installed: true, loggedIn: null, available: false, version: null, reason: `检测退出码 ${version.code}` };
  const info = { installed: true, version: version.output.trim().split(/\r?\n/)[0] || null };
  if (!loginArgs) return { ...info, loggedIn: null, available: true, reason: null };
  const login = await runOnce(target, loginArgs, spawnImpl, 8000);
  const loggedIn = login.error || login.timedOut ? null : (parseLogin ? parseLogin(login) : login.code === 0);
  return {
    ...info, loggedIn, available: loggedIn !== false,
    reason: loggedIn === false ? "已安装，但尚未登录" : null,
  };
}

const parseClaudeLogin = ({ code, output }) => {
  try { return Boolean(JSON.parse(output).loggedIn); } catch { return code === 0 ? null : null; }
};

export async function detectLocalAgents({ spawnImpl = spawn, home = os.homedir(), exists = existsSync } = {}) {
  const [claude, codexCli] = await Promise.all([
    probeCommand(process.env.CLAUDE_CLI || "claude", spawnImpl, { loginArgs: ["auth", "status"], parseLogin: parseClaudeLogin }),
    probeCommand(process.env.CODEX_CLI || "codex", spawnImpl, { loginArgs: ["login", "status"] }),
  ]);
  if (claude.loggedIn === false) {
    claude.reason = "命令行里的 claude 还没登录（Claude 桌面应用的登录不能给命令行用）：点“登录 Claude Code”，或在设置里粘贴令牌";
  }
  if (codexCli.installed) {
    if (codexCli.loggedIn === false) codexCli.reason = "已安装，但尚未登录：请在终端运行 codex login";
    return { claude, codex: codexCli };
  }
  const store = await detectCodexStore();
  if (!store.installed) return { claude, codex: { ...codexCli, reason: codexCli.reason || store.reason } };
  const loggedIn = exists(path.join(home, ".codex", "auth.json"));
  return {
    claude,
    codex: {
      installed: true, loggedIn, available: loggedIn, version: store.version, mode: "Windows 商店版",
      reason: loggedIn ? null : "已安装，但尚未登录：请在 Codex 应用里登录",
    },
  };
}

// ---------- signing in to Claude Code from the settings page ----------

let loginProcess = null;

/**
 * Starts "claude auth login", which opens the person's browser on Anthropic's sign-in page and finishes by itself once
 * they approve. At most one at a time; it is stopped after `timeoutMs` if nobody completes it.
 */
export function startClaudeLogin({ spawnImpl = spawn, command = process.env.CLAUDE_CLI || "claude", timeoutMs = 10 * 60_000 } = {}) {
  if (loginProcess && loginProcess.exitCode === null && !loginProcess.killed) {
    return Promise.resolve({ started: false, running: true, message: "登录已经在进行：请在浏览器里完成授权，然后点“重新检测”" });
  }
  const target = resolveExecutable(command);
  const child = spawnImpl(target.command, [...target.prefixArgs, "auth", "login", "--claudeai"], { stdio: "ignore", windowsHide: true });
  loginProcess = child;
  const timer = setTimeout(() => { if (child.exitCode === null) killProcessTree(child); }, timeoutMs);
  timer.unref?.();
  child.once("exit", () => { clearTimeout(timer); if (loginProcess === child) loginProcess = null; });
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      loginProcess = null;
      const message = error.code === "ENOENT" ? "找不到 claude 命令，请先安装 Claude Code" : `无法启动登录：${error.message}`;
      reject(Object.assign(new Error(message), { status: 400, code: "LOGIN_FAILED" }));
    });
    // An immediate failure (bad command) arrives within a tick or two; otherwise the browser is opening.
    setTimeout(() => resolve({ started: true, message: "已打开浏览器登录页：请在浏览器里完成授权，然后回到这里点“重新检测”" }), 400);
  });
}

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCodexStoreAdapter, detectCodexStore } from "./codex-store-adapter.mjs";

function execute(command, args, { cwd, signal, onChunk, env = process.env, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; onChunk?.("stdout", chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; onChunk?.("stderr", chunk); });
    const abort = () => child.kill("SIGTERM");
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

function createLocalCliAdapter({ name, command, argsFor, parseOutput, inputFor }) {
  return {
    name,
    async execute({ run, task, snapshot, workspace, artifactDirectory = workspace, signal, onEvent }) {
      const prompt = promptFor({ task, snapshot });
      const outputDirectory = path.resolve(artifactDirectory);
      await mkdir(outputDirectory, { recursive: true });
      const resultPath = path.join(outputDirectory, `${run.id}.result.txt`);
      const logPath = path.join(outputDirectory, `${run.id}.cli.log`);
      await onEvent({ type: "progress", message: `${name} 正在启动`, data: { step: "启动 Agent", pct: 3 } });
      let pending = "";
      let lastFlush = Date.now();
      const { stdout, stderr } = await execute(command, argsFor({ prompt, workspace, resultPath, task }), {
        cwd: workspace,
        signal,
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

export function createClaudeCodeAdapter({ command = process.env.CLAUDE_CLI || "claude" } = {}) {
  return createLocalCliAdapter({
    name: "claude",
    command,
    argsFor: ({ prompt, task }) => ["-p", "--permission-mode", task.kind === "analysis" ? "plan" : "acceptEdits", "--output-format", "text", "--append-system-prompt", "仅在当前独立工作树中完成任务。遵循任务自身的验收要求；不得访问或修改工作树之外的文件，不要自动批准高风险命令。", prompt],
    async parseOutput({ stdout, resultPath }) {
      await writeFile(resultPath, stdout, "utf8");
      return { summary: stdout.trim().slice(-6000) };
    },
  });
}

export function createCodexCliAdapter({ command = process.env.CODEX_CLI || "codex" } = {}) {
  return createLocalCliAdapter({
    name: "codex",
    command,
    argsFor: ({ workspace, resultPath, task }) => ["exec", "--cd", workspace, "--sandbox", task.kind === "analysis" ? "read-only" : "workspace-write", "--ask-for-approval", "on-request", "--output-last-message", resultPath, "-"],
    inputFor: ({ prompt }) => prompt,
    async parseOutput({ stdout, resultPath }) {
      let summary = "";
      try { summary = (await readFile(resultPath, "utf8")).trim(); }
      catch { summary = stdout.trim().slice(-6000); await writeFile(resultPath, summary, "utf8"); }
      return { summary };
    },
  });
}

export async function createAgentAdapter(provider) {
  if (provider === "claude" || provider === "claude-code") return createClaudeCodeAdapter();
  if (provider === "codex") {
    const command = process.env.CODEX_CLI || "codex";
    const status = await probeCommand(command);
    if (status.available) return createCodexCliAdapter({ command });
    const store = await detectCodexStore();
    if (store.installed) return createCodexStoreAdapter();
    throw new Error(`未检测到 Codex CLI 或 Windows 商店版：${status.reason || store.reason || "不可用"}`);
  }
  throw new Error(`Unsupported local agent '${provider || "(missing)"}'`);
}

function probeCommand(command, spawnImpl = spawn) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawnImpl(command, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); resolve({ available: false, version: null, reason: "检测超时" }); }, 4000);
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ available: false, version: null, reason: error.code === "ENOENT" ? "未安装或不在 PATH" : error.message }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ available: code === 0, version: output.trim().split(/\r?\n/)[0] || null, reason: code === 0 ? null : `检测退出码 ${code}` }); });
  });
}

export async function detectLocalAgents({ spawnImpl = spawn } = {}) {
  const [claude, codexCli] = await Promise.all([probeCommand(process.env.CLAUDE_CLI || "claude", spawnImpl), probeCommand(process.env.CODEX_CLI || "codex", spawnImpl)]);
  if (codexCli.available) return { claude, codex: codexCli };
  const codexStore = await detectCodexStore();
  return { claude, codex: codexStore.installed ? { ...codexStore, available: true, mode: "Windows 商店版" } : codexCli };
}

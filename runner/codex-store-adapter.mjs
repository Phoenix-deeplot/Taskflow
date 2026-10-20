import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PS = "powershell.exe";
const FAMILY = process.env.CODEX_PACKAGE_FAMILY || "OpenAI.Codex_2p2nqsd0c76g0";

function encodePowerShell(source) { return Buffer.from(source, "utf16le").toString("base64"); }
function quoteWindowsArg(value) {
  const text = String(value);
  if (text && !/[\s"]/.test(text)) return text;
  let out = '"'; let slashes = 0;
  for (const char of text) {
    if (char === "\\") { slashes += 1; continue; }
    if (char === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += "\\".repeat(slashes) + char; slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}
function powershellScript(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64");
  const inner = `$ErrorActionPreference='Stop'; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('INNER_DATA_PLACEHOLDER'))|ConvertFrom-Json; $psi=New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName=$d.exe; $psi.WorkingDirectory=$d.workspace; $psi.Arguments=$d.args; $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardInput=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; $p=New-Object System.Diagnostics.Process; $p.StartInfo=$psi; [void]$p.Start(); $outFile=[IO.File]::Open($d.stdout,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite); $errFile=[IO.File]::Open($d.stderr,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite); $outTask=$p.StandardOutput.BaseStream.CopyToAsync($outFile); $errTask=$p.StandardError.BaseStream.CopyToAsync($errFile); $p.StandardInput.Write([IO.File]::ReadAllText($d.prompt)); $p.StandardInput.Close(); $p.WaitForExit(); $outTask.Wait(); $errTask.Wait(); $outFile.Dispose(); $errFile.Dispose(); [IO.File]::WriteAllText($d.exit,[string]$p.ExitCode)`;
  const innerTemplate = encodePowerShell(inner);
  return `$ErrorActionPreference='Stop'; $pkg=Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq '${FAMILY}' } | Sort-Object Version -Descending | Select-Object -First 1; if(!$pkg){throw 'Codex Store package not found'}; $exe=Join-Path $pkg.InstallLocation 'app\\resources\\codex.exe'; if(!(Test-Path -LiteralPath $exe)){throw 'Codex app executable not found in current package'}; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json; $d.exe=$exe; $innerData=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($d|ConvertTo-Json -Compress))); $innerSource=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${innerTemplate}')).Replace('INNER_DATA_PLACEHOLDER',$innerData); $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($innerSource)); $launcher=Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; Invoke-CommandInDesktopPackage -PackageFamilyName $pkg.PackageFamilyName -AppId 'App' -Command $launcher -Args ('-NoProfile -NonInteractive -EncodedCommand '+$encoded) -PreventBreakaway | Out-Null`;
}
function runPowerShell(source, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PS, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(source)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const abort = () => child.kill();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve(); else reject(new Error(stderr.trim() || `PowerShell exited with ${code}`));
    });
  });
}

async function stopCodexByOutputPath(resultPath) {
  const marker = Buffer.from(resultPath, "utf8").toString("base64");
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${marker}')); Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(codex|cmd|powershell)\.exe$' -and $_.CommandLine -like ('*'+$p+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await runPowerShell(script).catch(() => {});
}

export function createCodexStoreAdapter({ pollMs = 500 } = {}) {
  return {
    name: "codex",
    async execute({ run, task, snapshot, workspace, artifactDirectory = workspace, signal, onEvent }) {
      if (process.platform !== "win32") throw new Error("Codex 商店版适配器仅支持 Windows；可安装普通 Codex CLI 后重试");
      const promptText = snapshot?.promptText || task?.taskText || task?.task;
      if (!promptText?.trim()) throw new Error("任务没有可执行的 prompt");
      await mkdir(artifactDirectory, { recursive: true });
      const prefix = path.join(artifactDirectory, `${run.id}.codex`);
      const paths = { prompt: `${prefix}.prompt.txt`, result: `${prefix}.result.txt`, stdout: `${prefix}.stdout.log`, stderr: `${prefix}.stderr.log`, exit: `${prefix}.exit` };
      const sandbox = task.kind === "analysis" ? "read-only" : "workspace-write";
      await writeFile(paths.prompt, promptText, "utf8");
      await Promise.all([paths.exit, paths.result, paths.stdout, paths.stderr].map((target) => rm(target, { force: true })));
      await onEvent({ type: "progress", message: "正在通过 Windows Appx 身份启动 Codex", data: { step: "启动 Codex", pct: 3 } });
      const args = ["exec", "--cd", workspace, "--sandbox", sandbox, "--ask-for-approval", "on-request", "--output-last-message", paths.result, "-"].map(quoteWindowsArg).join(" ");
      const payload = { workspace, args, exe: "", ...paths };
      await runPowerShell(powershellScript(payload), { signal });
      let lastStdout = 0;
      let lastStderr = 0;
      let lastLogAt = 0;
      while (!signal?.aborted) {
        const stdout = await readFile(paths.stdout, "utf8").catch(() => "");
        const stderr = await readFile(paths.stderr, "utf8").catch(() => "");
        if ((stdout.length > lastStdout || stderr.length > lastStderr) && Date.now() - lastLogAt >= 1000) {
          const delta = `${stdout.length > lastStdout ? `[stdout] ${stdout.slice(lastStdout)}` : ""}${stderr.length > lastStderr ? `[stderr] ${stderr.slice(lastStderr)}` : ""}`;
          await onEvent({ type: "log", message: delta.slice(-4000) });
          lastStdout = stdout.length;
          lastStderr = stderr.length;
          lastLogAt = Date.now();
        }
        const exitValue = await readFile(paths.exit, "utf8").catch(() => null);
        if (exitValue !== null) {
          const code = Number.parseInt(exitValue.trim(), 10);
          if (code !== 0) throw new Error(`Codex exited with ${Number.isFinite(code) ? code : "unknown status"}: ${(await readFile(paths.stderr, "utf8").catch(() => "")).slice(-2000)}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      if (signal?.aborted) {
        await stopCodexByOutputPath(paths.result);
        throw signal.reason || new Error("Codex execution cancelled");
      }
      const summary = await readFile(paths.result, "utf8").catch(async () => (await readFile(paths.stdout, "utf8")).slice(-6000));
      const log = await readFile(paths.stdout, "utf8").catch(() => "") + await readFile(paths.stderr, "utf8").catch(() => "");
      await writeFile(`${prefix}.combined.log`, log, "utf8");
      await onEvent({ type: "progress", message: "Codex 已完成生成", data: { step: "整理执行结果", pct: 95 } });
      return { summary: summary.trim() || "Codex 已完成任务。", evidence: [
        { kind: "agent-output", name: "Codex 输出", uri: pathToFileURL(paths.result).href },
        { kind: "agent-log", name: "Codex 执行日志", uri: pathToFileURL(`${prefix}.combined.log`).href },
      ], runner: os.hostname() };
    },
  };
}

export async function detectCodexStore({ command = PS } = {}) {
  if (process.platform !== "win32") return { available: false, installed: false, reason: "非 Windows 环境" };
  return new Promise((resolve) => {
    const script = `$ErrorActionPreference='Stop'; $p=Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq '${FAMILY}' } | Sort-Object Version -Descending | Select-Object -First 1; if(!$p){exit 3}; $e=Join-Path $p.InstallLocation 'app\resources\codex.exe'; if(!(Test-Path -LiteralPath $e)){exit 4}; Write-Output ($p.Version.ToString())`;
    const child = spawn(command, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errorText = "";
    const timer = setTimeout(() => { child.kill(); resolve({ available: false, installed: false, reason: "Appx 检测超时" }); }, 4000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); resolve({ available: false, installed: false, reason: error.message }); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0 ? { available: true, installed: true, version: output.trim() } : { available: false, installed: false, reason: errorText.trim() || `Appx 检测退出码 ${code}` }); });
  });
}

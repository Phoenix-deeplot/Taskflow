import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const releaseDirectory = path.join(projectRoot, "release");
const packageName = `Taskflow-Web-${manifest.version}`;
const outputPath = path.join(releaseDirectory, `${packageName}.zip`);
const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "taskflow-web-"));
const portableManifest = {
  name: "taskflow-web",
  version: manifest.version,
  private: true,
  type: "module",
  engines: { node: ">=22.13" },
  scripts: { start: "node scripts/start-taskflow.mjs" },
};

try {
  await mkdir(path.join(stagingRoot, "scripts"), { recursive: true });
  for (const directory of ["dist", "server", "runner"]) {
    await cp(path.join(projectRoot, directory), path.join(stagingRoot, directory), { recursive: true });
  }
  for (const script of ["serve-local.mjs", "run-runner.mjs", "start-taskflow.mjs"]) {
    await cp(path.join(projectRoot, "scripts", script), path.join(stagingRoot, "scripts", script));
  }
  await writeFile(path.join(stagingRoot, "package.json"), `${JSON.stringify(portableManifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(stagingRoot, "start-taskflow.cmd"), [
    "@echo off",
    "setlocal",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo Taskflow needs Node.js 22.13 or newer. Install Node.js, then run this file again.",
    "  pause",
    "  exit /b 1",
    ")",
    "if not defined WORKBENCH_DATA_DIR set WORKBENCH_DATA_DIR=%LOCALAPPDATA%\\Taskflow\\data",
    "if not defined WORKBENCH_RUNNER_DIR set WORKBENCH_RUNNER_DIR=%LOCALAPPDATA%\\Taskflow\\runner",
    "node \"%~dp0scripts\\start-taskflow.mjs\" %*",
    "if errorlevel 1 pause",
    "",
  ].join("\r\n"), "utf8");
  await writeFile(path.join(stagingRoot, "README.txt"), [
    "TASKFLOW WEB + RUNNER (LOCAL)",
    "",
    "Requirements: Windows, Node.js >= 22.13, Git, and any Agent CLI you want to use.",
    "No Electron, npm install, account, or cloud service is required.",
    "",
    "Start: double-click start-taskflow.cmd",
    "The launcher starts the local API and Agent Runner, then opens http://127.0.0.1:4179.",
    "Press Ctrl+C in the launcher window to stop it.",
    "",
    "The database and secrets default to %LOCALAPPDATA%\\Taskflow\\data; Runner workspaces go in %LOCALAPPDATA%\\Taskflow\\runner.",
    "In the Taskflow settings, select the Git project folder that the Runner should use.",
    "Configure Claude/Codex/custom Agent commands and credentials on this computer.",
    "Keep the launcher bound to localhost; this portable build is for one local user.",
    "",
  ].join("\r\n"), "utf8");

  await mkdir(releaseDirectory, { recursive: true });
  if (process.platform === "win32") {
    const powershell = "Import-Module Microsoft.PowerShell.Archive; $source = $env:TASKFLOW_PACKAGE_SOURCE; Compress-Archive -Path (Join-Path $source '*') -DestinationPath $env:TASKFLOW_PACKAGE_DEST -Force";
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershell], {
      env: { ...process.env, TASKFLOW_PACKAGE_SOURCE: stagingRoot, TASKFLOW_PACKAGE_DEST: outputPath },
      windowsHide: true,
    });
  } else {
    await execFileAsync("zip", ["-q", "-r", outputPath, "."], { cwd: stagingRoot });
  }
  console.log(`Created ${outputPath}`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

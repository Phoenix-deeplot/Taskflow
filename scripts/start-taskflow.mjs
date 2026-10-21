import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const minNode = [22, 13];
const currentNode = process.versions.node.split(".").map(Number);
if (currentNode[0] < minNode[0] || (currentNode[0] === minNode[0] && currentNode[1] < minNode[1])) {
  console.error(`Taskflow requires Node.js >= ${minNode.join(".")}; found ${process.versions.node}.`);
  process.exit(1);
}

const args = process.argv.slice(2);
const noOpen = args.includes("--no-open");
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 4179);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Port must be an integer between 1 and 65535.");
  process.exit(1);
}
const apiBase = `http://127.0.0.1:${port}`;
const url = apiBase;
const dataDirectory = process.env.WORKBENCH_DATA_DIR
  || path.join(projectRoot, "data");
const childEnv = { ...process.env, WORKBENCH_DATA_DIR: dataDirectory };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function apiIsReady() {
  try {
    const response = await fetch(new URL("/api/health", apiBase), { signal: AbortSignal.timeout(1200), cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

let serverProcess;
let runnerProcess;
let ownsServer = false;
let stopping = false;
let resolveMain;
const mainWait = new Promise((resolve) => { resolveMain = resolve; });

function spawnChild(label, script, env) {
  const child = spawn(process.execPath, [script], { cwd: projectRoot, env, stdio: "inherit", windowsHide: true });
  child.on("error", (error) => {
    console.error(`Taskflow ${label} failed to start: ${error.message}`);
    resolveMain(1);
  });
  return child;
}

async function waitForServer(child) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await apiIsReady()) return;
    if (child.exitCode !== null) throw new Error(`Web service exited with code ${child.exitCode}.`);
    await delay(400);
  }
  throw new Error("Timed out waiting for the local Web service.");
}

function openBrowser(target) {
  let command;
  let commandArgs;
  if (process.platform === "win32") {
    command = "cmd.exe";
    commandArgs = ["/d", "/s", "/c", `start "" "${target}"`];
  } else if (process.platform === "darwin") {
    command = "open";
    commandArgs = [target];
  } else {
    command = "xdg-open";
    commandArgs = [target];
  }
  try { spawn(command, commandArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref(); }
  catch { /* The URL is printed for manual opening if no browser opener is available. */ }
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [runnerProcess, ownsServer ? serverProcess : null]) {
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch { /* Process may have exited between checks. */ }
    }
  }
  await Promise.race([
    Promise.all([runnerProcess, ownsServer ? serverProcess : null].filter(Boolean).map((child) => new Promise((resolve) => child.once("exit", resolve)))),
    delay(2500),
  ]);
  process.exitCode = code;
}

process.once("SIGINT", () => resolveMain(0));
process.once("SIGTERM", () => resolveMain(0));

try {
  if (await apiIsReady()) {
    console.log(`Using existing local Web service: ${apiBase}`);
  } else {
    ownsServer = true;
    serverProcess = spawnChild("Web service", path.join(projectRoot, "scripts", "serve-local.mjs"), {
      ...childEnv,
      PORT: String(port),
    });
    serverProcess.once("exit", (code) => {
      if (!stopping) {
        console.error(`Taskflow Web service stopped (code ${code}).`);
        resolveMain(code || 1);
      }
    });
    await waitForServer(serverProcess);
  }

  runnerProcess = spawnChild("Runner", path.join(projectRoot, "scripts", "run-runner.mjs"), {
    ...childEnv,
    WORKBENCH_RUNNER_API: apiBase,
  });
  runnerProcess.once("exit", (code) => {
    if (!stopping && code !== 0) console.error(`Taskflow Runner exited with code ${code}.`);
  });

  console.log(`Taskflow Web + Runner is running at ${url}`);
  console.log(`Data directory: ${dataDirectory}`);
  console.log("Press Ctrl+C to stop the Runner and the Web service started by this launcher.");
  if (!noOpen) openBrowser(url);

  const code = await mainWait;
  await stop(code);
} catch (error) {
  console.error(`Taskflow could not start: ${error.message}`);
  await stop(1);
}

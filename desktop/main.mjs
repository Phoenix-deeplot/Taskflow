import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openDatabase } from "../server/db.mjs";
import { createApiHandler } from "../server/http-api.mjs";
import { guardRequest } from "../server/http-guard.mjs";
import { createSecretStore } from "../server/agent-config.mjs";
import { detectCustomAgent, detectLocalAgents, startClaudeLogin, createAgentAdapter } from "../runner/agent-adapters.mjs";
import { runRunner } from "../runner/runner-core.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(projectRoot, "dist");
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

let db;
let server;
let leaseSweep;
let runnerController;
let runnerPromise;
let apiBase;
let dataDirectory;
let mainWindow;
let quitting = false;

async function startLocalServices() {
  dataDirectory = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(app.getPath("userData"), "workbench"));
  const backupDirectory = path.join(dataDirectory, "backups");
  await mkdir(dataDirectory, { recursive: true });
  db = openDatabase(path.join(dataDirectory, "requirements.sqlite"), { backupDirectory });
  const secretStore = createSecretStore({ file: path.join(dataDirectory, "agent-secrets.json") });
  const handleApi = createApiHandler({ db, backupDirectory, databaseName: "requirements.sqlite", projectDirectory: projectRoot, detectAgents: detectLocalAgents, secretStore, detectCustomAgent, startClaudeLogin });
  leaseSweep = setInterval(() => {
    try { for (const run of handleApi.expireLeases()) console.warn(`[workbench] Runner lease expired: ${run.id} (${run.status})`); }
    catch (error) { console.error("[workbench] Could not expire Runner leases", error); }
  }, 1_000);
  leaseSweep.unref();
  server = createServer(async (request, response) => {
    if (guardRequest(request, response)) return;
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname); }
    catch { response.writeHead(400).end("Bad request"); return; }
    if (pathname.startsWith("/api/")) {
      if (await handleApi(request, response, pathname)) return;
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "API route not found" }));
      return;
    }
    const requested = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.resolve(distRoot, `.${requested}`);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) { response.writeHead(403).end("Forbidden"); return; }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(body);
    } catch { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  apiBase = `http://127.0.0.1:${server.address().port}`;
  console.info(`[workbench] Local API: ${apiBase}`);
  console.info(`[workbench] Data: ${dataDirectory}`);
}

async function chooseProjectDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, { title: "选择要执行任务的 Git 项目", message: "Runner 会在这个项目中为任务创建独立 Git worktree。", properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return;
  const projectPath = path.resolve(result.filePaths[0]);
  try {
    await execFileAsync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"]);
    const response = await fetch(new URL("/api/settings", apiBase), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectPath }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    await startRunner();
    dialog.showMessageBox(mainWindow, { type: "info", message: `已选择项目目录：\n${projectPath}` });
  } catch (error) { dialog.showMessageBox(mainWindow, { type: "error", message: `项目目录不可用：${error.message}` }); }
}

async function startRunner() {
  if (runnerPromise) return;
  const fallbackRepositoryPath = projectRoot;
  const resolveRepositoryPath = async () => {
    try {
      const response = await fetch(new URL("/api/settings", apiBase), { cache: "no-store" });
      const settings = await response.json();
      return path.resolve(settings.projectPath || fallbackRepositoryPath);
    } catch { return fallbackRepositoryPath; }
  };
  const repositoryPath = await resolveRepositoryPath();
  try { await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "--show-toplevel"]); }
  catch {
    console.info("[workbench] Runner is waiting for a Git project. Choose one from the Workbench menu.");
    return;
  }
  runnerController = new AbortController();
  const runnerDirectory = path.join(dataDirectory, "runner");
  console.info("[workbench] Starting local Agent Runner");
  runnerPromise = runRunner({
    apiBase, runnerId: `desktop-${process.pid}`, repositoryPath: fallbackRepositoryPath, resolveRepositoryPath,
    runnerDirectory, capabilities: ["claude", "claude-code", "codex", "custom:*"], leaseSeconds: 60,
    adapter: (claim, launch) => createAgentAdapter(claim.run?.executorType || claim.task?.executorType || claim.task?.provider, launch),
    signal: runnerController.signal,
  }).catch((error) => console.error(`[workbench] Runner stopped: ${error.message}`)).finally(() => { runnerPromise = null; runnerController = null; });
}

function createApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "工作台", submenu: [
      { label: "选择项目仓库…", click: () => void chooseProjectDirectory() },
      { label: "打开数据目录", click: () => void shell.openPath(dataDirectory) },
      { type: "separator" }, { role: "reload", label: "刷新页面" }, { type: "separator" }, { role: "quit", label: "退出" },
    ] },
    { label: "Runner", submenu: [
      { label: "启动 / 恢复 Agent Runner", click: () => void startRunner() },
      { label: "停止 Runner", click: () => runnerController?.abort(new Error("Stopped by user")) },
    ] },
  ]));
}

async function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 980, minHeight: 680, title: "Taskflow", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  mainWindow.webContents.on("will-navigate", (event, url) => { if (url !== apiBase && !url.startsWith(`${apiBase}/`)) event.preventDefault(); });
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(apiBase);
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  runnerController?.abort(new Error("Desktop app is closing"));
  if (runnerPromise) await Promise.race([runnerPromise, new Promise((resolve) => setTimeout(resolve, 1_500))]);
  clearInterval(leaseSweep);
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  db?.close();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName("Taskflow");
  if (process.platform === "win32") app.setAppUserModelId("com.chuhaila.requirements-workbench");
  app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    try { await startLocalServices(); createApplicationMenu(); await createWindow(); await startRunner(); }
    catch (error) { dialog.showErrorBox("工作台启动失败", error.stack || error.message); await shutdown(); app.quit(); }
  });
  app.on("before-quit", (event) => { if (!quitting) { event.preventDefault(); void shutdown().finally(() => app.quit()); } });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}

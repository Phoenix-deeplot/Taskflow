import { createWorkbench } from "./service.mjs";
import { exportLegacyState, hasWorkspaceData, syncLegacyState } from "./legacy-state.mjs";
import { commitLegacyImport, previewLegacyImport } from "./legacy-import.mjs";
import { previewRestore, restoreFromExport } from "./restore.mjs";
import { createProviderGateway } from "./provider-gateway.mjs";
import { proposeSplit } from "./split.mjs";
import { WorkbenchError } from "./util.mjs";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new WorkbenchError("PAYLOAD_TOO_LARGE", "请求超过 10 MB", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WorkbenchError("INVALID_JSON", "请求内容不是有效 JSON", 400); }
}

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function parseId(value) {
  try { return decodeURIComponent(value); }
  catch { throw new WorkbenchError("INVALID_ID", "路径 ID 编码无效", 400); }
}

export function createApiHandler({ db, backupDirectory, databaseName = "requirements.sqlite", projectDirectory = process.cwd(), workbench: injectedWorkbench, providerGateway: injectedProviderGateway, detectAgents }) {
  const workbench = injectedWorkbench || createWorkbench(db);
  const providerGateway = injectedProviderGateway || createProviderGateway();

  const handleApi = async function handleApi(request, response, pathname) {
    const method = request.method || "GET";
    const parts = pathname.split("/").filter(Boolean);
    try {
      if (pathname === "/api/health" && method === "GET") {
        send(response, 200, { ok: true, storage: "sqlite-relational", database: databaseName });
        return true;
      }
      // Tiny on purpose: the page polls this every few seconds and only reloads the whole state when it changes.
      if (pathname === "/api/version" && method === "GET") {
        send(response, 200, { stateVersion: workbench.stateVersion() });
        return true;
      }
      if (pathname === "/api/settings" && method === "GET") {
        send(response, 200, { projectPath: workbench.getSetting("project.path") || projectDirectory });
        return true;
      }
      if (pathname === "/api/settings" && method === "PUT") {
        const body = await readBody(request);
        const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
        if (!projectPath || projectPath.length > 500 || projectPath.includes("\0")) throw new WorkbenchError("INVALID", "项目目录必须是不超过 500 字的路径", 400);
        const { stat } = await import("node:fs/promises");
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const info = await stat(projectPath).catch(() => null);
        if (!info?.isDirectory()) throw new WorkbenchError("INVALID", "项目目录不存在或不是文件夹", 400);
        await execFileAsync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"]).catch(() => { throw new WorkbenchError("INVALID", "项目目录必须是 Git 仓库", 400); });
        send(response, 200, { projectPath: workbench.setSetting("project.path", projectPath) });
        return true;
      }
      if (pathname === "/api/agents" && method === "GET") {
        const detected = detectAgents ? await detectAgents() : {};
        send(response, 200, detected);
        return true;
      }
      if (pathname === "/api/analysis-template" && method === "GET") {
        send(response, 200, { template: workbench.DEFAULT_ANALYSIS_TEMPLATE });
        return true;
      }
      if (pathname === "/api/state" && method === "GET") {
        const state = exportLegacyState(db, workbench);
        send(response, 200, { initialized: hasWorkspaceData(db), state });
        return true;
      }
      if (pathname === "/api/state" && method === "PUT") {
        const body = await readBody(request);
        const state = syncLegacyState(db, body.state, { workbench, backupDirectory });
        send(response, 200, { initialized: hasWorkspaceData(db), state });
        return true;
      }
      if (pathname === "/api/import/preview" && method === "POST") {
        const body = await readBody(request);
        send(response, 200, previewLegacyImport(db, body.state));
        return true;
      }
      if (pathname === "/api/import/commit" && method === "POST") {
        const body = await readBody(request);
        send(response, 200, commitLegacyImport(db, body.state, { origin: body.origin || "api", backupDirectory }));
        return true;
      }
      if (pathname === "/api/restore/preview" && method === "POST") {
        const body = await readBody(request);
        send(response, 200, previewRestore(db, body.document || body.export || body.state));
        return true;
      }
      if (pathname === "/api/restore/commit" && method === "POST") {
        const body = await readBody(request);
        send(response, 200, restoreFromExport(db, body.document || body.export || body.state, { backupDirectory }));
        return true;
      }
      if (pathname === "/api/context" && method === "GET") {
        send(response, 200, { current: workbench.getContext(), versions: workbench.listContextVersions() });
        return true;
      }
      if (pathname === "/api/context" && method === "POST") {
        const body = await readBody(request);
        send(response, 201, workbench.appendContextVersion(body.rules || body));
        return true;
      }
      if (pathname === "/api/requirements" && method === "GET") {
        const url = new URL(request.url || "/", "http://localhost");
        send(response, 200, workbench.listRequirements({ decision: url.searchParams.get("decision") || undefined, targetVersion: url.searchParams.get("targetVersion") || undefined, query: url.searchParams.get("query") || undefined }));
        return true;
      }
      if (pathname === "/api/requirements" && method === "POST") {
        send(response, 201, workbench.createRequirement(await readBody(request)));
        return true;
      }
      if (pathname === "/api/tasks" && method === "GET") {
        const url = new URL(request.url || "/", "http://localhost");
        send(response, 200, workbench.listTasks({ status: url.searchParams.get("status") || undefined, requirementId: url.searchParams.get("requirementId") || undefined }));
        return true;
      }
      if (pathname === "/api/tasks" && method === "POST") {
        send(response, 201, workbench.createTask(await readBody(request)));
        return true;
      }
      if (pathname === "/api/tasks/dispatch" && method === "POST") {
        const body = await readBody(request);
        send(response, 202, workbench.dispatchTasks(body.taskIds, body));
        return true;
      }
      if (pathname === "/api/tasks/dispatch-all" && method === "POST") {
        send(response, 202, workbench.dispatchAll(await readBody(request)));
        return true;
      }
      if (parts[1] === "requirements" && parts.length === 4 && parts[3] === "analysis" && method === "POST") {
        send(response, 201, workbench.createAnalysisTask(parseId(parts[2]), await readBody(request)));
        return true;
      }
      if (parts[1] === "requirements" && parts.length === 3) {
        const id = parseId(parts[2]);
        if (method === "GET") { send(response, 200, workbench.getRequirement(id)); return true; }
        if (method === "PATCH") { const body = await readBody(request); send(response, 200, workbench.updateRequirement(id, body.patch || body, { expectedRevision: body.expectedRevision })); return true; }
        if (method === "DELETE") { const body = await readBody(request); send(response, 200, workbench.deleteRequirement(id, { reason: body.reason || "" })); return true; }
      }
      if (parts[1] === "requirements" && parts.length === 4) {
        const id = parseId(parts[2]);
        if (parts[3] === "progress" && method === "GET") { send(response, 200, workbench.requirementProgress(id)); return true; }
        if (parts[3] === "split" && method === "POST") {
          const body = await readBody(request);
          send(response, 201, workbench.splitRequirement(id, body.tasks || body.items || []));
          return true;
        }
      }
      if (parts[1] === "requirements" && parts.length === 5 && parts[3] === "split" && parts[4] === "propose" && method === "POST") {
        const body = await readBody(request);
        const provider = providerGateway.get(body.provider);
        send(response, 201, await proposeSplit(workbench, parseId(parts[2]), provider, { maxTasks: body.maxTasks, timeoutMs: body.timeoutMs }));
        return true;
      }
      if (parts[1] === "tasks" && parts.length >= 3) {
        const id = parseId(parts[2]);
        if (parts.length === 3 && method === "GET") { send(response, 200, workbench.getTask(id)); return true; }
        if (parts.length === 3 && method === "PATCH") { const body = await readBody(request); send(response, 200, workbench.updateTask(id, body.patch || body, { expectedRevision: body.expectedRevision })); return true; }
        if (parts.length === 4 && method === "POST") {
          const body = await readBody(request);
          if (parts[3] === "dispatch") { send(response, 202, workbench.dispatchTask(id, body)); return true; }
          if (parts[3] === "start") { send(response, 200, workbench.startTask(id, body)); return true; }
          if (parts[3] === "transition") { send(response, 200, workbench.transitionTask(id, body.target, body)); return true; }
          if (parts[3] === "accept") { send(response, 200, workbench.acceptTask(id, body)); return true; }
          if (parts[3] === "reject") { send(response, 200, workbench.rejectTask(id, body)); return true; }
          if (parts[3] === "reopen") { send(response, 200, workbench.reopenTask(id, body)); return true; }
        }
      }
      if (pathname === "/api/runner/claim" && method === "POST") {
        send(response, 200, workbench.claimRun(await readBody(request)));
        return true;
      }
      if (parts[1] === "runs" && parts.length === 4 && method === "POST") {
        const runId = parseId(parts[2]);
        const body = await readBody(request);
        if (parts[3] === "cancel") { send(response, 200, workbench.cancelRun(runId, body)); return true; }
        const callbackRoutes = new Set(["heartbeat", "events", "result", "failure", "artifacts"]);
        if (parts[3] === "ack-cancel" || callbackRoutes.has(parts[3])) {
          const authorization = String(request.headers.authorization || "");
          const leaseToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
          const runnerOnly = new Set(["heartbeat", "events", "artifacts", "ack-cancel"]).has(parts[3]);
          if (runnerOnly && !leaseToken) {
            send(response, 401, { code: "RUNNER_TOKEN_REQUIRED", error: "Runner 回调需要有效的租约令牌" });
            return true;
          }
          if (leaseToken && (request.headers.origin || request.headers["sec-fetch-site"])) {
            send(response, 403, { code: "RUNNER_CALLBACK_BROWSER_BLOCKED", error: "浏览器页面不能调用 Runner 回调" });
            return true;
          }
          if (parts[3] === "heartbeat") { send(response, 200, workbench.heartbeat(runId, leaseToken, body)); return true; }
          if (parts[3] === "events") { send(response, 201, workbench.appendRunEvent(runId, leaseToken, body)); return true; }
          if (parts[3] === "ack-cancel") { send(response, 200, workbench.ackCancel(runId, leaseToken)); return true; }
          if (parts[3] === "result") { send(response, 200, workbench.submitResult(runId, { ...body, ...(leaseToken ? { leaseToken } : {}) })); return true; }
          if (parts[3] === "failure") { send(response, 200, workbench.reportFailure(runId, { ...body, ...(leaseToken ? { leaseToken } : {}) })); return true; }
          send(response, 201, workbench.addArtifact(runId, leaseToken, body));
          return true;
        }
      }
      if (parts[1] === "runs" && parts.length === 3 && method === "GET") {
        send(response, 200, workbench.getRunDetail(parseId(parts[2])));
        return true;
      }
      if (parts[1] === "runs" && parts.length === 4 && parts[3] === "artifacts" && method === "GET") {
        send(response, 200, workbench.listArtifacts(parseId(parts[2])));
        return true;
      }
      if (parts[1] === "snapshots" && parts.length === 3 && method === "GET") {
        send(response, 200, workbench.getSnapshot(parseId(parts[2])));
        return true;
      }
      if (pathname === "/api/events" && method === "GET") {
        const url = new URL(request.url || "/", "http://localhost");
        send(response, 200, workbench.listEvents({ entityType: url.searchParams.get("entityType") || undefined, entityId: url.searchParams.get("entityId") || undefined, limit: Number(url.searchParams.get("limit") || 200), beforeId: Number(url.searchParams.get("beforeId")) || undefined }));
        return true;
      }
      if (pathname === "/api/export" && method === "GET") { send(response, 200, workbench.exportAll()); return true; }
      return false;
    } catch (error) {
      const status = error instanceof WorkbenchError ? error.status : error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      if (status >= 500) console.error("Local workbench API failed", error);
      send(response, status, { error: error.message || "内部错误", code: error.code || "INTERNAL", details: error.details });
      return true;
    }
  };
  handleApi.expireLeases = () => typeof workbench.expireLeases === "function" ? workbench.expireLeases() : [];
  return handleApi;
}

import { createWorkbench } from "./service.mjs";
import { exportLegacyState, hasWorkspaceData, syncLegacyState } from "./legacy-state.mjs";
import { commitLegacyImport, previewLegacyImport } from "./legacy-import.mjs";
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

export function createApiHandler({ db, backupDirectory, databaseName = "requirements.sqlite" }) {
  const workbench = createWorkbench(db);

  return async function handleApi(request, response, pathname) {
    const method = request.method || "GET";
    const parts = pathname.split("/").filter(Boolean);
    try {
      if (pathname === "/api/health" && method === "GET") {
        send(response, 200, { ok: true, storage: "sqlite-relational", database: databaseName });
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
      if (parts[1] === "requirements" && parts.length === 3) {
        const id = parseId(parts[2]);
        if (method === "GET") { send(response, 200, workbench.getRequirement(id)); return true; }
        if (method === "PATCH") { const body = await readBody(request); send(response, 200, workbench.updateRequirement(id, body.patch || body, { expectedRevision: body.expectedRevision })); return true; }
        if (method === "DELETE") { const body = await readBody(request); send(response, 200, workbench.deleteRequirement(id, { reason: body.reason || "" })); return true; }
      }
      if (parts[1] === "tasks" && parts.length >= 3) {
        const id = parseId(parts[2]);
        if (parts.length === 3 && method === "GET") { send(response, 200, workbench.getTask(id)); return true; }
        if (parts.length === 3 && method === "PATCH") { const body = await readBody(request); send(response, 200, workbench.updateTask(id, body.patch || body, { expectedRevision: body.expectedRevision })); return true; }
        if (parts.length === 4 && method === "POST") {
          const body = await readBody(request);
          if (parts[3] === "start") { send(response, 200, workbench.startTask(id, body)); return true; }
          if (parts[3] === "transition") { send(response, 200, workbench.transitionTask(id, body.target, body)); return true; }
          if (parts[3] === "accept") { send(response, 200, workbench.acceptTask(id, body)); return true; }
          if (parts[3] === "reject") { send(response, 200, workbench.rejectTask(id, body)); return true; }
          if (parts[3] === "reopen") { send(response, 200, workbench.reopenTask(id, body)); return true; }
        }
      }
      if (parts[1] === "runs" && parts.length === 4 && method === "POST") {
        const runId = parseId(parts[2]);
        const body = await readBody(request);
        if (parts[3] === "result") { send(response, 200, workbench.submitResult(runId, body)); return true; }
        if (parts[3] === "failure") { send(response, 200, workbench.reportFailure(runId, body)); return true; }
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
}

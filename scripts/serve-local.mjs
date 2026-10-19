import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalStore } from "./local-store.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(projectRoot, "dist");
const dataDirectory = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(projectRoot, "data"));
const store = createLocalStore(dataDirectory);
const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 4179);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function readJsonBody(request, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body exceeds 10 MB"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 });
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, storage: "sqlite", database: path.basename(store.dbPath) });
    return;
  }
  if (pathname === "/api/state" && request.method === "GET") {
    try {
      sendJson(response, 200, store.read());
    } catch (error) {
      console.error("Could not read local workspace database", error);
      sendJson(response, 500, { error: "本地数据库读取失败" });
    }
    return;
  }
  if (pathname === "/api/state" && request.method === "PUT") {
    try {
      const body = await readJsonBody(request);
      const saved = store.write(body.state);
      sendJson(response, 200, saved);
    } catch (error) {
      const status = error.statusCode || (error instanceof TypeError || error instanceof RangeError ? 400 : 500);
      if (status === 500) console.error("Could not save local workspace database", error);
      sendJson(response, status, { error: status === 500 ? "本地数据库保存失败" : error.message });
    }
    return;
  }
  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API route not found" });
    return;
  }

  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(root, `.${requested}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`本地调试服务已启动：http://127.0.0.1:${port}`);
  console.log(`SQLite 数据库：${store.dbPath}`);
  console.log("按 Ctrl+C 停止服务；修改 dist/index.html 后刷新浏览器即可。");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => {
    store.close();
    process.exit(0);
  }));
}

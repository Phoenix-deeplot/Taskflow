import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../server/db.mjs";
import { createApiHandler } from "../server/http-api.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(projectRoot, "dist");
const dataDirectory = path.resolve(process.env.WORKBENCH_DATA_DIR || path.join(projectRoot, "data"));
const databasePath = path.join(dataDirectory, "requirements.sqlite");
const backupDirectory = path.join(dataDirectory, "backups");
const db = openDatabase(databasePath, { backupDirectory });
const handleApi = createApiHandler({ db, backupDirectory, databaseName: path.basename(databasePath) });
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

const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (pathname.startsWith("/api/")) {
    const handled = await handleApi(request, response, pathname);
    if (handled) return;
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "API route not found" }));
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
  console.log(`SQLite 数据库：${databasePath}`);
  console.log("按 Ctrl+C 停止服务；修改 dist/index.html 后刷新浏览器即可。");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}

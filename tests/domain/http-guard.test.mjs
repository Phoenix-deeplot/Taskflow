import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openDatabase } from "../../server/db.mjs";
import { evaluateRequest, guardRequest, mediaType } from "../../server/http-guard.mjs";
import { createApiHandler } from "../../server/http-api.mjs";

/** The real API handler behind the guard, on a real socket, so headers behave exactly as on the wire. */
async function withGuardedApi(run) {
  const db = openDatabase(":memory:");
  const handle = createApiHandler({ db });
  const server = http.createServer(async (request, response) => {
    if (guardRequest(request, response)) return;
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!(await handle(request, response, pathname))) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const call = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    // Node's client does not frame a body on DELETE by itself; browsers always send Content-Length.
    const framing = body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) };
    const request = http.request({ host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...framing, ...headers } }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: data ? JSON.parse(data) : null }));
    });
    request.on("error", reject);
    request.end(body);
  });
  try { await run({ call, port, db }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

const json = { "Content-Type": "application/json" };
const requirements = (db) => db.prepare("SELECT COUNT(*) AS n FROM requirements").get().n;

test("the page's own requests are allowed: same host, JSON writes with or without an Origin header", async () => {
  await withGuardedApi(async ({ call, port }) => {
    assert.equal((await call("GET", "/api/health")).status, 200);
    const created = await call("POST", "/api/requirements", json, JSON.stringify({ title: "命令行创建" }));
    assert.equal(created.status, 201);
    const sameOrigin = await call("POST", "/api/requirements", { ...json, Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" }, JSON.stringify({ title: "页面创建" }));
    assert.equal(sameOrigin.status, 201);
    const localhostOrigin = await call("PATCH", `/api/requirements/${created.body.id}`, { ...json, Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, JSON.stringify({ title: "改名" }));
    assert.equal(localhostOrigin.status, 200);
    const del = await call("DELETE", `/api/requirements/${created.body.id}`, json, JSON.stringify({ reason: "x" }));
    assert.equal(del.status, 200);
  });
});

test("a cross-site text/plain POST (no preflight) is refused and writes nothing", async () => {
  await withGuardedApi(async ({ call, db }) => {
    const attack = await call("POST", "/api/requirements", { "Content-Type": "text/plain", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, JSON.stringify({ title: "来自恶意网页" }));
    assert.equal(attack.status, 403);
    assert.equal(attack.body.code, "ORIGIN_NOT_ALLOWED");
    assert.equal(requirements(db), 0);
  });
});

test("cross-site or foreign-origin writes are refused on every write route", async () => {
  await withGuardedApi(async ({ call, db, port }) => {
    for (const [method, path] of [["POST", "/api/requirements"], ["POST", "/api/tasks"], ["POST", "/api/tasks/TASK-X/start"], ["POST", "/api/import/commit"], ["PUT", "/api/state"], ["PATCH", "/api/requirements/REQ-X"], ["DELETE", "/api/requirements/REQ-X"]]) {
      for (const origin of ["https://evil.example", "null", `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`]) {
        const response = await call(method, path, { ...json, Origin: origin }, "{}");
        assert.equal(response.status, 403, `${method} ${path} from ${origin}`);
      }
    }
    assert.equal(requirements(db), 0);
  });
});

test("Sec-Fetch-Site cross-site / same-site is refused even without an Origin header", async () => {
  await withGuardedApi(async ({ call }) => {
    for (const site of ["cross-site", "same-site"]) {
      const response = await call("POST", "/api/requirements", { ...json, "Sec-Fetch-Site": site }, JSON.stringify({ title: "x" }));
      assert.equal(response.status, 403, site);
      assert.equal(response.body.code, "CROSS_SITE_BLOCKED");
    }
  });
});

test("writes without a JSON content type are refused, including from non-browser clients", async () => {
  await withGuardedApi(async ({ call, db }) => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
      const response = await call("POST", "/api/requirements", type ? { "Content-Type": type } : {}, JSON.stringify({ title: "x" }));
      assert.equal(response.status, 415, `content type "${type}"`);
    }
    const charset = await call("POST", "/api/requirements", { "Content-Type": "Application/JSON; charset=utf-8" }, JSON.stringify({ title: "ok" }));
    assert.equal(charset.status, 201);
    assert.equal(requirements(db), 1);
  });
});

test("a foreign Host header (DNS rebinding) cannot read or write anything", async () => {
  await withGuardedApi(async ({ call, port, db }) => {
    const read = await call("GET", "/api/export", { Host: `evil.example:${port}` });
    assert.equal(read.status, 403);
    assert.equal(read.body.code, "HOST_NOT_ALLOWED");
    assert.equal(read.body.workspace, undefined);
    const wrongPort = await call("GET", "/api/health", { Host: `127.0.0.1:${port + 1}` });
    assert.equal(wrongPort.status, 403);
    const write = await call("POST", "/api/requirements", { ...json, Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` }, JSON.stringify({ title: "x" }));
    assert.equal(write.status, 403);
    assert.equal(requirements(db), 0);
    assert.equal((await call("GET", "/api/health", { Host: `LOCALHOST:${port}` })).status, 200);
  });
});

test("evaluateRequest is a pure function over method and headers", () => {
  const req = (method, headers = {}, localPort = 4179) => ({ method, headers, socket: { localPort } });
  assert.equal(evaluateRequest(req("GET", { host: "127.0.0.1:4179" })), null);
  assert.equal(evaluateRequest(req("HEAD", { host: "127.0.0.1:4179", origin: "https://evil.example" })), null, "safe methods ignore Origin");
  assert.equal(evaluateRequest(req("GET", {})).code, "HOST_NOT_ALLOWED");
  assert.equal(evaluateRequest(req("POST", { host: "127.0.0.1:4179", "content-type": "application/json" })), null);
  assert.equal(evaluateRequest(req("DELETE", { host: "127.0.0.1:4179" })), null, "a body-less DELETE needs no content type");
  assert.equal(evaluateRequest(req("DELETE", { host: "127.0.0.1:4179", "content-length": "2" })).status, 415);
  assert.equal(evaluateRequest(req("POST", { host: "[::1]:4179", origin: "http://[::1]:4179", "content-type": "application/json" })), null);
  assert.equal(evaluateRequest(req("POST", { host: "myhost:80", "content-type": "application/json" }), { allowedHosts: ["myhost:80"] }), null);
  assert.equal(mediaType("Application/JSON ; charset=utf-8"), "application/json");
  assert.equal(mediaType(undefined), "");
});

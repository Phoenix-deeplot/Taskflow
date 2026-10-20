import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer, request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tempDirectory } from "./domain/helpers.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function rawRequest(port, method, pathname, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: pathname, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = "";
      res.setEncoding("utf8"); res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject); req.end(body);
  });
}

test("the real local server guards requests before routing and uses only temporary data", async () => {
  const { directory, cleanup } = tempDirectory();
  const port = await freePort();
  const child = spawn(process.execPath, ["scripts/serve-local.mjs", "--port", String(port)], {
    cwd: projectRoot,
    env: { ...process.env, WORKBENCH_DATA_DIR: directory },
    stdio: "ignore",
  });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`local server exited with ${child.exitCode}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { healthy = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, "local service should start");

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const poisonedPost = await rawRequest(port, "POST", "/api/state", {
      Origin: "https://attacker.example", "Content-Type": "text/plain", "Content-Length": "2",
    }, "{}");
    assert.equal(poisonedPost.status, 403);
    const spoofedHost = await rawRequest(port, "GET", "/api/export", { Host: `attacker.example:${port}` });
    assert.equal(spoofedHost.status, 403);
    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
    assert.equal(state.initialized, false, "blocked cross-site write must not initialize or alter the workspace");
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
    cleanup();
  }
});

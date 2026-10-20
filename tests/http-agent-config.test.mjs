import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSecretStore } from "../server/agent-config.mjs";
import { openDatabase } from "../server/db.mjs";
import { createApiHandler } from "../server/http-api.mjs";

async function withApi(run, options = {}) {
  const db = openDatabase(":memory:");
  const secretStore = options.secretStore || createSecretStore();
  const handle = createApiHandler({ db, secretStore, ...options });
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!await handle(request, response, pathname)) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base, { db, secretStore }); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
}

async function call(base, pathname, method = "GET", body, headers = {}) {
  const response = await fetch(base + pathname, {
    method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

test("keys are set and cleared over HTTP, and no response ever contains the key", async () => {
  await withApi(async (base) => {
    const secret = "sk-live-aaaabbbbccccdddd1234";
    const saved = await call(base, "/api/agent-config/keys/openai-api-key", "PUT", { value: secret });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.hint, "…1234");
    assert.equal(saved.text.includes(secret), false);

    const listing = await call(base, "/api/agent-config");
    assert.equal(listing.status, 200);
    assert.equal(listing.body.keys["openai-api-key"].configured, true);
    assert.equal(listing.text.includes(secret), false, "the settings page can never read a key back");

    const cleared = await call(base, "/api/agent-config/keys/openai-api-key", "DELETE");
    assert.equal(cleared.body.configured, false);
    assert.equal((await call(base, "/api/agent-config")).body.keys["openai-api-key"].configured, false);

    for (const bad of [{ value: "has space" }, { value: "" }, {}, { value: 5 }]) assert.equal((await call(base, "/api/agent-config/keys/openai-api-key", "PUT", bad)).status, 400);
    assert.equal((await call(base, "/api/agent-config/keys/not-a-slot", "PUT", { value: "abc" })).status, 400);
  });
});

test("a key set over HTTP is what the model gateway uses", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({ url, headers: init.headers }); return { ok: true, json: async () => ({ choices: [{ message: { content: "{\"ok\":true}" } }], usage: {} }) }; };
  const { createProviderGateway } = await import("../server/provider-gateway.mjs");
  const { providerEnvironment } = await import("../server/agent-config.mjs");
  const secretStore = createSecretStore();
  const providerGateway = createProviderGateway({ env: providerEnvironment(secretStore, {}), fetchImpl });
  await withApi(async (base) => {
    await assert.rejects(providerGateway.get("deepseek").complete({ system: "s", input: {}, schema: { type: "object", properties: {} } }), /DEEPSEEK_API_KEY/);
    await call(base, "/api/agent-config/keys/deepseek-api-key", "PUT", { value: "ds-key-from-page-123456" });
    await call(base, "/api/agent-config/keys/deepseek-model", "PUT", { value: "deepseek-test" });
    const answer = await providerGateway.get("deepseek").complete({ system: "s", input: {}, schema: { type: "object", properties: {} } });
    assert.equal(answer.model, "deepseek-test");
    assert.equal(requests[0].headers.Authorization, "Bearer ds-key-from-page-123456");
  }, { secretStore, providerGateway });
});

test("custom agents are saved, reported with availability, and take their credential with them when removed", async () => {
  const detectCustomAgent = async (agent) => ({ available: agent.command === "present", reason: agent.command === "present" ? null : "找不到命令" });
  await withApi(async (base, { secretStore }) => {
    const saved = await call(base, "/api/agent-config/custom-agents", "PUT", { agents: [
      { id: "aider", name: "Aider", command: "present", args: ["{promptFile}"], secretEnv: "OPENAI_API_KEY" },
      { id: "ghost", command: "missing" },
    ] });
    assert.equal(saved.status, 200);
    await call(base, "/api/agent-config/keys/custom:aider", "PUT", { value: "aider-secret-123456" });

    const agents = await call(base, "/api/agents");
    const byId = Object.fromEntries(agents.body.custom.map((entry) => [entry.id, entry]));
    assert.equal(byId.aider.available, true);
    assert.equal(byId.aider.secretConfigured, true);
    assert.equal(byId.aider.executorType, "custom:aider");
    assert.equal(byId.ghost.available, false);
    assert.equal(agents.text.includes("aider-secret"), false);

    assert.equal((await call(base, "/api/agent-config/custom-agents", "PUT", { agents: [{ id: "codex", command: "x" }] })).status, 400, "built-in names are taken");
    assert.equal((await call(base, "/api/agent-config/custom-agents", "PUT", { agents: "x" })).status, 400);

    await call(base, "/api/agent-config/custom-agents", "PUT", { agents: [{ id: "ghost", command: "missing" }] });
    assert.equal(secretStore.has("custom:aider"), false, "removing an agent removes its credential");
  }, { detectCustomAgent });
});

test("a token or API key set on the page makes an installed but signed-out Claude Code usable", async () => {
  const detectAgents = async () => ({ claude: { installed: true, loggedIn: false, available: false, reason: "未登录" }, codex: { installed: true, available: true } });
  await withApi(async (base) => {
    assert.equal((await call(base, "/api/agents")).body.claude.available, false);
    await call(base, "/api/agent-config/keys/claude-code-token", "PUT", { value: "subscription-token-abcdef" });
    const after = (await call(base, "/api/agents")).body.claude;
    assert.deepEqual([after.available, after.loggedIn, after.mode], [true, true, "已配置订阅令牌"]);
  }, { detectAgents });
});

test("sign-in from the page starts the login helper, or says it cannot", async () => {
  await withApi(async (base) => assert.equal((await call(base, "/api/agents/claude/login", "POST", {})).status, 501));
  let started = 0;
  await withApi(async (base) => {
    const answer = await call(base, "/api/agents/claude/login", "POST", {});
    assert.equal(answer.status, 202);
    assert.equal(answer.body.started, true);
    assert.equal(started, 1);
  }, { startClaudeLogin: async () => { started += 1; return { started: true, message: "ok" }; } });
});

test("launch-config hands credentials only to the holder of the run's lease, never to a browser", async () => {
  await withApi(async (base, { secretStore }) => {
    await call(base, "/api/agent-config/custom-agents", "PUT", { agents: [{ id: "aider", command: "aider", args: ["{promptFile}"], secretEnv: "OPENAI_API_KEY" }] });
    secretStore.set("custom:aider", "aider-secret-123456");
    secretStore.set("claude-code-token", "subscription-token-abcdef");

    const sent = [];
    for (const executorType of ["custom:aider", "claude"]) {
      const task = await call(base, "/api/tasks", "POST", { taskText: "do it", executorType });
      sent.push(await call(base, `/api/tasks/${task.body.id}/dispatch`, "POST", {}));
    }
    const claimCustom = await call(base, "/api/runner/claim", "POST", { runnerId: "r1", capabilities: ["custom:*"] });
    const claimClaude = await call(base, "/api/runner/claim", "POST", { runnerId: "r1", capabilities: ["claude"] });
    const bearer = (claim) => ({ Authorization: `Bearer ${claim.body.leaseToken}` });

    const custom = await call(base, `/api/runs/${claimCustom.body.run.id}/launch-config`, "POST", {}, bearer(claimCustom));
    assert.equal(custom.status, 200);
    assert.deepEqual(custom.body, { env: { OPENAI_API_KEY: "aider-secret-123456" }, custom: { id: "aider", name: "aider", command: "aider", args: ["{promptFile}"] } });
    const claude = await call(base, `/api/runs/${claimClaude.body.run.id}/launch-config`, "POST", {}, bearer(claimClaude));
    assert.deepEqual(claude.body, { env: { CLAUDE_CODE_OAUTH_TOKEN: "subscription-token-abcdef" }, custom: null }, "each run gets its own executor's credentials only");

    assert.equal((await call(base, `/api/runs/${claimCustom.body.run.id}/launch-config`, "POST", {})).status, 401, "no lease token");
    assert.equal((await call(base, `/api/runs/${claimCustom.body.run.id}/launch-config`, "POST", {}, { Authorization: "Bearer wrong" })).status, 401, "wrong lease token");
    assert.equal((await call(base, `/api/runs/${claimCustom.body.run.id}/launch-config`, "POST", {}, { ...bearer(claimCustom), Origin: base })).status, 403, "a web page cannot read it");
    assert.equal((await call(base, `/api/runs/${claimClaude.body.run.id}/launch-config`, "POST", {}, bearer(claimCustom))).status, 401, "another run's lease does not work");

    const detail = await call(base, `/api/runs/${claimCustom.body.run.id}`);
    assert.equal(detail.text.includes("aider-secret"), false, "credentials do not show up in run details");
    const events = await call(base, "/api/events?limit=200");
    assert.equal(events.text.includes("aider-secret") || events.text.includes("subscription-token"), false, "nor in events");
  });
});

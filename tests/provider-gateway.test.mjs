import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { openDatabase } from "../server/db.mjs";
import { createProviderGateway } from "../server/provider-gateway.mjs";
import { createWorkbench } from "../server/service.mjs";
import { proposeSplit } from "../server/split.mjs";
import { SPLIT_SCHEMA } from "../server/split.mjs";

const answer = { tasks: [{ key: "api", taskText: "Build API", acceptance: [], fileScope: [], dependsOn: [] }] };
const jsonResponse = (status, body) => ({ status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function fakeProviderServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const entry = { method: request.method, url: request.url, headers: request.headers, body: JSON.parse(body) };
    requests.push(entry);
    const result = await handler(entry, requests.length);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

const providerEnvelope = (name) => {
  if (name === "claude") return { content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 4 }, model: "claude-test" };
  if (name === "openai") return { output: [{ content: [{ type: "output_text", text: JSON.stringify(answer) }] }], usage: { input_tokens: 10, output_tokens: 4 }, model: "openai-test" };
  return { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 4 }, model: "deepseek-test" };
};

test("Claude, OpenAI, and DeepSeek use server-side credentials and normalize JSON/usage", async () => {
  const api = await fakeProviderServer((entry) => jsonResponse(200, providerEnvelope(entry.url.includes("messages") ? "claude" : entry.url.includes("responses") ? "openai" : "deepseek")));
  const env = {
    ANTHROPIC_API_KEY: "test-claude-secret", ANTHROPIC_MODEL: "claude-test",
    OPENAI_API_KEY: "test-openai-secret", OPENAI_MODEL: "openai-test",
    DEEPSEEK_API_KEY: "test-deepseek-secret", DEEPSEEK_MODEL: "deepseek-test",
  };
  const gateway = createProviderGateway({ env, endpoints: {
    claude: `${api.base}/v1/messages`, openai: `${api.base}/v1/responses`, deepseek: `${api.base}/chat/completions`,
  } });
  try {
    for (const name of ["claude", "openai", "deepseek"]) {
      const result = await gateway.get(name).complete({ system: "Return JSON.", input: { task: "split" }, schema: SPLIT_SCHEMA });
      assert.deepEqual(result.json, answer);
      assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4 });
      assert.equal(result.model, `${name}-test`);
    }
    assert.deepEqual(api.requests.map((request) => request.url), ["/v1/messages", "/v1/responses", "/chat/completions"]);
    assert.equal(api.requests[0].headers["x-api-key"], env.ANTHROPIC_API_KEY);
    assert.equal(api.requests[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(api.requests[1].headers.authorization, `Bearer ${env.OPENAI_API_KEY}`);
    assert.equal(api.requests[2].headers.authorization, `Bearer ${env.DEEPSEEK_API_KEY}`);
    assert.equal(api.requests[0].body.output_config.format.type, "json_schema");
    assert.equal(api.requests[1].body.text.format.strict, true);
    assert.equal(api.requests[2].body.response_format.type, "json_object");
    for (const request of api.requests) {
      const serialized = JSON.stringify(request.body);
      assert.equal(serialized.includes("test-claude-secret"), false);
      assert.equal(serialized.includes("test-openai-secret"), false);
      assert.equal(serialized.includes("test-deepseek-secret"), false);
    }
  } finally { await api.close(); }
});

test("DeepSeek is told the JSON structure in the prompt (its JSON mode does not know our schema)", async () => {
  const api = await fakeProviderServer(() => jsonResponse(200, providerEnvelope("deepseek")));
  const gateway = createProviderGateway({
    env: { DEEPSEEK_API_KEY: "test-deepseek-secret", DEEPSEEK_MODEL: "deepseek-test" }, endpoints: { deepseek: `${api.base}/chat/completions` }, retries: 0,
  });
  try {
    await gateway.get("deepseek").complete({ system: "请分析。", input: { requirement: "x" }, schema: SPLIT_SCHEMA });
    const body = api.requests[0].body;
    assert.equal(body.response_format.type, "json_object");
    assert.match(body.messages[0].content, /^请分析。/);
    assert.match(body.messages[0].content, /JSON Schema/);
    assert.match(body.messages[0].content, /"taskText"/, "the field names the answer must use are in the prompt");
    assert.match(body.messages[0].content, /"required":\["key","taskText","acceptance","fileScope","dependsOn"\]/, "every field is required, like for the other providers");
    assert.equal(JSON.stringify(body).includes("test-deepseek-secret"), false);
  } finally { await api.close(); }
});

test("provider gateway retries rate limits and never returns remote error bodies that may echo secrets", async () => {
  const api = await fakeProviderServer((_entry, attempt) => attempt === 1
    ? jsonResponse(429, { error: { message: "test-openai-secret should not leak" } })
    : jsonResponse(200, providerEnvelope("openai")));
  const gateway = createProviderGateway({
    env: { OPENAI_API_KEY: "test-openai-secret", OPENAI_MODEL: "openai-test" },
    endpoints: { openai: `${api.base}/v1/responses` }, retries: 1, timeoutMs: 1_000,
  });
  try {
    const result = await gateway.get("openai").complete({ system: "JSON", input: {}, schema: SPLIT_SCHEMA });
    assert.deepEqual(result.json, answer);
    assert.equal(api.requests.length, 2);
    await assert.rejects(() => gateway.get("claude").complete({ system: "JSON", input: {}, schema: SPLIT_SCHEMA }), (error) => {
      assert.equal(error.code, "AUTH");
      assert.equal(error.message.includes("test-openai-secret"), false);
      return true;
    });
  } finally { await api.close(); }
});

test("provider timeouts are classified without exposing credentials", async () => {
  const api = await fakeProviderServer(() => new Promise((resolve) => setTimeout(() => resolve(jsonResponse(200, providerEnvelope("deepseek"))), 100)));
  const gateway = createProviderGateway({
    env: { DEEPSEEK_API_KEY: "test-deepseek-secret", DEEPSEEK_MODEL: "deepseek-test" },
    endpoints: { deepseek: `${api.base}/chat/completions` }, timeoutMs: 5, retries: 0,
  });
  try {
    await assert.rejects(() => gateway.get("deepseek").complete({ system: "JSON", input: {}, schema: SPLIT_SCHEMA }), (error) => {
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.message.includes("test-deepseek-secret"), false);
      return true;
    });
  } finally { await api.close(); }
});

test("provider credentials are absent from split drafts, events, and database exports", async () => {
  const secret = "sk-test-secret-that-must-not-escape";
  const api = await fakeProviderServer(() => jsonResponse(200, providerEnvelope("openai")));
  const gateway = createProviderGateway({
    env: { OPENAI_API_KEY: secret, OPENAI_MODEL: "openai-test" },
    endpoints: { openai: `${api.base}/v1/responses` },
  });
  const db = openDatabase(":memory:");
  const workbench = createWorkbench(db);
  try {
    const requirement = workbench.createRequirement({ id: "REQ-SECRET", title: "Credential isolation" });
    const draft = await proposeSplit(workbench, requirement.id, gateway.get("openai"));
    assert.equal(draft.status, "draft");
    const serialized = JSON.stringify({ draft, events: workbench.listEvents(), export: workbench.exportAll() });
    assert.equal(serialized.includes(secret), false);
    assert.equal(JSON.stringify(api.requests[0].body).includes(secret), false);
    assert.equal(api.requests[0].headers.authorization, `Bearer ${secret}`);
  } finally { db.close(); await api.close(); }
});

test("provider output that echoes a credential is rejected before it can become a draft", async () => {
  const secret = "sk-test-secret-that-must-not-escape";
  const leakedAnswer = { tasks: [{ key: "bad", taskText: secret, acceptance: [], fileScope: [], dependsOn: [] }] };
  const api = await fakeProviderServer(() => jsonResponse(200, {
    output_text: JSON.stringify(leakedAnswer), usage: { input_tokens: secret, output_tokens: 4 }, model: secret,
  }));
  const gateway = createProviderGateway({
    env: { OPENAI_API_KEY: secret, OPENAI_MODEL: "openai-test" },
    endpoints: { openai: `${api.base}/v1/responses` },
  });
  try {
    await assert.rejects(() => gateway.get("openai").complete({ system: "JSON", input: {}, schema: SPLIT_SCHEMA }), (error) => {
      assert.equal(error.code, "BAD_RESPONSE");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  } finally { await api.close(); }
});

import { findSecrets, ProviderError } from "./provider.mjs";

const PROVIDERS = {
  claude: {
    keyEnv: "ANTHROPIC_API_KEY", modelEnv: "ANTHROPIC_MODEL", url: "https://api.anthropic.com/v1/messages",
  },
  openai: {
    keyEnv: "OPENAI_API_KEY", modelEnv: "OPENAI_MODEL", url: "https://api.openai.com/v1/responses",
  },
  deepseek: {
    keyEnv: "DEEPSEEK_API_KEY", modelEnv: "DEEPSEEK_MODEL", url: "https://api.deepseek.com/chat/completions",
  },
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal?.aborted) { clearTimeout(timer); reject(signal.reason || new Error("Aborted")); return; }
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("Aborted")); }, { once: true });
});

function strictSchema(schema) {
  const copy = structuredClone(schema);
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object" && node.properties && typeof node.properties === "object") {
      node.additionalProperties = false;
      node.required = Object.keys(node.properties);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(copy);
  return copy;
}

function extractText(provider, body) {
  if (provider === "claude") return body?.content?.find((part) => part.type === "text")?.text;
  if (provider === "openai") {
    return body?.output_text ?? body?.output?.flatMap((item) => item.content || []).find((part) => part.type === "output_text" || typeof part.text === "string")?.text;
  }
  return body?.choices?.[0]?.message?.content;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeUsage(provider, usage = {}) {
  if (provider === "claude" || provider === "openai") return { inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens) };
  return { inputTokens: tokenCount(usage.prompt_tokens), outputTokens: tokenCount(usage.completion_tokens) };
}

function providerError(provider, status) {
  if (status === 401 || status === 403) return new ProviderError("AUTH", `${provider} 认证失败，请检查服务端 API Key`, { status: 401 });
  if (status === 429) return new ProviderError("RATE_LIMIT", `${provider} 请求频率受限，请稍后重试`, { retryable: true, status: 429 });
  if (status >= 500) return new ProviderError("PROVIDER_ERROR", `${provider} 服务暂时不可用`, { retryable: true, status: 502 });
  return new ProviderError("PROVIDER_ERROR", `${provider} 请求未成功（HTTP ${status}）`, { status: 502 });
}

async function requestJson({ provider, url, headers, payload, fetchImpl, signal, timeoutMs, retries }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new ProviderError("TIMEOUT", "模型调用已取消", { status: 504, cause: signal.reason });
    const controller = new AbortController();
    let timedOut = false;
    const abortParent = () => controller.abort(signal.reason || new Error("Aborted"));
    signal?.addEventListener("abort", abortParent, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Timeout")); }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal,
      });
      if (!response.ok) {
        const error = providerError(provider, response.status);
        if (!error.retryable || attempt === retries) throw error;
        lastError = error;
      } else {
        try { return await response.json(); }
        catch (cause) { throw new ProviderError("BAD_RESPONSE", `${provider} 返回的响应不是有效 JSON`, { status: 502, cause }); }
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        if (!error.retryable || attempt === retries) throw error;
        lastError = error;
      } else if (timedOut) {
        lastError = new ProviderError("TIMEOUT", `${provider} 调用超时`, { retryable: true, status: 504, cause: error });
        if (attempt === retries) throw lastError;
      } else if (signal?.aborted) {
        throw new ProviderError("TIMEOUT", "模型调用已取消", { status: 504, cause: signal.reason });
      } else {
        lastError = new ProviderError("PROVIDER_ERROR", `${provider} 网络请求失败`, { retryable: true, status: 502, cause: error });
        if (attempt === retries) throw lastError;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortParent);
    }
    await sleep(Math.min(250 * (2 ** attempt), 1_000), signal);
  }
  throw lastError || new ProviderError("PROVIDER_ERROR", `${provider} 请求失败`);
}

/** Server-side provider adapters. Keys and model names are resolved only from this process environment. */
export function createProviderGateway({ env = process.env, fetchImpl = globalThis.fetch, endpoints = {}, timeoutMs = 30_000, retries = 2 } = {}) {
  const providers = {};
  for (const [name, config] of Object.entries(PROVIDERS)) {
    providers[name] = {
      name,
      model: env[config.modelEnv] || "",
      async complete({ system, input, schema, signal }) {
        const apiKey = env[config.keyEnv];
        const model = env[config.modelEnv];
        if (!apiKey) throw new ProviderError("AUTH", `服务端未配置 ${config.keyEnv}`, { status: 400 });
        if (!model) throw new ProviderError("AUTH", `服务端未配置 ${config.modelEnv}`, { status: 400 });
        const jsonSchema = strictSchema(schema);
        let url = endpoints[name] || config.url;
        let headers;
        let payload;
        if (name === "claude") {
          headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
          payload = {
            model, max_tokens: 4096, system,
            messages: [{ role: "user", content: JSON.stringify(input) }],
            output_config: { format: { type: "json_schema", schema: jsonSchema } },
          };
        } else if (name === "openai") {
          headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
          payload = {
            model, instructions: system, input: JSON.stringify(input), max_output_tokens: 4096,
            text: { format: { type: "json_schema", name: "requirements_split", schema: jsonSchema, strict: true } },
          };
        } else {
          headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
          payload = {
            model, max_tokens: 4096,
            messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }],
            response_format: { type: "json_object" },
          };
        }

        const response = await requestJson({ provider: name, url, headers, payload, fetchImpl, signal, timeoutMs, retries });
        const rawText = extractText(name, response);
        if (typeof rawText !== "string" || !rawText.trim()) throw new ProviderError("BAD_RESPONSE", `${name} 没有返回结构化文本`, { status: 502 });
        let json;
        try { json = JSON.parse(rawText); }
        catch (cause) { throw new ProviderError("BAD_RESPONSE", `${name} 返回的内容不是有效 JSON`, { status: 502, cause }); }
        if (findSecrets(JSON.stringify(json))) {
          throw new ProviderError("BAD_RESPONSE", `${name} 输出中检测到疑似密钥，已丢弃`, { status: 502 });
        }
        return { json, usage: normalizeUsage(name, response.usage), model };
      },
    };
  }
  return {
    providers,
    get(name) {
      const provider = providers[String(name || "").toLowerCase()];
      if (!provider) throw new ProviderError("PROVIDER_ERROR", `不支持的模型提供方：${String(name || "（空）")}`, { status: 400 });
      return provider;
    },
  };
}

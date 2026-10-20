import { WorkbenchError, invalid, nonEmpty } from "./util.mjs";

/**
 * Model provider contract (what the gateway implements for Claude / OpenAI / DeepSeek):
 *
 *   provider = {
 *     name:  "claude",                 // short, stable id recorded on drafts
 *     model: "claude-...",             // default model id
 *     async complete({ system, input, schema, signal }) -> { json, usage, model? }
 *   }
 *
 * - `input` is a plain object (the gateway serialises it); `schema` is a JSON Schema for `json`.
 * - `json` is the parsed model answer. `usage` is free-form (inputTokens, outputTokens, ...).
 * - Failures are thrown as ProviderError so the workbench can record and show them.
 * - API keys live inside the gateway (environment / OS credential store). They never appear in
 *   `system`, `input`, usage, drafts, events, exports or logs.
 */
export const PROVIDER_ERROR_CODES = ["TIMEOUT", "AUTH", "RATE_LIMIT", "BAD_RESPONSE", "PROVIDER_ERROR"];

/** A WorkbenchError, so an HTTP layer that maps `error.status` handles provider failures with no special case. */
export class ProviderError extends WorkbenchError {
  constructor(code, message, { retryable = false, status = 502, cause } = {}) {
    super(code, message, status);
    this.name = "ProviderError";
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

export function assertProvider(provider) {
  if (!provider || typeof provider.complete !== "function" || !nonEmpty(provider.name)) {
    throw invalid("模型提供方必须有 name 和 complete() 方法");
  }
}

const SECRET_PATTERNS = [
  ["API 密钥（sk-）", /sk-[A-Za-z0-9_-]{20,}/],
  ["AWS 访问密钥", /AKIA[0-9A-Z]{16}/],
  ["GitHub 令牌", /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ["Google API 密钥", /AIza[0-9A-Za-z_-]{35}/],
  ["Slack 令牌", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["私钥", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Looks for credentials in text about to leave the machine. Returns the kind only, never the secret itself. */
export function findSecrets(text) {
  const value = String(text ?? "");
  for (const [kind, pattern] of SECRET_PATTERNS) if (pattern.test(value)) return { kind };
  return null;
}

/**
 * A provider that replays scripted answers, for tests and for developing the UI without a key.
 * Each `replies` entry is consumed by one `complete()` call and may be:
 *   - an object            -> returned as `{ json: object, usage }`
 *   - an Error             -> thrown
 *   - a function(request)  -> its return value / thrown error / awaited promise
 * Every request is kept in `.calls`.
 */
export function createScriptedProvider({ name = "fake", model = "fake-model-1", replies = [] } = {}) {
  const queue = [...replies];
  const calls = [];
  return {
    name, model, calls,
    async complete(request) {
      calls.push(structuredClone({ system: request.system, input: request.input, schema: request.schema }));
      if (!queue.length) throw new ProviderError("PROVIDER_ERROR", "脚本化提供方没有更多回复");
      const reply = queue.shift();
      const value = typeof reply === "function" ? await reply(request) : reply;
      if (value instanceof Error) throw value;
      if (value && typeof value === "object" && "json" in value) return value;
      return { json: value, usage: { inputTokens: 100, outputTokens: 50 }, model };
    },
  };
}

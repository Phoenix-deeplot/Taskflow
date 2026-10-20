import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { invalid } from "./util.mjs";

/**
 * Keys and agents the person configures on the settings page.
 *
 * Secrets (API keys, tokens) live in ONE small file next to the database — never inside it — so database exports,
 * backups and VACUUM copies cannot carry them. They are never sent back to the page (only "configured" and the last
 * four characters), never written to events or logs, and only reach a Runner through its own lease (launch-config).
 * Everything that is not secret (the list of custom agents, model names) is ordinary data.
 */

/** Every credential the page can set. `env` is the variable the program reads it from. */
export const SLOTS = {
  "claude-code-token": { secret: true, env: "CLAUDE_CODE_OAUTH_TOKEN", label: "Claude Code 订阅令牌（在终端运行 claude setup-token 生成）" },
  "claude-code-api-key": { secret: true, env: "ANTHROPIC_API_KEY", label: "Claude Code 使用的 Anthropic API Key" },
  "anthropic-api-key": { secret: true, env: "ANTHROPIC_API_KEY", label: "Claude 接口 API Key（智能拆分）" },
  "anthropic-model": { secret: false, env: "ANTHROPIC_MODEL", label: "Claude 模型名" },
  "openai-api-key": { secret: true, env: "OPENAI_API_KEY", label: "OpenAI API Key（智能拆分）" },
  "openai-model": { secret: false, env: "OPENAI_MODEL", label: "OpenAI 模型名" },
  "deepseek-api-key": { secret: true, env: "DEEPSEEK_API_KEY", label: "DeepSeek API Key（智能拆分）" },
  "deepseek-model": { secret: false, env: "DEEPSEEK_MODEL", label: "DeepSeek 模型名" },
};
const PROVIDER_ENV_TO_SLOT = Object.fromEntries(Object.entries(SLOTS).filter(([slot]) => !slot.startsWith("claude-code")).map(([slot, def]) => [def.env, slot]));
const CUSTOM_SLOT = /^custom:[a-z][a-z0-9-]{0,23}$/;
const RESERVED_AGENT_IDS = new Set(["claude", "claude-code", "codex", "manual", "manual-handoff", "manual_handoff"]);
const FORBIDDEN_ENV = new Set(["PATH", "PATHEXT", "COMSPEC", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE", "TEMP", "TMP"]);

export const isKnownSlot = (slot) => Object.hasOwn(SLOTS, slot) || CUSTOM_SLOT.test(String(slot));
const isSecretSlot = (slot) => (Object.hasOwn(SLOTS, slot) ? SLOTS[slot].secret : true);

function cleanValue(slot, value) {
  if (typeof value !== "string") throw invalid("请填写内容");
  const text = value.trim();
  const secret = isSecretSlot(slot);
  if (!text) throw invalid("内容不能为空");
  if (text.length > (secret ? 500 : 100)) throw invalid(secret ? "密钥太长（最多 500 个字符）" : "模型名太长（最多 100 个字符）");
  // Tokens and model names never contain spaces or line breaks; refusing them catches a pasted command or a whole config file.
  if (/[\s\u0000-\u001f\u007f]/.test(text)) throw invalid(secret ? "密钥里不能有空格或换行，请只粘贴密钥本身" : "模型名里不能有空格或换行");
  return text;
}

/**
 * POSIX file modes mean nothing on Windows, where a data folder on a non-system drive is often readable by every local
 * account. Make the file this user's alone. The user is named by SID, never by name (a name can resolve to the wrong
 * principal and lock the owner out), and the result is checked: if the file can no longer be read, the change is undone.
 * Best effort — failing to tighten permissions must never lose or block a saved key.
 */
function restrictToCurrentUser(file) {
  try {
    const sid = /"(S-1-[\d-]+)"/.exec(execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 5000, windowsHide: true }))?.[1];
    if (!sid) return;
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: "ignore", timeout: 5000, windowsHide: true });
    readFileSync(file);
  } catch {
    try { execFileSync("icacls", [file, "/reset"], { stdio: "ignore", timeout: 5000, windowsHide: true }); } catch { /* nothing more to do */ }
  }
}

/** A small JSON file of `{ slot: value }`. Without a file path it lives in memory (tests). */
export function createSecretStore({ file } = {}) {
  let memory = {};
  const read = () => {
    if (!file) return memory;
    try { const parsed = JSON.parse(readFileSync(file, "utf8")); return parsed && typeof parsed.values === "object" && parsed.values ? parsed.values : {}; }
    catch { return {}; }
  };
  const write = (values) => {
    if (!file) { memory = values; return; }
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify({ version: 1, values }, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    // Every save replaces the file, and a replacement inherits the folder's permissions again, so tighten each time.
    if (process.platform === "win32") restrictToCurrentUser(file);
  };
  const store = {
    get(slot) { const value = read()[slot]; return typeof value === "string" && value ? value : null; },
    has(slot) { return store.get(slot) !== null; },
    set(slot, value) {
      if (!isKnownSlot(slot)) throw invalid(`未知的设置项：${slot}`);
      write({ ...read(), [slot]: cleanValue(slot, value) });
    },
    clear(slot) {
      if (!isKnownSlot(slot)) throw invalid(`未知的设置项：${slot}`);
      const values = { ...read() };
      if (slot in values) { delete values[slot]; write(values); }
    },
    /** What the page may see: whether each slot is set, and for a key only its last four characters. Never the key. */
    describe() {
      const values = read();
      const result = {};
      const slots = [...Object.keys(SLOTS), ...Object.keys(values).filter((slot) => CUSTOM_SLOT.test(slot))];
      for (const slot of slots) {
        const value = typeof values[slot] === "string" ? values[slot] : "";
        const secret = isSecretSlot(slot);
        result[slot] = {
          configured: Boolean(value), secret, label: SLOTS[slot]?.label || "",
          ...(secret ? { hint: value.length >= 12 ? `…${value.slice(-4)}` : "" } : { value }),
        };
      }
      return result;
    },
  };
  return store;
}

/** `process.env`, except that a key or model set on the settings page wins. Handed to the model-provider gateway. */
export function providerEnvironment(store, base = process.env) {
  return new Proxy(base, {
    get(target, name) {
      const slot = typeof name === "string" ? PROVIDER_ENV_TO_SLOT[name] : undefined;
      return (slot && store.get(slot)) || target[name];
    },
  });
}

// ---------- custom agents ----------

/** Validates the list of agents the person added. Throws a readable error naming the first problem. */
export function normalizeCustomAgents(list) {
  if (!Array.isArray(list)) throw invalid("自定义 Agent 必须是一个列表");
  if (list.length > 10) throw invalid("最多添加 10 个自定义 Agent");
  const seen = new Set();
  return list.map((raw, index) => {
    const where = `第 ${index + 1} 个 Agent`;
    if (!raw || typeof raw !== "object") throw invalid(`${where}格式不对`);
    const id = String(raw.id ?? "").trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) throw invalid(`${where}的标识只能用小写字母、数字和短横线，并以字母开头（最多 24 个字符）`);
    if (RESERVED_AGENT_IDS.has(id)) throw invalid(`${where}的标识“${id}”已被内置功能占用`);
    if (seen.has(id)) throw invalid(`标识“${id}”重复了`);
    seen.add(id);
    const name = String(raw.name ?? "").trim() || id;
    if (name.length > 40) throw invalid(`${where}的名称不能超过 40 个字符`);
    const command = String(raw.command ?? "").trim();
    if (!command || command.length > 300 || /[\u0000\r\n]/.test(command)) throw invalid(`${where}的命令不能为空，且不能超过 300 个字符、不能换行`);
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.length > 20 || args.some((arg) => typeof arg !== "string" || arg.length > 300 || arg.includes("\0"))) {
      throw invalid(`${where}的参数必须是不超过 20 项的文本列表，每项不超过 300 个字符`);
    }
    const secretEnv = String(raw.secretEnv ?? "").trim();
    if (secretEnv && (!/^[A-Z][A-Z0-9_]{0,63}$/.test(secretEnv) || FORBIDDEN_ENV.has(secretEnv))) {
      throw invalid(`${where}的密钥环境变量名只能是大写字母、数字和下划线（例如 OPENAI_API_KEY），不能是系统变量`);
    }
    return { id, name, command, args, secretEnv };
  });
}

/** The environment variables a given executor needs on top of the Runner's own. Nothing for an executor with no credentials. */
export function environmentForExecutor(executorType, store, customAgents = []) {
  if (executorType === "claude" || executorType === "claude-code") {
    const token = store.get("claude-code-token");
    if (token) return { CLAUDE_CODE_OAUTH_TOKEN: token };
    const key = store.get("claude-code-api-key");
    return key ? { ANTHROPIC_API_KEY: key } : {};
  }
  if (String(executorType).startsWith("custom:")) {
    const agent = customAgents.find((entry) => `custom:${entry.id}` === executorType);
    const secret = agent?.secretEnv ? store.get(`custom:${agent.id}`) : null;
    return secret ? { [agent.secretEnv]: secret } : {};
  }
  return {};
}

/** What a Runner needs to start one run: extra environment, and (for a custom agent) how to launch it. */
export function launchConfigFor(executorType, store, customAgents = []) {
  const custom = String(executorType).startsWith("custom:") ? customAgents.find((entry) => `custom:${entry.id}` === executorType) : null;
  return {
    env: environmentForExecutor(executorType, store, customAgents),
    custom: custom ? { id: custom.id, name: custom.name, command: custom.command, args: custom.args } : null,
  };
}

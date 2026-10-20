import { createHash } from "node:crypto";
import { assertProvider, findSecrets, ProviderError } from "./provider.mjs";
import { isUnsafeScope } from "./file-scope.mjs";
import { WorkbenchError, canonicalJson, invalid, nonEmpty } from "./util.mjs";

export const SPLIT_TEMPLATE_VERSION = "split-v1";
export const MAX_SPLIT_TASKS = 50;

/** JSON Schema handed to the provider; the answer is validated again locally, never trusted as-is. */
export const SPLIT_SCHEMA = {
  type: "object",
  required: ["tasks"],
  additionalProperties: false,
  properties: {
    notes: { type: "string", description: "对拆分思路的简短说明，可为空" },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["key", "taskText", "acceptance"],
        additionalProperties: false,
        properties: {
          key: { type: "string", description: "本次拆分内唯一的短标识，如 design、api" },
          taskText: { type: "string", description: "任务说明：做什么、不做什么" },
          acceptance: { type: "array", items: { type: "string" }, description: "可检验的验收标准，每条能判断通过与否" },
          fileScope: { type: "array", items: { type: "string" }, description: "预计涉及的相对路径或目录，不确定就留空" },
          dependsOn: { type: "array", items: { type: "string" }, description: "必须先完成的任务的 key" },
        },
      },
    },
  },
};

const text = (value, label, max, { required = false } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${label}不能为空`);
    return "";
  }
  if (typeof value !== "string") throw invalid(`${label}必须是文本`);
  const trimmed = value.trim();
  if (required && !trimmed) throw invalid(`${label}不能为空`);
  if (trimmed.length > max) throw invalid(`${label}超过 ${max} 字`);
  return trimmed;
};

const list = (value, label, { max, itemMax }) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw invalid(`${label}必须是字符串数组`);
  const cleaned = value.map((entry) => entry.trim()).filter(Boolean);
  if (cleaned.length > max) throw invalid(`${label}最多 ${max} 条`);
  if (cleaned.some((entry) => entry.length > itemMax)) throw invalid(`${label}中有超过 ${itemMax} 字的条目`);
  return cleaned;
};

/**
 * Validates and cleans proposed tasks (from a person or a model). Unknown fields are dropped.
 * Rejects: empty or oversized lists, duplicate keys, unknown or self dependencies, dependency cycles,
 * and file scopes that point outside the repository.
 */
export function normalizeSplitTasks(raw, { defaultStatus = "queued", maxTasks = MAX_SPLIT_TASKS } = {}) {
  if (!Array.isArray(raw) || !raw.length) throw invalid("拆分结果至少需要一条任务");
  if (raw.length > maxTasks) throw invalid(`一次最多 ${maxTasks} 条任务，收到 ${raw.length} 条`);
  const tasks = raw.map((item, index) => {
    const where = `第 ${index + 1} 条任务`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid(`${where}不是对象`);
    const status = item.status ?? defaultStatus;
    if (!["clarification", "queued"].includes(status)) throw invalid(`${where}的状态只能是 clarification 或 queued`);
    const fileScope = list(item.fileScope, `${where}的文件范围`, { max: 50, itemMax: 300 });
    const unsafe = fileScope.find(isUnsafeScope);
    if (unsafe) throw invalid(`${where}的文件范围“${unsafe}”不在仓库内（不允许绝对路径或 ..）`);
    return {
      key: nonEmpty(item.key) ? text(item.key, `${where}的 key`, 80, { required: true }) : `#${index + 1}`,
      taskText: text(item.taskText, `${where}的任务说明`, 4000, { required: true }),
      acceptance: list(item.acceptance, `${where}的验收标准`, { max: 20, itemMax: 500 }),
      fileScope,
      dependsOn: list(item.dependsOn, `${where}的依赖`, { max: 20, itemMax: 80 }),
      provider: text(item.provider, `${where}的模型`, 100),
      assignee: text(item.assignee, `${where}的执行人`, 100),
      status,
    };
  });

  const keys = tasks.map((task) => task.key);
  if (new Set(keys).size !== keys.length) throw invalid("拆分任务的 key 不能重复");
  tasks.forEach((task) => {
    for (const dep of task.dependsOn) {
      if (dep === task.key) throw invalid(`任务 ${task.key} 不能依赖自己`);
      if (!keys.includes(dep)) throw invalid(`任务 ${task.key} 依赖了不存在的 key：${dep}`);
    }
  });
  // Kahn's algorithm: whatever is left after peeling off tasks with no open dependencies is a cycle.
  const open = new Map(tasks.map((task) => [task.key, new Set(task.dependsOn)]));
  let progressed = true;
  while (open.size && progressed) {
    progressed = false;
    for (const [key, deps] of open) {
      if (!deps.size) {
        open.delete(key);
        for (const other of open.values()) other.delete(key);
        progressed = true;
      }
    }
  }
  if (open.size) throw invalid(`拆分任务存在循环依赖：${[...open.keys()].join("、")}`);
  return tasks;
}

const clip = (value, max) => (String(value ?? "").length > max ? `${String(value).slice(0, max)}…` : String(value ?? ""));

/** Everything the provider is allowed to see, in a stable shape (and its hash, stored with the draft). */
export function buildSplitRequest({ context, requirement, existingTasks = [], maxTasks = 12 }) {
  const rules = context?.rules ?? {};
  const input = {
    requirement: {
      id: requirement.id, title: requirement.title, module: requirement.module, description: requirement.description,
      targetVersion: requirement.targetVersion, decision: requirement.decision, decisionNote: requirement.decisionNote,
    },
    globalContext: { rules: rules.rules ?? [], constraints: rules.constraints ?? [], glossary: rules.glossary ?? [] },
    existingTasks: existingTasks.map((task) => ({ id: task.id, status: task.status, taskText: clip(task.taskText, 200) })),
    limits: { maxTasks },
  };
  const system = [
    "你是需求拆分助手。把给定的一条需求拆成若干可以独立交付、独立验收的任务。",
    `要求：最多 ${maxTasks} 条；每条任务写清楚做什么、不做什么；验收标准必须能判断“通过/不通过”；`,
    "依赖只写本次拆分里其他任务的 key；不要拆出需求以外的范围；已有任务（existingTasks）不要重复拆；",
    "文件范围只写仓库内的相对路径，不确定就留空；不要输出任何密钥、令牌或账号信息。",
    "只输出符合给定 JSON Schema 的 JSON，不要附加其他文字。",
  ].join("\n");
  return {
    templateVersion: SPLIT_TEMPLATE_VERSION,
    system, input, schema: SPLIT_SCHEMA,
    inputHash: createHash("sha256").update(canonicalJson({ system, input })).digest("hex"),
  };
}

function withTimeout(promise, ms, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError("TIMEOUT", `模型在 ${Math.round(ms / 1000)} 秒内没有返回`, { retryable: true, status: 504 }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Asks a provider to propose a split and stores the answer as a DRAFT. Nothing becomes a real task
 * until `confirmSplitDraft`. Anything that goes wrong is recorded as an event and thrown; no draft is kept.
 */
export async function proposeSplit(workbench, requirementId, provider, { maxTasks = 12, timeoutMs = 60000 } = {}) {
  assertProvider(provider);
  const requirement = workbench.getRequirement(requirementId);
  if (requirement.deletedAt) throw new WorkbenchError("CONFLICT", `需求 ${requirementId} 已删除，不能拆分`, 409);
  const request = buildSplitRequest({
    context: workbench.getContext(), requirement, existingTasks: workbench.listTasks({ requirementId }), maxTasks,
  });

  const leak = findSecrets(`${request.system}\n${JSON.stringify(request.input)}`);
  if (leak) {
    workbench.recordSplitFailure(requirementId, { provider: provider.name, model: provider.model ?? "", code: "SECRET_IN_INPUT", message: `疑似包含${leak.kind}` });
    throw new WorkbenchError("SECRET_IN_INPUT", `需求或全局上下文里疑似包含${leak.kind}，已拒绝发送给模型。请先删掉再试。`, 400);
  }

  const fail = (error, code) => {
    workbench.recordSplitFailure(requirementId, { provider: provider.name, model: provider.model ?? "", code, message: String(error.message).slice(0, 500) });
    return error;
  };

  const controller = new AbortController();
  let response;
  try {
    response = await withTimeout(
      Promise.resolve(provider.complete({ system: request.system, input: request.input, schema: request.schema, signal: controller.signal })),
      timeoutMs, controller,
    );
  } catch (error) {
    const wrapped = error instanceof ProviderError ? error : new ProviderError("PROVIDER_ERROR", `模型调用失败：${error.message}`, { cause: error });
    throw fail(wrapped, wrapped.code);
  }

  let tasks;
  try {
    const json = response?.json;
    if (!json || typeof json !== "object" || !Array.isArray(json.tasks)) throw invalid("模型返回的内容里没有 tasks 数组");
    tasks = normalizeSplitTasks(json.tasks, { defaultStatus: "clarification", maxTasks });
  } catch (error) {
    throw fail(new ProviderError("BAD_RESPONSE", `模型返回的拆分结果不合格：${error.message}`, { status: 502 }), "BAD_RESPONSE");
  }

  return workbench.createSplitDraft(requirementId, {
    tasks, provider: provider.name, model: response.model || provider.model || "", usage: response.usage ?? {},
    input: request.input, inputHash: request.inputHash, promptTemplateVersion: request.templateVersion,
    requirementRevision: requirement.revision,
  });
}

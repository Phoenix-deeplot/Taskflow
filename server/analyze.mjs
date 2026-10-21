import { createHash } from "node:crypto";
import { assertProvider, findSecrets, ProviderError } from "./provider.mjs";
import { withTimeout } from "./split.mjs";
import { WorkbenchError, canonicalJson } from "./util.mjs";

export const MODEL_ANALYSIS_TEMPLATE_VERSION = "model-analysis-v1";

/** What the model must answer. Validated again locally (never trusted as-is). */
export const ANALYSIS_RESULT_SCHEMA = {
  type: "object",
  required: ["conclusion", "userValue", "complexity", "risks", "v1Scope", "openQuestions", "needsSplit", "refinedTaskText", "acceptance"],
  additionalProperties: false,
  properties: {
    conclusion: { type: "string", description: "明确结论：做 / 不做 / 改后做，加一两句理由" },
    userValue: { type: "string", description: "用户价值：谁会用、解决什么、不做会怎样" },
    complexity: { type: "string", description: "实现复杂度（低/中/高）和主要工作量来自哪里，要结合给出的项目现状" },
    risks: { type: "array", items: { type: "string" }, description: "关键风险与依赖，每条具体" },
    v1Scope: { type: "string", description: "建议的 V1 范围：做什么、明确不做什么" },
    openQuestions: { type: "array", items: { type: "string" }, description: "需要人确认的问题；没有就留空" },
    needsSplit: {
      type: "object",
      required: ["value", "reason"],
      additionalProperties: false,
      properties: {
        value: { type: "boolean", description: "是否需要拆成多个任务才能交付和验收" },
        reason: { type: "string", description: "判断依据；多数需求一个任务就够" },
      },
    },
    refinedTaskText: { type: "string", description: "细化后的任务说明：做什么、不做什么、涉及哪些位置，能直接交给执行 Agent" },
    acceptance: { type: "array", items: { type: "string" }, description: "可检验的验收标准，每条能判断通过与否" },
  },
};

const clip = (value, max) => (String(value ?? "").length > max ? `${String(value).slice(0, max)}…` : String(value ?? ""));

/** Everything the model is allowed to see about the requirement and its surroundings. */
export function buildAnalysisRequest({ context, requirement, siblings = [], tasks = [], project = null }) {
  const rules = context?.rules ?? {};
  const input = {
    requirement: {
      id: requirement.id, title: requirement.title, module: requirement.module, description: requirement.description,
      targetVersion: requirement.targetVersion, decision: requirement.decision, decisionNote: requirement.decisionNote,
    },
    globalContext: { rules: rules.rules ?? [], constraints: rules.constraints ?? [], glossary: rules.glossary ?? [] },
    sameModuleRequirements: siblings.map((item) => ({ title: clip(item.title, 80), decision: item.decision, targetVersion: item.targetVersion })),
    existingTasks: tasks.map((task) => ({ status: task.status, kind: task.kind, taskText: clip(task.taskText, 200), result: clip(task.result, 300) })),
    ...(project ? { project } : {}),
  };
  const system = [
    "你是产品需求分析助手，要对给定的一条需求给出具体、直接、可执行的结论。",
    "依据只能来自 input：需求本身、全局上下文、同模块的其他需求、已有任务和（如果有）项目概况（README、目录结构、脚本）。",
    "不要泛泛而谈；涉及实现时指出项目里具体的位置或模块；input 里没有的信息就写进“需要确认的问题”，不要编造文件或事实。",
    "needsSplit：多数需求一个任务就够；只有当它包含多个可独立交付、独立验收的部分，或工作量明显超出一次执行时才选“需要”，并写明依据。",
    "refinedTaskText 要能直接交给执行 Agent：写清做什么、不做什么、涉及哪里。",
    "不要输出任何密钥、令牌或账号信息。只输出符合给定 JSON Schema 的 JSON，不要附加其他文字。",
  ].join("\n");
  return {
    templateVersion: MODEL_ANALYSIS_TEMPLATE_VERSION, system, input, schema: ANALYSIS_RESULT_SCHEMA,
    inputHash: createHash("sha256").update(canonicalJson({ system, input })).digest("hex"),
  };
}

const textField = (value, label, { required = false } = {}) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error(`缺少“${label}”`);
  return text;
};
const listField = (value, max = 20) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()).slice(0, max) : []);

/** Cleans the model's answer into the shape the page and the review step rely on. */
export function normalizeAnalysisResult(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("返回的不是对象");
  const needs = json.needsSplit && typeof json.needsSplit === "object" ? json.needsSplit : {};
  return {
    conclusion: textField(json.conclusion, "结论", { required: true }),
    userValue: textField(json.userValue, "用户价值"),
    complexity: textField(json.complexity, "实现复杂度"),
    risks: listField(json.risks),
    v1Scope: textField(json.v1Scope, "建议的 V1 范围"),
    openQuestions: listField(json.openQuestions),
    needsSplit: { value: needs.value === true, reason: textField(needs.reason, "拆分判断") },
    refinedTaskText: textField(json.refinedTaskText, "细化后的任务说明", { required: true }),
    acceptance: listField(json.acceptance),
  };
}

/** The text a person reads and edits. Uses the six headings of the built-in analysis format, then the extras. */
export function renderAnalysisText(result) {
  const bullets = (items) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "- 暂无");
  return [
    `结论\n${result.conclusion}`,
    `用户价值\n${result.userValue || "（模型未说明）"}`,
    `实现复杂度\n${result.complexity || "（模型未说明）"}`,
    `关键风险与依赖\n${bullets(result.risks)}`,
    `建议的 V1 范围\n${result.v1Scope || "（模型未说明）"}`,
    `需要我确认的问题\n${bullets(result.openQuestions)}`,
    `是否需要拆分\n${result.needsSplit.value ? "需要" : "不需要"}：${result.needsSplit.reason || "（模型未说明）"}`,
    `细化后的任务说明\n${result.refinedTaskText}`,
    `验收标准\n${bullets(result.acceptance)}`,
  ].join("\n\n");
}

/** Gathers what the model gets to see, calls it, validates the answer. Returns `{ text, structured, usage, model, inputHash, provider }`. */
export async function analyzeWithModel(workbench, requirementId, provider, { project = null, timeoutMs = 90_000 } = {}) {
  assertProvider(provider);
  const requirement = workbench.getRequirement(requirementId);
  if (requirement.deletedAt) throw new WorkbenchError("CONFLICT", `需求 ${requirementId} 已删除，不能分析`, 409);
  const siblings = workbench.listRequirements({}).filter((item) => item.module === requirement.module && item.id !== requirement.id).slice(0, 12);
  const tasks = workbench.listTasks({ requirementId }).slice(0, 12).map((task) => {
    const detail = workbench.getTask(task.id);
    const latest = detail.runs.slice().reverse().find((run) => run.resultSummary);
    return { ...task, result: latest?.resultSummary ?? "" };
  });
  const request = buildAnalysisRequest({ context: workbench.getContext(), requirement, siblings, tasks, project });

  const leak = findSecrets(`${request.system}\n${JSON.stringify(request.input)}`);
  if (leak) {
    workbench.recordAnalysisFailure(requirementId, { provider: provider.name, model: provider.model ?? "", code: "SECRET_IN_INPUT", message: `疑似包含${leak.kind}` });
    throw new WorkbenchError("SECRET_IN_INPUT", `需求、全局上下文或项目概况里疑似包含${leak.kind}，已拒绝发送给模型。请先删掉再试。`, 400);
  }
  const fail = (error, code) => {
    workbench.recordAnalysisFailure(requirementId, { provider: provider.name, model: provider.model ?? "", code, message: String(error.message).slice(0, 500) });
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

  let structured;
  try { structured = normalizeAnalysisResult(response?.json); }
  catch (error) { throw fail(new ProviderError("BAD_RESPONSE", `模型返回的分析不合格：${error.message}`, { status: 502 }), "BAD_RESPONSE"); }
  return {
    text: renderAnalysisText(structured), structured, usage: response.usage ?? {}, model: response.model || provider.model || "",
    inputHash: request.inputHash, provider: provider.name,
  };
}

import { canonicalJson, sha256 } from "./util.mjs";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const PROMPT_TEMPLATE_VERSION = "task-exec-v1";
export const ANALYSIS_PROMPT_VERSION = "task-analysis-v1";

function list(items, empty) {
  return items.length ? items.map((item, index) => `${index + 1}. ${item}`).join("\n") : empty;
}

export function renderPrompt(payload) {
  const { requirement, task, dependencies, workspace } = payload;
  const rules = Array.isArray(workspace.rules?.rules) ? workspace.rules.rules : [];
  const constraints = Array.isArray(workspace.rules?.constraints) ? workspace.rules.constraints : [];
  const analysis = task.kind === "analysis";
  const sections = [
    analysis
      ? "你是本任务的分析 Agent。只做只读分析：不要创建、修改或删除任何文件，不要运行会改变状态的命令。遇到缺失信息先说明，不要自行假设。"
      : "你是本任务的执行 Agent。只处理本任务范围；遇到缺失信息、冲突或超出范围的改动先说明，不要擅自扩大。",
  ];
  if (rules.length || constraints.length) {
    sections.push(`全局规则：\n${list([...rules, ...constraints].map(String), "（无）")}`);
  }
  sections.push([
    `需求：${requirement?.title || "未关联需求"}`,
    `模块：${requirement?.module || "未分类"}`,
    `目标版本：${requirement?.target_version || "未指定"}`,
    `需求说明：${requirement?.description || "暂无"}`,
    `当前决策：${requirement?.decision || "未指定"}`,
    `执行人：${task.assignee || task.provider || "未分配"}`,
  ].join("\n"));
  sections.push(`本任务：\n${task.task_text || "请先分析需求并提出可执行步骤。"}`);
  sections.push(`验收标准：\n${list(task.acceptance, "（未填写，请在结果中说明你如何判断完成）")}`);
  if (task.file_scope.length) sections.push(`文件范围：\n${list(task.file_scope, "")}`);
  if (dependencies.length) {
    sections.push(`依赖任务：\n${dependencies.map((dep) => `- ${dep.id}（${dep.status}）${dep.result_summary ? `：${dep.result_summary}` : ""}`).join("\n")}`);
  }
  if (payload.override_reason) sections.push(`注意：本次启动越过了就绪检查，原因：${payload.override_reason}`);
  sections.push(analysis
    ? "请直接输出分析结论，格式按任务说明；不要附加过程说明。若有验收标准，逐条回应。"
    : "完成时请返回：实际完成内容、涉及文件/产物、执行过的检查及结果、未解决问题。若有验收标准，逐条给出证据。");
  return sections.join("\n\n");
}

/** Pure function: builds the immutable snapshot record for a task start. */
export function buildSnapshot({ workspace, requirement, task, dependencies, overrideReason }) {
  const payload = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    prompt_template_version: task?.kind === "analysis" ? ANALYSIS_PROMPT_VERSION : PROMPT_TEMPLATE_VERSION,
    workspace,
    requirement,
    task,
    dependencies,
    override_reason: overrideReason || "",
  };
  const payloadJson = canonicalJson(payload);
  return { payload, payloadJson, payloadHash: sha256(payloadJson), promptText: renderPrompt(payload) };
}

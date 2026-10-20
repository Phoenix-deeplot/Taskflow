export const ANALYSIS_TEMPLATE_VERSION = "analysis-v1";
export const MAX_ANALYSIS_TEXT = 20000;

/** Built-in analysis template (editable per task in the assign dialog). */
export const DEFAULT_ANALYSIS_TEMPLATE = [
  "请从用户价值、实现复杂度、依赖风险和验证方式四个方面分析下面的需求，并给出明确建议。",
  "只做分析，不要修改任何文件。",
  "请按「结论 / 用户价值 / 实现复杂度 / 关键风险与依赖 / 建议的 V1 范围 / 需要我确认的问题」输出，用简洁要点。",
  "不要把建议直接视为产品决策。",
].join("\n");

export const ANALYSIS_ACCEPTANCE = [
  "给出明确结论（做 / 不做 / 改后做）",
  "覆盖用户价值、实现复杂度、关键风险与依赖、建议的 V1 范围",
  "列出需要我确认的问题",
];

// [key to look for, label shown when missing]; spaces are ignored when matching.
const ANALYSIS_SECTIONS = [
  ["结论", "结论"], ["用户价值", "用户价值"], ["实现复杂度", "实现复杂度"],
  ["风险", "关键风险与依赖"], ["V1范围", "建议的 V1 范围"], ["确认", "需要我确认的问题"],
];

/**
 * Soft check of an analysis answer against the built-in format. Returns null when the task did not use the
 * built-in template (a custom template asks for something else, so there is nothing to compare against).
 * It never blocks a result: the reviewer sees the outcome next to the answer.
 */
export function checkAnalysisResult(summary, taskText) {
  if (!String(taskText ?? "").includes(DEFAULT_ANALYSIS_TEMPLATE)) return null;
  const flat = String(summary ?? "").replace(/\s+/g, "");
  const missing = ANALYSIS_SECTIONS.filter(([key]) => !flat.includes(key)).map(([, label]) => label);
  return { passed: missing.length === 0, missing };
}

/** "Template + requirement details", the text a person would otherwise paste together by hand. */
export function renderAnalysisTaskText({ template, requirement }) {
  const body = (typeof template === "string" && template.trim() ? template.trim() : DEFAULT_ANALYSIS_TEMPLATE);
  const lines = [
    "—— 需求 ——",
    `需求：${requirement.title}`,
    `模块：${requirement.module || "未分类"}`,
    `目标版本：${requirement.targetVersion}`,
    `当前决策：${requirement.decision}${requirement.decisionNote ? `（${requirement.decisionNote}）` : ""}`,
    `说明：${requirement.description || "暂无"}`,
  ];
  return `${body}\n\n${lines.join("\n")}`;
}

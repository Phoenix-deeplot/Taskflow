import { all, one } from "./db.mjs";
import { normalizeCustomAgents } from "./agent-config.mjs";
import { ANALYSIS_ACCEPTANCE, DEFAULT_ANALYSIS_TEMPLATE, MAX_ANALYSIS_TEXT, renderAnalysisTaskText } from "./analysis.mjs";
import { TASK_STATUSES } from "./state-machine.mjs";
import { workspaceContract } from "./workspace.mjs";
import { WorkbenchError, conflict, invalid, nonEmpty, notFound, parseJson } from "./util.mjs";

const SETTING_RULES = {
  "project.path": (value) => {
    if (typeof value !== "string" || !value.trim() || value.length > 500 || value.includes("\0")) {
      throw invalid("项目目录必须是不超过 500 字的路径");
    }
    return value.trim();
  },
  // Agents the person added on the settings page (their commands only; credentials are kept elsewhere).
  "agents.custom": (value) => normalizeCustomAgents(value),
};

const clip = (text, max) => (String(text ?? "").length > max ? `${String(text).slice(0, max)}…` : String(text ?? ""));
const LOG_TAIL_CHARS = 8000;
const SLOW_HEARTBEAT_SECONDS = 30;

/** Plain-language line for the run timeline. */
function describeEvent(event) {
  const p = event.payload ?? {};
  switch (event.eventType) {
    case "run.dispatched": return "已派发，等待 Runner 领取";
    case "run.started": return "已手动启动";
    case "run.claimed": return `Runner ${p.runnerId ?? ""} 已领取`.trim();
    case "run.progress": return p.type === "log" ? `日志：${clip(p.message, 120)}` : (p.data?.step ? `${p.data.step}${p.message ? `：${p.message}` : ""}` : (p.message || "进度更新"));
    case "run.succeeded": return "已提交结果";
    case "run.failed": return `执行失败：${clip(p.message, 160)}`;
    case "run.worker_lost": return "Runner 失联，租约过期，已回收";
    case "run.cancel_requested": return `已请求取消：${p.reason ?? ""}`;
    case "run.cancelled": return `已取消：${p.reason ?? ""}`;
    case "artifact.added": return `新增产物：${p.kind ?? ""}`;
    case "task.transition": return `任务 ${p.from ?? ""} → ${p.to ?? ""}`;
    default: return event.eventType;
  }
}

/**
 * Analysis tasks, batch dispatch, small settings and the run-detail read model.
 * `kit` is the shared toolbox created inside createWorkbench.
 */
export function createBatchOps(kit) {
  const { db, tx, emit, clock, workspaceId, requireRunRow, requireTaskRow, requireRequirementRow, toRun, toTask, toEvent, toRequirement, createTask, dispatchTask, listArtifacts, startTask, submitResult, acceptTask } = kit;

  // ---------- analysis tasks ----------
  function createAnalysisTask(requirementId, { template, executorType, provider = "", assignee = "" } = {}) {
    return tx(() => {
      const row = requireRequirementRow(requirementId);
      if (row.deleted_at) throw conflict(`需求 ${requirementId} 已删除，不能再分配任务`);
      const taskText = renderAnalysisTaskText({ template, requirement: toRequirement(row) });
      if (taskText.length > MAX_ANALYSIS_TEXT) throw invalid(`任务说明太长（最多 ${MAX_ANALYSIS_TEXT} 字）`);
      return createTask({
        requirementId, kind: "analysis", taskText, acceptance: ANALYSIS_ACCEPTANCE, provider, assignee,
        executorType: executorType ?? "manual_handoff",
      });
    });
  }

  /**
   * A model's analysis, recorded the same way an Agent's is: an analysis task with a finished run waiting for a person
   * to confirm it. (The model call itself happens outside the database; this only stores its answer.)
   */
  function recordModelAnalysis(requirementId, { provider, model = "", usage = {}, inputHash = "", summary, structured } = {}) {
    if (!nonEmpty(provider)) throw invalid("需要模型提供方的名称");
    if (!nonEmpty(summary)) throw invalid("分析结果不能为空");
    return tx(() => {
      const task = createAnalysisTask(requirementId, { executorType: `model:${provider}`, provider, assignee: `${provider} 模型` });
      const started = startTask(task.id);
      const submitted = submitResult(started.run.id, {
        summary,
        evidence: [
          { kind: "model", name: `${provider}${model ? ` · ${model}` : ""}`, ref: inputHash, usage },
          ...(structured ? [{ kind: "analysis-json", name: "结构化分析", data: structured }] : []),
        ],
      });
      emit("task", task.id, "analysis.model_recorded", { provider, model, usage, inputHash }, started.run.id);
      return { task: submitted.task, run: submitted.run };
    });
  }

  /** A failed model call leaves a trace, so the history explains why there is no analysis. */
  function recordAnalysisFailure(requirementId, { provider = "", model = "", code = "PROVIDER_ERROR", message = "" } = {}) {
    return tx(() => {
      requireRequirementRow(requirementId);
      emit("requirement", requirementId, "analysis.model_failed", { provider, model, code, message });
    });
  }

  /**
   * The step after a person has read an analysis: confirm it (the analysis task is accepted) and create the task that
   * carries out what was agreed, with the (possibly edited) text. Dispatching it is a separate, ordinary call.
   */
  function assignFromAnalysis(analysisTaskId, { taskText, acceptance, executorType, provider = "", assignee = "", note = "" } = {}) {
    if (!nonEmpty(taskText)) throw invalid("请填写要分配的任务说明");
    if (taskText.length > MAX_ANALYSIS_TEXT) throw invalid(`任务说明太长（最多 ${MAX_ANALYSIS_TEXT} 字）`);
    return tx(() => {
      const analysis = requireTaskRow(analysisTaskId);
      if (analysis.kind !== "analysis") throw invalid("只能从分析任务确认并分配");
      if (analysis.status !== "review") throw conflict(`分析任务的状态是“${analysis.status}”，只有“待验收”的分析可以确认`);
      if (!analysis.requirement_id) throw invalid("这条分析没有关联需求");
      if (requireRequirementRow(analysis.requirement_id).deleted_at) throw conflict("需求已删除，不能再分配");
      const accepted = acceptTask(analysisTaskId, { note: nonEmpty(note) ? note : "分析已确认，按此分配" });
      const task = createTask({
        requirementId: analysis.requirement_id, kind: "execution", taskText: taskText.trim(),
        acceptance: Array.isArray(acceptance) && acceptance.length ? acceptance : ["说明实际完成内容、关键依据和未解决问题"],
        provider, assignee, executorType: executorType ?? "manual_handoff",
      });
      emit("task", analysisTaskId, "analysis.assigned", { taskId: task.id, executorType: task.executorType });
      return { analysisTask: accepted.task, task };
    });
  }

  // ---------- batch dispatch ----------
  /**
   * Dispatches many tasks to a runner. Each task is its own transaction, so one refusal never undoes or blocks
   * the others; every task gets a result line with the reason when it was skipped.
   */
  function dispatchTasks(taskIds, options = {}) {
    if (!Array.isArray(taskIds) || !taskIds.length) throw invalid("请选择至少一个任务");
    if (taskIds.length > 200) throw invalid("一次最多 200 个任务");
    const results = [];
    const seen = new Set();
    for (const taskId of taskIds) {
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      try {
        const sent = dispatchTask(taskId, options);
        results.push({ taskId, ok: true, runId: sent.run.id });
      } catch (error) {
        if (!(error instanceof WorkbenchError)) throw error;
        results.push({ taskId, ok: false, code: error.code, message: error.message, blockers: error.details?.blockers });
      }
    }
    const summary = { results, dispatched: results.filter((r) => r.ok).length, skipped: results.filter((r) => !r.ok).length };
    tx(() => emit("workspace", workspaceId, "batch.dispatched", { taskIds: [...seen], dispatched: summary.dispatched, skipped: summary.skipped }));
    return summary;
  }

  /**
   * "Run everything that is not finished": every queued task, oldest first. Tasks that cannot start yet
   * (waiting on a dependency, or no executor chosen) are skipped with a reason; tasks in other states are
   * counted in `waiting` so the caller can say what is left and why.
   */
  function dispatchAll({ requirementId, kinds, ...options } = {}) {
    // Tasks of a deleted requirement are history, not work to do.
    const where = ["workspace_id = ?", "(requirement_id IS NULL OR requirement_id NOT IN (SELECT id FROM requirements WHERE deleted_at IS NOT NULL))"]; const params = [workspaceId];
    if (requirementId) { where.push("requirement_id = ?"); params.push(requirementId); }
    if (kinds?.length) { where.push(`kind IN (${kinds.map(() => "?").join(",")})`); params.push(...kinds); }
    const rows = all(db, `SELECT id, status FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at, rowid`, ...params);
    const waiting = Object.fromEntries(TASK_STATUSES.filter((s) => s !== "queued" && s !== "done").map((s) => [s, 0]));
    for (const row of rows) if (row.status in waiting) waiting[row.status] += 1;
    const queued = rows.filter((row) => row.status === "queued").map((row) => row.id);
    if (!queued.length) return { results: [], dispatched: 0, skipped: 0, waiting };
    return { ...dispatchTasks(queued, options), waiting };
  }

  // ---------- settings ----------
  function listSettings() {
    const stored = Object.fromEntries(all(db, "SELECT key, value_json FROM settings").map((row) => [row.key, parseJson(row.value_json, null)]));
    return Object.fromEntries(Object.keys(SETTING_RULES).map((key) => [key, stored[key] ?? null]));
  }
  const getSetting = (key, fallback = null) => listSettings()[key] ?? fallback;

  function setSetting(key, value) {
    const rule = SETTING_RULES[key];
    if (!rule) throw invalid(`未知的设置项：${key}`);
    const clean = rule(value);
    return tx(() => {
      const before = getSetting(key);
      if (before === clean) return clean;
      db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(clean), clock());
      emit("workspace", workspaceId, "setting.changed", { key, before, after: clean });
      return clean;
    });
  }

  function clearSetting(key) {
    if (!SETTING_RULES[key]) throw invalid(`未知的设置项：${key}`);
    return tx(() => {
      const before = getSetting(key);
      if (before === null) return null;
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      emit("workspace", workspaceId, "setting.changed", { key, before, after: null });
      return null;
    });
  }

  // ---------- run detail ----------
  /** Everything the page needs to show how a run is going: phase, progress, heartbeat, error, log tail, artifacts, attempts. */
  function getRunDetail(runId) {
    const runRow = requireRunRow(runId);
    const run = toRun(runRow);
    const task = toTask(requireTaskRow(run.taskId));
    const now = clock();
    const events = all(db, "SELECT * FROM events WHERE run_id = ? ORDER BY id", runId).map(toEvent);
    const progressEvents = events.filter((e) => e.eventType === "run.progress");
    const lastProgress = progressEvents.filter((e) => e.payload.type === "progress").at(-1) ?? null;
    const logTail = progressEvents.filter((e) => e.payload.type === "log").map((e) => e.payload.message).join("\n").slice(-LOG_TAIL_CHARS);

    let heartbeat = null;
    if (run.claimedBy) {
      const ageSeconds = run.heartbeatAt ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(run.heartbeatAt)) / 1000)) : null;
      const leaseAlive = run.leaseUntil && Date.parse(run.leaseUntil) > Date.parse(now);
      let state = "ended";
      if (run.status === "running") state = !leaseAlive ? "lost" : (ageSeconds !== null && ageSeconds > SLOW_HEARTBEAT_SECONDS ? "slow" : "ok");
      heartbeat = { runnerId: run.claimedBy, at: run.heartbeatAt, ageSeconds, leaseUntil: run.leaseUntil, state };
    }

    const artifacts = listArtifacts(runId);
    const lastArtifact = (kind) => artifacts.filter((a) => a.kind === kind).at(-1) ?? null;
    const branchReport = lastArtifact("branch");
    const diff = lastArtifact("diff");
    const workspace = {
      ...workspaceContract(db, { taskId: task.id, kind: task.kind, attempt: run.attempt }),
      reportedBranch: branchReport ? { uri: branchReport.uri, ...branchReport.metadata } : null,
      diff: diff ? { artifactId: diff.id, uri: diff.uri, sizeBytes: diff.sizeBytes } : null,
    };

    const lost = heartbeat?.state === "lost";
    let phase;
    switch (run.status) {
      case "pending": phase = "等待 Runner 领取"; break;
      case "running": phase = run.cancelRequested ? "正在终止…（等待 Runner 停下 Agent）" : !run.claimedBy ? "已手动启动，等待你提交结果" : lost ? "Runner 失联" : (lastProgress?.payload.data?.step ?? "执行中"); break;
      case "succeeded": phase = run.reviewDecision === "accepted" ? "已验收通过" : run.reviewDecision === "rejected" ? "已退回" : "已提交结果，待验收"; break;
      case "failed": phase = "执行失败"; break;
      case "cancelled": phase = "已取消"; break;
      case "worker_lost": phase = "Runner 失联，已回收"; break;
      default: phase = run.status;
    }

    return {
      run,
      task: { id: task.id, kind: task.kind, status: task.status, taskText: clip(task.taskText, 200) },
      phase,
      progress: lastProgress ? {
        step: lastProgress.payload.data?.step ?? null, pct: lastProgress.payload.data?.pct ?? null,
        message: lastProgress.payload.message, at: lastProgress.createdAt,
      } : null,
      heartbeat,
      error: ["failed", "cancelled", "worker_lost"].includes(run.status) ? { code: run.errorCode, message: run.errorMessage } : null,
      logTail,
      workspace,
      artifacts,
      attempts: all(db, "SELECT id, attempt, status, started_at, ended_at, error_code FROM task_runs WHERE task_id = ? ORDER BY attempt", run.taskId)
        .map((r) => ({ id: r.id, attempt: r.attempt, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, errorCode: r.error_code })),
      timeline: events.map((e) => ({ id: e.id, at: e.createdAt, type: e.eventType, summary: describeEvent(e) })),
    };
  }

  return {
    createAnalysisTask, recordModelAnalysis, recordAnalysisFailure, assignFromAnalysis, dispatchTasks, dispatchAll,
    listSettings, getSetting, setSetting, clearSetting, getRunDetail, DEFAULT_ANALYSIS_TEMPLATE,
  };
}

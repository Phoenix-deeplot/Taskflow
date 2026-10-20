import { all, one, transaction } from "./db.mjs";
import { checkAnalysisResult } from "./analysis.mjs";
import { createBatchOps } from "./batch-ops.mjs";
import { createRunnerOps } from "./runner-ops.mjs";
import { buildSnapshot } from "./snapshot.mjs";
import { createSplitOps } from "./split-ops.mjs";
import {
  BLOCKER_CODES, DECISIONS, TASK_STATUSES, VERSIONS,
  findTransition, operationsFor,
} from "./state-machine.mjs";
import {
  WorkbenchError, canonicalize, conflict, invalid, newId, nonEmpty, notFound, parseJson,
} from "./util.mjs";

const REQUIREMENT_FIELDS = {
  module: "module", title: "title", description: "description",
  sourceVersion: "source_version", targetVersion: "target_version",
  decision: "decision", decisionNote: "decision_note",
};
const TASK_FIELDS = {
  requirementId: "requirement_id", provider: "provider", executorType: "executor_type",
  assignee: "assignee", taskText: "task_text", resultNote: "result_note",
};

export const toRequirement = (r) => r && ({
  id: r.id, revision: r.revision, module: r.module, title: r.title, description: r.description,
  sourceVersion: r.source_version, targetVersion: r.target_version, decision: r.decision,
  decisionNote: r.decision_note, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
});
export const toTask = (r) => r && ({
  id: r.id, requirementId: r.requirement_id, revision: r.revision, status: r.status,
  provider: r.provider, executorType: r.executor_type, assignee: r.assignee, taskText: r.task_text,
  kind: r.kind ?? "execution", resultNote: r.result_note ?? "", acceptance: parseJson(r.acceptance_json, []), fileScope: parseJson(r.file_scope_json, []),
  blockedReason: r.blocked_reason, legacyRequirementTitle: r.legacy_requirement_title,
  legacyRequirementModule: r.legacy_requirement_module, createdAt: r.created_at, updatedAt: r.updated_at,
});
export const toRun = (r) => r && ({
  id: r.id, taskId: r.task_id, snapshotId: r.snapshot_id, attempt: r.attempt, status: r.status,
  executorType: r.executor_type, executorId: r.executor_id, startedAt: r.started_at, endedAt: r.ended_at,
  resultSummary: r.result_summary, evidence: parseJson(r.evidence_json, []), errorCode: r.error_code,
  errorMessage: r.error_message, reviewDecision: r.review_decision, reviewNote: r.review_note,
  reviewedAt: r.reviewed_at, overrideReason: r.override_reason, isLegacy: r.is_legacy === 1,
  claimedBy: r.claimed_by ?? "", claimedAt: r.claimed_at ?? null, leaseUntil: r.lease_until ?? null, heartbeatAt: r.heartbeat_at ?? null,
  cancelRequested: Boolean(r.cancel_requested_at), cancelReason: r.cancel_reason ?? "",
});
export const toEvent = (r) => r && ({
  id: r.id, entityType: r.entity_type, entityId: r.entity_id, runId: r.run_id, eventType: r.event_type,
  actorId: r.actor_id, payload: parseJson(r.payload_json, {}), createdAt: r.created_at,
});

function stringList(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw invalid(`${label}必须是字符串数组`);
  return value.map((item) => item.trim()).filter(Boolean);
}

export function createWorkbench(db, { clock = () => new Date().toISOString(), actorId = "local-user", workspaceId = "WS-LOCAL" } = {}) {
  const tx = (fn) => transaction(db, fn);

  function emit(entityType, entityId, eventType, payload = {}, runId = null) {
    db.prepare(`INSERT INTO events (workspace_id, entity_type, entity_id, run_id, event_type, actor_id, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(workspaceId, entityType, entityId, runId, eventType, actorId, JSON.stringify(payload), clock());
  }

  function uniqueId(prefix, table) {
    for (let i = 0; i < 20; i += 1) {
      const id = newId(prefix);
      if (!one(db, `SELECT 1 AS x FROM ${table} WHERE id = ?`, id)) return id;
    }
    throw new Error(`Could not allocate a unique ${prefix} id`);
  }

  function requireRequirementRow(id) {
    const row = one(db, "SELECT * FROM requirements WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!row) throw notFound(`找不到需求 ${id}`);
    return row;
  }
  function requireTaskRow(id) {
    const row = one(db, "SELECT * FROM tasks WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!row) throw notFound(`找不到任务 ${id}`);
    return row;
  }
  function requireRunRow(id) {
    const row = one(db, "SELECT r.* FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ? AND t.workspace_id = ?", id, workspaceId);
    if (!row) throw notFound(`找不到运行记录 ${id}`);
    return row;
  }
  function checkRevision(row, expectedRevision, label) {
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== row.revision) {
      throw conflict(`${label}已被修改（当前版本 ${row.revision}，你基于 ${expectedRevision}）`, { currentRevision: row.revision });
    }
  }
  /** The unfinished run of a task, whether it is waiting for a runner or already running. */
  const activeRun = (taskId) => one(db, "SELECT * FROM task_runs WHERE task_id = ? AND status IN ('pending', 'running')", taskId);

  function setTaskStatus(task, status, blockedReason = "") {
    db.prepare("UPDATE tasks SET status = ?, blocked_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(status, blockedReason, clock(), task.id);
  }

  // ---------- requirements ----------
  function createRequirement(input = {}) {
    if (!nonEmpty(input.title)) throw invalid("需求标题不能为空");
    const decision = input.decision ?? "pending";
    const targetVersion = input.targetVersion ?? "V1";
    if (!DECISIONS.includes(decision)) throw invalid(`无效的决策：${decision}`);
    if (!VERSIONS.includes(targetVersion)) throw invalid(`无效的目标版本：${targetVersion}`);
    return tx(() => {
      let id = input.id;
      if (id !== undefined) {
        if (!nonEmpty(id)) throw invalid("需求 ID 无效");
        if (one(db, "SELECT 1 AS x FROM requirements WHERE id = ?", id)) throw conflict(`需求 ${id} 已存在`);
      } else id = uniqueId("REQ", "requirements");
      const now = clock();
      db.prepare(`INSERT INTO requirements (id, workspace_id, revision, module, title, description, source_version, target_version,
                  decision, decision_note, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, workspaceId, input.module ?? "", input.title.trim(), input.description ?? "", input.sourceVersion ?? "",
          targetVersion, decision, input.decisionNote ?? "", now, now);
      const created = toRequirement(requireRequirementRow(id));
      emit("requirement", id, "requirement.created", { after: created });
      return created;
    });
  }

  function updateRequirement(id, patch = {}, { expectedRevision } = {}) {
    return tx(() => {
      const before = requireRequirementRow(id);
      if (before.deleted_at) throw conflict(`需求 ${id} 已删除`);
      checkRevision(before, expectedRevision, "需求");
      const sets = []; const values = [];
      for (const [key, column] of Object.entries(REQUIREMENT_FIELDS)) {
        if (patch[key] === undefined) continue;
        if (key === "title" && !nonEmpty(patch.title)) throw invalid("需求标题不能为空");
        if (key === "decision" && !DECISIONS.includes(patch.decision)) throw invalid(`无效的决策：${patch.decision}`);
        if (key === "targetVersion" && !VERSIONS.includes(patch.targetVersion)) throw invalid(`无效的目标版本：${patch.targetVersion}`);
        sets.push(`${column} = ?`); values.push(typeof patch[key] === "string" ? patch[key] : String(patch[key]));
      }
      if (!sets.length) throw invalid("没有可更新的字段");
      db.prepare(`UPDATE requirements SET ${sets.join(", ")}, revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(...values, clock(), id);
      const after = toRequirement(requireRequirementRow(id));
      emit("requirement", id, "requirement.updated", { before: toRequirement(before), after });
      return after;
    });
  }

  function deleteRequirement(id, { reason = "" } = {}) {
    return tx(() => {
      const before = requireRequirementRow(id);
      if (before.deleted_at) throw conflict(`需求 ${id} 已删除`);
      const now = clock();
      db.prepare("UPDATE requirements SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(now, now, id);
      const affectedTasks = one(db, "SELECT COUNT(*) AS n FROM tasks WHERE requirement_id = ?", id).n;
      emit("requirement", id, "requirement.deleted", { reason, affectedTasks, before: toRequirement(before) });
      return toRequirement(requireRequirementRow(id));
    });
  }

  /** Undoes a soft delete. Optional `patch` applies in the same revision bump (e.g. re-adding an id from a backup). */
  function restoreRequirement(id, patch = {}) {
    return tx(() => {
      const before = requireRequirementRow(id);
      if (!before.deleted_at) throw conflict(`需求 ${id} 没有被删除`);
      if (patch.title !== undefined && !nonEmpty(patch.title)) throw invalid("需求标题不能为空");
      db.prepare("UPDATE requirements SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?").run(clock(), id);
      const hasPatch = Object.keys(patch).length > 0;
      if (hasPatch) updateRequirement(id, patch);
      const after = toRequirement(requireRequirementRow(id));
      emit("requirement", id, "requirement.restored", { before: toRequirement(before), after });
      return after;
    });
  }

  /**
   * Monotonic token for "has anything changed since I loaded?". Every mutation appends an event,
   * so the highest event id is a cheap, reliable version of the whole workspace.
   */
  function stateVersion() { return one(db, "SELECT COALESCE(MAX(id), 0) AS v FROM events").v; }

  function getRequirement(id) { return toRequirement(requireRequirementRow(id)); }

  function listRequirements({ includeDeleted = false, decision, targetVersion, query } = {}) {
    const where = ["workspace_id = ?"]; const params = [workspaceId];
    if (!includeDeleted) where.push("deleted_at IS NULL");
    if (decision) { where.push("decision = ?"); params.push(decision); }
    if (targetVersion) { where.push("target_version = ?"); params.push(targetVersion); }
    if (nonEmpty(query)) {
      where.push("(title LIKE ? OR description LIKE ? OR module LIKE ? OR id LIKE ?)");
      const like = `%${query.trim()}%`; params.push(like, like, like, like);
    }
    return all(db, `SELECT * FROM requirements WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id`, ...params).map(toRequirement);
  }

  // ---------- tasks ----------
  function createTask(input = {}) {
    if (!nonEmpty(input.taskText)) throw invalid("任务说明不能为空");
    if (input.resultNote !== undefined && typeof input.resultNote !== "string") throw invalid("备注必须是文本");
    const kind = input.kind ?? "execution";
    if (!["execution", "analysis"].includes(kind)) throw invalid(`无效的任务类型：${kind}（只能是 execution 或 analysis）`);
    const status = input.status ?? "queued";
    if (!["clarification", "queued"].includes(status)) throw invalid("新任务只能从“待澄清”或“待执行”开始");
    const acceptance = stringList(input.acceptance, "验收标准") ?? [];
    const fileScope = stringList(input.fileScope, "文件范围") ?? [];
    return tx(() => {
      if (input.requirementId) {
        const requirement = requireRequirementRow(input.requirementId);
        if (requirement.deleted_at) throw conflict(`需求 ${input.requirementId} 已删除，不能再创建任务`);
      }
      let id = input.id;
      if (id !== undefined) {
        if (!nonEmpty(id)) throw invalid("任务 ID 无效");
        if (one(db, "SELECT 1 AS x FROM tasks WHERE id = ?", id)) throw conflict(`任务 ${id} 已存在`);
      } else id = uniqueId("TASK", "tasks");
      const now = clock();
      db.prepare(`INSERT INTO tasks (id, workspace_id, requirement_id, revision, status, provider, executor_type, assignee, task_text,
                  result_note, kind, acceptance_json, file_scope_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, workspaceId, input.requirementId ?? null, status, input.provider ?? "", input.executorType ?? "manual_handoff",
          input.assignee ?? "", input.taskText.trim(), input.resultNote ?? "", kind, JSON.stringify(acceptance), JSON.stringify(fileScope), now, now);
      const created = toTask(requireTaskRow(id));
      emit("task", id, "task.created", { after: created });
      return created;
    });
  }

  function updateTask(id, patch = {}, { expectedRevision } = {}) {
    if (patch.status !== undefined) throw invalid("任务状态不能直接修改，请使用启动/提交/验收/流转操作");
    const acceptance = stringList(patch.acceptance, "验收标准");
    const fileScope = stringList(patch.fileScope, "文件范围");
    return tx(() => {
      const before = requireTaskRow(id);
      checkRevision(before, expectedRevision, "任务");
      const sets = []; const values = [];
      for (const [key, column] of Object.entries(TASK_FIELDS)) {
        if (patch[key] === undefined) continue;
        if (key === "taskText" && !nonEmpty(patch.taskText)) throw invalid("任务说明不能为空");
        if (key === "resultNote" && typeof patch.resultNote !== "string") throw invalid("备注必须是文本");
        if (key === "requirementId" && patch.requirementId !== null) {
          const requirement = requireRequirementRow(patch.requirementId);
          if (requirement.deleted_at) throw conflict(`需求 ${patch.requirementId} 已删除`);
        }
        sets.push(`${column} = ?`); values.push(patch[key]);
      }
      if (acceptance !== undefined) { sets.push("acceptance_json = ?"); values.push(JSON.stringify(acceptance)); }
      if (fileScope !== undefined) { sets.push("file_scope_json = ?"); values.push(JSON.stringify(fileScope)); }
      if (!sets.length) throw invalid("没有可更新的字段");
      db.prepare(`UPDATE tasks SET ${sets.join(", ")}, revision = revision + 1, updated_at = ? WHERE id = ?`).run(...values, clock(), id);
      const after = toTask(requireTaskRow(id));
      emit("task", id, "task.updated", { before: toTask(before), after });
      return after;
    });
  }

  function listDependencies(taskId) {
    return all(db, `SELECT t.id, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
                    WHERE d.task_id = ? ORDER BY t.id`, taskId);
  }

  function dependencyResult(taskId) {
    const row = one(db, `SELECT result_summary FROM task_runs WHERE task_id = ? AND status = 'succeeded'
                         ORDER BY (review_decision = 'accepted') DESC, attempt DESC LIMIT 1`, taskId);
    return row?.result_summary ?? "";
  }

  function addDependency(taskId, dependsOnTaskId) {
    return tx(() => {
      requireTaskRow(taskId); requireTaskRow(dependsOnTaskId);
      if (taskId === dependsOnTaskId) throw invalid("任务不能依赖自己");
      if (one(db, "SELECT 1 AS x FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?", taskId, dependsOnTaskId)) {
        throw conflict("该依赖已存在");
      }
      // A cycle exists if `dependsOnTaskId` already (transitively) depends on `taskId`.
      const seen = new Set(); const stack = [dependsOnTaskId];
      while (stack.length) {
        const current = stack.pop();
        if (current === taskId) throw invalid("不能创建循环依赖", { taskId, dependsOnTaskId });
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of all(db, "SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ?", current)) stack.push(next.id);
      }
      db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)").run(taskId, dependsOnTaskId, clock());
      emit("task", taskId, "dependency.added", { dependsOnTaskId });
      return listDependencies(taskId);
    });
  }

  function removeDependency(taskId, dependsOnTaskId) {
    return tx(() => {
      requireTaskRow(taskId);
      const result = db.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?").run(taskId, dependsOnTaskId);
      if (!result.changes) throw notFound("依赖不存在");
      emit("task", taskId, "dependency.removed", { dependsOnTaskId });
      return listDependencies(taskId);
    });
  }

  function readinessOf(taskRow) {
    const blockers = []; const warnings = [];
    if (taskRow.status !== "queued") {
      blockers.push({ code: "NOT_QUEUED", message: `任务当前状态为“${taskRow.status}”，只有“待执行”的任务可以启动` });
    }
    const open = listDependencies(taskRow.id).filter((dep) => dep.status !== "done");
    if (open.length) {
      blockers.push({ code: "DEPENDENCY_NOT_DONE", message: `有 ${open.length} 个依赖任务尚未验收通过`, taskIds: open.map((dep) => dep.id) });
    }
    if (taskRow.requirement_id) {
      const requirement = one(db, "SELECT deleted_at FROM requirements WHERE id = ?", taskRow.requirement_id);
      if (requirement?.deleted_at) blockers.push({ code: "REQUIREMENT_DELETED", message: "关联的需求已删除" });
    }
    if (!parseJson(taskRow.acceptance_json, []).length) warnings.push({ code: "NO_ACCEPTANCE", message: "未填写验收标准" });
    if (!taskRow.assignee && !taskRow.provider) warnings.push({ code: "NO_ASSIGNEE", message: "未填写执行人或模型" });
    return { ready: blockers.length === 0, blockers, warnings };
  }

  function getReadiness(taskId) { return readinessOf(requireTaskRow(taskId)); }

  function getTask(id) {
    const row = requireTaskRow(id);
    return {
      ...toTask(row),
      dependencies: listDependencies(id),
      readiness: readinessOf(row),
      runs: all(db, "SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt", id).map(toRun),
    };
  }

  function listTasks({ status, requirementId } = {}) {
    const where = ["workspace_id = ?"]; const params = [workspaceId];
    if (status) { where.push("status = ?"); params.push(status); }
    if (requirementId) { where.push("requirement_id = ?"); params.push(requirementId); }
    return all(db, `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at, id`, ...params).map(toTask);
  }

  // ---------- runs and state transitions ----------
  /**
   * Shared by startTask (hand-off: the run is `running` at once) and dispatchTask (the run is `pending` until a
   * runner claims it). Same checks, same immutable snapshot, one transaction.
   */
  function launchRun(taskId, { overrideReason = "", executorId = "", expectedRevision, executorType } = {}, runStatus) {
    return tx(() => {
      const task = requireTaskRow(taskId);
      checkRevision(task, expectedRevision, "任务");
      if (executorType && executorType !== task.executor_type) {
        db.prepare("UPDATE tasks SET executor_type = ? WHERE id = ?").run(executorType, taskId);
        task.executor_type = executorType;
      }
      const readiness = readinessOf(task);
      const hard = readiness.blockers.filter((b) => !BLOCKER_CODES[b.code]?.overridable);
      if (hard.length) throw new WorkbenchError("NOT_READY", hard[0].message, 409, { blockers: readiness.blockers });
      if (readiness.blockers.length && !nonEmpty(overrideReason)) {
        throw new WorkbenchError("NOT_READY", `${readiness.blockers[0].message}；如需强行启动，请填写原因`, 409, { blockers: readiness.blockers });
      }

      const requirement = task.requirement_id ? one(db, "SELECT * FROM requirements WHERE id = ?", task.requirement_id) : null;
      const workspace = one(db, "SELECT * FROM workspaces WHERE id = ?", workspaceId);
      const context = one(db, "SELECT * FROM workspace_context_versions WHERE workspace_id = ? ORDER BY revision DESC LIMIT 1", workspaceId);
      const dependencies = listDependencies(taskId).map((dep) => ({ id: dep.id, status: dep.status, result_summary: dependencyResult(dep.id) }));
      const snapshot = buildSnapshot({
        workspace: { id: workspace.id, revision: workspace.revision, context_revision: context.revision, rules: parseJson(context.rules_json, {}) },
        requirement: requirement && {
          id: requirement.id, revision: requirement.revision, module: requirement.module, title: requirement.title,
          description: requirement.description, target_version: requirement.target_version,
          decision: requirement.decision, decision_note: requirement.decision_note,
        },
        task: {
          id: task.id, revision: task.revision, kind: task.kind, provider: task.provider, executor_type: task.executor_type, assignee: task.assignee,
          task_text: task.task_text, acceptance: parseJson(task.acceptance_json, []), file_scope: parseJson(task.file_scope_json, []),
        },
        dependencies,
        overrideReason,
      });

      const now = clock();
      const snapshotId = uniqueId("SNAP", "task_context_snapshots");
      db.prepare(`INSERT INTO task_context_snapshots (id, task_id, workspace_revision, requirement_revision, task_revision, schema_version,
                  prompt_template_version, payload_json, prompt_text, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(snapshotId, taskId, workspace.revision, requirement?.revision ?? null, task.revision, snapshot.payload.schema_version,
          snapshot.payload.prompt_template_version, snapshot.payloadJson, snapshot.promptText, snapshot.payloadHash, now);

      const attempt = (one(db, "SELECT MAX(attempt) AS n FROM task_runs WHERE task_id = ?", taskId).n ?? 0) + 1;
      const runId = uniqueId("RUN", "task_runs");
      db.prepare(`INSERT INTO task_runs (id, task_id, snapshot_id, attempt, status, executor_type, executor_id, started_at, override_reason)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, taskId, snapshotId, attempt, runStatus, task.executor_type, executorId, now, overrideReason);

      setTaskStatus(task, "working");
      emit("task", taskId, "task.transition", { from: "queued", to: "working", overrideReason, snapshotId, attempt }, runId);
      emit("run", runId, runStatus === "pending" ? "run.dispatched" : "run.started", { taskId, snapshotId, attempt, overrideReason, executorType: task.executor_type }, runId);
      return {
        task: toTask(requireTaskRow(taskId)),
        run: toRun(requireRunRow(runId)),
        snapshot: { id: snapshotId, payloadHash: snapshot.payloadHash, promptText: snapshot.promptText, payload: snapshot.payload },
      };
    });
  }

  /** Hand-off start: a person copies the prompt to an agent. The run is `running` immediately. */
  const startTask = (taskId, options = {}) => launchRun(taskId, { ...options, executorType: undefined }, "running");

  /**
   * Queues the task for a local runner. The run waits as `pending` until `claimRun`. The executor type
   * (e.g. "codex_cli") decides which runners may take it; manual hand-off tasks cannot be dispatched.
   */
  function dispatchTask(taskId, options = {}) {
    const task = requireTaskRow(taskId);
    const executorType = options.executorType ?? task.executor_type;
    if (!nonEmpty(executorType) || executorType === "manual_handoff") {
      throw invalid("派发给 Runner 需要指定执行器类型（codex 或 claude）；“manual_handoff”只能手动启动");
    }
    return launchRun(taskId, { ...options, executorType }, "pending");
  }

  /** Runner-owned runs must present their lease token; hand-off runs never do. `idempotencyKey` makes a retried call return the first answer. */
  function submitResult(runId, { summary, evidence = [], expectedTaskRevision, leaseToken, idempotencyKey } = {}) {
    if (!nonEmpty(summary)) throw invalid("提交结果必须填写结果摘要");
    if (!Array.isArray(evidence) || evidence.some((item) => !item || typeof item !== "object")) throw invalid("证据必须是对象数组");
    return tx(() => {
      const run = requireRunRow(runId);
      runnerKit.internal.requireToken(run, leaseToken);
      const again = runnerKit.internal.replay(runId, idempotencyKey, "result");
      if (again) return again;
      if (run.status !== "running") {
        if (run.claimed_by && ["worker_lost", "cancelled"].includes(run.status)) {
          throw new WorkbenchError("LEASE_LOST", `运行 ${runId} 已${run.status === "cancelled" ? "取消" : "因租约过期被回收"}，结果不再接收`, 409, { runStatus: run.status });
        }
        throw conflict(`运行 ${runId} 的状态是 ${run.status}，不能再提交结果`);
      }
      const task = requireTaskRow(run.task_id);
      checkRevision(task, expectedTaskRevision, "任务");
      if (task.status !== "working") throw conflict(`任务状态为 ${task.status}，不能提交结果`);
      // An analysis answer is compared with the built-in format; the outcome is attached as evidence, never a blocker.
      const check = task.kind === "analysis" ? checkAnalysisResult(summary, task.task_text) : null;
      const finalEvidence = check ? [...evidence, { kind: "check", name: "分析格式", passed: check.passed, missing: check.missing }] : evidence;
      db.prepare("UPDATE task_runs SET status = 'succeeded', ended_at = ?, result_summary = ?, evidence_json = ? WHERE id = ?")
        .run(clock(), summary.trim(), JSON.stringify(finalEvidence), runId);
      setTaskStatus(task, "review");
      emit("run", runId, "run.succeeded", { taskId: task.id, evidenceCount: finalEvidence.length, analysisCheck: check }, runId);
      emit("task", task.id, "task.transition", { from: "working", to: "review", attempt: run.attempt }, runId);
      const result = { task: toTask(requireTaskRow(task.id)), run: toRun(requireRunRow(runId)) };
      runnerKit.internal.remember(runId, idempotencyKey, "result", result);
      return result;
    });
  }

  function reportFailure(runId, { message, errorCode = "EXECUTION_FAILED", leaseToken, idempotencyKey } = {}) {
    if (!nonEmpty(message)) throw invalid("报告失败必须填写失败信息");
    return tx(() => {
      const run = requireRunRow(runId);
      runnerKit.internal.requireToken(run, leaseToken);
      const again = runnerKit.internal.replay(runId, idempotencyKey, "failure");
      if (again) return again;
      if (run.status !== "running") {
        if (run.claimed_by && ["worker_lost", "cancelled"].includes(run.status)) {
          throw new WorkbenchError("LEASE_LOST", `运行 ${runId} 已${run.status === "cancelled" ? "取消" : "因租约过期被回收"}`, 409, { runStatus: run.status });
        }
        throw conflict(`运行 ${runId} 的状态是 ${run.status}`);
      }
      const task = requireTaskRow(run.task_id);
      db.prepare("UPDATE task_runs SET status = 'failed', ended_at = ?, error_code = ?, error_message = ? WHERE id = ?")
        .run(clock(), errorCode, message.trim(), runId);
      setTaskStatus(task, "queued");
      emit("run", runId, "run.failed", { taskId: task.id, errorCode, message: message.trim() }, runId);
      emit("task", task.id, "task.transition", { from: "working", to: "queued", reason: message.trim(), attempt: run.attempt }, runId);
      const result = { task: toTask(requireTaskRow(task.id)), run: toRun(requireRunRow(runId)) };
      runnerKit.internal.remember(runId, idempotencyKey, "failure", result);
      return result;
    });
  }

  function transitionTask(taskId, target, { reason = "", expectedRevision } = {}) {
    if (!TASK_STATUSES.includes(target)) throw invalid(`无效的目标状态：${target}`);
    return tx(() => {
      const task = requireTaskRow(taskId);
      checkRevision(task, expectedRevision, "任务");
      const rule = findTransition(task.status, target, "transition");
      if (!rule) {
        const operations = operationsFor(task.status, target);
        const hint = operations.length ? `；请使用 ${operations.join(" / ")}` : "";
        throw new WorkbenchError("ILLEGAL_TRANSITION", `不允许从“${task.status}”流转到“${target}”${hint}`, 409, { from: task.status, to: target, via: operations });
      }
      if (rule.reason && !nonEmpty(reason)) throw new WorkbenchError("REASON_REQUIRED", `从“${task.status}”到“${target}”必须填写原因`, 400);
      let cancelledRunId = null;
      if (rule.cancelsRun) {
        const run = activeRun(taskId);
        if (run) {
          db.prepare("UPDATE task_runs SET status = 'cancelled', ended_at = ?, error_code = 'CANCELLED', error_message = ? WHERE id = ?")
            .run(clock(), reason.trim(), run.id);
          cancelledRunId = run.id;
          emit("run", run.id, "run.cancelled", { taskId, reason: reason.trim() }, run.id);
        }
      }
      setTaskStatus(task, target, target === "blocked" ? reason.trim() : "");
      emit("task", taskId, "task.transition", { from: task.status, to: target, reason: reason.trim(), cancelledRunId }, cancelledRunId);
      return toTask(requireTaskRow(taskId));
    });
  }

  function acceptTask(taskId, { note = "", expectedRevision } = {}) {
    return tx(() => {
      const task = requireTaskRow(taskId);
      checkRevision(task, expectedRevision, "任务");
      if (task.status !== "review") throw new WorkbenchError("ILLEGAL_TRANSITION", `任务状态为“${task.status}”，只有“待验收”的任务可以验收`, 409);
      const run = one(db, `SELECT * FROM task_runs WHERE task_id = ? AND status = 'succeeded' AND review_decision IS NULL
                           ORDER BY attempt DESC LIMIT 1`, taskId);
      if (!run) throw conflict("找不到待验收的运行结果");
      const now = clock();
      db.prepare("UPDATE task_runs SET review_decision = 'accepted', review_note = ?, reviewed_at = ? WHERE id = ?").run(note.trim(), now, run.id);
      setTaskStatus(task, "done");
      emit("task", taskId, "task.accepted", { runId: run.id, note: note.trim(), attempt: run.attempt }, run.id);
      emit("task", taskId, "task.transition", { from: "review", to: "done" }, run.id);
      return { task: toTask(requireTaskRow(taskId)), run: toRun(requireRunRow(run.id)) };
    });
  }

  function rejectTask(taskId, { note, expectedRevision } = {}) {
    if (!nonEmpty(note)) throw new WorkbenchError("REASON_REQUIRED", "退回必须填写修改意见", 400);
    return tx(() => {
      const task = requireTaskRow(taskId);
      checkRevision(task, expectedRevision, "任务");
      if (task.status !== "review") throw new WorkbenchError("ILLEGAL_TRANSITION", `任务状态为“${task.status}”，只有“待验收”的任务可以退回`, 409);
      const run = one(db, `SELECT * FROM task_runs WHERE task_id = ? AND status = 'succeeded' AND review_decision IS NULL
                           ORDER BY attempt DESC LIMIT 1`, taskId);
      if (!run) throw conflict("找不到待验收的运行结果");
      db.prepare("UPDATE task_runs SET review_decision = 'rejected', review_note = ?, reviewed_at = ? WHERE id = ?").run(note.trim(), clock(), run.id);
      setTaskStatus(task, "queued");
      emit("task", taskId, "task.rejected", { runId: run.id, note: note.trim(), attempt: run.attempt }, run.id);
      emit("task", taskId, "task.transition", { from: "review", to: "queued", reason: note.trim() }, run.id);
      return { task: toTask(requireTaskRow(taskId)), run: toRun(requireRunRow(run.id)) };
    });
  }

  function reopenTask(taskId, { reason, expectedRevision } = {}) {
    if (!nonEmpty(reason)) throw new WorkbenchError("REASON_REQUIRED", "重开任务必须填写原因", 400);
    return tx(() => {
      const task = requireTaskRow(taskId);
      checkRevision(task, expectedRevision, "任务");
      if (task.status !== "done") throw new WorkbenchError("ILLEGAL_TRANSITION", `任务状态为“${task.status}”，只有“已完成”的任务可以重开`, 409);
      setTaskStatus(task, "queued");
      emit("task", taskId, "task.reopened", { reason: reason.trim() });
      emit("task", taskId, "task.transition", { from: "done", to: "queued", reason: reason.trim() });
      return toTask(requireTaskRow(taskId));
    });
  }

  // ---------- manual split and progress ----------
  /**
   * Turns one requirement into several tasks (and optional dependencies between them) in one transaction.
   * Each item may carry a `key`; `dependsOn` lists keys of other items in the same batch.
   */
  function splitRequirement(requirementId, items = []) {
    if (!Array.isArray(items) || !items.length) throw invalid("拆分至少需要一条任务");
    if (items.length > 50) throw invalid("一次最多拆分 50 条任务");
    const keys = items.map((item, index) => (nonEmpty(item?.key) ? item.key : `#${index + 1}`));
    if (new Set(keys).size !== keys.length) throw invalid("拆分任务的 key 不能重复");
    items.forEach((item, index) => {
      for (const dep of item?.dependsOn ?? []) {
        if (!keys.includes(dep)) throw invalid(`任务 ${keys[index]} 依赖了不存在的 key：${dep}`);
        if (dep === keys[index]) throw invalid(`任务 ${keys[index]} 不能依赖自己`);
      }
    });
    return tx(() => {
      const requirement = requireRequirementRow(requirementId);
      if (requirement.deleted_at) throw conflict(`需求 ${requirementId} 已删除，不能拆分`);
      const created = items.map((item) => createTask({ ...item, requirementId }));
      const idByKey = new Map(keys.map((key, index) => [key, created[index].id]));
      const dependencies = [];
      items.forEach((item, index) => {
        for (const dep of item.dependsOn ?? []) {
          addDependency(created[index].id, idByKey.get(dep));
          dependencies.push({ taskId: created[index].id, dependsOnTaskId: idByKey.get(dep) });
        }
      });
      emit("requirement", requirementId, "requirement.split", { taskIds: created.map((task) => task.id), dependencies });
      return { tasks: created.map((task) => getTask(task.id)), dependencies };
    });
  }

  const emptyProgress = (requirementId) => ({
    requirementId, total: 0, done: 0, open: 0, percent: 0, byStatus: Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])),
  });

  /** Progress is derived from tasks every time; it is never stored on the requirement. */
  function requirementProgress(requirementId) {
    const progress = new Map();
    const where = requirementId ? "AND requirement_id = ?" : "AND requirement_id IS NOT NULL";
    const params = requirementId ? [workspaceId, requirementId] : [workspaceId];
    for (const row of all(db, `SELECT requirement_id, status, COUNT(*) AS n FROM tasks WHERE workspace_id = ? ${where} GROUP BY requirement_id, status`, ...params)) {
      const entry = progress.get(row.requirement_id) ?? emptyProgress(row.requirement_id);
      entry.byStatus[row.status] = row.n;
      entry.total += row.n;
      progress.set(row.requirement_id, entry);
    }
    for (const entry of progress.values()) {
      entry.done = entry.byStatus.done;
      entry.open = entry.total - entry.done;
      entry.percent = entry.total ? Math.round((entry.done / entry.total) * 100) : 0;
    }
    if (requirementId) {
      requireRequirementRow(requirementId);
      return progress.get(requirementId) ?? emptyProgress(requirementId);
    }
    return Object.fromEntries(progress);
  }

  // ---------- global context versions ----------
  const toContext = (r) => r && ({
    id: r.id, revision: r.revision, rules: parseJson(r.rules_json, {}), createdBy: r.created_by, createdAt: r.created_at,
  });
  const CONTEXT_LISTS = ["rules", "glossary", "constraints"];

  function getContext() {
    return toContext(one(db, "SELECT * FROM workspace_context_versions WHERE workspace_id = ? ORDER BY revision DESC LIMIT 1", workspaceId));
  }
  function listContextVersions() {
    return all(db, "SELECT * FROM workspace_context_versions WHERE workspace_id = ? ORDER BY revision DESC", workspaceId).map(toContext);
  }

  /** Appends a new global-context version (never edits an old one) and bumps the workspace revision. */
  function appendContextVersion(rules = {}) {
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw invalid("全局上下文必须是对象");
    const next = {};
    for (const key of CONTEXT_LISTS) {
      const list = rules[key] ?? [];
      if (!Array.isArray(list) || list.length > 200) throw invalid(`${key} 必须是不超过 200 条的数组`);
      if (list.some((entry) => (typeof entry === "string" ? entry.length > 2000 : !entry || typeof entry !== "object"))) {
        throw invalid(`${key} 中的每一项必须是字符串（或术语对象），且不超过 2000 字`);
      }
      next[key] = list;
    }
    return tx(() => {
      const current = getContext();
      if (JSON.stringify(canonicalize(current.rules)) === JSON.stringify(canonicalize(next))) throw invalid("全局上下文没有变化");
      const revision = current.revision + 1;
      const id = `CTX-${revision}`;
      db.prepare("INSERT INTO workspace_context_versions (id, workspace_id, revision, rules_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, workspaceId, revision, JSON.stringify(next), actorId, clock());
      db.prepare("UPDATE workspaces SET revision = revision + 1 WHERE id = ?").run(workspaceId);
      emit("workspace", workspaceId, "context.versioned", { fromRevision: current.revision, toRevision: revision });
      return getContext();
    });
  }

  // ---------- reads ----------
  function listRuns(taskId) {
    requireTaskRow(taskId);
    return all(db, "SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt", taskId).map(toRun);
  }

  function getSnapshot(id) {
    const row = one(db, `SELECT s.* FROM task_context_snapshots s JOIN tasks t ON t.id = s.task_id WHERE s.id = ? AND t.workspace_id = ?`, id, workspaceId);
    if (!row) throw notFound(`找不到快照 ${id}`);
    return {
      id: row.id, taskId: row.task_id, workspaceRevision: row.workspace_revision, requirementRevision: row.requirement_revision,
      taskRevision: row.task_revision, schemaVersion: row.schema_version, promptTemplateVersion: row.prompt_template_version,
      payload: parseJson(row.payload_json, null), promptText: row.prompt_text, payloadHash: row.payload_hash, createdAt: row.created_at,
    };
  }

  function listEvents({ entityType, entityId, limit = 200, beforeId } = {}) {
    const where = ["workspace_id = ?"]; const params = [workspaceId];
    if (entityType) { where.push("entity_type = ?"); params.push(entityType); }
    if (entityId) { where.push("entity_id = ?"); params.push(entityId); }
    if (beforeId) { where.push("id < ?"); params.push(beforeId); }
    return all(db, `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...params, Math.min(Math.max(1, limit), 1000)).map(toEvent);
  }

  function exportAll() {
    const rows = (table, order) => all(db, `SELECT * FROM ${table} ORDER BY ${order}`);
    return {
      app: "出海产品需求工作台",
      schemaVersion: 2,
      exportedAt: clock(),
      workspace: one(db, "SELECT * FROM workspaces WHERE id = ?", workspaceId),
      contextVersions: rows("workspace_context_versions", "revision"),
      requirements: rows("requirements", "created_at, id"),
      tasks: rows("tasks", "created_at, id"),
      taskDependencies: rows("task_dependencies", "task_id, depends_on_task_id"),
      snapshots: rows("task_context_snapshots", "created_at, id"),
      // The lease token hash is a credential: it never leaves the database file.
      runs: rows("task_runs", "started_at, id").map(({ lease_token_hash: _hidden, ...run }) => run),
      artifacts: rows("artifacts", "created_at, id"),
      splitDrafts: rows("split_drafts", "created_at, id"),
      settings: rows("settings", "key"),
      events: rows("events", "id"),
      migrationSources: rows("migration_sources", "id"),
    };
  }

  // Runner leases and split drafts live in their own files; they share this toolbox.
  const kit = {
    db, tx, emit, clock, workspaceId, uniqueId, requireRequirementRow, requireTaskRow, requireRunRow, checkRevision,
    setTaskStatus, toRun, toTask, getSnapshot, splitRequirement,
  };
  const runnerKit = createRunnerOps(kit);
  const splitOps = createSplitOps(kit);
  const batchOps = createBatchOps({
    ...kit, toEvent, toRequirement, createTask, dispatchTask, listArtifacts: runnerKit.api.listArtifacts,
  });

  return {
    workspaceId,
    createRequirement, updateRequirement, deleteRequirement, restoreRequirement, getRequirement, listRequirements, stateVersion,
    createTask, updateTask, getTask, listTasks,
    addDependency, removeDependency, getReadiness, splitRequirement, requirementProgress,
    getContext, listContextVersions, appendContextVersion,
    startTask, dispatchTask, submitResult, reportFailure, transitionTask, acceptTask, rejectTask, reopenTask,
    ...runnerKit.api, ...splitOps, ...batchOps,
    listRuns, getSnapshot, listEvents, exportAll,
  };
}

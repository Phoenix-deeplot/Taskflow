import { all, one, transaction } from "./db.mjs";
import { commitLegacyImport } from "./legacy-import.mjs";
import { createWorkbench } from "./service.mjs";
import { conflict, invalid, WorkbenchError } from "./util.mjs";
import { normalizeLegacyState } from "./legacy-payload.mjs";

const activeRows = (db, table) => one(db, `SELECT COUNT(*) AS count FROM ${table}`).count;
export const hasWorkspaceData = (db) => ["requirements", "tasks", "events", "migration_sources"].some((table) => activeRows(db, table) > 0);

function snapshotFor(task, workbench) {
  const snapshotId = task.runs?.slice().reverse().find((run) => run.snapshotId)?.snapshotId;
  if (!snapshotId) return null;
  const value = workbench.getSnapshot(snapshotId);
  const payload = value.payload || {};
  const r = payload.requirement;
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    createdAt: value.createdAt,
    workspaceRevision: value.workspaceRevision,
    requirement: r ? {
      id: r.id, module: r.module, title: r.title, description: r.description,
      targetVersion: r.target_version, decision: r.decision, decisionNote: r.decision_note,
    } : null,
    task: payload.task ? {
      id: payload.task.id, model: payload.task.provider, assignee: payload.task.assignee,
      task: payload.task.task_text, acceptanceCriteria: payload.task.acceptance,
    } : null,
    promptText: value.promptText,
    payloadHash: value.payloadHash,
  };
}

export function exportLegacyState(db, workbench) {
  const items = workbench.listRequirements().map((r) => ({
    id: r.id, module: r.module, title: r.title, description: r.description,
    sourceVersion: r.sourceVersion, targetVersion: r.targetVersion, decision: r.decision,
    decisionNote: r.decisionNote, createdAt: r.createdAt, updatedAt: r.updatedAt, revision: r.revision,
  }));
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const tasks = workbench.listTasks().map((row) => {
    const detail = workbench.getTask(row.id);
    const feature = itemMap.get(row.requirementId);
    const runs = detail.runs.map((run) => ({
      id: run.id, contextSnapshotId: run.snapshotId, status: run.status === "succeeded" ? "awaiting_review" : run.status,
      startedAt: run.startedAt, finishedAt: run.endedAt, result: run.resultSummary,
      errorCode: run.errorCode, errorMessage: run.errorMessage, reviewDecision: run.reviewDecision,
    }));
    return {
      id: row.id, featureId: row.requirementId, model: row.provider, task: row.taskText,
      status: row.status, assignee: row.assignee, suggestion: row.resultNote || detail.runs.slice().reverse().find((run) => run.resultSummary)?.resultSummary || "",
      blockedReason: row.blockedReason, createdAt: row.createdAt, updatedAt: row.updatedAt,
      featureTitle: feature?.title || row.legacyRequirementTitle || "",
      featureModule: feature?.module || row.legacyRequirementModule || "",
      acceptanceCriteria: detail.readiness?.warnings?.some((warning) => warning.code === "NO_ACCEPTANCE") ? [] : row.acceptance,
      fileScope: row.fileScope, dependencies: detail.dependencies, readiness: detail.readiness,
      runs, contextSnapshot: snapshotFor(detail, workbench), revision: row.revision,
    };
  });
  const events = workbench.listEvents({ limit: 1000 }).map((event) => ({
    id: event.id, entityType: event.entityType, entityId: event.entityId,
    action: event.eventType, actor: event.actorId, before: event.payload?.before || null,
    after: event.payload?.after || event.payload || null, createdAt: event.createdAt,
  }));
  const updatedAt = [...items.map((x) => x.updatedAt), ...tasks.map((x) => x.updatedAt), ...events.map((x) => x.createdAt)].sort().at(-1) || new Date(0).toISOString();
  return { schemaVersion: 2, stateVersion: workbench.stateVersion(), items, tasks, events, updatedAt };
}

function mapTaskInput(task) {
  return {
    id: task.id,
    requirementId: task.featureId || null,
    provider: task.model || "",
    executorType: task.executorType || "manual_handoff",
    assignee: task.assignee || "",
    taskText: task.task || task.taskText || "",
    resultNote: task.suggestion || "",
    acceptance: task.acceptance !== undefined ? task.acceptance : task.acceptanceCriteria,
    fileScope: task.fileScope,
    suggestion: task.suggestion || "",
    blockedReason: task.blockedReason || "",
    status: task.status || "queued",
  };
}

function syncTaskStatus(workbench, before, after) {
  if (before.status === after.status) return;
  // A local-storage fallback can continue a task while the relational database is
  // unavailable. When that newer cache is chosen on restart, replay the minimal
  // legal lifecycle rather than attempting an illegal queued -> review/done jump.
  if (["review", "done"].includes(after.status) && ["clarification", "queued", "blocked", "working"].includes(before.status)) {
    let current = workbench.getTask(before.id);
    if (["clarification", "blocked"].includes(current.status)) {
      workbench.transitionTask(before.id, "queued", { expectedRevision: current.revision });
      current = workbench.getTask(before.id);
    }
    if (current.status === "queued") {
      workbench.startTask(before.id, { expectedRevision: current.revision });
      current = workbench.getTask(before.id);
    }
    if (current.status === "working") {
      const run = workbench.listRuns(before.id).slice().reverse().find((entry) => entry.status === "running");
      if (!run) throw conflict("本地缓存包含执行结果，但数据库中没有对应的运行记录");
      if (!after.suggestion?.trim()) throw invalid("提交验收前必须填写执行结果");
      workbench.submitResult(run.id, { summary: after.suggestion, evidence: [], expectedTaskRevision: current.revision });
      current = workbench.getTask(before.id);
    }
    if (after.status === "done" && current.status === "review") {
      workbench.acceptTask(before.id, { expectedRevision: current.revision });
    }
    return;
  }
  if (after.status === "working") {
    workbench.startTask(before.id, { expectedRevision: before.revision });
    return;
  }
  if (after.status === "review") {
    const run = workbench.listRuns(before.id).slice().reverse().find((entry) => entry.status === "running");
    if (!run) throw conflict("任务没有运行中的 Run，不能提交验收");
    if (!after.suggestion?.trim()) throw invalid("提交验收前必须填写执行结果");
    workbench.submitResult(run.id, { summary: after.suggestion, evidence: [], expectedTaskRevision: before.revision });
    return;
  }
  if (after.status === "done") {
    workbench.acceptTask(before.id, { expectedRevision: before.revision });
    return;
  }
  if (after.status === "queued" && before.status === "working") {
    const run = workbench.listRuns(before.id).slice().reverse().find((entry) => entry.status === "running");
    if (!run) throw conflict("任务没有运行中的 Run，不能报告失败并重试");
    workbench.reportFailure(run.id, { message: after.blockedReason || after.suggestion || "用户将任务退回待执行" });
    return;
  }
  if (after.status === "queued" && before.status === "review") {
    workbench.rejectTask(before.id, { note: after.blockedReason || after.suggestion || "验收退回，请补充修改意见", expectedRevision: before.revision });
    return;
  }
  if (after.status === "queued" && before.status === "done") {
    workbench.reopenTask(before.id, { reason: after.blockedReason || after.suggestion || "重新打开任务", expectedRevision: before.revision });
    return;
  }
  workbench.transitionTask(before.id, after.status, {
    reason: after.blockedReason || "",
    expectedRevision: before.revision,
  });
}

/** Compatibility write path for the current single-page UI; domain operations remain server-owned. */
export function syncLegacyState(db, desiredValue, { workbench = createWorkbench(db), backupDirectory } = {}) {
  const desired = normalizeLegacyState(desiredValue);
  if (!hasWorkspaceData(db)) {
    if (!desired.items.length && !desired.tasks.length && !desired.events.length) return exportLegacyState(db, workbench);
    const result = commitLegacyImport(db, desired, { origin: "local-api-state", backupDirectory });
    if (result.status === "invalid") throw new Error(result.warnings?.join("; ") || "导入数据格式无效");
    return exportLegacyState(db, workbench);
  }

  const currentVersion = workbench.stateVersion();
  if (!Number.isInteger(desired.stateVersion) || desired.stateVersion !== currentVersion) {
    throw new WorkbenchError("STALE_STATE", `工作区已在其他标签页发生变化（当前版本 ${currentVersion}）。请重新载入后再编辑。`, 409, { currentStateVersion: currentVersion });
  }

  transaction(db, () => {
    const existingRequirements = workbench.listRequirements({ includeDeleted: true });
    const activeRequirements = new Map(existingRequirements.filter((item) => !item.deletedAt).map((item) => [item.id, item]));
    const desiredRequirements = new Map(desired.items.map((item) => [item.id, item]));
    for (const item of desired.items) {
      const old = activeRequirements.get(item.id);
      if (!old) {
        const deleted = existingRequirements.find((entry) => entry.id === item.id && entry.deletedAt);
        if (deleted) workbench.restoreRequirement(item.id, item);
        else workbench.createRequirement(item);
      }
      else {
        const patch = {};
        for (const field of ["module", "title", "description", "sourceVersion", "targetVersion", "decision", "decisionNote"]) {
          if (item[field] !== undefined && item[field] !== old[field]) patch[field] = item[field];
        }
        if (Object.keys(patch).length) workbench.updateRequirement(item.id, patch, { expectedRevision: old.revision });
      }
    }
    for (const old of activeRequirements.values()) if (!desiredRequirements.has(old.id)) workbench.deleteRequirement(old.id, { reason: "从本地工作台需求清单删除" });

    const currentTasks = new Map(workbench.listTasks().map((item) => [item.id, item]));
    const desiredTasks = new Map(desired.tasks.map((item) => [item.id, item]));
    for (const raw of desired.tasks) {
      const input = mapTaskInput(raw);
      const old = currentTasks.get(input.id);
      if (!old) {
        if (!["clarification", "queued"].includes(input.status)) throw invalid("新任务只能从待澄清或待执行状态创建");
        workbench.createTask(input);
        continue;
      }
      const patch = {};
      for (const field of ["requirementId", "provider", "executorType", "assignee", "taskText", "resultNote", "acceptance", "fileScope"]) {
        if (input[field] !== undefined && JSON.stringify(input[field]) !== JSON.stringify(old[field])) patch[field] = input[field];
      }
      if (Object.keys(patch).length) workbench.updateTask(input.id, patch, { expectedRevision: old.revision });
      const latest = workbench.getTask(input.id);
      syncTaskStatus(workbench, { ...old, revision: latest.revision }, input);
    }
    // Tasks are retained as history; removing a task from a client snapshot never deletes it.
    void desiredTasks;
  });
  return exportLegacyState(db, workbench);
}

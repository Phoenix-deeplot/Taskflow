import { all, backupDatabase, one, transaction } from "./db.mjs";
import { DECISIONS, TASK_STATUSES } from "./state-machine.mjs";
import { canonicalJson, isoOrNow, sha256, text } from "./util.mjs";

const WORKSPACE_ID = "WS-LOCAL";
const ACTOR = "local-user";
const REQUIREMENT_COMPARE = ["module", "title", "description", "source_version", "target_version", "decision", "decision_note"];
const TASK_COMPARE = ["provider", "assignee", "task_text", "status", "blocked_reason"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const present = (value) => typeof value === "string" && value.trim().length > 0;

function legacyEventKey(event) {
  return event.id !== undefined && event.id !== null ? `id:${event.id}` : `hash:${sha256(canonicalJson(event))}`;
}

/**
 * Builds the full import plan for a legacy `{ items, tasks, events }` state without touching the database.
 * The returned `report` is what the preview shows; `rows` is what a commit would insert.
 */
export function planLegacyImport(db, state) {
  const report = {
    status: "ready",
    sourceHash: null,
    counts: {
      requirements: { total: 0, new: 0, identical: 0, conflicts: 0, invalid: 0 },
      tasks: { total: 0, new: 0, identical: 0, conflicts: 0, invalid: 0 },
      events: { total: 0, new: 0, alreadyImported: 0, invalid: 0 },
      legacyRuns: 0,
    },
    conflicts: [], invalid: [], orphanTasks: [], warnings: [],
  };
  const rows = { requirements: [], tasks: [], runs: [], events: [] };
  const fail = (message) => {
    report.status = "invalid";
    report.warnings.push(message);
    return { report, rows };
  };

  if (!isObject(state)) return fail("导入内容不是对象");
  if (!Array.isArray(state.items)) return fail("找不到 items 数组");
  const items = state.items;
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const events = Array.isArray(state.events) ? state.events : [];
  report.sourceHash = sha256(canonicalJson({ items, tasks, events }));

  if (one(db, "SELECT 1 AS x FROM migration_sources WHERE source_hash = ?", report.sourceHash)) {
    report.status = "already_imported";
    return { report, rows };
  }

  const existingRequirements = new Map(all(db, "SELECT * FROM requirements").map((row) => [row.id, row]));
  const knownRequirementIds = new Set(existingRequirements.keys());
  const seenRequirements = new Set();

  items.forEach((item, index) => {
    report.counts.requirements.total += 1;
    if (!isObject(item) || !present(item.id) || !present(item.title)) {
      report.counts.requirements.invalid += 1;
      report.invalid.push({ kind: "requirement", index, reason: "缺少 id 或 title" });
      return;
    }
    if (seenRequirements.has(item.id)) {
      report.counts.requirements.invalid += 1;
      report.invalid.push({ kind: "requirement", index, id: item.id, reason: "载荷内 ID 重复，已忽略后出现的记录" });
      return;
    }
    seenRequirements.add(item.id);
    let decision = item.decision;
    if (!DECISIONS.includes(decision)) {
      if (decision !== undefined) report.warnings.push(`需求 ${item.id} 的决策“${decision}”无效，已按“待讨论”导入`);
      decision = "pending";
    }
    const now = new Date().toISOString();
    const row = {
      id: item.id, revision: 1, module: text(item.module), title: item.title.trim(), description: text(item.description),
      source_version: text(item.sourceVersion), target_version: present(item.targetVersion) ? item.targetVersion : "V1", decision,
      decision_note: text(item.decisionNote), created_at: isoOrNow(item.createdAt, now), updated_at: isoOrNow(item.updatedAt, isoOrNow(item.createdAt, now)),
    };
    const existing = existingRequirements.get(item.id);
    if (existing) {
      const differing = REQUIREMENT_COMPARE.filter((field) => existing[field] !== row[field]);
      if (differing.length) {
        report.counts.requirements.conflicts += 1;
        report.conflicts.push({ kind: "requirement", id: item.id, fields: differing });
      } else report.counts.requirements.identical += 1;
      return;
    }
    report.counts.requirements.new += 1;
    knownRequirementIds.add(item.id);
    rows.requirements.push(row);
  });

  const existingTasks = new Map(all(db, "SELECT * FROM tasks").map((row) => [row.id, row]));
  const seenTasks = new Set();
  tasks.forEach((task, index) => {
    report.counts.tasks.total += 1;
    if (!isObject(task) || !present(task.id)) {
      report.counts.tasks.invalid += 1;
      report.invalid.push({ kind: "task", index, reason: "缺少 id" });
      return;
    }
    if (seenTasks.has(task.id)) {
      report.counts.tasks.invalid += 1;
      report.invalid.push({ kind: "task", index, id: task.id, reason: "载荷内 ID 重复，已忽略后出现的记录" });
      return;
    }
    seenTasks.add(task.id);
    let status = task.status ?? "queued";
    if (!TASK_STATUSES.includes(status)) {
      report.warnings.push(`任务 ${task.id} 的状态“${task.status}”无效，已按“待执行”导入`);
      status = "queued";
    }
    let blockedReason = status === "blocked" ? text(task.blockedReason) : "";
    if (status === "blocked" && !present(blockedReason)) {
      report.warnings.push(`任务 ${task.id} 处于阻塞但没有记录原因`);
      blockedReason = "（迁移前未记录阻塞原因）";
    }
    const linked = present(task.featureId) && knownRequirementIds.has(task.featureId);
    const now = new Date().toISOString();
    const row = {
      id: task.id, requirement_id: linked ? task.featureId : null, revision: 1, status,
      provider: text(task.model), executor_type: "manual_handoff", assignee: text(task.assignee), task_text: text(task.task),
      result_note: text(task.suggestion), acceptance_json: "[]", file_scope_json: "[]", blocked_reason: blockedReason,
      legacy_requirement_title: linked ? null : text(task.featureTitle) || null,
      legacy_requirement_module: linked ? null : text(task.featureModule) || null,
      created_at: isoOrNow(task.createdAt, now), updated_at: isoOrNow(task.updatedAt, isoOrNow(task.createdAt, now)),
    };
    const existing = existingTasks.get(task.id);
    if (existing) {
      const differing = TASK_COMPARE.filter((field) => existing[field] !== row[field]);
      if (differing.length) {
        report.counts.tasks.conflicts += 1;
        report.conflicts.push({ kind: "task", id: task.id, fields: differing });
      } else report.counts.tasks.identical += 1;
      return;
    }
    if (!linked) report.orphanTasks.push({ id: task.id, featureId: text(task.featureId), featureTitle: text(task.featureTitle) });
    report.counts.tasks.new += 1;
    rows.tasks.push(row);

    // Only tasks that actually got going have a run history. A note on a queued/blocked task stays a note (result_note).
    const suggestion = text(task.suggestion);
    if (status === "working" || status === "review" || status === "done") {
      const running = status === "working";
      rows.runs.push({
        id: `RUN-LEG-${task.id}`, task_id: task.id, attempt: 1, status: running ? "running" : "succeeded",
        started_at: row.created_at, ended_at: running ? null : row.updated_at, result_summary: suggestion,
        review_decision: status === "done" ? "accepted" : null, reviewed_at: status === "done" ? row.updated_at : null,
      });
      report.counts.legacyRuns += 1;
    }
  });

  const importedEventKeys = new Set(
    all(db, "SELECT json_extract(payload_json, '$.legacyKey') AS k FROM events WHERE event_type = 'legacy.import'").map((row) => row.k),
  );
  const entityType = { feature: "requirement", ai_task: "task", workspace: "workspace" };
  const planned = [];
  events.forEach((event, index) => {
    report.counts.events.total += 1;
    if (!isObject(event) || !present(event.action)) {
      report.counts.events.invalid += 1;
      report.invalid.push({ kind: "event", index, reason: "缺少 action" });
      return;
    }
    const key = legacyEventKey(event);
    if (importedEventKeys.has(key)) { report.counts.events.alreadyImported += 1; return; }
    importedEventKeys.add(key);
    const createdAt = isoOrNow(event.createdAt, new Date().toISOString());
    planned.push({
      entity_type: entityType[event.entityType] || text(event.entityType, "workspace") || "workspace",
      entity_id: text(event.entityId, "workspace") || "workspace",
      payload: { legacyKey: key, legacyId: event.id ?? null, action: event.action, actor: text(event.actor), before: event.before ?? null, after: event.after ?? null },
      created_at: createdAt, order: index,
    });
  });
  // Legacy history is stored newest-first; write oldest-first so autoincrement ids follow time.
  planned.sort((a, b) => a.created_at.localeCompare(b.created_at) || b.order - a.order);
  rows.events = planned;
  report.counts.events.new = planned.length;

  const nothing = !rows.requirements.length && !rows.tasks.length && !rows.events.length;
  if (nothing) report.status = "nothing_to_import";
  return { report, rows };
}

/** Dry run: no writes. */
export function previewLegacyImport(db, state) {
  return planLegacyImport(db, state).report;
}

/**
 * Imports legacy browser data. Never overwrites existing records; conflicts are skipped and reported.
 * A pre-import backup is taken when `backupDirectory` is given, and the whole import is one transaction
 * that is rolled back if the resulting row counts do not match the plan.
 */
export function commitLegacyImport(db, state, { origin = "", backupDirectory, clock = () => new Date().toISOString() } = {}) {
  const { report, rows } = planLegacyImport(db, state);
  if (report.status === "invalid" || report.status === "already_imported") return { ...report, committed: false };

  const backupPath = backupDirectory ? backupDatabase(db, backupDirectory, "pre-legacy-import") : null;
  const countOf = (table, ids) => ids.length
    ? one(db, `SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).n
    : 0;

  try {
    transaction(db, () => {
      const now = clock();
      const insertRequirement = db.prepare(`INSERT INTO requirements (id, workspace_id, revision, module, title, description, source_version,
        target_version, decision, decision_note, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rows.requirements) {
        insertRequirement.run(r.id, WORKSPACE_ID, r.module, r.title, r.description, r.source_version, r.target_version, r.decision,
          r.decision_note, r.created_at, r.updated_at);
      }
      const insertTask = db.prepare(`INSERT INTO tasks (id, workspace_id, requirement_id, revision, status, provider, executor_type, assignee,
        task_text, result_note, acceptance_json, file_scope_json, blocked_reason, legacy_requirement_title, legacy_requirement_module, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const t of rows.tasks) {
        insertTask.run(t.id, WORKSPACE_ID, t.requirement_id, t.status, t.provider, t.executor_type, t.assignee, t.task_text, t.result_note,
          t.acceptance_json, t.file_scope_json, t.blocked_reason, t.legacy_requirement_title, t.legacy_requirement_module, t.created_at, t.updated_at);
      }
      const insertRun = db.prepare(`INSERT INTO task_runs (id, task_id, snapshot_id, attempt, status, started_at, ended_at, result_summary,
        review_decision, reviewed_at, is_legacy) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1)`);
      for (const r of rows.runs) {
        insertRun.run(r.id, r.task_id, r.attempt, r.status, r.started_at, r.ended_at, r.result_summary, r.review_decision, r.reviewed_at);
      }
      const insertEvent = db.prepare(`INSERT INTO events (workspace_id, entity_type, entity_id, run_id, event_type, actor_id, payload_json, created_at)
        VALUES (?, ?, ?, NULL, 'legacy.import', ?, ?, ?)`);
      for (const e of rows.events) insertEvent.run(WORKSPACE_ID, e.entity_type, e.entity_id, ACTOR, JSON.stringify(e.payload), e.created_at);

      // Verify before committing: anything missing aborts and rolls back the whole import.
      const got = {
        requirements: countOf("requirements", rows.requirements.map((r) => r.id)),
        tasks: countOf("tasks", rows.tasks.map((t) => t.id)),
        runs: countOf("task_runs", rows.runs.map((r) => r.id)),
      };
      if (got.requirements !== rows.requirements.length || got.tasks !== rows.tasks.length || got.runs !== rows.runs.length) {
        throw new Error(`迁移核对失败：${JSON.stringify(got)}，已回滚`);
      }

      db.prepare(`INSERT INTO migration_sources (kind, source_hash, origin, received_at, raw_json, report_json) VALUES ('localStorage-v1', ?, ?, ?, ?, ?)`)
        .run(report.sourceHash, origin, now, JSON.stringify(state), JSON.stringify(report));
      db.prepare(`INSERT INTO events (workspace_id, entity_type, entity_id, run_id, event_type, actor_id, payload_json, created_at)
        VALUES (?, 'workspace', ?, NULL, 'migration.legacy_import', ?, ?, ?)`)
        .run(WORKSPACE_ID, WORKSPACE_ID, ACTOR, JSON.stringify({ origin, sourceHash: report.sourceHash, counts: report.counts, backupPath }), now);
    });
  } catch (error) {
    throw new Error(`旧数据迁移失败，数据库未改变：${error.message}`, { cause: error });
  }
  return { ...report, status: "imported", committed: true, backupPath };
}

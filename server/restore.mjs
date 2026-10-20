import { existsSync } from "node:fs";
import { all, backupDatabase, one, openDatabase, transaction } from "./db.mjs";
import { WorkbenchError } from "./util.mjs";

const WORKSPACE_ID = "WS-LOCAL";
const ACTOR = "local-user";

/** Export key -> table, in foreign-key order. */
const TABLES = [
  ["settings", "settings"],
  ["requirements", "requirements"],
  ["splitDrafts", "split_drafts"],
  ["tasks", "tasks"],
  ["taskDependencies", "task_dependencies"],
  ["snapshots", "task_context_snapshots"],
  ["runs", "task_runs"],
  ["artifacts", "artifacts"],
  ["events", "events"],
  ["migrationSources", "migration_sources"],
];
// Sections added after the first v2 exports; older files simply do not have them.
const OPTIONAL_KEYS = new Set(["migrationSources", "splitDrafts", "artifacts", "settings"]);
const BUSINESS_TABLES = ["requirements", "split_drafts", "tasks", "task_runs", "artifacts", "task_context_snapshots", "events", "migration_sources"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function columnsOf(db, table) {
  return all(db, `PRAGMA table_info(${table})`).map((column) => column.name);
}

/** Dry run: validates an `exportAll()` document against the target database without writing. */
export function previewRestore(db, doc) {
  const report = { status: "ready", counts: {}, problems: [], warnings: [] };
  const problem = (message) => { report.status = "invalid"; report.problems.push(message); };

  if (!isObject(doc)) { problem("导入内容不是对象"); return report; }
  if (doc.schemaVersion === 1 || (doc.schemaVersion === undefined && Array.isArray(doc.items))) {
    problem("这是旧版（v1）备份，请使用“旧数据迁移/合并导入”而不是整库恢复");
    return report;
  }
  if (doc.schemaVersion !== 2) { problem(`不支持的导出版本：${doc.schemaVersion}`); return report; }
  if (!isObject(doc.workspace) || doc.workspace.id !== WORKSPACE_ID) problem(`工作区必须是 ${WORKSPACE_ID}`);
  if (!Array.isArray(doc.contextVersions) || !doc.contextVersions.length) problem("缺少 contextVersions");

  const ids = {};
  for (const [key, table] of TABLES) {
    const rows = doc[key];
    if (rows === undefined && OPTIONAL_KEYS.has(key)) { report.counts[key] = 0; continue; }
    if (!Array.isArray(rows)) { problem(`缺少数组：${key}`); continue; }
    report.counts[key] = rows.length;
    const columns = new Set(columnsOf(db, table));
    const seen = new Set(); let unknown = 0;
    rows.forEach((row, index) => {
      if (!isObject(row)) { problem(`${key}[${index}] 不是对象`); return; }
      for (const name of Object.keys(row)) if (!columns.has(name)) unknown += 1;
      const primary = table === "settings" ? row.key : row.id;
      if (table !== "task_dependencies") {
        if (primary === undefined || primary === null) { problem(`${key}[${index}] 缺少 id`); return; }
        if (seen.has(primary)) problem(`${key} 中 id 重复：${primary}`);
        seen.add(primary);
      }
      if (row.workspace_id !== undefined && row.workspace_id !== WORKSPACE_ID) problem(`${key}[${index}] 属于其他工作区：${row.workspace_id}`);
    });
    if (unknown) report.warnings.push(`${key} 中有 ${unknown} 个未知字段，将被忽略`);
    ids[key] = seen;
  }

  if (report.status !== "invalid") {
    const has = (key, id) => ids[key]?.has(id);
    doc.tasks.forEach((task) => { if (task.requirement_id && !has("requirements", task.requirement_id)) problem(`任务 ${task.id} 引用了不存在的需求 ${task.requirement_id}`); });
    doc.taskDependencies.forEach((dep) => {
      if (!has("tasks", dep.task_id) || !has("tasks", dep.depends_on_task_id)) problem(`依赖 ${dep.task_id} -> ${dep.depends_on_task_id} 引用了不存在的任务`);
    });
    doc.snapshots.forEach((s) => { if (!has("tasks", s.task_id)) problem(`快照 ${s.id} 引用了不存在的任务 ${s.task_id}`); });
    (doc.splitDrafts ?? []).forEach((d) => { if (!has("requirements", d.requirement_id)) problem(`拆分草稿 ${d.id} 引用了不存在的需求 ${d.requirement_id}`); });
    (doc.artifacts ?? []).forEach((a) => { if (!has("runs", a.run_id)) problem(`产物 ${a.id} 引用了不存在的运行 ${a.run_id}`); });
    doc.runs.forEach((run) => {
      if (!has("tasks", run.task_id)) problem(`运行 ${run.id} 引用了不存在的任务 ${run.task_id}`);
      if (run.snapshot_id && !has("snapshots", run.snapshot_id)) problem(`运行 ${run.id} 引用了不存在的快照 ${run.snapshot_id}`);
    });
  }

  if (report.status !== "invalid") {
    const occupied = BUSINESS_TABLES.filter((table) => one(db, `SELECT COUNT(*) AS n FROM ${table}`).n > 0);
    if (occupied.length) {
      report.status = "not_empty";
      report.problems.push(`目标数据库已有数据（${occupied.join("、")}）。整库恢复只能用于空库；请改用新数据库文件，或用合并导入`);
    }
  }
  return report;
}

function insertRows(db, table, rows) {
  const columns = new Set(columnsOf(db, table));
  const statements = new Map();
  for (const row of rows) {
    const names = Object.keys(row).filter((name) => columns.has(name));
    const signature = names.join(",");
    if (!statements.has(signature)) {
      statements.set(signature, db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`));
    }
    statements.get(signature).run(...names.map((name) => row[name]));
  }
}

/**
 * Restores a full `exportAll()` document into an EMPTY database, in one transaction.
 * Takes a backup first when `backupDirectory` is given and rolls back if anything fails or the counts differ.
 */
export function restoreFromExport(db, doc, { backupDirectory, recordEvent = true, clock = () => new Date().toISOString() } = {}) {
  const report = previewRestore(db, doc);
  if (report.status === "invalid") throw new WorkbenchError("INVALID_EXPORT", `导出文件无效：${report.problems[0]}`, 400, { problems: report.problems });
  if (report.status === "not_empty") throw new WorkbenchError("NOT_EMPTY", report.problems[0], 409, { problems: report.problems });

  const backupPath = backupDirectory ? backupDatabase(db, backupDirectory, "pre-restore") : null;
  try {
    transaction(db, () => {
      db.prepare("DELETE FROM workspace_context_versions").run();
      insertRows(db, "workspace_context_versions", doc.contextVersions);
      db.prepare("UPDATE workspaces SET name = ?, revision = ?, created_at = ? WHERE id = ?")
        .run(doc.workspace.name ?? "本地工作区", doc.workspace.revision ?? 1, doc.workspace.created_at ?? clock(), WORKSPACE_ID);
      for (const [key, table] of TABLES) insertRows(db, table, doc[key] ?? []);

      for (const [key, table] of TABLES) {
        const got = one(db, `SELECT COUNT(*) AS n FROM ${table}`).n;
        if (got !== (doc[key] ?? []).length) throw new Error(`${table} 条数核对失败：期望 ${(doc[key] ?? []).length}，实际 ${got}`);
      }
      if (recordEvent) {
        db.prepare(`INSERT INTO events (workspace_id, entity_type, entity_id, run_id, event_type, actor_id, payload_json, created_at)
                    VALUES (?, 'workspace', ?, NULL, 'restore.completed', ?, ?, ?)`)
          .run(WORKSPACE_ID, WORKSPACE_ID, ACTOR, JSON.stringify({ counts: report.counts, exportedAt: doc.exportedAt ?? null, backupPath }), clock());
      }
    });
  } catch (error) {
    throw new WorkbenchError("RESTORE_FAILED", `整库恢复失败，数据库未改变：${error.message}`, 500, { cause: error.message });
  }
  return { ...report, status: "restored", backupPath };
}

/** Builds a brand-new database file from an export. Refuses to touch an existing file. */
export function createDatabaseFromExport(doc, filePath, options = {}) {
  if (existsSync(filePath)) throw new WorkbenchError("FILE_EXISTS", `目标文件已存在：${filePath}`, 409);
  const db = openDatabase(filePath);
  try {
    const report = restoreFromExport(db, doc, options);
    return { db, report };
  } catch (error) {
    db.close();
    throw error;
  }
}

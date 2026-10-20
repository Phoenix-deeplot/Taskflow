import { one } from "./db.mjs";
import { parseJson } from "./util.mjs";

/**
 * What a runner needs to know before it touches the project, decided here so every adapter (Claude Code,
 * Codex, ...) behaves the same:
 *   - projectPath  the directory agents work in (setting `project.path`; null = the server's own directory)
 *   - access       "read-only" for analysis tasks, "write-on-branch" for execution tasks
 *   - branch       the branch/worktree an execution run must use (null when read-only); never the main branch
 *   - autoApprove  always false: no adapter may switch on "approve everything" by default
 *
 * Adapters report back through artifacts: kind "branch" (uri "git:<branch>", metadata { base, commit })
 * and kind "diff" (the change as a file).
 */
export const accessFor = (kind) => (kind === "analysis" ? "read-only" : "write-on-branch");

export function branchNameFor(taskId, attempt) {
  const slug = String(taskId).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "");
  return `wb/${slug || "task"}-a${attempt}`;
}

export function readProjectPath(db) {
  const row = one(db, "SELECT value_json FROM settings WHERE key = 'project.path'");
  return row ? parseJson(row.value_json, null) : null;
}

export function workspaceContract(db, { taskId, kind, attempt }) {
  const access = accessFor(kind);
  return {
    projectPath: readProjectPath(db),
    access,
    branch: access === "read-only" ? null : branchNameFor(taskId, attempt),
    autoApprove: false,
  };
}

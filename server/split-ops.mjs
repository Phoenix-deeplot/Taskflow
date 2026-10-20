import { all, one } from "./db.mjs";
import { normalizeSplitTasks } from "./split.mjs";
import { WorkbenchError, conflict, invalid, nonEmpty, notFound, parseJson } from "./util.mjs";

export const toDraft = (r) => r && ({
  id: r.id, requirementId: r.requirement_id, requirementRevision: r.requirement_revision, status: r.status, source: r.source,
  provider: r.provider, model: r.model, promptTemplateVersion: r.prompt_template_version, inputHash: r.input_hash,
  input: parseJson(r.input_json, {}), tasks: parseJson(r.tasks_json, []), usage: parseJson(r.usage_json, {}),
  confirmedTaskIds: parseJson(r.confirmed_task_ids_json, []), discardReason: r.discard_reason, revision: r.revision,
  createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at,
});

/** Split-draft operations; `kit` is the shared toolbox created inside createWorkbench. */
export function createSplitOps(kit) {
  const { db, tx, emit, clock, workspaceId, uniqueId, requireRequirementRow, checkRevision, splitRequirement } = kit;

  function requireDraftRow(id) {
    const row = one(db, "SELECT * FROM split_drafts WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!row) throw notFound(`找不到拆分草稿 ${id}`);
    return row;
  }
  const requireOpen = (row) => {
    if (row.status !== "draft") throw conflict(`拆分草稿 ${row.id} 已${row.status === "confirmed" ? "确认" : "丢弃"}，不能再修改`);
  };

  /** Stores a proposal. `provider` present means it came from a model (tasks then default to "待澄清"). */
  function createSplitDraft(requirementId, { tasks, provider = "", model = "", usage = {}, input = {}, inputHash = "", promptTemplateVersion = "", requirementRevision } = {}) {
    const source = nonEmpty(provider) ? "provider" : "manual";
    const cleaned = normalizeSplitTasks(tasks, { defaultStatus: source === "provider" ? "clarification" : "queued" });
    return tx(() => {
      const requirement = requireRequirementRow(requirementId);
      if (requirement.deleted_at) throw conflict(`需求 ${requirementId} 已删除，不能拆分`);
      const id = uniqueId("SPLIT", "split_drafts");
      const now = clock();
      db.prepare(`INSERT INTO split_drafts (id, workspace_id, requirement_id, requirement_revision, status, source, provider, model,
                  prompt_template_version, input_json, input_hash, tasks_json, usage_json, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, workspaceId, requirementId, requirementRevision ?? requirement.revision, source, provider, model, promptTemplateVersion,
          JSON.stringify(input), inputHash, JSON.stringify(cleaned), JSON.stringify(usage), now, now);
      emit("split_draft", id, "split.drafted", { requirementId, source, provider, model, taskCount: cleaned.length, usage });
      return toDraft(requireDraftRow(id));
    });
  }

  function updateSplitDraft(id, { tasks } = {}, { expectedRevision } = {}) {
    return tx(() => {
      const row = requireDraftRow(id);
      requireOpen(row);
      checkRevision(row, expectedRevision, "拆分草稿");
      const cleaned = normalizeSplitTasks(tasks, { defaultStatus: row.source === "provider" ? "clarification" : "queued" });
      db.prepare("UPDATE split_drafts SET tasks_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(cleaned), clock(), id);
      emit("split_draft", id, "split.edited", { taskCount: cleaned.length });
      return toDraft(requireDraftRow(id));
    });
  }

  /**
   * The only way a draft becomes real tasks. Refuses when the requirement changed after the draft was made
   * unless `acceptStale` is set, so a person has seen what the proposal was based on.
   */
  function confirmSplitDraft(id, { expectedRevision, acceptStale = false } = {}) {
    return tx(() => {
      const row = requireDraftRow(id);
      requireOpen(row);
      checkRevision(row, expectedRevision, "拆分草稿");
      const requirement = requireRequirementRow(row.requirement_id);
      if (requirement.deleted_at) throw conflict(`需求 ${row.requirement_id} 已删除，不能确认拆分`);
      if (requirement.revision !== row.requirement_revision && !acceptStale) {
        throw new WorkbenchError("STALE_DRAFT", `需求在草稿生成后已修改（草稿基于版本 ${row.requirement_revision}，当前 ${requirement.revision}）。请重新审阅，或明确接受后再确认。`, 409,
          { draftRevision: row.requirement_revision, currentRevision: requirement.revision });
      }
      const result = splitRequirement(row.requirement_id, parseJson(row.tasks_json, []));
      const taskIds = result.tasks.map((task) => task.id);
      const now = clock();
      db.prepare("UPDATE split_drafts SET status = 'confirmed', confirmed_task_ids_json = ?, decided_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(taskIds), now, now, id);
      emit("split_draft", id, "split.confirmed", { requirementId: row.requirement_id, taskIds, acceptedStale: acceptStale && requirement.revision !== row.requirement_revision });
      return { draft: toDraft(requireDraftRow(id)), ...result };
    });
  }

  function discardSplitDraft(id, { reason = "" } = {}) {
    return tx(() => {
      const row = requireDraftRow(id);
      requireOpen(row);
      const now = clock();
      db.prepare("UPDATE split_drafts SET status = 'discarded', discard_reason = ?, decided_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(String(reason).trim(), now, now, id);
      emit("split_draft", id, "split.discarded", { reason: String(reason).trim() });
      return toDraft(requireDraftRow(id));
    });
  }

  const getSplitDraft = (id) => toDraft(requireDraftRow(id));

  function listSplitDrafts({ requirementId, status } = {}) {
    const where = ["workspace_id = ?"]; const params = [workspaceId];
    if (requirementId) { where.push("requirement_id = ?"); params.push(requirementId); }
    if (status) { where.push("status = ?"); params.push(status); }
    return all(db, `SELECT * FROM split_drafts WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC`, ...params).map(toDraft);
  }

  /** A failed model call leaves a trace (without the secret-free input) so the history explains why no draft exists. */
  function recordSplitFailure(requirementId, { provider = "", model = "", code = "PROVIDER_ERROR", message = "" } = {}) {
    return tx(() => {
      requireRequirementRow(requirementId);
      emit("requirement", requirementId, "split.proposal_failed", { provider, model, code, message });
    });
  }

  return { createSplitDraft, updateSplitDraft, confirmSplitDraft, discardSplitDraft, getSplitDraft, listSplitDrafts, recordSplitFailure };
}

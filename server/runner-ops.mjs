import { randomBytes, timingSafeEqual } from "node:crypto";
import { all, one } from "./db.mjs";
import { scopesOverlap } from "./file-scope.mjs";
import { WorkbenchError, conflict, invalid, nonEmpty, parseJson, sha256 } from "./util.mjs";
import { workspaceContract } from "./workspace.mjs";

export const toArtifact = (r) => r && ({
  id: r.id, runId: r.run_id, kind: r.kind, uri: r.uri, checksum: r.checksum, sizeBytes: r.size_bytes,
  metadata: parseJson(r.metadata_json, {}), createdAt: r.created_at,
});

const leaseSeconds = (value) => {
  const n = Number(value ?? 60);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 5), 3600) : 60;
};
const plus = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const isLive = (run, now) => Boolean(run.lease_until) && Date.parse(run.lease_until) > Date.parse(now);
const lost = (reason, status) => new WorkbenchError("LEASE_LOST", `${reason}，请停止执行`, 409, { runStatus: status });

/**
 * Runner-facing operations: dispatch is in the main service; this file holds claim, lease, heartbeat,
 * idempotent callbacks, cancellation, recovery and artifacts. `kit` is the toolbox built in createWorkbench.
 *
 * A lease is a random token returned once at claim time; only its SHA-256 is stored. A runner that stops
 * heartbeating loses its run: expiry marks it `worker_lost` and returns the task to the queue.
 */
export function createRunnerOps(kit) {
  const { db, tx, emit, clock, workspaceId, uniqueId, requireRunRow, requireTaskRow, setTaskStatus, toRun, toTask, getSnapshot } = kit;

  /** Manual hand-off runs (never claimed) need no token; claimed runs always do. */
  function requireToken(run, leaseToken) {
    if (!run.claimed_by) return;
    const given = Buffer.from(sha256(String(leaseToken ?? "")), "hex");
    const stored = Buffer.from(run.lease_token_hash ?? "", "hex");
    if (!nonEmpty(leaseToken) || given.length !== stored.length || !timingSafeEqual(given, stored)) {
      throw new WorkbenchError("LEASE_INVALID", "租约令牌缺失或无效", 401);
    }
  }

  function replay(runId, key, kind) {
    if (!nonEmpty(key)) return null;
    const row = one(db, "SELECT result_json FROM run_callbacks WHERE run_id = ? AND event_id = ?", runId, `${kind}:${key}`);
    return row ? parseJson(row.result_json, null) : null;
  }

  function remember(runId, key, kind, result) {
    if (!nonEmpty(key)) return;
    if (String(key).length > 200) throw invalid("幂等键太长（最多 200 字符）");
    db.prepare("INSERT INTO run_callbacks (run_id, event_id, result_json, created_at) VALUES (?, ?, ?, ?)")
      .run(runId, `${kind}:${key}`, JSON.stringify(result), clock());
  }

  /** Recovers every claimed run whose lease ran out. Must run inside a transaction. */
  function expireAt(now) {
    const expired = all(db, `SELECT * FROM task_runs WHERE status = 'running' AND claimed_by != '' AND lease_until IS NOT NULL AND lease_until <= ? ORDER BY started_at, id`, now);
    const ids = [];
    for (const run of expired) {
      const task = requireTaskRow(run.task_id);
      const cancelled = Boolean(run.cancel_requested_at);
      const message = cancelled ? run.cancel_reason : "Runner 的租约已过期，没有收到心跳或结果";
      db.prepare("UPDATE task_runs SET status = ?, ended_at = ?, error_code = ?, error_message = ? WHERE id = ?")
        .run(cancelled ? "cancelled" : "worker_lost", now, cancelled ? "CANCELLED" : "WORKER_LOST", message, run.id);
      if (task.status === "working") setTaskStatus(task, "queued");
      emit("run", run.id, cancelled ? "run.cancelled" : "run.worker_lost", { taskId: task.id, runnerId: run.claimed_by, leaseUntil: run.lease_until, reason: message }, run.id);
      emit("task", task.id, "task.transition", { from: "working", to: "queued", reason: message, attempt: run.attempt }, run.id);
      ids.push(run.id);
    }
    return ids.map((id) => toRun(requireRunRow(id)));
  }

  const expireLeases = () => tx(() => expireAt(clock()));

  /** Scopes held right now: running, claimed, unexpired runs whose task declared a file scope. */
  function heldScopes(now) {
    return all(db, `SELECT r.id, t.file_scope_json FROM task_runs r JOIN tasks t ON t.id = r.task_id
                    WHERE r.status = 'running' AND r.claimed_by != '' AND r.lease_until > ? AND t.workspace_id = ?`, now, workspaceId)
      .map((row) => ({ runId: row.id, scope: parseJson(row.file_scope_json, []) }))
      .filter((entry) => entry.scope.length);
  }

  /**
   * Atomically hands the oldest eligible pending run to a runner. Eligible = its executor type is in the
   * runner's capabilities and its declared file scope does not overlap a run that is running now.
   * Returns null when there is nothing to do. The lease token is returned only here.
   */
  function claimRun({ runnerId, capabilities, leaseSeconds: requested } = {}) {
    if (!nonEmpty(runnerId)) throw invalid("runnerId 不能为空");
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some((entry) => !nonEmpty(entry))) {
      throw invalid("capabilities 必须是非空的字符串数组（Runner 能执行的执行器类型）");
    }
    return tx(() => {
      const now = clock();
      expireAt(now);
      const pending = all(db, `SELECT r.* FROM task_runs r JOIN tasks t ON t.id = r.task_id
                               WHERE t.workspace_id = ? AND r.status = 'pending' AND r.executor_type IN (${capabilities.map(() => "?").join(",")})
                               ORDER BY r.started_at, r.rowid`, workspaceId, ...capabilities);
      if (!pending.length) return null;
      const held = heldScopes(now);
      for (const run of pending) {
        const task = requireTaskRow(run.task_id);
        const scope = parseJson(task.file_scope_json, []);
        if (scope.length && held.some((entry) => scopesOverlap(scope, entry.scope))) continue;
        const leaseToken = randomBytes(32).toString("hex");
        const leaseUntil = plus(now, leaseSeconds(requested));
        db.prepare(`UPDATE task_runs SET status = 'running', claimed_by = ?, claimed_at = ?, lease_token_hash = ?, lease_until = ?, heartbeat_at = ?
                    WHERE id = ? AND status = 'pending'`).run(runnerId, now, sha256(leaseToken), leaseUntil, now, run.id);
        emit("run", run.id, "run.claimed", { taskId: task.id, runnerId, leaseUntil }, run.id);
        return {
          run: toRun(requireRunRow(run.id)), task: toTask(requireTaskRow(task.id)),
          snapshot: getSnapshot(run.snapshot_id), leaseToken, leaseUntil,
          workspace: workspaceContract(db, { taskId: task.id, kind: task.kind, attempt: run.attempt }),
        };
      }
      return null;
    });
  }

  /** Throwing inside the transaction would undo an expiry it just performed, so outcomes are returned and thrown after. */
  function heartbeat(runId, leaseToken, { leaseSeconds: requested } = {}) {
    const outcome = tx(() => {
      const run = requireRunRow(runId);
      if (!run.claimed_by) throw invalid("该运行不是由 Runner 领取的，不需要心跳");
      requireToken(run, leaseToken);
      const now = clock();
      if (run.status !== "running") return { lost: `运行已是 ${run.status}`, status: run.status };
      if (!isLive(run, now)) { expireAt(now); return { lost: "租约已过期", status: "worker_lost" }; }
      const leaseUntil = plus(now, leaseSeconds(requested));
      db.prepare("UPDATE task_runs SET lease_until = ?, heartbeat_at = ? WHERE id = ?").run(leaseUntil, now, runId);
      return { leaseUntil, cancelRequested: Boolean(run.cancel_requested_at), cancelReason: run.cancel_reason };
    });
    if (outcome.lost) throw lost(outcome.lost, outcome.status);
    return outcome;
  }

  function appendRunEvent(runId, leaseToken, { eventId, type, message = "", data } = {}) {
    if (!nonEmpty(eventId) || String(eventId).length > 200) throw invalid("eventId 必填，且不超过 200 字符");
    if (!nonEmpty(type) || String(type).length > 60) throw invalid("type 必填，且不超过 60 字符");
    if (typeof message !== "string" || message.length > 4000) throw invalid("message 必须是不超过 4000 字的文本");
    if (data !== undefined && JSON.stringify(data).length > 16384) throw invalid("data 太大（最多 16 KB）");
    // Progress contract: data may carry { step?: string, pct?: number 0..100 }; the page shows them as given.
    if (type === "progress" && data?.pct !== undefined && !(typeof data.pct === "number" && data.pct >= 0 && data.pct <= 100)) {
      throw invalid("进度 pct 必须是 0 到 100 的数字");
    }
    if (type === "progress" && data?.step !== undefined && (typeof data.step !== "string" || data.step.length > 120)) {
      throw invalid("进度 step 必须是不超过 120 字的文本");
    }
    const outcome = tx(() => {
      const run = requireRunRow(runId);
      if (!run.claimed_by) throw invalid("该运行不是由 Runner 领取的");
      requireToken(run, leaseToken);
      const now = clock();
      if (run.status !== "running") return { lost: `运行已是 ${run.status}`, status: run.status };
      if (!isLive(run, now)) { expireAt(now); return { lost: "租约已过期", status: "worker_lost" }; }
      if (replay(runId, eventId, "event")) return { duplicate: true };
      remember(runId, eventId, "event", { ok: true });
      emit("run", runId, "run.progress", { taskId: run.task_id, type, message, data: data ?? null }, runId);
      return { duplicate: false };
    });
    if (outcome.lost) throw lost(outcome.lost, outcome.status);
    return outcome;
  }

  /**
   * A person cancels a run. Waiting or hand-off runs end at once; a runner-owned run is flagged, the runner
   * sees `cancelRequested` on its next heartbeat and confirms with `ackCancel`. If it never answers, the
   * lease expiry ends the run as cancelled (not worker_lost).
   */
  function cancelRun(runId, { reason } = {}) {
    if (!nonEmpty(reason)) throw new WorkbenchError("REASON_REQUIRED", "取消运行必须填写原因", 400);
    return tx(() => {
      const run = requireRunRow(runId);
      const task = requireTaskRow(run.task_id);
      const now = clock();
      const immediate = run.status === "pending" || (run.status === "running" && !run.claimed_by);
      if (immediate) {
        db.prepare("UPDATE task_runs SET status = 'cancelled', ended_at = ?, error_code = 'CANCELLED', error_message = ? WHERE id = ?").run(now, reason.trim(), runId);
        if (task.status === "working") setTaskStatus(task, "queued");
        emit("run", runId, "run.cancelled", { taskId: task.id, reason: reason.trim() }, runId);
        emit("task", task.id, "task.transition", { from: "working", to: "queued", reason: reason.trim(), attempt: run.attempt }, runId);
        return { run: toRun(requireRunRow(runId)), task: toTask(requireTaskRow(task.id)), cancelled: true };
      }
      if (run.status !== "running") throw conflict(`运行 ${runId} 已结束（${run.status}），不能取消`);
      if (!run.cancel_requested_at) {
        db.prepare("UPDATE task_runs SET cancel_requested_at = ?, cancel_reason = ? WHERE id = ?").run(now, reason.trim(), runId);
        emit("run", runId, "run.cancel_requested", { taskId: task.id, reason: reason.trim(), runnerId: run.claimed_by }, runId);
      }
      return { run: toRun(requireRunRow(runId)), task: toTask(task), cancelled: false };
    });
  }

  function ackCancel(runId, leaseToken) {
    return tx(() => {
      const run = requireRunRow(runId);
      if (!run.claimed_by) throw invalid("该运行不是由 Runner 领取的");
      requireToken(run, leaseToken);
      if (!run.cancel_requested_at) throw conflict("该运行没有被要求取消");
      if (run.status !== "cancelled") {
        if (run.status !== "running") throw lost(`运行已是 ${run.status}`, run.status);
        const task = requireTaskRow(run.task_id);
        const now = clock();
        db.prepare("UPDATE task_runs SET status = 'cancelled', ended_at = ?, error_code = 'CANCELLED', error_message = ? WHERE id = ?").run(now, run.cancel_reason, runId);
        if (task.status === "working") setTaskStatus(task, "queued");
        emit("run", runId, "run.cancelled", { taskId: task.id, reason: run.cancel_reason, acknowledgedBy: run.claimed_by }, runId);
        emit("task", task.id, "task.transition", { from: "working", to: "queued", reason: run.cancel_reason, attempt: run.attempt }, runId);
      }
      return { run: toRun(requireRunRow(runId)), task: toTask(requireTaskRow(run.task_id)) };
    });
  }

  function addArtifact(runId, leaseToken, { kind, uri, checksum = "", sizeBytes = 0, metadata = {} } = {}) {
    if (!nonEmpty(kind) || kind.length > 60) throw invalid("产物类型必填，且不超过 60 字符");
    if (!nonEmpty(uri) || uri.length > 2000) throw invalid("产物地址必填，且不超过 2000 字符");
    if (typeof checksum !== "string" || checksum.length > 200) throw invalid("校验和必须是不超过 200 字符的文本");
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0) throw invalid("产物大小必须是非负整数");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || JSON.stringify(metadata).length > 8192) throw invalid("metadata 必须是不超过 8 KB 的对象");
    return tx(() => {
      const run = requireRunRow(runId);
      requireToken(run, leaseToken);
      if (!["running", "succeeded", "failed"].includes(run.status)) throw lost(`运行已是 ${run.status}`, run.status);
      const id = uniqueId("ART", "artifacts");
      db.prepare("INSERT INTO artifacts (id, run_id, kind, uri, checksum, size_bytes, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, runId, kind, uri, checksum, sizeBytes, JSON.stringify(metadata), clock());
      emit("run", runId, "artifact.added", { taskId: run.task_id, artifactId: id, kind, uri, sizeBytes }, runId);
      return toArtifact(one(db, "SELECT * FROM artifacts WHERE id = ?", id));
    });
  }

  function listArtifacts(runId) {
    requireRunRow(runId);
    // rowid keeps insertion order even when two artifacts share a timestamp.
    return all(db, "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, rowid", runId).map(toArtifact);
  }

  return {
    api: { claimRun, heartbeat, appendRunEvent, cancelRun, ackCancel, expireLeases, addArtifact, listArtifacts },
    internal: { requireToken, replay, remember },
  };
}

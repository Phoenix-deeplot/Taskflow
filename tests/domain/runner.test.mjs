import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { patternsOverlap, scopesOverlap } from "../../server/file-scope.mjs";
import { restoreFromExport } from "../../server/restore.mjs";
import { count, manualWorkbench, memoryWorkbench } from "./helpers.mjs";

const rejects = (fn, code, status) => assert.throws(fn, (e) => e.code === code && (status === undefined || e.status === status), `expected ${code}`);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const CODEX = ["codex_cli"];
const make = (wb, extra = {}) => wb.createTask({ taskText: "t", executorType: "codex_cli", ...extra });
const dispatched = (wb, extra = {}) => wb.dispatchTask(make(wb, extra).id);
const claimed = (wb, extra = {}, runnerId = "runner-1") => {
  const sent = dispatched(wb, extra);
  return { ...wb.claimRun({ runnerId, capabilities: CODEX }), sent };
};

test("dispatch queues a pending run with the same snapshot and checks as a hand-off start", () => {
  const { db, wb } = manualWorkbench();
  const task = make(wb);
  const { task: after, run, snapshot } = wb.dispatchTask(task.id);
  assert.equal(after.status, "working");
  assert.deepEqual([run.status, run.attempt, run.executorType, run.claimedBy, run.leaseUntil], ["pending", 1, "codex_cli", "", null]);
  assert.equal(snapshot.payload.task.executor_type, "codex_cli");
  assert.equal(count(db, "task_context_snapshots"), 1);
  assert.equal(wb.listEvents({ entityType: "run" })[0].eventType, "run.dispatched");
  rejects(() => wb.dispatchTask(task.id), "NOT_READY");
  assert.equal(count(db, "task_runs"), 1);
});

test("dispatch needs a real executor type and honours dependencies", () => {
  const { wb } = manualWorkbench();
  const manual = wb.createTask({ taskText: "t" });
  rejects(() => wb.dispatchTask(manual.id), "INVALID");
  const set = wb.dispatchTask(manual.id, { executorType: "codex_cli" });
  assert.equal(set.snapshot.payload.task.executor_type, "codex_cli");
  assert.equal(wb.getTask(manual.id).executorType, "codex_cli");
  const upstream = make(wb); const downstream = make(wb);
  wb.addDependency(downstream.id, upstream.id);
  rejects(() => wb.dispatchTask(downstream.id), "NOT_READY");
  assert.equal(wb.dispatchTask(downstream.id, { overrideReason: "先行" }).run.overrideReason, "先行");
  rejects(() => wb.dispatchTask(manual.id, { executorType: "manual_handoff" }), "INVALID", 400);
});

test("a hand-off start still produces a running run that no runner can claim or heartbeat", () => {
  const { wb } = manualWorkbench();
  const task = wb.createTask({ taskText: "t" });
  const { run } = wb.startTask(task.id);
  assert.deepEqual([run.status, run.claimedBy], ["running", ""]);
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: ["manual_handoff", "codex_cli"] }), null);
  rejects(() => wb.heartbeat(run.id, "x"), "INVALID");
});

test("claimRun returns the oldest matching run, once, with a token that is stored only as a hash", () => {
  const { db, wb, clock } = manualWorkbench();
  const first = make(wb); const second = make(wb);
  const a = wb.dispatchTask(first.id);
  clock.advance(1);
  wb.dispatchTask(second.id);
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: ["claude_code"] }), null, "capability must match");

  const claim = wb.claimRun({ runnerId: "runner-1", capabilities: CODEX });
  assert.equal(claim.run.id, a.run.id, "oldest first");
  assert.match(claim.leaseToken, /^[0-9a-f]{64}$/);
  assert.equal(claim.leaseUntil, "2026-10-19T00:01:01.000Z", "60 s after the claim, which happened 1 s into the test");
  assert.deepEqual([claim.run.status, claim.run.claimedBy, claim.run.leaseUntil], ["running", "runner-1", claim.leaseUntil]);
  assert.equal(claim.snapshot.promptText, a.snapshot.promptText);
  assert.equal(claim.task.id, first.id);
  const stored = db.prepare("SELECT lease_token_hash FROM task_runs WHERE id = ?").get(claim.run.id).lease_token_hash;
  assert.equal(stored, sha(claim.leaseToken));
  assert.notEqual(stored, claim.leaseToken);

  const next = wb.claimRun({ runnerId: "runner-2", capabilities: CODEX });
  assert.notEqual(next.run.id, claim.run.id, "a claimed run is never handed out twice");
  assert.equal(wb.claimRun({ runnerId: "runner-3", capabilities: CODEX }), null);
});

test("claimRun validates its arguments", () => {
  const { wb } = manualWorkbench();
  for (const bad of [{}, { runnerId: "" , capabilities: CODEX }, { runnerId: "r" }, { runnerId: "r", capabilities: [] }, { runnerId: "r", capabilities: [""] }, { runnerId: "r", capabilities: "codex_cli" }]) {
    rejects(() => wb.claimRun(bad), "INVALID");
  }
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: CODEX }), null);
});

test("heartbeat extends the lease; wrong or missing tokens are refused without touching the run", () => {
  const { wb, clock } = manualWorkbench();
  const claim = claimed(wb);
  clock.advance(30);
  const beat = wb.heartbeat(claim.run.id, claim.leaseToken, { leaseSeconds: 90 });
  assert.equal(beat.leaseUntil, new Date(Date.parse("2026-10-19T00:00:30.000Z") + 90_000).toISOString());
  assert.equal(beat.cancelRequested, false);
  assert.equal(wb.listRuns(claim.task.id)[0].heartbeatAt, "2026-10-19T00:00:30.000Z");
  for (const token of [undefined, "", "nope", claim.leaseToken.slice(0, 63), `${claim.leaseToken}0`]) {
    rejects(() => wb.heartbeat(claim.run.id, token), "LEASE_INVALID", 401);
  }
  assert.equal(wb.listRuns(claim.task.id)[0].leaseUntil, beat.leaseUntil);
  assert.equal(wb.heartbeat(claim.run.id, claim.leaseToken, { leaseSeconds: 1 }).leaseUntil, "2026-10-19T00:00:35.000Z", "lease length is clamped to at least 5 s");
  assert.equal(wb.heartbeat(claim.run.id, claim.leaseToken, { leaseSeconds: 999999 }).leaseUntil, "2026-10-19T01:00:30.000Z", "and to at most 1 h");
});

test("a runner that stops heartbeating loses the run; the task returns to the queue and can be dispatched again", () => {
  const { db, wb, clock } = manualWorkbench();
  const claim = claimed(wb);
  clock.advance(61);
  rejects(() => wb.heartbeat(claim.run.id, claim.leaseToken), "LEASE_LOST", 409);
  const [run] = wb.listRuns(claim.task.id);
  assert.deepEqual([run.status, run.endedAt !== null], ["worker_lost", true]);
  assert.equal(wb.getTask(claim.task.id).status, "queued");
  assert.ok(wb.listEvents({ entityId: claim.run.id }).some((e) => e.eventType === "run.worker_lost"));
  rejects(() => wb.heartbeat(claim.run.id, claim.leaseToken), "LEASE_LOST", 409);

  const again = wb.dispatchTask(claim.task.id);
  assert.equal(again.run.attempt, 2);
  assert.equal(count(db, "task_runs"), 2);
});

test("expireLeases recovers only expired runner-owned runs and is safe to repeat", () => {
  const { wb, clock } = manualWorkbench();
  const live = claimed(wb); const dead = claimed(wb, {}, "runner-2");
  const waiting = dispatched(wb);
  const manual = wb.startTask(wb.createTask({ taskText: "m" }).id);
  clock.advance(40);
  wb.heartbeat(live.run.id, live.leaseToken);
  clock.advance(30);
  assert.deepEqual(wb.expireLeases().map((r) => r.id), [dead.run.id]);
  assert.deepEqual(wb.expireLeases(), []);
  const status = (id) => wb.listRuns(wb.getTask(id).id).at(-1).status;
  assert.equal(status(live.task.id), "running");
  assert.equal(status(waiting.task.id), "pending");
  assert.equal(wb.listRuns(manual.task.id)[0].status, "running");
  assert.equal(wb.getTask(dead.task.id).status, "queued");
});

test("claimRun recovers expired leases first, so a dead runner never blocks the queue", () => {
  const { wb, clock } = manualWorkbench();
  const dead = claimed(wb, { fileScope: ["src/api"] });
  const waiting = wb.dispatchTask(make(wb, { fileScope: ["src/api/user.ts"] }).id);
  assert.equal(wb.claimRun({ runnerId: "runner-2", capabilities: CODEX }), null, "blocked while the first lease is alive");
  clock.advance(120);
  const claim = wb.claimRun({ runnerId: "runner-2", capabilities: CODEX });
  assert.equal(claim.run.id, waiting.run.id);
  assert.equal(wb.listRuns(dead.task.id)[0].status, "worker_lost");
});

test("progress events are idempotent and need the lease", () => {
  const { wb, clock } = manualWorkbench();
  const claim = claimed(wb);
  const send = (eventId, token = claim.leaseToken) => wb.appendRunEvent(claim.run.id, token, { eventId, type: "log", message: "编译中", data: { pct: 40 } });
  assert.deepEqual(send("e1"), { duplicate: false });
  assert.deepEqual(send("e1"), { duplicate: true });
  assert.deepEqual(send("e2"), { duplicate: false });
  const progress = wb.listEvents({ entityId: claim.run.id }).filter((e) => e.eventType === "run.progress");
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0].payload, { taskId: claim.task.id, type: "log", message: "编译中", data: { pct: 40 } });
  rejects(() => send("e3", "bad"), "LEASE_INVALID", 401);
  rejects(() => wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId: "", type: "log" }), "INVALID");
  rejects(() => wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId: "e9", type: "log", message: "x".repeat(4001) }), "INVALID");
  rejects(() => wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId: "e9", type: "log", data: { blob: "x".repeat(17000) } }), "INVALID");
  clock.advance(100);
  rejects(() => send("e4"), "LEASE_LOST", 409);
  assert.equal(wb.listEvents({ entityId: claim.run.id }).filter((e) => e.eventType === "run.progress").length, 2);
});

test("a runner's result needs its token; retries with the same key return the first answer and change nothing", () => {
  const { db, wb } = manualWorkbench();
  const claim = claimed(wb);
  const body = { summary: "做完了", evidence: [{ kind: "test", ref: "npm test" }] };
  rejects(() => wb.submitResult(claim.run.id, body), "LEASE_INVALID", 401);
  rejects(() => wb.submitResult(claim.run.id, { ...body, leaseToken: "bad" }), "LEASE_INVALID", 401);
  assert.equal(wb.getTask(claim.task.id).status, "working");

  const first = wb.submitResult(claim.run.id, { ...body, leaseToken: claim.leaseToken, idempotencyKey: "res-1" });
  assert.equal(first.task.status, "review");
  const events = count(db, "events");
  const retry = wb.submitResult(claim.run.id, { ...body, leaseToken: claim.leaseToken, idempotencyKey: "res-1" });
  assert.deepEqual(retry, first);
  assert.equal(count(db, "events"), events);
  rejects(() => wb.submitResult(claim.run.id, { ...body, leaseToken: claim.leaseToken, idempotencyKey: "res-2" }), "CONFLICT");
  rejects(() => wb.submitResult(claim.run.id, { ...body, leaseToken: "bad", idempotencyKey: "res-1" }), "LEASE_INVALID", 401);
});

test("a result that arrives after the lease ran out is still taken if nobody recovered the run yet", () => {
  const { wb, clock } = manualWorkbench();
  const claim = claimed(wb);
  clock.advance(500);
  const late = wb.submitResult(claim.run.id, { summary: "晚到的结果", leaseToken: claim.leaseToken });
  assert.equal(late.task.status, "review");
  assert.equal(late.run.status, "succeeded");
});

test("once a run was recovered its runner can no longer report anything", () => {
  const { wb, clock } = manualWorkbench();
  const claim = claimed(wb);
  clock.advance(500);
  wb.expireLeases();
  rejects(() => wb.submitResult(claim.run.id, { summary: "太晚了", leaseToken: claim.leaseToken }), "LEASE_LOST", 409);
  rejects(() => wb.reportFailure(claim.run.id, { message: "失败", leaseToken: claim.leaseToken }), "LEASE_LOST", 409);
  rejects(() => wb.addArtifact(claim.run.id, claim.leaseToken, { kind: "log", uri: "file:///x" }), "LEASE_LOST", 409);
  assert.equal(wb.getTask(claim.task.id).status, "queued");
});

test("a runner's failure report returns the task to the queue, once", () => {
  const { wb } = manualWorkbench();
  const claim = claimed(wb);
  rejects(() => wb.reportFailure(claim.run.id, { message: "挂了" }), "LEASE_INVALID", 401);
  const failed = wb.reportFailure(claim.run.id, { message: "编译失败", errorCode: "BUILD", leaseToken: claim.leaseToken, idempotencyKey: "f1" });
  assert.deepEqual([failed.run.status, failed.run.errorCode, failed.task.status], ["failed", "BUILD", "queued"]);
  assert.deepEqual(wb.reportFailure(claim.run.id, { message: "编译失败", errorCode: "BUILD", leaseToken: claim.leaseToken, idempotencyKey: "f1" }), failed);
  rejects(() => wb.reportFailure(claim.run.id, { message: "x", leaseToken: claim.leaseToken, idempotencyKey: "f2" }), "CONFLICT");
  assert.equal(wb.dispatchTask(claim.task.id).run.attempt, 2);
});

test("a person cancels a waiting run at once", () => {
  const { wb } = manualWorkbench();
  const sent = dispatched(wb);
  rejects(() => wb.cancelRun(sent.run.id, {}), "REASON_REQUIRED", 400);
  const result = wb.cancelRun(sent.run.id, { reason: "不做了" });
  assert.deepEqual([result.cancelled, result.run.status, result.run.errorCode, result.task.status], [true, "cancelled", "CANCELLED", "queued"]);
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: CODEX }), null);
  rejects(() => wb.cancelRun(sent.run.id, { reason: "再来" }), "CONFLICT");
});

test("cancelling a runner-owned run is a handshake: flag, heartbeat tells the runner, runner acknowledges", () => {
  const { wb } = manualWorkbench();
  const claim = claimed(wb);
  rejects(() => wb.ackCancel(claim.run.id, claim.leaseToken), "CONFLICT");
  const requested = wb.cancelRun(claim.run.id, { reason: "需求变了" });
  assert.deepEqual([requested.cancelled, requested.run.status, requested.run.cancelRequested], [false, "running", true]);
  assert.equal(wb.cancelRun(claim.run.id, { reason: "需求变了" }).cancelled, false, "asking twice is harmless");
  const beat = wb.heartbeat(claim.run.id, claim.leaseToken);
  assert.deepEqual([beat.cancelRequested, beat.cancelReason], [true, "需求变了"]);
  rejects(() => wb.ackCancel(claim.run.id, "bad"), "LEASE_INVALID", 401);
  const done = wb.ackCancel(claim.run.id, claim.leaseToken);
  assert.deepEqual([done.run.status, done.run.errorMessage, done.task.status], ["cancelled", "需求变了", "queued"]);
  assert.equal(wb.ackCancel(claim.run.id, claim.leaseToken).run.status, "cancelled", "acknowledging again is harmless");
  rejects(() => wb.heartbeat(claim.run.id, claim.leaseToken), "LEASE_LOST", 409);
});

test("a runner that never acknowledges a cancel ends as cancelled, not as lost", () => {
  const { wb, clock } = manualWorkbench();
  const claim = claimed(wb);
  wb.cancelRun(claim.run.id, { reason: "停掉" });
  clock.advance(200);
  const [recovered] = wb.expireLeases();
  assert.deepEqual([recovered.status, recovered.errorCode, recovered.errorMessage], ["cancelled", "CANCELLED", "停掉"]);
  assert.equal(wb.getTask(claim.task.id).status, "queued");
});

test("moving a working task out of 'working' cancels a waiting or runner-owned run", () => {
  const { wb } = manualWorkbench();
  const waiting = dispatched(wb);
  wb.transitionTask(waiting.task.id, "queued", { reason: "先别跑" });
  assert.equal(wb.listRuns(waiting.task.id)[0].status, "cancelled");
  assert.equal(wb.claimRun({ runnerId: "r", capabilities: CODEX }), null);

  const claim = claimed(wb);
  wb.transitionTask(claim.task.id, "blocked", { reason: "等账号" });
  assert.equal(wb.listRuns(claim.task.id)[0].status, "cancelled");
  rejects(() => wb.submitResult(claim.run.id, { summary: "x", leaseToken: claim.leaseToken }), "LEASE_LOST", 409);
});

test("tasks with overlapping file scopes never run at the same time; unrelated and unscoped tasks do", () => {
  const { wb, clock } = manualWorkbench();
  const api = claimed(wb, { fileScope: ["src/api/**"] });
  const user = wb.dispatchTask(make(wb, { fileScope: ["src/api/user.ts"] }).id);
  clock.advance(1);
  const docs = wb.dispatchTask(make(wb, { fileScope: ["docs/"] }).id);
  const free = wb.dispatchTask(make(wb).id); // same second as docs: first-in-first-out must still hold

  const second = wb.claimRun({ runnerId: "runner-2", capabilities: CODEX });
  assert.equal(second.run.id, docs.run.id, "the overlapping task is skipped, the next one is taken");
  const third = wb.claimRun({ runnerId: "runner-3", capabilities: CODEX });
  assert.equal(third.run.id, free.run.id, "no declared scope means no lock");
  assert.equal(wb.claimRun({ runnerId: "runner-4", capabilities: CODEX }), null);
  assert.equal(wb.listRuns(user.task.id)[0].status, "pending");

  wb.submitResult(api.run.id, { summary: "好了", leaseToken: api.leaseToken });
  const released = wb.claimRun({ runnerId: "runner-4", capabilities: CODEX });
  assert.equal(released.run.id, user.run.id, "finishing the first run releases its files");
});

test("file scope overlap is conservative and ignores case and separators", () => {
  const yes = [["src/api", "src/api/user.ts"], ["src/api/**", "src/api/user.ts"], ["src", "src/a/b/c.ts"], ["Src\\API", "src/api/x"], ["./src/api/", "src/api"], ["src/*.ts", "src/api/x.ts"], ["", "src"], ["../x", "src"], ["C:/repo", "src"], ["**", "src/a"]];
  const no = [["src/api", "src/web"], ["src/a.ts", "src/b.ts"], ["docs", "src"], ["src/api/user.ts", "src/api/order.ts"]];
  for (const [a, b] of yes) assert.equal(patternsOverlap(a, b), true, `${a} / ${b}`);
  for (const [a, b] of no) assert.equal(patternsOverlap(a, b), false, `${a} / ${b}`);
  assert.equal(scopesOverlap([], ["src"]), false);
  assert.equal(scopesOverlap(["docs", "src/api"], ["src/api/x", "lib"]), true);
  assert.equal(scopesOverlap(["docs"], ["lib", "src"]), false);
});

test("artifacts are references with a checksum, need the lease, and are validated", () => {
  const { wb } = manualWorkbench();
  const claim = claimed(wb);
  const art = { kind: "log", uri: "file:///data/artifacts/run.log", checksum: "sha256:abc", sizeBytes: 1234, metadata: { lines: 80 } };
  rejects(() => wb.addArtifact(claim.run.id, "bad", art), "LEASE_INVALID", 401);
  const stored = wb.addArtifact(claim.run.id, claim.leaseToken, art);
  assert.deepEqual([stored.runId, stored.kind, stored.uri, stored.checksum, stored.sizeBytes, stored.metadata], [claim.run.id, "log", art.uri, "sha256:abc", 1234, { lines: 80 }]);
  for (const bad of [{ ...art, kind: "" }, { ...art, uri: "" }, { ...art, sizeBytes: -1 }, { ...art, sizeBytes: 1.5 }, { ...art, metadata: [] }, { ...art, checksum: 5 }]) {
    rejects(() => wb.addArtifact(claim.run.id, claim.leaseToken, bad), "INVALID");
  }
  wb.submitResult(claim.run.id, { summary: "好了", leaseToken: claim.leaseToken });
  wb.addArtifact(claim.run.id, claim.leaseToken, { kind: "diff", uri: "file:///data/artifacts/run.diff" });
  assert.deepEqual(wb.listArtifacts(claim.run.id).map((a) => a.kind), ["log", "diff"]);
  rejects(() => wb.listArtifacts("RUN-NOPE"), "NOT_FOUND");
});

test("lease tokens never appear in events or exports, and exports restore with runner data intact", () => {
  const { wb } = manualWorkbench();
  const claim = claimed(wb);
  wb.appendRunEvent(claim.run.id, claim.leaseToken, { eventId: "e1", type: "log", message: "x" });
  wb.addArtifact(claim.run.id, claim.leaseToken, { kind: "log", uri: "file:///x", checksum: "c", sizeBytes: 3 });
  wb.submitResult(claim.run.id, { summary: "好了", leaseToken: claim.leaseToken });
  const exported = JSON.parse(JSON.stringify(wb.exportAll()));
  const everything = JSON.stringify([exported, wb.listEvents({ limit: 1000 }), wb.getTask(claim.task.id)]);
  assert.ok(!everything.includes(claim.leaseToken), "the token must not leak");
  assert.ok(!everything.includes(sha(claim.leaseToken)), "nor its hash");
  assert.equal(exported.artifacts.length, 1);
  assert.equal("lease_token_hash" in exported.runs[0], false);

  const target = memoryWorkbench();
  restoreFromExport(target.db, exported, { recordEvent: false });
  const restored = JSON.parse(JSON.stringify(target.wb.exportAll()));
  assert.deepEqual({ ...restored, exportedAt: 0 }, { ...exported, exportedAt: 0 });
  assert.deepEqual(target.wb.getTask(claim.task.id).runs[0].claimedBy, "runner-1");
});

test("the database allows one unfinished run per task, counting waiting runs", () => {
  const { db, wb } = manualWorkbench();
  const sent = dispatched(wb);
  const insert = (id, status) => db.prepare(`INSERT INTO task_runs (id, task_id, snapshot_id, attempt, status, started_at) VALUES (?, ?, ?, ?, ?, 'now')`)
    .run(id, sent.task.id, sent.snapshot.id, status === "pending" ? 2 : 3, status);
  assert.throws(() => insert("RUN-X1", "pending"), /UNIQUE/);
  assert.throws(() => insert("RUN-X2", "running"), /UNIQUE/);
  assert.throws(() => insert("RUN-X3", "paused"), /CHECK/);
  assert.doesNotThrow(() => insert("RUN-X4", "worker_lost"), "finished runs may pile up");
});

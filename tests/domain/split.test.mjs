import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../../server/db.mjs";
import { ProviderError, assertProvider, createScriptedProvider, findSecrets } from "../../server/provider.mjs";
import { restoreFromExport } from "../../server/restore.mjs";
import { SPLIT_TEMPLATE_VERSION, normalizeSplitTasks, proposeSplit } from "../../server/split.mjs";
import { count, memoryWorkbench } from "./helpers.mjs";

const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code, `expected ${code}`);
const good = () => [
  { key: "design", taskText: "设计接口", acceptance: ["有接口文档"], fileScope: ["docs/api"] },
  { key: "build", taskText: "实现接口", acceptance: ["测试通过"], dependsOn: ["design"], fileScope: ["src/api/**"] },
];
const answer = (tasks = good()) => ({ json: { tasks }, usage: { inputTokens: 120, outputTokens: 80 }, model: "fake-model-9" });

test("normalizeSplitTasks cleans input, fills defaults and drops unknown fields", () => {
  const [a, b] = normalizeSplitTasks([
    { taskText: "  做 A  ", acceptance: [" 一 ", ""], evil: "x", status: "queued" },
    { key: "b", taskText: "做 B", dependsOn: ["#1"], provider: "claude" },
  ], { defaultStatus: "clarification" });
  assert.deepEqual(a, { key: "#1", taskText: "做 A", acceptance: ["一"], fileScope: [], dependsOn: [], provider: "", assignee: "", status: "queued" });
  assert.deepEqual([b.key, b.status, b.provider, b.dependsOn], ["b", "clarification", "claude", ["#1"]]);
  assert.equal("evil" in a, false);
});

test("normalizeSplitTasks refuses unusable proposals", () => {
  const ok = { key: "a", taskText: "t" };
  const bad = {
    "not an array": "x", "empty list": [], "item is not an object": [null], "empty task text": [{ key: "a", taskText: "  " }],
    "task text is not text": [{ taskText: 5 }], "text too long": [{ taskText: "x".repeat(4001) }],
    "bad status": [{ ...ok, status: "done" }], "duplicate keys": [ok, { ...ok }],
    "unknown dependency": [{ ...ok, dependsOn: ["zzz"] }], "self dependency": [{ ...ok, dependsOn: ["a"] }],
    "cycle": [{ key: "a", taskText: "t", dependsOn: ["b"] }, { key: "b", taskText: "t", dependsOn: ["a"] }],
    "long cycle": [{ key: "a", taskText: "t", dependsOn: ["c"] }, { key: "b", taskText: "t", dependsOn: ["a"] }, { key: "c", taskText: "t", dependsOn: ["b"] }, { key: "d", taskText: "t" }],
    "absolute scope": [{ ...ok, fileScope: ["/etc/passwd"] }], "drive scope": [{ ...ok, fileScope: ["C:\\Users"] }],
    "escaping scope": [{ ...ok, fileScope: ["src/../../secret"] }], "too many criteria": [{ ...ok, acceptance: Array(21).fill("x") }],
    "criteria not strings": [{ ...ok, acceptance: [1] }],
  };
  for (const [name, value] of Object.entries(bad)) assert.throws(() => normalizeSplitTasks(value), (e) => e.code === "INVALID", name);
  assert.throws(() => normalizeSplitTasks(Array(51).fill(ok).map((t, i) => ({ ...t, key: `k${i}` }))), (e) => e.code === "INVALID");
  assert.throws(() => normalizeSplitTasks([ok, { key: "b", taskText: "t" }], { maxTasks: 1 }), (e) => e.code === "INVALID");
});

test("a draft creates no tasks; confirming it creates tasks and dependencies and cannot be repeated", () => {
  const { db, wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "大需求" });
  const draft = wb.createSplitDraft(requirement.id, { tasks: good() });
  assert.equal(draft.status, "draft");
  assert.equal(draft.source, "manual");
  assert.equal(draft.requirementRevision, requirement.revision);
  assert.equal(count(db, "tasks"), 0);

  const edited = wb.updateSplitDraft(draft.id, { tasks: [...good(), { key: "docs", taskText: "写文档" }] }, { expectedRevision: draft.revision });
  assert.equal(edited.revision, draft.revision + 1);
  assert.equal(edited.tasks.length, 3);
  rejects(() => wb.updateSplitDraft(draft.id, { tasks: good() }, { expectedRevision: draft.revision }), "CONFLICT");
  rejects(() => wb.updateSplitDraft(draft.id, { tasks: [] }), "INVALID");

  const confirmed = wb.confirmSplitDraft(draft.id);
  assert.equal(confirmed.draft.status, "confirmed");
  assert.equal(confirmed.tasks.length, 3);
  assert.deepEqual(confirmed.draft.confirmedTaskIds, confirmed.tasks.map((t) => t.id));
  assert.ok(confirmed.tasks.every((t) => t.requirementId === requirement.id && t.status === "queued"));
  assert.equal(confirmed.dependencies.length, 1);
  assert.equal(count(db, "tasks"), 3);
  rejects(() => wb.confirmSplitDraft(draft.id), "CONFLICT");
  rejects(() => wb.discardSplitDraft(draft.id), "CONFLICT");
  rejects(() => wb.updateSplitDraft(draft.id, { tasks: good() }), "CONFLICT");
  assert.equal(count(db, "tasks"), 3, "a repeated confirm must not create more tasks");
});

test("a discarded draft stays on record and cannot be confirmed", () => {
  const { db, wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const draft = wb.createSplitDraft(requirement.id, { tasks: good() });
  const discarded = wb.discardSplitDraft(draft.id, { reason: "拆得不对" });
  assert.deepEqual([discarded.status, discarded.discardReason], ["discarded", "拆得不对"]);
  rejects(() => wb.confirmSplitDraft(draft.id), "CONFLICT");
  assert.equal(count(db, "tasks"), 0);
  assert.deepEqual(wb.listSplitDrafts({ requirementId: requirement.id, status: "discarded" }).map((d) => d.id), [draft.id]);
  assert.deepEqual(wb.listSplitDrafts({ status: "draft" }), []);
  rejects(() => wb.getSplitDraft("SPLIT-NOPE"), "NOT_FOUND");
});

test("confirming a draft whose requirement changed afterwards needs an explicit acceptance", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r", description: "旧说明" });
  const draft = wb.createSplitDraft(requirement.id, { tasks: good() });
  wb.updateRequirement(requirement.id, { description: "新说明" });
  assert.throws(() => wb.confirmSplitDraft(draft.id), (e) => e.code === "STALE_DRAFT" && e.details.draftRevision === 1 && e.details.currentRevision === 2);
  assert.equal(wb.listTasks().length, 0);
  assert.equal(wb.getSplitDraft(draft.id).status, "draft");
  const result = wb.confirmSplitDraft(draft.id, { acceptStale: true });
  assert.equal(result.tasks.length, 2);
  assert.equal(wb.listEvents({ entityId: draft.id })[0].payload.acceptedStale, true);
});

test("drafts cannot be made or confirmed for a deleted requirement", () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const draft = wb.createSplitDraft(requirement.id, { tasks: good() });
  wb.deleteRequirement(requirement.id);
  rejects(() => wb.confirmSplitDraft(draft.id), "CONFLICT");
  rejects(() => wb.createSplitDraft(requirement.id, { tasks: good() }), "CONFLICT");
  rejects(() => wb.createSplitDraft("REQ-NOPE", { tasks: good() }), "NOT_FOUND");
});

test("proposeSplit stores the model's answer as a draft with provenance, and creates no tasks", async () => {
  const { db, wb } = memoryWorkbench();
  wb.appendContextVersion({ rules: ["只拆需求内的范围"], constraints: ["本地优先"] });
  const requirement = wb.createRequirement({ title: "支付比较", description: "按国家比较支付工具", module: "工具" });
  wb.createTask({ requirementId: requirement.id, taskText: "x".repeat(500), status: "clarification" });
  const provider = createScriptedProvider({ name: "claude", model: "claude-test", replies: [answer()] });

  const draft = await proposeSplit(wb, requirement.id, provider);
  assert.equal(draft.status, "draft");
  assert.equal(draft.source, "provider");
  assert.deepEqual([draft.provider, draft.model, draft.promptTemplateVersion], ["claude", "fake-model-9", SPLIT_TEMPLATE_VERSION]);
  assert.deepEqual(draft.usage, { inputTokens: 120, outputTokens: 80 });
  assert.match(draft.inputHash, /^[0-9a-f]{64}$/);
  assert.ok(draft.tasks.every((t) => t.status === "clarification"), "model proposals start as 待澄清 so a person reviews them");
  assert.equal(draft.requirementRevision, requirement.revision);
  assert.equal(count(db, "tasks"), 1, "only the pre-existing task");

  assert.equal(provider.calls.length, 1);
  const call = provider.calls[0];
  assert.equal(call.input.requirement.title, "支付比较");
  assert.deepEqual(call.input.globalContext.rules, ["只拆需求内的范围"]);
  assert.deepEqual(call.input.globalContext.constraints, ["本地优先"]);
  assert.equal(call.input.existingTasks.length, 1);
  assert.ok(call.input.existingTasks[0].taskText.length <= 201, "existing task text is clipped");
  assert.deepEqual(call.schema.required, ["tasks"]);
  assert.equal(JSON.stringify(draft.input), JSON.stringify(call.input), "the stored input is exactly what the model saw");

  const confirmed = wb.confirmSplitDraft(draft.id);
  assert.deepEqual(confirmed.tasks.map((t) => t.status), ["clarification", "clarification"]);
});

test("a failing or unusable provider leaves a trace but no draft", async () => {
  const cases = [
    ["AUTH", new ProviderError("AUTH", "密钥无效"), "AUTH"],
    ["plain error", new Error("socket hang up"), "PROVIDER_ERROR"],
    ["no tasks array", { json: { oops: true } }, "BAD_RESPONSE"],
    ["not an object", { json: null }, "BAD_RESPONSE"],
    ["cycle", answer([{ key: "a", taskText: "t", dependsOn: ["b"] }, { key: "b", taskText: "t", dependsOn: ["a"] }]), "BAD_RESPONSE"],
    ["escaping file scope", answer([{ key: "a", taskText: "t", fileScope: ["../x"] }]), "BAD_RESPONSE"],
    ["more tasks than allowed", answer(Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, taskText: "t" }))), "BAD_RESPONSE"],
  ];
  for (const [name, reply, code] of cases) {
    const { db, wb } = memoryWorkbench();
    const requirement = wb.createRequirement({ title: "r" });
    const provider = createScriptedProvider({ replies: [reply] });
    await assert.rejects(() => proposeSplit(wb, requirement.id, provider), (error) => error.code === code && error.name !== "Error" && Number.isInteger(error.status), name);
    assert.equal(count(db, "split_drafts"), 0, name);
    assert.equal(count(db, "tasks"), 0, name);
    const failure = wb.listEvents({ entityId: requirement.id })[0];
    assert.equal(failure.eventType, "split.proposal_failed", name);
    assert.equal(failure.payload.code, code, name);
  }
});

test("a provider that never answers is cut off and told to stop", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  let signal;
  const provider = createScriptedProvider({ replies: [(request) => { signal = request.signal; return new Promise(() => {}); }] });
  await assert.rejects(() => proposeSplit(wb, requirement.id, provider, { timeoutMs: 30 }), (error) => error.code === "TIMEOUT" && error.retryable === true);
  assert.equal(signal.aborted, true);
  assert.equal(wb.listSplitDrafts().length, 0);
});

test("text that looks like a credential is never sent to the model", async () => {
  const secret = `sk-ant-${"a1B2c3D4e5".repeat(4)}`;
  for (const place of ["requirement", "context"]) {
    const { db, wb } = memoryWorkbench();
    if (place === "context") wb.appendContextVersion({ rules: [`调用密钥是 ${secret}`] });
    const requirement = wb.createRequirement({ title: "r", description: place === "requirement" ? `接口密钥 ${secret}` : "普通说明" });
    const provider = createScriptedProvider({ replies: [answer()] });
    await assert.rejects(() => proposeSplit(wb, requirement.id, provider), (error) => {
      assert.equal(error.code, "SECRET_IN_INPUT");
      assert.ok(!error.message.includes(secret), "the error must not echo the secret");
      return true;
    }, place);
    assert.equal(provider.calls.length, 0, `${place}: the provider must not be called`);
    assert.equal(count(db, "split_drafts"), 0);
    // The requirement's own history holds what the user typed; the refusal record must not repeat the secret.
    const refusals = wb.listEvents({ limit: 50 }).filter((event) => event.eventType === "split.proposal_failed");
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].payload.code, "SECRET_IN_INPUT");
    assert.ok(!JSON.stringify(refusals[0]).includes(secret), "the refusal record must not echo the secret");
  }
});

test("findSecrets recognises common credential shapes and nothing else", () => {
  for (const sample of ["sk-" + "x".repeat(24), "AKIAABCDEFGHIJKLMNOP", "ghp_" + "a".repeat(36), "github_pat_" + "a".repeat(40), "AIza" + "a".repeat(35), "xoxb-1234567890-abc", "-----BEGIN RSA PRIVATE KEY-----"]) {
    assert.ok(findSecrets(`前缀 ${sample} 后缀`), sample);
  }
  for (const sample of ["", "普通的需求说明", "task-queue sk-short", "skill-based routing", null, undefined]) assert.equal(findSecrets(sample), null, String(sample));
});

test("proposeSplit refuses a deleted requirement and a broken provider before calling anything", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const provider = createScriptedProvider({ replies: [answer()] });
  wb.deleteRequirement(requirement.id);
  await assert.rejects(() => proposeSplit(wb, requirement.id, provider), (e) => e.code === "CONFLICT");
  assert.equal(provider.calls.length, 0);
  await assert.rejects(() => proposeSplit(wb, requirement.id, {}), (e) => e.code === "INVALID");
  assert.throws(() => assertProvider({ name: "x" }), (e) => e.code === "INVALID");
  assert.doesNotThrow(() => assertProvider(provider));
});

test("drafts survive export and restore unchanged", async () => {
  const { wb } = memoryWorkbench();
  const requirement = wb.createRequirement({ title: "r" });
  const draft = await proposeSplit(wb, requirement.id, createScriptedProvider({ replies: [answer()] }));
  const exported = JSON.parse(JSON.stringify(wb.exportAll()));
  assert.equal(exported.splitDrafts.length, 1);
  const target = memoryWorkbench();
  restoreFromExport(target.db, exported, { recordEvent: false });
  assert.deepEqual(target.wb.getSplitDraft(draft.id), wb.getSplitDraft(draft.id));
});

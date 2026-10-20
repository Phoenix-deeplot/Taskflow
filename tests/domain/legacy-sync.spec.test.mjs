/**
 * Executable spec for server/legacy-state.mjs (the page's full-state PUT /api/state compatibility path).
 *
 * Contract guarded here:
 *  - exportLegacyState(...) returns `stateVersion` (workbench.stateVersion()); the page sends it back inside `state`.
 *  - syncLegacyState(...) throws WorkbenchError("STALE_STATE", ..., 409) when the incoming `stateVersion` is missing or
 *    differs from the current one, before changing anything. The page then reloads instead of overwriting.
 *  - Task `suggestion` is stored as the task's `resultNote` (and exported as `suggestion`: resultNote first, else the
 *    latest run result).
 *  - An id that was soft-deleted and comes back in the state is revived with workbench.restoreRequirement(id, patch).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../../server/db.mjs";
import { exportLegacyState, syncLegacyState } from "../../server/legacy-state.mjs";
import { createWorkbench } from "../../server/service.mjs";

function fresh() {
  const db = openDatabase(":memory:");
  const wb = createWorkbench(db);
  return {
    db, wb,
    get: () => exportLegacyState(db, wb),
    put: (state) => syncLegacyState(db, structuredClone(state), { workbench: wb }),
  };
}

const item = (id, title) => ({
  id, module: "m", title, description: "", sourceVersion: "v0.1", targetVersion: "V1", decision: "pending", decisionNote: "",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
});
const seed = (s) => s.put({ items: [item("REQ-AAAAA", "一"), item("REQ-BBBBB", "二")], tasks: [], events: [] });
const stale = (error) => error?.code === "STALE_STATE" && error?.status === 409;
const active = (s) => s.wb.listRequirements().map((r) => r.id).sort();

test("export carries a state version that changes with the data and not without it", () => {
  const s = fresh();
  seed(s);
  const v1 = s.get().stateVersion;
  assert.equal(typeof v1, "number");
  assert.equal(s.get().stateVersion, v1, "reading must not change the version");
  const next = s.get(); next.items[0].title = "改了";
  s.put(next);
  assert.ok(s.get().stateVersion > v1);
});

test("a stale tab cannot delete a requirement another tab created", () => {
  const s = fresh();
  s.put({ items: [item("REQ-AAAAA", "一")], tasks: [], events: [] });
  const tab1 = s.get();
  const tab2 = s.get(); tab2.items.push(item("REQ-BBBBB", "二")); s.put(tab2);
  tab1.items[0].title = "一（改）";
  assert.throws(() => s.put(tab1), stale);
  assert.deepEqual(active(s), ["REQ-AAAAA", "REQ-BBBBB"]);
  assert.equal(s.wb.getRequirement("REQ-AAAAA").title, "一");
});

test("a stale tab cannot revert a newer edit, even on fields it did not touch", () => {
  const s = fresh();
  s.put({ items: [item("REQ-AAAAA", "原始")], tasks: [], events: [] });
  const tab1 = s.get();
  const tab2 = s.get(); tab2.items[0].title = "标签页2的新标题"; s.put(tab2);
  tab1.items[0].description = "标签页1只改了描述";
  assert.throws(() => s.put(tab1), stale);
  assert.equal(s.wb.getRequirement("REQ-AAAAA").title, "标签页2的新标题");
  assert.equal(s.wb.getRequirement("REQ-AAAAA").description, "");
});

test("an up-to-date client may delete requirements, including the last one", () => {
  const s = fresh();
  seed(s);
  const one = s.get(); one.items = one.items.filter((i) => i.id !== "REQ-BBBBB"); s.put(one);
  assert.deepEqual(active(s), ["REQ-AAAAA"]);
  const none = s.get(); none.items = []; s.put(none);
  assert.deepEqual(active(s), []);
  assert.equal(s.wb.listRequirements({ includeDeleted: true }).length, 2, "deleted requirements stay in the history");
});

test("a save that carries no state version is refused once data exists", () => {
  const s = fresh();
  seed(s);
  assert.throws(() => s.put({ items: [], tasks: [], events: [] }), stale);
  assert.deepEqual(active(s), ["REQ-AAAAA", "REQ-BBBBB"]);
});

test("the AI suggestion typed on a task is stored, for new and for edited tasks", () => {
  const s = fresh();
  s.put({ items: [item("REQ-AAAAA", "一")], tasks: [], events: [] });
  const created = s.get();
  created.tasks.push({ id: "TASK-NEW01", featureId: "REQ-AAAAA", model: "claude", status: "queued", assignee: "我", task: "做事", suggestion: "我手动记录的 AI 建议", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
  s.put(created);
  assert.equal(s.get().tasks.find((t) => t.id === "TASK-NEW01").suggestion, "我手动记录的 AI 建议");
  const edited = s.get(); edited.tasks[0].suggestion = "编辑后的建议"; s.put(edited);
  assert.equal(s.get().tasks[0].suggestion, "编辑后的建议");
  assert.equal(s.wb.getTask("TASK-NEW01").resultNote, "编辑后的建议");
});

test("re-adding a deleted requirement id (e.g. importing a backup) revives it instead of failing every save", () => {
  const s = fresh();
  seed(s);
  const without = s.get(); without.items = without.items.filter((i) => i.id !== "REQ-BBBBB"); s.put(without);
  const back = s.get(); back.items.push(item("REQ-BBBBB", "二（从备份导入）"));
  s.put(back);
  assert.deepEqual(active(s), ["REQ-AAAAA", "REQ-BBBBB"]);
  assert.equal(s.wb.getRequirement("REQ-BBBBB").title, "二（从备份导入）");
});

test("legacy status edits cannot invent reasons when returning tasks to queued", () => {
  for (const targetBeforeReturn of ["working", "review", "done"]) {
    const s = fresh();
    s.put({ items: [item("REQ-AAAAA", "一")], tasks: [{ id: "TASK-REASON", featureId: "REQ-AAAAA", status: "queued", task: "有原因的状态机" }], events: [] });
    let current = s.get();
    if (["working", "review", "done"].includes(targetBeforeReturn)) {
      current.tasks[0].status = "working"; s.put(current);
    }
    if (["review", "done"].includes(targetBeforeReturn)) {
      current = s.get(); current.tasks[0].status = "review"; current.tasks[0].suggestion = "执行结果"; s.put(current);
    }
    if (targetBeforeReturn === "done") {
      current = s.get(); current.tasks[0].status = "done"; s.put(current);
    }
    current = s.get();
    current.tasks[0].status = "queued";
    current.tasks[0].suggestion = "";
    current.tasks[0].blockedReason = "";
    assert.throws(() => s.put(current), (error) => error?.code === "REASON_REQUIRED", targetBeforeReturn);
    assert.equal(s.wb.getTask("TASK-REASON").status, targetBeforeReturn);
  }
});

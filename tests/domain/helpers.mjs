import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../server/db.mjs";
import { createWorkbench } from "../../server/service.mjs";

/** Deterministic, strictly increasing UTC clock (one second per call). */
export function makeClock(start = "2026-10-19T00:00:00.000Z") {
  let t = Date.parse(start);
  return () => {
    const value = new Date(t).toISOString();
    t += 1000;
    return value;
  };
}

export function memoryWorkbench() {
  const db = openDatabase(":memory:");
  const wb = createWorkbench(db, { clock: makeClock() });
  return { db, wb };
}

export function tempDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-domain-"));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/** Creates a task and drives it into `status` using only legal operations. */
export function taskInStatus(wb, status, extra = {}) {
  const base = { taskText: "测试任务", provider: "claude", ...extra };
  if (status === "clarification") return wb.createTask({ ...base, status: "clarification" });
  let task = wb.createTask(base);
  if (status === "queued") return task;
  if (status === "blocked") return wb.transitionTask(task.id, "blocked", { reason: "等待输入" });
  const { run } = wb.startTask(task.id);
  if (status === "working") return wb.getTask(task.id);
  wb.submitResult(run.id, { summary: "完成" });
  if (status === "review") return wb.getTask(task.id);
  wb.acceptTask(task.id);
  return wb.getTask(task.id);
}

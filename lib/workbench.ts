import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { changeEvents } from "@/db/schema";

export const DECISIONS = ["pending", "keep", "modify", "defer", "delete"] as const;
export const VERSIONS = ["V1", "V2", "V3", "Later"] as const;
export const MODELS = ["deepseek", "chatgpt", "claude"] as const;
export const TASK_STATUSES = ["queued", "working", "review", "done"] as const;

export type Decision = (typeof DECISIONS)[number];
export type Version = (typeof VERSIONS)[number];
export type Model = (typeof MODELS)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];

export async function requireApiUser() {
  const user = await getChatGPTUser();
  if (!user) return null;
  return user;
}

export function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function recordChange({
  entityType,
  entityId,
  action,
  actorId,
  before,
  after,
}: {
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  before?: unknown;
  after?: unknown;
}) {
  const db = getDb();
  await db.insert(changeEvents).values({
    entityType,
    entityId,
    action,
    actorId,
    beforeJson: before === undefined ? null : JSON.stringify(before),
    afterJson: after === undefined ? null : JSON.stringify(after),
  });
}

export function apiError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

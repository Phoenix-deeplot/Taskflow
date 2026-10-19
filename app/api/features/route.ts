import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { aiTasks, features } from "@/db/schema";
import { apiError, makeId, recordChange, requireApiUser } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);

  try {
    const db = getDb();
    const [items, tasks] = await Promise.all([
      db.select().from(features).orderBy(desc(features.updatedAt)),
      db.select().from(aiTasks).orderBy(desc(aiTasks.updatedAt)),
    ]);
    const latestTasks = new Map<string, (typeof tasks)[number]>();
    for (const task of tasks) {
      if (!latestTasks.has(task.featureId)) latestTasks.set(task.featureId, task);
    }
    return Response.json({
      items: items.map((item) => ({ ...item, latestTask: latestTasks.get(item.id) ?? null })),
      tasks,
    });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to load requirements", 500);
  }
}

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return apiError("功能名称不能为空");

  const item = {
    id: makeId("REQ"),
    module: typeof body?.module === "string" && body.module.trim() ? body.module.trim() : "未分类",
    title,
    description: typeof body?.description === "string" ? body.description.trim() : "",
    sourceVersion: typeof body?.sourceVersion === "string" ? body.sourceVersion : "v0.1",
    targetVersion: typeof body?.targetVersion === "string" ? body.targetVersion : "V1",
    decision: typeof body?.decision === "string" ? body.decision : "pending",
    decisionNote: typeof body?.decisionNote === "string" ? body.decisionNote.trim() : "",
    createdBy: user.userId,
    updatedBy: user.userId,
  };

  try {
    const db = getDb();
    await db.insert(features).values(item);
    await recordChange({ entityType: "feature", entityId: item.id, action: "created", actorId: user.userId, after: item });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to create requirement", 500);
  }
}

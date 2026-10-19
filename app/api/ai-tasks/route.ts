import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { aiTasks, features } from "@/db/schema";
import { apiError, makeId, MODELS, recordChange, requireApiUser } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);
  try {
    const db = getDb();
    const rows = await db.select({ task: aiTasks, featureTitle: features.title, featureModule: features.module })
      .from(aiTasks).leftJoin(features, eq(aiTasks.featureId, features.id)).orderBy(desc(aiTasks.updatedAt));
    return Response.json({ tasks: rows.map((row) => ({ ...row.task, featureTitle: row.featureTitle, featureModule: row.featureModule })) });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to load AI tasks", 500);
  }
}

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const featureId = typeof body?.featureId === "string" ? body.featureId : "";
  const model = typeof body?.model === "string" ? body.model : "chatgpt";
  const taskText = typeof body?.task === "string" ? body.task.trim() : "";
  if (!featureId) return apiError("请选择关联需求");
  if (!MODELS.includes(model as (typeof MODELS)[number])) return apiError("不支持的模型");
  if (!taskText) return apiError("任务说明不能为空");

  const task = {
    id: makeId("TASK"), featureId, model, task: taskText, status: "queued",
    suggestion: "", createdBy: user.userId, updatedBy: user.userId,
  };
  try {
    const db = getDb();
    await db.insert(aiTasks).values(task);
    await recordChange({ entityType: "ai_task", entityId: task.id, action: "created", actorId: user.userId, after: task });
    return Response.json({ task }, { status: 201 });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to create AI task", 500);
  }
}

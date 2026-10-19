import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { aiTasks } from "@/db/schema";
import { apiError, recordChange, TASK_STATUSES, requireApiUser } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiError("Invalid JSON body");
  const patch: { status?: string; suggestion?: string } = {};
  if (typeof body.status === "string") {
    if (!TASK_STATUSES.includes(body.status as (typeof TASK_STATUSES)[number])) return apiError("Invalid status");
    patch.status = body.status;
  }
  if (typeof body.suggestion === "string") patch.suggestion = body.suggestion.trim();
  if (!Object.keys(patch).length) return apiError("没有可保存的修改");

  try {
    const db = getDb();
    const [before] = await db.select().from(aiTasks).where(eq(aiTasks.id, id)).limit(1);
    if (!before) return apiError("AI 任务不存在", 404);
    await db.update(aiTasks).set({ ...patch, updatedBy: user.userId, updatedAt: new Date().toISOString() }).where(eq(aiTasks.id, id));
    const [updated] = await db.select().from(aiTasks).where(eq(aiTasks.id, id)).limit(1);
    await recordChange({ entityType: "ai_task", entityId: id, action: "updated", actorId: user.userId, before, after: updated });
    return Response.json({ task: updated });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to update AI task", 500);
  }
}

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { features } from "@/db/schema";
import { apiError, recordChange, requireApiUser } from "@/lib/workbench";

export const dynamic = "force-dynamic";

const editableFields = ["module", "title", "description", "targetVersion", "decision", "decisionNote"] as const;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);

  const { id } = await context.params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return apiError("Invalid JSON body");

  const patch: Record<string, string> = {};
  for (const field of editableFields) {
    if (typeof body[field] === "string") patch[field] = (body[field] as string).trim();
  }
  if ("title" in patch && !patch.title) return apiError("功能名称不能为空");
  if ("decision" in patch && !["pending", "keep", "modify", "defer", "delete"].includes(patch.decision)) return apiError("Invalid decision");
  if ("targetVersion" in patch && !["V1", "V2", "V3", "Later"].includes(patch.targetVersion)) return apiError("Invalid target version");
  if (!Object.keys(patch).length) return apiError("没有可保存的修改");

  try {
    const db = getDb();
    const [before] = await db.select().from(features).where(eq(features.id, id)).limit(1);
    if (!before) return apiError("需求不存在", 404);
    const after = { ...patch, updatedBy: user.userId, updatedAt: new Date().toISOString() };
    await db.update(features).set(after).where(eq(features.id, id));
    const [updated] = await db.select().from(features).where(eq(features.id, id)).limit(1);
    await recordChange({ entityType: "feature", entityId: id, action: "updated", actorId: user.userId, before, after: updated });
    return Response.json({ item: updated });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to update requirement", 500);
  }
}

import { count } from "drizzle-orm";
import { getDb } from "@/db";
import { features } from "@/db/schema";
import { seedFeatures } from "@/lib/seed-data";
import { apiError, makeId, recordChange, requireApiUser } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);
  try {
    const db = getDb();
    const [total] = await db.select({ value: count() }).from(features);
    if (total.value > 0) return apiError("已有需求记录，请用新增或 JSON 导入", 409);
    const rows = seedFeatures.map((seed) => ({
      id: makeId("REQ"),
      ...seed,
      sourceVersion: "v0.1",
      decisionNote: "",
      createdBy: user.userId,
      updatedBy: user.userId,
    }));
    for (const row of rows) await db.insert(features).values(row);
    await recordChange({ entityType: "workspace", entityId: "primary", action: "seeded_tool_module", actorId: user.userId, after: { count: rows.length } });
    return Response.json({ count: rows.length });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to load starter requirements", 500);
  }
}

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { features } from "@/db/schema";
import { apiError, recordChange, requireApiUser } from "@/lib/workbench";

export const dynamic = "force-dynamic";

const decisions = new Set(["pending", "keep", "modify", "defer", "delete"]);
const versions = new Set(["V1", "V2", "V3", "Later"]);

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);
  const payload = await request.json().catch(() => null) as { items?: unknown[] } | null;
  if (!Array.isArray(payload?.items) || payload.items.length > 1000) return apiError("JSON 中需要包含不超过 1000 条 items");

  const records = payload.items.map((value) => value as Record<string, unknown>);
  if (records.some((row) => typeof row.id !== "string" || typeof row.title !== "string" || !row.title.trim())) {
    return apiError("每条需求都必须有 id 和 title");
  }
  try {
    const db = getDb();
    let imported = 0;
    for (const row of records) {
      const item = {
        id: String(row.id),
        module: typeof row.module === "string" ? row.module : "未分类",
        title: String(row.title).trim(),
        description: typeof row.description === "string" ? row.description : "",
        sourceVersion: typeof row.sourceVersion === "string" ? row.sourceVersion : "导入",
        targetVersion: typeof row.targetVersion === "string" && versions.has(row.targetVersion) ? row.targetVersion : "V1",
        decision: typeof row.decision === "string" && decisions.has(row.decision) ? row.decision : "pending",
        decisionNote: typeof row.decisionNote === "string" ? row.decisionNote : "",
        createdBy: user.userId,
        updatedBy: user.userId,
      };
      const [existing] = await db.select().from(features).where(eq(features.id, item.id)).limit(1);
      if (existing) {
        await db.update(features).set({ ...item, updatedAt: new Date().toISOString() }).where(eq(features.id, item.id));
      } else {
        await db.insert(features).values(item);
      }
      imported += 1;
    }
    await recordChange({ entityType: "workspace", entityId: "primary", action: "json_import", actorId: user.userId, after: { imported } });
    return Response.json({ imported });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to import data", 500);
  }
}

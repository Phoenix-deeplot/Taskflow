import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { aiTasks, changeEvents, features } from "@/db/schema";
import { apiError, requireApiUser } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);
  try {
    const db = getDb();
    const [items, tasks, events] = await Promise.all([
      db.select().from(features).orderBy(features.id),
      db.select().from(aiTasks).orderBy(aiTasks.id),
      db.select().from(changeEvents).orderBy(desc(changeEvents.createdAt)).limit(2000),
    ]);
    return Response.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), items, tasks, events });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to export data", 500);
  }
}

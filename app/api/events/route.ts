import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { changeEvents } from "@/db/schema";
import { apiError, requireApiUser } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireApiUser();
  if (!user) return apiError("Sign in required", 401);
  try {
    const rows = await getDb().select().from(changeEvents).orderBy(desc(changeEvents.createdAt)).limit(200);
    return Response.json({ events: rows });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to load history", 500);
  }
}

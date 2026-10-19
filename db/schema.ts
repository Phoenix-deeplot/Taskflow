import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const features = sqliteTable(
  "features",
  {
    id: text("id").primaryKey(),
    module: text("module").notNull().default("工具模块"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    sourceVersion: text("source_version").notNull().default("v0.1"),
    targetVersion: text("target_version").notNull().default("V1"),
    decision: text("decision").notNull().default("pending"),
    decisionNote: text("decision_note").notNull().default(""),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("features_module_idx").on(table.module),
    index("features_version_idx").on(table.targetVersion),
    index("features_decision_idx").on(table.decision),
  ],
);

export const aiTasks = sqliteTable(
  "ai_tasks",
  {
    id: text("id").primaryKey(),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    model: text("model").notNull().default("chatgpt"),
    task: text("task").notNull().default(""),
    status: text("status").notNull().default("queued"),
    suggestion: text("suggestion").notNull().default(""),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("ai_tasks_feature_idx").on(table.featureId)],
);

export const changeEvents = sqliteTable(
  "change_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("change_events_created_idx").on(table.createdAt),
    index("change_events_entity_idx").on(table.entityType, table.entityId),
  ],
);


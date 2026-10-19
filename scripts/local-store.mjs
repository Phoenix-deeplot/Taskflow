import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_STATE_BYTES = 10 * 1024 * 1024;

export function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("state must be an object");
  }
  if (!Array.isArray(value.items) || !Array.isArray(value.tasks) || !Array.isArray(value.events)) {
    throw new TypeError("state must contain items, tasks, and events arrays");
  }
  const state = {
    schemaVersion: Number.isInteger(value.schemaVersion) ? value.schemaVersion : 1,
    items: value.items,
    tasks: value.tasks,
    events: value.events.slice(0, 2000),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) {
    throw new RangeError("state exceeds the 10 MB local storage limit");
  }
  return state;
}

export function createLocalStore(dataDirectory) {
  mkdirSync(dataDirectory, { recursive: true });
  const dbPath = path.join(dataDirectory, "workbench.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS workbench_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const readStatement = db.prepare("SELECT schema_version, payload_json, updated_at FROM workbench_state WHERE id = 1");
  const writeStatement = db.prepare(`
    INSERT INTO workbench_state (id, schema_version, payload_json, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_version = excluded.schema_version,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  return {
    dbPath,
    read() {
      const row = readStatement.get();
      if (!row) return { initialized: false, state: null };
      return {
        initialized: true,
        state: normalizeState(JSON.parse(row.payload_json)),
        updatedAt: row.updated_at,
      };
    },
    write(value) {
      const state = normalizeState(value);
      const payload = JSON.stringify(state);
      db.exec("BEGIN IMMEDIATE");
      try {
        writeStatement.run(state.schemaVersion, payload, state.updatedAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { initialized: true, state };
    },
    close() { db.close(); },
  };
}

import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const migrationsDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function listMigrations() {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => ({ version: Number(name.slice(0, 4)), name, sql: readFileSync(path.join(migrationsDirectory, name), "utf8") }));
}

export function backupDatabase(db, directory, label = "backup") {
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target = path.join(directory, `${label}-${stamp}.sqlite`);
  for (let n = 1; existsSync(target); n += 1) target = path.join(directory, `${label}-${stamp}-${n}.sqlite`);
  db.prepare("VACUUM INTO ?").run(target);
  return target;
}

/**
 * Opens (and migrates) the workbench database. Use ":memory:" for tests.
 * An existing database that needs a migration is backed up first when `backupDirectory` is given.
 */
export function openDatabase(file, { backupDirectory } = {}) {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");

  const current = db.prepare("PRAGMA user_version").get().user_version;
  const pending = listMigrations().filter((migration) => migration.version > current);
  if (pending.length && current > 0 && backupDirectory) backupDatabase(db, backupDirectory, `pre-migration-v${current}`);
  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${migration.name} failed: ${error.message}`, { cause: error });
    }
  }
  return db;
}

export const schemaVersion = (db) => db.prepare("PRAGMA user_version").get().user_version;

export function one(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params).map((row) => ({ ...row }));
}

const depth = new WeakMap();

/** Runs `fn` in an immediate transaction; nested calls join the outer one. */
export function transaction(db, fn) {
  const level = depth.get(db) || 0;
  if (level > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back by SQLite */ }
    throw error;
  } finally {
    depth.delete(db);
  }
}

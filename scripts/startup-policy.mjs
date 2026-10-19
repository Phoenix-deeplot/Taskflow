import { normalizeState } from "./local-store.mjs";

export function sameContent(left, right) {
  const a = normalizeState(left);
  const b = normalizeState(right);
  return JSON.stringify({ schemaVersion: a.schemaVersion, items: a.items, tasks: a.tasks, events: a.events }) ===
    JSON.stringify({ schemaVersion: b.schemaVersion, items: b.items, tasks: b.tasks, events: b.events });
}

export function hasSavedData(value) {
  const state = normalizeState(value);
  return state.items.length > 0 || state.tasks.length > 0 || state.events.length > 0;
}

function isNewer(left, right) {
  const leftTime = Date.parse(left?.updatedAt || "");
  const rightTime = Date.parse(right?.updatedAt || "");
  return Number.isFinite(leftTime) && (!Number.isFinite(rightTime) || leftTime > rightTime);
}

export function decideStartup({ database, local }) {
  const databaseReady = Boolean(database?.initialized && database?.state);
  const localReady = Boolean(local?.present && local?.valid && local?.state);

  if (!databaseReady) {
    if (localReady && hasSavedData(local.state)) {
      return { action: "migrate-local", state: normalizeState(local.state), writeDatabase: true, backupLocal: true };
    }
    return { action: "start-empty", state: null, writeDatabase: false, backupLocal: false };
  }

  if (!local?.present) {
    return { action: "use-database", state: normalizeState(database.state), backupLocal: false };
  }
  if (!localReady) {
    return { action: "use-database", state: normalizeState(database.state), backupLocal: true };
  }
  if (sameContent(database.state, local.state)) {
    return { action: "use-database", state: normalizeState(database.state), backupLocal: false };
  }
  if (hasSavedData(local.state) && !hasSavedData(database.state) || isNewer(local.state, database.state)) {
    return {
      action: "choose-newer-local",
      state: normalizeState(local.state),
      databaseState: normalizeState(database.state),
      backupLocal: true,
    };
  }
  return { action: "use-database", state: normalizeState(database.state), backupLocal: true };
}

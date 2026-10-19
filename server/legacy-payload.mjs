const MAX_STATE_BYTES = 10 * 1024 * 1024;

export function normalizeLegacyState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("state must be an object");
  if (!Array.isArray(value.items) || !Array.isArray(value.tasks) || !Array.isArray(value.events)) {
    throw new TypeError("state must contain items, tasks, and events arrays");
  }
  const state = {
    schemaVersion: Number.isInteger(value.schemaVersion) ? value.schemaVersion : 1,
    stateVersion: Number.isInteger(value.stateVersion) ? value.stateVersion : undefined,
    items: value.items,
    tasks: value.tasks,
    events: value.events.slice(0, 2000),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) throw new RangeError("state exceeds the 10 MB import limit");
  return state;
}

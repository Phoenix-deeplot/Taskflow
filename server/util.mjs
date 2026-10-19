import { createHash, randomUUID } from "node:crypto";

export class WorkbenchError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "WorkbenchError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const invalid = (message, details) => new WorkbenchError("INVALID", message, 400, details);
export const notFound = (message) => new WorkbenchError("NOT_FOUND", message, 404);
export const conflict = (message, details) => new WorkbenchError("CONFLICT", message, 409, details);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function isoOrNow(value, fallback) {
  if (typeof value === "string" && value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

export const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);
export const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
export const parseJson = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

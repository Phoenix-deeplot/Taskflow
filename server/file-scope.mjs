/**
 * File-scope overlap, used to keep two tasks that touch the same files from running at once.
 * Deliberately conservative: a false "overlap" only delays a task, a false "no overlap" could corrupt work.
 * A task with no declared scope holds no lock (declaring a scope is how a task opts in).
 */
const GLOB = /[*?[\]{}]/;

/** Path segments that are fixed before the first glob character; `null` means "everything". */
export function scopeSegments(pattern) {
  const normalized = String(pattern ?? "").trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized || /^[a-z]:/.test(normalized)) return null;
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) return null;
  const fixed = [];
  for (const segment of segments) {
    if (GLOB.test(segment)) break;
    fixed.push(segment);
  }
  return fixed;
}

export function patternsOverlap(a, b) {
  const left = scopeSegments(a);
  const right = scopeSegments(b);
  if (left === null || right === null) return true;
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

export function scopesOverlap(first, second) {
  if (!first?.length || !second?.length) return false;
  return first.some((a) => second.some((b) => patternsOverlap(a, b)));
}

/** A pattern a proposal (human or model) may not use: absolute paths, drive letters and `..` escapes. */
export function isUnsafeScope(pattern) {
  const normalized = String(pattern ?? "").trim().replace(/\\/g, "/");
  return !normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").includes("..");
}

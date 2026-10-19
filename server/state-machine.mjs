export const TASK_STATUSES = ["clarification", "queued", "working", "review", "done", "blocked"];
export const RUN_STATUSES = ["running", "succeeded", "failed", "cancelled"];
export const DECISIONS = ["pending", "keep", "modify", "defer", "delete"];
export const VERSIONS = ["V1", "V2", "V3", "Later"];

/**
 * Every allowed task transition. `via` names the only operation that may perform it;
 * "transition" means the generic `transitionTask`. `reason` marks transitions that need a written reason.
 */
export const TASK_TRANSITIONS = [
  { from: "clarification", to: "queued", via: "transition" },
  { from: "clarification", to: "blocked", via: "transition", reason: true },
  { from: "queued", to: "clarification", via: "transition" },
  { from: "queued", to: "blocked", via: "transition", reason: true },
  { from: "queued", to: "working", via: "startTask" },
  { from: "working", to: "review", via: "submitResult" },
  { from: "working", to: "queued", via: "transition", reason: true, cancelsRun: true },
  { from: "working", to: "queued", via: "reportFailure" },
  { from: "working", to: "blocked", via: "transition", reason: true, cancelsRun: true },
  { from: "review", to: "done", via: "acceptTask" },
  { from: "review", to: "queued", via: "rejectTask", reason: true },
  { from: "review", to: "blocked", via: "transition", reason: true },
  { from: "done", to: "queued", via: "reopenTask", reason: true },
  { from: "blocked", to: "queued", via: "transition" },
  { from: "blocked", to: "clarification", via: "transition" },
];

export function findTransition(from, to, via) {
  return TASK_TRANSITIONS.find((rule) => rule.from === from && rule.to === to && rule.via === via) || null;
}

/** Which operation(s) can reach `to` from `from`, for error hints. */
export function operationsFor(from, to) {
  return TASK_TRANSITIONS.filter((rule) => rule.from === from && rule.to === to).map((rule) => rule.via);
}

export const BLOCKER_CODES = {
  NOT_QUEUED: { overridable: false },
  DEPENDENCY_NOT_DONE: { overridable: true },
  REQUIREMENT_DELETED: { overridable: true },
};

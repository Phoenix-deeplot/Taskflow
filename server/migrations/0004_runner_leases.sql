-- Runner support: pending / worker_lost run states, leases, idempotent callbacks, artifacts.
-- task_runs is rebuilt because SQLite cannot change a CHECK constraint in place.
-- Nothing references task_runs by foreign key (events.run_id is a plain column), so the swap is safe.

CREATE TABLE task_runs_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  snapshot_id TEXT REFERENCES task_context_snapshots(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'worker_lost')),
  executor_type TEXT NOT NULL DEFAULT 'manual_handoff',
  executor_id TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result_summary TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  review_decision TEXT CHECK (review_decision IN ('accepted', 'rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  override_reason TEXT NOT NULL DEFAULT '',
  is_legacy INTEGER NOT NULL DEFAULT 0 CHECK (is_legacy IN (0, 1)),
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  lease_token_hash TEXT,
  lease_until TEXT,
  heartbeat_at TEXT,
  cancel_requested_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  UNIQUE (task_id, attempt),
  CHECK (is_legacy = 1 OR snapshot_id IS NOT NULL)
);

INSERT INTO task_runs_new (
  id, task_id, snapshot_id, attempt, status, executor_type, executor_id, started_at, ended_at, result_summary,
  evidence_json, error_code, error_message, review_decision, review_note, reviewed_at, override_reason, is_legacy
)
SELECT
  id, task_id, snapshot_id, attempt, status, executor_type, executor_id, started_at, ended_at, result_summary,
  evidence_json, error_code, error_message, review_decision, review_note, reviewed_at, override_reason, is_legacy
FROM task_runs;

DROP TABLE task_runs;
ALTER TABLE task_runs_new RENAME TO task_runs;

-- At most one unfinished run per task: waiting for a runner counts as unfinished too.
CREATE UNIQUE INDEX one_active_run_per_task ON task_runs (task_id) WHERE status IN ('pending', 'running');
CREATE INDEX task_runs_claim_idx ON task_runs (status, executor_type, started_at);

-- A callback id seen once is never applied twice (events, results, failures).
CREATE TABLE run_callbacks (
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  event_id TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, event_id)
);

-- Large files stay outside the database; only a reference and a checksum are kept.
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_run_idx ON artifacts (run_id);

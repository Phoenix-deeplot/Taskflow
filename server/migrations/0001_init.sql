-- Local single-user schema. Times are UTC ISO-8601 strings written by the application layer.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE workspace_context_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  revision INTEGER NOT NULL,
  rules_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, revision)
);

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  revision INTEGER NOT NULL DEFAULT 1,
  module TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_version TEXT NOT NULL DEFAULT '',
  target_version TEXT NOT NULL DEFAULT 'V1',
  decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'keep', 'modify', 'defer', 'delete')),
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX requirements_workspace_idx ON requirements (workspace_id, deleted_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  requirement_id TEXT REFERENCES requirements(id),
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('clarification', 'queued', 'working', 'review', 'done', 'blocked')),
  provider TEXT NOT NULL DEFAULT '',
  executor_type TEXT NOT NULL DEFAULT 'manual_handoff',
  assignee TEXT NOT NULL DEFAULT '',
  task_text TEXT NOT NULL DEFAULT '',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  file_scope_json TEXT NOT NULL DEFAULT '[]',
  blocked_reason TEXT NOT NULL DEFAULT '',
  legacy_requirement_title TEXT,
  legacy_requirement_module TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_requirement_idx ON tasks (requirement_id);
CREATE INDEX tasks_status_idx ON tasks (workspace_id, status);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE task_context_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  workspace_revision INTEGER NOT NULL,
  requirement_revision INTEGER,
  task_revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  prompt_template_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX snapshots_task_idx ON task_context_snapshots (task_id);

CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON task_context_snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON task_context_snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  snapshot_id TEXT REFERENCES task_context_snapshots(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
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
  UNIQUE (task_id, attempt),
  CHECK (is_legacy = 1 OR snapshot_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_running_run_per_task ON task_runs (task_id) WHERE status = 'running';

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  run_id TEXT,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX events_entity_idx ON events (entity_type, entity_id, id);
CREATE INDEX events_created_idx ON events (created_at);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE migration_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  source_hash TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  report_json TEXT NOT NULL
);

INSERT INTO workspaces (id, name, revision, created_at)
VALUES ('WS-LOCAL', '本地工作区', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO workspace_context_versions (id, workspace_id, revision, rules_json, created_by, created_at)
VALUES ('CTX-1', 'WS-LOCAL', 1, '{"rules":[],"glossary":[],"constraints":[]}', 'system',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

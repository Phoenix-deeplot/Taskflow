-- Requirement split proposals. A draft never creates real tasks; only confirming it does.
CREATE TABLE split_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  requirement_id TEXT NOT NULL REFERENCES requirements(id),
  requirement_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'discarded')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'provider')),
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  prompt_template_version TEXT NOT NULL DEFAULT '',
  input_json TEXT NOT NULL DEFAULT '{}',
  input_hash TEXT NOT NULL DEFAULT '',
  tasks_json TEXT NOT NULL,
  usage_json TEXT NOT NULL DEFAULT '{}',
  confirmed_task_ids_json TEXT NOT NULL DEFAULT '[]',
  discard_reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX split_drafts_requirement_idx ON split_drafts (requirement_id, status);

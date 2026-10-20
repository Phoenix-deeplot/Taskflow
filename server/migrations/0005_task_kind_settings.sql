-- Task kind: "analysis" runs read-only and produces a written answer; "execution" changes files on a branch.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'execution' CHECK (kind IN ('execution', 'analysis'));

-- Small key/value settings (currently: the project directory agents work in).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

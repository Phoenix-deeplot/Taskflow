-- A free-form working note on a task (the prototype's "AI 建议 / 结果记录" box).
-- Separate from task_runs.result_summary, which is the formal result submitted for review.
ALTER TABLE tasks ADD COLUMN result_note TEXT NOT NULL DEFAULT '';

-- Add subtask support: parent-child relationships for tasks
ALTER TABLE task_ref ADD COLUMN IF NOT EXISTS parent_external_task_id TEXT;
ALTER TABLE task_ref ADD COLUMN IF NOT EXISTS parent_task_ref_id UUID REFERENCES task_ref(id);
ALTER TABLE task_ref ADD COLUMN IF NOT EXISTS position TEXT;

CREATE INDEX IF NOT EXISTS idx_task_ref_parent ON task_ref (parent_task_ref_id);

-- Add list_type to project_ref to capture semantic meaning
-- (do, subjects, learn, or user-defined)
ALTER TABLE project_ref ADD COLUMN IF NOT EXISTS list_type TEXT;

-- Google Tasks is now read-only, and linking uses only task titles and
-- status. Notes and due/completion dates are kept for the "Subjects" list
-- alone, which the idea import copies from (list_subjects_for_import), and
-- the sync no longer fetches them for other lists. This clears the copies
-- already stored for those other lists. Google keeps the originals.
-- Idempotent.

SET LOCAL statement_timeout = 0;

UPDATE task_ref t
   SET notes = NULL, due_at = NULL, completed_at = NULL
 WHERE (t.notes IS NOT NULL OR t.due_at IS NOT NULL OR t.completed_at IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM project_ref p
      WHERE p.id = t.project_ref_id AND p.list_type = 'subjects'
   );

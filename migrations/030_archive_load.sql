-- 030_archive_load.sql
--
-- Published-archive consolidation, step 4: load. Each work (029) becomes one
-- public_artifact row with source_system 'archive'. Rows from the first
-- import that a work replaces are marked superseded, never deleted. See
-- docs/archive-consolidation.md.

ALTER TABLE public_artifact
  -- Searchable, but not confirmed by consolidation: 'review' is a work
  -- still to check (unpublished, or its canonical text uncertain);
  -- 'unmatched' is a row from the first import that matches no work.
  ADD COLUMN IF NOT EXISTS flag TEXT CHECK (flag IN ('review', 'unmatched')),
  -- The row that replaces this one. The row leaves search (status
  -- 'superseded') once its replacement has been processed, so a piece is
  -- never missing from search while its new row waits in the queue.
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES public_artifact(id) ON DELETE SET NULL,
  -- Every outlet the piece went to, the first publication's first.
  ADD COLUMN IF NOT EXISTS outlets TEXT[];

CREATE INDEX IF NOT EXISTS idx_public_artifact_superseded_by
  ON public_artifact (superseded_by) WHERE superseded_by IS NOT NULL;

ALTER TABLE archive_collect_run DROP CONSTRAINT IF EXISTS archive_collect_run_source_check;
ALTER TABLE archive_collect_run
  ADD CONSTRAINT archive_collect_run_source_check
  CHECK (source IN ('gmail', 'gdrive', 'extract', 'match', 'load'));

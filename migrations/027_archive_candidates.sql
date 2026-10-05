-- 027_archive_candidates.sql
--
-- Published-archive consolidation, step 2: extract. Each staged source item
-- (021_archive_staging.sql) becomes one candidate: the essay text with notes
-- to editors, quoted replies, signatures and platform wrappers removed, plus
-- what extraction could tell about it (kind, outlet, column, date). Nothing
-- in archive_source_item changes; a re-run rewrites every candidate, so the
-- rules can be improved and run again. See docs/archive-consolidation.md.

CREATE TABLE IF NOT EXISTS archive_candidate (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_item_id UUID NOT NULL UNIQUE REFERENCES archive_source_item(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  -- submission | attachment | newsletter | self_draft | post | page | doc |
  -- reply | forward | received | platform_copy | draft | empty | duplicate
  kind TEXT NOT NULL,
  -- keep: an essay; review: probably, but a rule was unsure; drop: not one.
  status TEXT NOT NULL CHECK (status IN ('keep', 'review', 'drop')),
  reasons TEXT[] NOT NULL DEFAULT '{}',
  title TEXT,
  outlet TEXT,
  column_name TEXT,
  published_at TIMESTAMPTZ,
  -- sent | subject | email | export | title | file-created
  date_source TEXT,
  is_published BOOLEAN,
  body_text TEXT,
  -- Text removed before the essay (a note to the editor), for review.
  note TEXT,
  -- Copies of one newsletter issue share a key; all but one are duplicates.
  dedupe_key TEXT,
  char_count INTEGER NOT NULL DEFAULT 0,
  extractor_version INTEGER NOT NULL,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_archive_candidate_source_status ON archive_candidate (source, status);
CREATE INDEX IF NOT EXISTS idx_archive_candidate_kind ON archive_candidate (kind);
CREATE INDEX IF NOT EXISTS idx_archive_candidate_dedupe ON archive_candidate (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Extraction runs share the collection runs' tracking (heartbeat, status,
-- resume after a restart).
ALTER TABLE archive_collect_run DROP CONSTRAINT IF EXISTS archive_collect_run_source_check;
ALTER TABLE archive_collect_run
  ADD CONSTRAINT archive_collect_run_source_check CHECK (source IN ('gmail', 'gdrive', 'extract'));

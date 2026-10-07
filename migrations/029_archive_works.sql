-- 029_archive_works.sql
--
-- Published-archive consolidation, step 3: match. Candidates of the same
-- piece (a column, its resends, its Substack repost, its Drive draft) form
-- one work with one canonical text. Every match run rebuilds both tables
-- from archive_candidate (027). See docs/archive-consolidation.md.

CREATE TABLE IF NOT EXISTS archive_work (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_candidate_id UUID NOT NULL UNIQUE REFERENCES archive_candidate(id) ON DELETE CASCADE,
  title TEXT,
  -- First publication: the earliest date among the published members.
  published_at TIMESTAMPTZ,
  outlet TEXT,
  column_name TEXT,
  -- Every outlet a member went to, canonical's first.
  outlets TEXT[] NOT NULL DEFAULT '{}',
  is_published BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('keep', 'review')),
  reasons TEXT[] NOT NULL DEFAULT '{}',
  member_count INTEGER NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  matcher_version INTEGER NOT NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive_work_member (
  work_id UUID NOT NULL REFERENCES archive_work(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL UNIQUE REFERENCES archive_candidate(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('canonical', 'copy')),
  -- Jaccard similarity of the member's text to the canonical text.
  similarity REAL NOT NULL,
  PRIMARY KEY (work_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_archive_work_status ON archive_work (status);
CREATE INDEX IF NOT EXISTS idx_archive_work_published ON archive_work (published_at);

ALTER TABLE archive_collect_run DROP CONSTRAINT IF EXISTS archive_collect_run_source_check;
ALTER TABLE archive_collect_run
  ADD CONSTRAINT archive_collect_run_source_check CHECK (source IN ('gmail', 'gdrive', 'extract', 'match'));

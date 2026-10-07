-- 028_idea_garden_v2.sql
--
-- Idea Garden v2 (refocus Phase 4, docs/decisions/2026-10-05-refocus.md):
-- the schema only. It ships ahead of the Worker code that uses it, because
-- the Worker deploys on merge while migrations run when the monolith boots.
-- Every change is additive, so the current Worker keeps working.
--
--   idea.reviewed_at       when a garden review handled the idea. NULL means
--                          the idea is in the inbox. There is no backfill:
--                          every existing idea starts in the inbox (Simon's
--                          call), and imported ideas land there too (D2).
--   idea.promoted_at,      when Simon promoted the idea to his Google Tasks
--   idea.promoted_title    "Subjects" list, and the task title used (D1).
--                          Simon or Muse writes the task; 2nd-brain only
--                          records it. Set together or not at all.
--   idea_link.link_type    adds mechanism_for (directed: the source explains
--                          why the target happens) and inverts (symmetric:
--                          each is the other with the causality flipped), D4.
--                          Stored names never change; the brief's names
--                          (contradicts, extends, ...) are display labels.
--   idea_link.proposed_by  adds 'capture': links proposed right after a
--                          capture, which wait for Simon's yes (D3).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded constraints, and CHECKs
-- dropped and re-added under the same names (019 left them unnamed, so
-- Postgres named them <table>_<column>_check). Nothing is deleted.

SET LOCAL statement_timeout = 0;

ALTER TABLE idea ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE idea ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
ALTER TABLE idea ADD COLUMN IF NOT EXISTS promoted_title TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idea_promoted_pair') THEN
    ALTER TABLE idea ADD CONSTRAINT idea_promoted_pair CHECK (
      (promoted_at IS NULL) = (promoted_title IS NULL)
      AND (promoted_title IS NULL OR length(btrim(promoted_title)) BETWEEN 1 AND 500)
    );
  END IF;
END $$;

-- The inbox: ideas no garden review has handled yet.
CREATE INDEX IF NOT EXISTS idx_idea_inbox ON idea (user_id, captured_at) WHERE reviewed_at IS NULL;

ALTER TABLE idea_link DROP CONSTRAINT IF EXISTS idea_link_link_type_check;
ALTER TABLE idea_link ADD CONSTRAINT idea_link_link_type_check CHECK (link_type IN (
  'builds_on', 'example_of', 'part_of', 'tension_with', 'same_mechanism',
  'combines_with', 'related', 'became', 'revisits', 'mechanism_for', 'inverts'
));

-- Symmetric types are stored once per pair, smaller id first.
ALTER TABLE idea_link DROP CONSTRAINT IF EXISTS idea_link_symmetric_canonical;
ALTER TABLE idea_link ADD CONSTRAINT idea_link_symmetric_canonical CHECK (
  link_type NOT IN ('tension_with', 'same_mechanism', 'combines_with', 'related', 'inverts')
  OR source_idea_id < target_idea_id
);

ALTER TABLE idea_link DROP CONSTRAINT IF EXISTS idea_link_proposed_by_check;
ALTER TABLE idea_link ADD CONSTRAINT idea_link_proposed_by_check
  CHECK (proposed_by IN ('gardening', 'import', 'synthesis', 'capture'));

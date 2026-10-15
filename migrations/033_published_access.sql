-- 033_published_access.sql
--
-- Members-only pieces in the published archive (refocus Phase 5, D10 in
-- docs/decisions/2026-10-05-refocus.md): today, YouTube members-only
-- episodes. They stay in the archive and never go on a public surface.
-- The schema only, ahead of the code that reads it: the Worker deploys on
-- merge, while migrations run when the monolith boots. See
-- docs/archive-consolidation.md.
--
-- Idempotent, and nothing is rewritten: with a constant default, every
-- existing row reads false without being touched.

SET LOCAL statement_timeout = 0;

ALTER TABLE public_artifact
  -- A column, not a tag: the archive worker replaces a row's tags, and
  -- every YouTube re-sync resets them. Only the YouTube import sets it (a
  -- sync that leaves the field out keeps the stored value); a load never
  -- does.
  ADD COLUMN IF NOT EXISTS members_only BOOLEAN NOT NULL DEFAULT false;

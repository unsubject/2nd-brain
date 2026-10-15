-- 033_archive_old_rows.sql
--
-- Published-archive consolidation, step 4: Simon's rules (2026-10-15) for
-- the rows of the first import that are no copy of any version. A copy of
-- a video's transcript with no transcript row stays searchable, flagged
-- 'video'; a fragment (a reply, a pitch, a blurb) leaves search (status
-- 'hidden'), flagged 'fragment'. 'unmatched' is no longer written. See
-- docs/archive-consolidation.md.

ALTER TABLE public_artifact DROP CONSTRAINT IF EXISTS public_artifact_flag_check;
ALTER TABLE public_artifact
  ADD CONSTRAINT public_artifact_flag_check
  CHECK (flag IN ('review', 'unmatched', 'video', 'fragment'));

-- 031_archive_claim.sql
--
-- Archive worker leases. Each time the worker claims a public_artifact row
-- it gets a token of its own, and every write it makes for that pass (the
-- result, or the error) requires the token. A claim taken back (its lease
-- expired), requeued by a load or reset by hand loses its token, so a
-- worker that held it writes nothing, even once another pass has finished
-- the row (Codex on #102). See docs/archive-consolidation.md.

ALTER TABLE public_artifact
  -- The claim the row is held under; NULL when no worker holds it.
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  -- The lease: set at the claim, renewed between the worker's model
  -- steps. A row 'processing' whose lease is 15 minutes old goes back to
  -- the queue. No backfill: a row left 'processing' before this column
  -- existed has none, and its updated_at (stamped by that claim) stands in.
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

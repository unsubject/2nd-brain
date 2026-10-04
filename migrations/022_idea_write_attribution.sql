-- 022_idea_write_attribution.sql
--
-- Record which MCP connection (credential label, migration 020) made the
-- remaining kinds of idea writes, permanently. The call log also records
-- this, but it is pruned after MCP_CALL_LOG_RETENTION_DAYS.
--
--   idea.edit_log          append-only [{at, credential, tool, fields?}], one
--                          entry per update_idea call (with the fields it
--                          touched) or import merge (no fields). Notes also
--                          carry their own `credential`.
--   idea_link.decided_via  {credential} — who recorded the current decision.
--                          The Worker sets it with decided_at and clears it on
--                          reopen. Retracting snapshots the previous decision
--                          into `history`; accepting with a different type or
--                          direction, reopening and reviving also snapshot the
--                          previous proposal and proposer.
--
-- An earlier revision of this branch shipped a different 022 under another
-- filename (idea.updated_via). Every statement here is idempotent so a
-- database that ran either revision converges on this one.
--
-- The decided_via CHECK only pins the shape, not the pairing with
-- decided_at: a Worker rolled back to a build that predates this column
-- reopens links by clearing decided_at alone, and must not hit a CHECK.

ALTER TABLE idea ADD COLUMN IF NOT EXISTS edit_log JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE idea DROP COLUMN IF EXISTS updated_via;
ALTER TABLE idea_link ADD COLUMN IF NOT EXISTS decided_via JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idea_edit_log_array') THEN
    ALTER TABLE idea ADD CONSTRAINT idea_edit_log_array
      CHECK (jsonb_typeof(edit_log) = 'array');
  END IF;
END $$;

ALTER TABLE idea_link DROP CONSTRAINT IF EXISTS idea_link_decided_via;
ALTER TABLE idea_link ADD CONSTRAINT idea_link_decided_via
  CHECK (decided_via IS NULL OR jsonb_typeof(decided_via) = 'object');

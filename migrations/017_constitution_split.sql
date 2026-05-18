-- 017_constitution_split.sql
--
-- Restructure the goal system into a 4-layer hierarchy:
--   1. constitution_domains — 5 stable, crisis-rooted "north star"
--      principles (Mind / Body / Family / Wealth / Social). NOT SMART.
--      Change only via constitution_amendments with 14-day cooldown +
--      mandatory crisis_justification.
--   2. goals — SMART, outcome-measured, ~1yr commitment, max 3 active per
--      constitution_domain. Reviewed at most quarterly. Change via
--      goal_amendments with 72h cooldown.
--   3. undertakings (existing, repointed) — monthly/quarterly cycles,
--      output-measured, weekly progress review. FK now references the
--      NEW goals table, not constitution_domains.
--   4. task_ref (existing, untouched) — daily/weekly review.
--
-- Migration 015 introduced `goals`/`goal_amendments` with SMART fields
-- baked in at the top layer. That conflated direction (constitution)
-- with measurement (goals). This split separates them.
--
-- Greenfield: live DB has 0 rows in goals, goal_amendments, undertakings,
-- and undertaking_cycles, so the rename path is purely structural.

-- ── 1. Rename old goals → constitution_domains ────────────────────────
-- Drop SMART columns (constitution is direction, not measurement).
-- Add `label` for the named domain (Mind, Body, …).

ALTER TABLE goals RENAME TO constitution_domains;

ALTER TABLE constitution_domains
  DROP COLUMN IF EXISTS specific,
  DROP COLUMN IF EXISTS measurable,
  DROP COLUMN IF EXISTS achievable,
  DROP COLUMN IF EXISTS relevant,
  DROP COLUMN IF EXISTS time_bound;

ALTER TABLE constitution_domains
  ADD COLUMN IF NOT EXISTS label TEXT NOT NULL;

-- One label per user (no duplicate domain names).
CREATE UNIQUE INDEX IF NOT EXISTS idx_constitution_domains_user_label
  ON constitution_domains (user_id, label);

-- Replace the old idx_goals_active (auto-followed the table rename, but
-- the name still says "goals"). Drop and recreate with the right name.
DROP INDEX IF EXISTS idx_goals_active;
CREATE INDEX IF NOT EXISTS idx_constitution_domains_active
  ON constitution_domains (user_id) WHERE status = 'active';

-- merged_into_id self-FK auto-follows the rename; the PG-generated
-- constraint name still says "goals_*" — leave it, constraint names
-- aren't user-visible.

-- ── 2. Rename goal_amendments → constitution_amendments ───────────────
-- 14-day cooldown (vs 72h before).
-- crisis_justification required for EVERY kind (not just 'new').

ALTER TABLE goal_amendments RENAME TO constitution_amendments;

ALTER TABLE constitution_amendments
  RENAME COLUMN irreducibility_justification TO crisis_justification;

-- Required for all kinds — the 015 schema made it required only for
-- 'new'. Constitution-level changes always need a crisis story.
ALTER TABLE constitution_amendments
  ALTER COLUMN crisis_justification SET NOT NULL;

-- The 015 CHECK only fired for kind='new'. Replace with the stronger
-- NOT NULL invariant above; drop the now-redundant CHECK.
ALTER TABLE constitution_amendments
  DROP CONSTRAINT IF EXISTS goal_amendments_new_has_justification;

-- Rename the foreign-key column from goal_id → constitution_domain_id.
-- The FK auto-follows the renamed parent table (constitution_domains).
ALTER TABLE constitution_amendments
  RENAME COLUMN goal_id TO constitution_domain_id;

-- Rename source_goal_ids → source_constitution_domain_ids. At this
-- layer the IDs are constitution_domain IDs; the misnomer dates to
-- when this table did double duty. CHECK constraint expressions
-- auto-update with the column rename (PG follows the column).
ALTER TABLE constitution_amendments
  RENAME COLUMN source_goal_ids TO source_constitution_domain_ids;

-- Synthesize CHECK — drop the old auto-followed name, re-add with a
-- name that matches the new table.
ALTER TABLE constitution_amendments
  DROP CONSTRAINT IF EXISTS goal_amendments_synthesize_has_sources;
ALTER TABLE constitution_amendments
  ADD CONSTRAINT constitution_amendments_synthesize_has_sources
    CHECK (kind <> 'synthesize' OR cardinality(source_constitution_domain_ids) >= 2);

-- Drop the old trigger + function (72h cooldown). Recreate with 14d.
-- Same trigger pattern as 015: BEFORE INSERT OR UPDATE, with UPDATE
-- pinning both proposed_at and cooldown_until to their OLD values so
-- no client path can move the cooldown.
DROP TRIGGER IF EXISTS goal_amendments_set_cooldown ON constitution_amendments;
DROP FUNCTION IF EXISTS set_goal_amendment_cooldown();

CREATE OR REPLACE FUNCTION set_constitution_amendment_cooldown() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.cooldown_until := NEW.proposed_at + interval '14 days';
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.proposed_at := OLD.proposed_at;
    NEW.cooldown_until := OLD.cooldown_until;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS constitution_amendments_set_cooldown ON constitution_amendments;
CREATE TRIGGER constitution_amendments_set_cooldown
  BEFORE INSERT OR UPDATE ON constitution_amendments
  FOR EACH ROW EXECUTE FUNCTION set_constitution_amendment_cooldown();

DROP INDEX IF EXISTS idx_goal_amendments_pending;
DROP INDEX IF EXISTS idx_goal_amendments_goal;
CREATE INDEX IF NOT EXISTS idx_constitution_amendments_pending
  ON constitution_amendments (proposed_at DESC) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_constitution_amendments_domain
  ON constitution_amendments (constitution_domain_id);

-- ── 3. New goals table (SMART layer beneath constitution) ─────────────

CREATE TABLE IF NOT EXISTS goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  constitution_domain_id UUID NOT NULL REFERENCES constitution_domains(id),
  statement TEXT NOT NULL,
  -- SMART fields (same shape as the old goals table had, now living one
  -- level down where they belong: outcome targets, not direction).
  specific TEXT NOT NULL,
  measurable TEXT NOT NULL,
  achievable TEXT NOT NULL,
  relevant TEXT NOT NULL,
  time_bound TEXT NOT NULL,
  -- The outcome metric — what gets measured at quarterly review.
  -- Outcome (not output): "lose 10 lbs", not "go to gym 3x/week".
  -- Output-level test criteria live on undertakings.
  outcome_metric TEXT NOT NULL,
  target_date DATE,
  last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'achieved', 'abandoned', 'merged')),
  -- Two goals synthesize → originals retained with pointer at successor.
  merged_into_id UUID REFERENCES goals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_amended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT goals_merge_consistency
    CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_goals_active
  ON goals (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_goals_domain
  ON goals (constitution_domain_id) WHERE status = 'active';

-- Cap: ≤3 active goals per (user_id, constitution_domain_id). Enforced
-- via trigger because partial unique indexes can't express "count <= N"
-- and an app-side check has the same race-window problem the P2 badge
-- on PR #50 was about. Trigger sees the row in its final state and
-- raises if the cap would be exceeded. Fires on INSERT and on any
-- UPDATE that flips status into 'active' from a non-active state.
CREATE OR REPLACE FUNCTION enforce_goals_cap() RETURNS TRIGGER AS $$
DECLARE
  active_count INT;
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    SELECT count(*) INTO active_count
      FROM goals
     WHERE user_id = NEW.user_id
       AND constitution_domain_id = NEW.constitution_domain_id
       AND status = 'active'
       AND id <> NEW.id;
    IF active_count >= 3 THEN
      RAISE EXCEPTION 'goals cap reached: domain % already has 3 active goals',
        NEW.constitution_domain_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS goals_cap_check ON goals;
CREATE TRIGGER goals_cap_check
  BEFORE INSERT OR UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION enforce_goals_cap();

-- ── 4. New goal_amendments table (72h cooldown, applies to goals) ─────
-- Distinct table from constitution_amendments above. Same audit-log +
-- cooldown pattern, looser cadence (goals are reviewable; constitution
-- is not).

CREATE TABLE IF NOT EXISTS goal_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  -- 'achieve' / 'abandon' are status transitions; 'retire' doesn't exist
  -- at this layer (goals end via achievement or abandonment, not crisis).
  kind TEXT NOT NULL CHECK (kind IN ('new','amend','synthesize','achieve','abandon')),
  goal_id UUID REFERENCES goals(id),
  source_goal_ids UUID[] NOT NULL DEFAULT '{}',
  proposed_payload JSONB NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','committed','withdrawn')),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cooldown_until TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  CONSTRAINT goal_amendments_synthesize_has_sources
    CHECK (kind <> 'synthesize' OR cardinality(source_goal_ids) >= 2)
);

CREATE OR REPLACE FUNCTION set_goal_amendment_cooldown() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.cooldown_until := NEW.proposed_at + interval '72 hours';
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.proposed_at := OLD.proposed_at;
    NEW.cooldown_until := OLD.cooldown_until;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS goal_amendments_set_cooldown ON goal_amendments;
CREATE TRIGGER goal_amendments_set_cooldown
  BEFORE INSERT OR UPDATE ON goal_amendments
  FOR EACH ROW EXECUTE FUNCTION set_goal_amendment_cooldown();

CREATE INDEX IF NOT EXISTS idx_goal_amendments_pending
  ON goal_amendments (proposed_at DESC) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_goal_amendments_goal
  ON goal_amendments (goal_id);

-- ── 5. Repoint undertakings.primary_goal_id from constitution_domains
--      (the former goals table) to the new goals table ────────────────
-- Drop the old auto-named FK and re-add pointing at the new goals.
-- secondary_goal_ids stays as uuid[] (no FK; validated app-side, same
-- as before).

ALTER TABLE undertakings
  DROP CONSTRAINT IF EXISTS undertakings_primary_goal_id_fkey;
ALTER TABLE undertakings
  ADD CONSTRAINT undertakings_primary_goal_id_fkey
    FOREIGN KEY (primary_goal_id) REFERENCES goals(id);

-- ── Done. Tool surface (mcp-worker/src/tools/) is updated in companion
--    commits in this PR.

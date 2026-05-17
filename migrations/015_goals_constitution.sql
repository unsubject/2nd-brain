-- Personal goal system: the user's "constitution".
-- Goals are stable, low-cardinality, crisis-rooted SMART statements that
-- red-flag drift rather than dictate action. Undertakings are
-- work-in-flight that serves a goal. Tasks are NOT modeled here — they
-- live in Google Tasks; undertakings.gtasks_parent_id is the bridge from
-- an undertaking to its action-item subtasks.
--
-- DISAMBIGUATION FROM project_ref:
--   project_ref  = one row per Google Tasks LIST (Build, Family, Subjects, ...)
--   undertakings = one row per focused effort under a goal
-- Both live in this DB. project_ref is an external-system mirror (the
-- _ref suffix convention). undertakings is a first-class internal entity.
--
-- See docs/goal-amendment-interview.md for the amendment protocol that
-- drives writes to goals/goal_amendments.

-- Goals --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  -- SMART breakdown. Five NOT NULL columns enforce the discipline (vs a
  -- JSON blob where omissions slip through).
  specific TEXT NOT NULL,
  measurable TEXT NOT NULL,
  achievable TEXT NOT NULL,
  relevant TEXT NOT NULL,
  time_bound TEXT NOT NULL,
  -- The precipitating crisis. NOT NULL by design — if you can't name it,
  -- it isn't constitutional yet.
  crisis_origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','merged','retired')),
  -- When two goals synthesize, originals retained with this pointer at
  -- the unified successor.
  merged_into_id UUID REFERENCES goals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_amended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT goals_merge_consistency
    CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_goals_active
  ON goals (user_id) WHERE status = 'active';

-- Undertakings -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS undertakings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  outcome TEXT NOT NULL,
  test_criteria TEXT NOT NULL,
  primary_goal_id UUID NOT NULL REFERENCES goals(id),
  -- Rare: an undertaking serving >1 goal. Postgres can't FK array elements;
  -- handlers validate existence app-side (both create_undertaking and
  -- update_undertaking).
  secondary_goal_ids UUID[] NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL DEFAULT 'outcome'
    CHECK (kind IN ('outcome','habit_forming')),
  -- Bridge to Google Tasks. Action items live as subtasks of this parent.
  gtasks_parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','archived','sleeping')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_undertakings_primary_goal
  ON undertakings (primary_goal_id);
CREATE INDEX IF NOT EXISTS idx_undertakings_active
  ON undertakings (user_id) WHERE status = 'active';

-- Undertaking cycles (habit_forming kind only) -----------------------------
CREATE TABLE IF NOT EXISTS undertaking_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  undertaking_id UUID NOT NULL REFERENCES undertakings(id) ON DELETE CASCADE,
  cycle_number INT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','closed')),
  streak_summary JSONB,
  reformulation_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  UNIQUE (undertaking_id, cycle_number)
);
-- At most one active cycle per undertaking.
CREATE UNIQUE INDEX IF NOT EXISTS idx_undertaking_cycles_one_active
  ON undertaking_cycles (undertaking_id) WHERE status = 'active';

-- Goal amendments (audit log + 72h cooldown staging) -----------------------
CREATE TABLE IF NOT EXISTS goal_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('new','amend','synthesize','retire')),
  -- For amend/retire: the goal being changed.
  -- For new: set to the inserted goal_id on commit.
  -- For synthesize: set to the resulting (unified) goal_id on commit.
  goal_id UUID REFERENCES goals(id),
  -- For synthesize only: the goals being unified.
  source_goal_ids UUID[] NOT NULL DEFAULT '{}',
  -- Full proposed state of the goal(s). Shape varies by kind; the handler
  -- validates at propose time via zod, and re-validates the required keys
  -- at commit time before applying.
  proposed_payload JSONB NOT NULL,
  rationale TEXT NOT NULL,
  -- Required for kind='new' only — why this can't be an amendment.
  irreducibility_justification TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','committed','withdrawn')),
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- cooldown_until is set by a BEFORE INSERT trigger below. We can't use
  -- GENERATED ALWAYS AS (proposed_at + interval '72 hours') STORED because
  -- timestamptz + interval is STABLE (timezone-dependent), and Postgres
  -- requires generation expressions to be IMMUTABLE. The trigger gives
  -- equivalent semantics — clients can't meaningfully override the value
  -- because the trigger always overwrites.
  cooldown_until TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  CONSTRAINT goal_amendments_new_has_justification
    CHECK (kind <> 'new' OR irreducibility_justification IS NOT NULL),
  CONSTRAINT goal_amendments_synthesize_has_sources
    CHECK (kind <> 'synthesize' OR cardinality(source_goal_ids) >= 2)
);

CREATE OR REPLACE FUNCTION set_goal_amendment_cooldown() RETURNS TRIGGER AS $$
BEGIN
  NEW.cooldown_until := NEW.proposed_at + interval '72 hours';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS goal_amendments_set_cooldown ON goal_amendments;
CREATE TRIGGER goal_amendments_set_cooldown
  BEFORE INSERT ON goal_amendments
  FOR EACH ROW EXECUTE FUNCTION set_goal_amendment_cooldown();

CREATE INDEX IF NOT EXISTS idx_goal_amendments_pending
  ON goal_amendments (proposed_at DESC) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_goal_amendments_goal
  ON goal_amendments (goal_id);

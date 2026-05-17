-- editorial_pick: training-signal storage for the socialisn2 candidate workflow.
-- One row per pick/pass/defer decision Simon makes on an editorial candidate.
-- Candidate fields are denormalized snapshots — socialisn2's candidate is
-- ephemeral upstream, so we keep enough context for offline learning even
-- after the original candidate is garbage-collected.
--
-- record_episode_link later sets episode_url + episode_linked_at on a
-- previously-picked row, when the candidate eventually ships as an episode.

CREATE TABLE IF NOT EXISTS editorial_pick (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision TEXT NOT NULL CHECK (decision IN ('pick','pass','defer')),
  reason TEXT,
  headline TEXT NOT NULL,
  context TEXT,
  domain TEXT,
  keywords JSONB,
  tags JSONB,
  urls JSONB,
  episode_url TEXT,
  episode_linked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_editorial_pick_recorded
  ON editorial_pick (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_editorial_pick_decision
  ON editorial_pick (decision, recorded_at DESC);

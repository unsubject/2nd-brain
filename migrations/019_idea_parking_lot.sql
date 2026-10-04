-- 019_idea_parking_lot.sql
--
-- Idea Parking Lot: curated raw material, one stage before work. Ideas
-- are NOT tasks (no due dates, no priorities). See
-- docs/phase-idea-parking-lot-spec.md and docs/idea-parking-lot-protocol.md.
--
--   idea         — one parked idea unit, or a synthesis (several ideas
--                  combined into something bigger, e.g. an episode seed).
--   idea_source  — provenance. One idea can carry several sources (a
--                  Notion row and the Google Tasks item it came from), each
--                  idempotent on (user, system, external id) with a
--                  lossless copy of the original record.
--   idea_link    — typed associations, created ONLY through gardening:
--                  proposed → accepted | rejected | withdrawn,
--                  accepted → retracted. Rejected/retracted pairs are
--                  remembered so they are not re-proposed.
--
-- Deliberately separate from link_edge: link_edge is the machine-made
-- graph (user_id 'default', no lifecycle, no FKs). Idea links are
-- human-confirmed and carry a lifecycle, rationale and real FKs.
--
-- Embeddings are written by the Node sweeper (src/ideas/worker.ts). The
-- Worker inserts rows with embedding NULL; the BEFORE UPDATE trigger
-- clears the embedding whenever an embedded field changes so the
-- sweeper re-embeds it.

-- ── 1. idea ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS idea (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unit' CHECK (kind IN ('unit', 'synthesis')),
  -- What a synthesis is meant to become. NULL for units.
  intent TEXT CHECK (intent IN ('episode', 'essay', 'series', 'learning', 'undecided')),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'parked'
    CHECK (status IN ('parked', 'exploring', 'used', 'composted')),
  -- When the idea was encountered (may be backdated on import).
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  encountered_where TEXT,
  source_url TEXT,
  source_title TEXT,
  source_excerpt TEXT,
  why_interesting TEXT,
  -- The user's own words, verbatim. Never paraphrased by an AI.
  thoughts TEXT,
  -- AI-written framing ("what it is / what it is not"). Never the user's words.
  framing TEXT,
  -- Development log: [{at, by: 'simon'|'agent'|'import'|'system', text}]
  notes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notes) = 'array'),
  tags TEXT[] NOT NULL DEFAULT '{}',
  -- {client, model, role: 'librarian'|'importer'|'gardener'}
  captured_via JSONB,
  embedding vector(1536),
  embedding_model TEXT,
  embedded_at TIMESTAMPTZ,
  embed_attempts INT NOT NULL DEFAULT 0,
  embed_error TEXT,
  -- Backoff after a row-specific embedding failure (NULL = eligible now).
  embed_retry_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idea_intent_iff_synthesis CHECK ((kind = 'synthesis') = (intent IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_idea_user_status
  ON idea (user_id, status, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_idea_tags
  ON idea USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_idea_embedding
  ON idea USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_idea_needs_embedding
  ON idea (updated_at) WHERE embedding IS NULL;

-- kind is immutable; any change to an embedded field clears the
-- embedding (the sweeper re-embeds); status changes are timestamped.
-- Only notes written by the user count as embedded text, so agent/system
-- notes don't force a re-embed.
CREATE OR REPLACE FUNCTION idea_before_update() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'idea.kind is immutable (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.framing IS DISTINCT FROM OLD.framing
     OR NEW.why_interesting IS DISTINCT FROM OLD.why_interesting
     OR NEW.thoughts IS DISTINCT FROM OLD.thoughts
     OR NEW.source_title IS DISTINCT FROM OLD.source_title
     OR NEW.source_excerpt IS DISTINCT FROM OLD.source_excerpt
     OR NEW.tags IS DISTINCT FROM OLD.tags
     OR jsonb_path_query_array(NEW.notes, '$[*] ? (@.by == "simon").text')
        IS DISTINCT FROM
        jsonb_path_query_array(OLD.notes, '$[*] ? (@.by == "simon").text')
  THEN
    NEW.embedding := NULL;
    NEW.embedding_model := NULL;
    NEW.embedded_at := NULL;
    NEW.embed_attempts := 0;
    NEW.embed_error := NULL;
    NEW.embed_retry_at := NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS idea_before_update ON idea;
CREATE TRIGGER idea_before_update
  BEFORE UPDATE ON idea
  FOR EACH ROW EXECUTE FUNCTION idea_before_update();

-- ── 2. idea_source (provenance) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS idea_source (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id UUID NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  source_system TEXT NOT NULL
    CHECK (source_system IN ('librarian', 'notion', 'gtasks_subjects', 'gardening')),
  -- Notion row key | Google task id | librarian idempotency key
  source_external_id TEXT,
  -- Lossless copy of the original record (imports only).
  import_payload JSONB,
  -- true when this source was attached to a pre-existing idea (dedup).
  merged BOOLEAN NOT NULL DEFAULT false,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idea_source_ext_required
    CHECK (source_system IN ('librarian', 'gardening') OR source_external_id IS NOT NULL),
  -- NULL external ids are distinct, so keyless librarian captures are fine.
  CONSTRAINT idea_source_unique UNIQUE (user_id, source_system, source_external_id)
);

CREATE INDEX IF NOT EXISTS idx_idea_source_idea ON idea_source (idea_id);

-- ── 3. idea_link (gardening-only associations) ────────────────────────

CREATE TABLE IF NOT EXISTS idea_link (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  source_idea_id UUID NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  target_idea_id UUID REFERENCES idea(id) ON DELETE CASCADE,
  target_artifact_id UUID REFERENCES public_artifact(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN (
    'builds_on', 'example_of', 'part_of',
    'tension_with', 'same_mechanism', 'combines_with', 'related',
    'became', 'revisits'
  )),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'rejected', 'withdrawn', 'retracted')),
  rationale TEXT NOT NULL CHECK (length(btrim(rationale)) BETWEEN 3 AND 500),
  similarity REAL,
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('gardening', 'import', 'synthesis')),
  proposed_via JSONB,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  -- Prior states when a proposal is reopened: [{status, rationale, link_type, at}]
  history JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
  CONSTRAINT idea_link_one_target
    CHECK (num_nonnulls(target_idea_id, target_artifact_id) = 1),
  CONSTRAINT idea_link_endpoints
    CHECK ((link_type IN ('became', 'revisits')) = (target_artifact_id IS NOT NULL)),
  CONSTRAINT idea_link_no_self
    CHECK (target_idea_id IS NULL OR target_idea_id <> source_idea_id),
  -- Symmetric types are stored in canonical order (smaller uuid first).
  CONSTRAINT idea_link_symmetric_canonical CHECK (
    link_type NOT IN ('tension_with', 'same_mechanism', 'combines_with', 'related')
    OR source_idea_id < target_idea_id
  ),
  CONSTRAINT idea_link_decided CHECK ((status = 'proposed') = (decided_at IS NULL))
);

-- One row per unordered idea pair + type: "A builds_on B" and
-- "B builds_on A" cannot both exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_idea_link_pair_type
  ON idea_link (
    LEAST(source_idea_id, target_idea_id),
    GREATEST(source_idea_id, target_idea_id),
    link_type
  )
  WHERE target_idea_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_idea_link_artifact_type
  ON idea_link (source_idea_id, target_artifact_id, link_type)
  WHERE target_artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idea_link_source ON idea_link (source_idea_id);
CREATE INDEX IF NOT EXISTS idx_idea_link_target
  ON idea_link (target_idea_id) WHERE target_idea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idea_link_pending
  ON idea_link (proposed_at) WHERE status = 'proposed';

-- Cross-row rules a CHECK can't express: both idea endpoints belong to
-- the link's user, and part_of always points at a synthesis.
CREATE OR REPLACE FUNCTION idea_link_validate() RETURNS TRIGGER AS $$
DECLARE
  src_user TEXT;
  tgt_user TEXT;
  tgt_kind TEXT;
BEGIN
  SELECT user_id INTO src_user FROM idea WHERE id = NEW.source_idea_id;
  IF src_user IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'idea_link source idea % does not belong to user %', NEW.source_idea_id, NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.target_idea_id IS NOT NULL THEN
    SELECT user_id, kind INTO tgt_user, tgt_kind FROM idea WHERE id = NEW.target_idea_id;
    IF tgt_user IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'idea_link target idea % does not belong to user %', NEW.target_idea_id, NEW.user_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.link_type = 'part_of' AND tgt_kind IS DISTINCT FROM 'synthesis' THEN
      RAISE EXCEPTION 'part_of must target a synthesis (idea % is %)', NEW.target_idea_id, tgt_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS idea_link_validate ON idea_link;
CREATE TRIGGER idea_link_validate
  BEFORE INSERT OR UPDATE OF user_id, source_idea_id, target_idea_id, link_type ON idea_link
  FOR EACH ROW EXECUTE FUNCTION idea_link_validate();

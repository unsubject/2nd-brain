-- 021_archive_staging.sql
--
-- Published-archive consolidation, step 1: collect. Every candidate copy of
-- a published piece is copied here verbatim from its source (Gmail "Writing"
-- label, the Drive archive folders, the WordPress export, the Substack
-- export) before anything is cleaned, matched or loaded into
-- public_artifact. See docs/archive-consolidation.md.
--
-- Rows are never rewritten by later steps: extraction and matching read
-- from here and write elsewhere, so every decision stays traceable to the
-- exact source text.

CREATE TABLE IF NOT EXISTS archive_source_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('gmail', 'gdrive', 'wordpress', 'substack')),
  -- gmail: message id (attachments: <message id>#<part id>)
  -- gdrive: file id | wordpress: <site host>:<wp post id>
  -- substack: <numeric post id>
  -- Export-based refs ignore which export file they came from, so a newer
  -- export updates the same rows instead of duplicating them.
  source_ref TEXT NOT NULL,
  -- gmail: thread id | gdrive: parent folder id | wordpress/substack: export file id
  container_ref TEXT,
  title TEXT,
  -- When the source says the piece was written/sent/published.
  authored_at TIMESTAMPTZ,
  -- Verbatim bodies as the source provides them; at least one is present.
  raw_text TEXT,
  raw_html TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  -- sha256 over raw_text and raw_html; changes when the source copy changes.
  content_hash TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT archive_source_item_has_body CHECK (raw_text IS NOT NULL OR raw_html IS NOT NULL),
  CONSTRAINT archive_source_item_unique UNIQUE (source, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_archive_source_item_source_date
  ON archive_source_item (source, authored_at);
CREATE INDEX IF NOT EXISTS idx_archive_source_item_container
  ON archive_source_item (container_ref);

-- One row per collector run, so a run's outcome survives log rotation.
CREATE TABLE IF NOT EXISTS archive_collect_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('gmail', 'gdrive')),
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bumped while the run makes progress; a stale 'running' row (server
  -- restarted mid-run) is marked failed when the next run starts.
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- At most one running collector per source.
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_collect_run_one_running
  ON archive_collect_run (source) WHERE status = 'running';

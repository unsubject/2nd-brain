-- Long-term memory layer: published works knowledge base

CREATE TABLE public_artifact (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  TEXT NOT NULL,
  type                     TEXT NOT NULL,
  title                    TEXT NOT NULL,
  slug                     TEXT,
  status                   TEXT NOT NULL DEFAULT 'published',

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at             TIMESTAMPTZ,

  raw_source               TEXT NOT NULL,
  clean_text               TEXT,
  summary                  TEXT,
  excerpt                  TEXT,

  canonical_url            TEXT,
  series                   TEXT,
  series_position          INTEGER,
  language                 TEXT DEFAULT 'en',

  tags                     TEXT[],
  word_count               INTEGER,

  source_system            TEXT NOT NULL,
  source_external_id       TEXT,
  source_last_synced_at    TIMESTAMPTZ,

  processing_status        TEXT NOT NULL DEFAULT 'pending',

  embedding                vector(1536),
  embedding_model          TEXT,

  fulltext_tsv             tsvector GENERATED ALWAYS AS
                             (to_tsvector('english', coalesce(clean_text, ''))) STORED,

  UNIQUE (source_system, source_external_id)
);

CREATE INDEX idx_public_artifact_type ON public_artifact (type);
CREATE INDEX idx_public_artifact_status ON public_artifact (status);
CREATE INDEX idx_public_artifact_published ON public_artifact (published_at DESC);
CREATE INDEX idx_public_artifact_tags ON public_artifact USING GIN (tags);
CREATE INDEX idx_public_artifact_fulltext ON public_artifact USING GIN (fulltext_tsv);
CREATE INDEX idx_public_artifact_pending ON public_artifact (processing_status)
  WHERE processing_status = 'pending';

CREATE TABLE public_artifact_chunk (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_artifact_id       UUID NOT NULL REFERENCES public_artifact(id) ON DELETE CASCADE,
  chunk_index              INTEGER NOT NULL,
  chunk_text               TEXT NOT NULL,
  chunk_tokens             INTEGER,
  heading_path             TEXT[],
  start_offset             INTEGER,
  end_offset               INTEGER,
  embedding                vector(1536),
  fulltext_tsv             tsvector GENERATED ALWAYS AS
                             (to_tsvector('english', chunk_text)) STORED,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (public_artifact_id, chunk_index)
);

CREATE INDEX idx_chunk_artifact ON public_artifact_chunk (public_artifact_id);
CREATE INDEX idx_chunk_fulltext ON public_artifact_chunk USING GIN (fulltext_tsv);
CREATE INDEX idx_chunk_embedding ON public_artifact_chunk
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE entity_ref (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  TEXT NOT NULL,
  entity_type              TEXT NOT NULL,
  normalized_name          TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  aliases                  TEXT[],
  notes                    TEXT,
  embedding                vector(1536),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, entity_type, normalized_name)
);

CREATE INDEX idx_entity_type ON entity_ref (entity_type);

CREATE TABLE public_artifact_entity (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_artifact_id       UUID NOT NULL REFERENCES public_artifact(id) ON DELETE CASCADE,
  entity_ref_id            UUID NOT NULL REFERENCES entity_ref(id) ON DELETE CASCADE,
  mention_text             TEXT,
  mention_offset           INTEGER,
  salience                 REAL,
  UNIQUE (public_artifact_id, entity_ref_id, mention_offset)
);

CREATE INDEX idx_pae_artifact ON public_artifact_entity (public_artifact_id);
CREATE INDEX idx_pae_entity ON public_artifact_entity (entity_ref_id);

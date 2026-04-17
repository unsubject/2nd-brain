-- Vector similarity search on email_ref.embedding was falling back to a
-- brute-force scan in linkRelatedEmails; add an HNSW index to match the one
-- that already exists on journal_entry.embedding.
CREATE INDEX IF NOT EXISTS idx_email_ref_embedding
  ON email_ref USING hnsw (embedding vector_cosine_ops);

-- getLinksForRecentEntries sorts by confidence DESC then created_at DESC.
-- Add a covering index so that sort doesn't scan the full table.
CREATE INDEX IF NOT EXISTS idx_link_edge_confidence_created_at
  ON link_edge (confidence DESC NULLS LAST, created_at DESC);

-- findPendingEntry filters on processing_status = 'pending' and sorts by
-- stitch_window_end. The previous partial index in 002 matches that shape,
-- but the worker query sorted by created_at, forcing a sort. We switch the
-- query to sort by stitch_window_end (see src/db/queries.ts); no new index
-- needed, but we record this intent here for future reference.

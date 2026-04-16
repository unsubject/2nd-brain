-- Add unique constraint to prevent duplicate links
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_edge_unique
  ON link_edge (source_type, source_id, target_type, target_id, link_type);

ALTER TABLE journal_entry
  ADD COLUMN IF NOT EXISTS clean_text TEXT,
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[],
  ADD COLUMN IF NOT EXISTS primary_type TEXT,
  ADD COLUMN IF NOT EXISTS primary_type_confidence REAL,
  ADD COLUMN IF NOT EXISTS suggested_actions JSONB;

CREATE INDEX IF NOT EXISTS idx_journal_entry_processing
  ON journal_entry (processing_status, stitch_window_end)
  WHERE processing_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_journal_entry_tags
  ON journal_entry USING GIN (tags)
  WHERE tags IS NOT NULL;

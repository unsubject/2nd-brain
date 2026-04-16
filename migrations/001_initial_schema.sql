CREATE TABLE IF NOT EXISTS journal_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  stitch_window_start TIMESTAMPTZ NOT NULL,
  stitch_window_end TIMESTAMPTZ NOT NULL,
  full_text TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_journal_entry_stitch
  ON journal_entry (user_id, channel, stitch_window_end DESC);

CREATE TABLE IF NOT EXISTS capture_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID REFERENCES journal_entry(id),
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_message_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  raw_text TEXT NOT NULL,
  is_system_command BOOLEAN NOT NULL DEFAULT false,
  system_command_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_capture_event_user_time
  ON capture_event (user_id, channel, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_capture_event_journal
  ON capture_event (journal_entry_id);

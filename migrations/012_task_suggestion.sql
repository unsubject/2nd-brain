-- Task suggestions: one row per journal_entry whose Haiku classification
-- was primary_type='task_candidate' with sufficient confidence. The bot
-- sweeper posts an [Add] [Skip] prompt to the origin chat; the callback
-- either creates a Google Task (status='added') or marks it skipped.

CREATE TABLE IF NOT EXISTS task_suggestion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('personal','family')),
  suggested_title TEXT NOT NULL,
  suggested_list_name TEXT NOT NULL,
  suggested_due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','added','skipped','expired')),
  telegram_chat_id TEXT,
  telegram_message_id TEXT,
  external_task_id TEXT,
  resolved_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  UNIQUE (journal_entry_id)
);

-- Sweeper wants to find un-posted pending rows fast.
CREATE INDEX IF NOT EXISTS idx_task_suggestion_unposted
  ON task_suggestion (created_at)
  WHERE status = 'pending' AND posted_at IS NULL;

-- Expiry sweep wants old pending rows (posted or not).
CREATE INDEX IF NOT EXISTS idx_task_suggestion_pending_created
  ON task_suggestion (created_at)
  WHERE status = 'pending';

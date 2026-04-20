-- Family scope: personal | family, one-way spillover family → personal.
-- See Family Scope Phase 1 spec.

ALTER TABLE capture_event
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal'
  CHECK (scope IN ('personal', 'family'));

ALTER TABLE journal_entry
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal'
  CHECK (scope IN ('personal', 'family'));

ALTER TABLE email_ref
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal'
  CHECK (scope IN ('personal', 'family'));

ALTER TABLE calendar_event_ref
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal'
  CHECK (scope IN ('personal', 'family'));

ALTER TABLE task_ref
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal'
  CHECK (scope IN ('personal', 'family'));

ALTER TABLE morning_review
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal'
  CHECK (scope IN ('personal', 'family'));

-- chat_id lets group captures key drafts per-chat, not just per-user.
ALTER TABLE journal_entry ADD COLUMN IF NOT EXISTS chat_id TEXT;
ALTER TABLE capture_event ADD COLUMN IF NOT EXISTS chat_id TEXT;

-- label_ids are opaque Google IDs; label_names carries 'DSJ' etc. for filtering.
ALTER TABLE email_ref ADD COLUMN IF NOT EXISTS label_names TEXT[];

-- Allow one review per (date, scope) instead of one per date.
ALTER TABLE morning_review DROP CONSTRAINT IF EXISTS morning_review_review_date_key;
ALTER TABLE morning_review
  ADD CONSTRAINT morning_review_date_scope_key UNIQUE (review_date, scope);

-- Backfill: emails to/from family domains.
UPDATE email_ref
SET scope = 'family'
WHERE scope = 'personal'
  AND (
    from_address ILIKE '%@leesim.one'
    OR from_address = 'yinfun.li@gmail.com'
    OR EXISTS (
      SELECT 1 FROM unnest(to_addresses) AS addr
      WHERE addr ILIKE '%@leesim.one' OR addr = 'yinfun.li@gmail.com'
    )
  );
-- DSJ label backfill happens after label_names is populated on next sync.

-- Backfill: tasks whose list is named 'Family'.
UPDATE task_ref t
SET scope = 'family'
FROM project_ref p
WHERE t.project_ref_id = p.id
  AND lower(p.name) = 'family'
  AND t.scope = 'personal';

-- Calendar, journal_entry, capture_event: no retroactive family data.

CREATE INDEX IF NOT EXISTS idx_journal_entry_scope      ON journal_entry      (scope);
CREATE INDEX IF NOT EXISTS idx_email_ref_scope          ON email_ref          (scope);
CREATE INDEX IF NOT EXISTS idx_calendar_event_ref_scope ON calendar_event_ref (scope);
CREATE INDEX IF NOT EXISTS idx_task_ref_scope           ON task_ref           (scope);
CREATE INDEX IF NOT EXISTS idx_morning_review_scope     ON morning_review     (scope);

-- Fast per-chat draft lookup for the family capture flow.
CREATE INDEX IF NOT EXISTS idx_journal_entry_drafting
  ON journal_entry (user_id, chat_id, scope)
  WHERE processing_status = 'drafting';

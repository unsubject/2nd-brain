-- The family bot (retired in #84) captured group-chat messages as journal
-- entries in processing_status 'drafting' and saved them as 'pending' after
-- five minutes, or when the sender confirmed. That code is gone, so a draft
-- left behind at the moment of the deploy would never be processed or found
-- by search. Save any such row exactly as the bot's auto-save did, and drop
-- the partial index that only served draft lookups.
--
-- Idempotent: a no-op once no 'drafting' rows remain.

UPDATE journal_entry
   SET processing_status = 'pending',
       stitch_window_end = now() - interval '11 minutes',
       updated_at = now()
 WHERE processing_status = 'drafting';

DROP INDEX IF EXISTS idx_journal_entry_drafting;

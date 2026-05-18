-- journal_entry.last_error: capture the exception text from the worker's
-- catch block so triage doesn't depend on Railway log retention. Nullable;
-- populated only when processing_status = 'error'. Cleared on success
-- (saveProcessingResult, saveAiFeedbackResult). Mirror of migration 013
-- for public_artifact (PR #43).

ALTER TABLE journal_entry
  ADD COLUMN IF NOT EXISTS last_error TEXT;

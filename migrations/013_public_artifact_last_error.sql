-- public_artifact.last_error: capture the exception text from the worker's
-- catch block so triage doesn't depend on Railway log retention. Nullable;
-- populated only when processing_status = 'error'. Cleared on success
-- (saveArtifactProcessingResult) and on retry (resetErroredArtifacts).

ALTER TABLE public_artifact
  ADD COLUMN IF NOT EXISTS last_error TEXT;

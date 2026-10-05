-- Journal entries whose processing failed stayed in 'error' for good: the
-- worker only picks up 'pending' rows. The known cause is the old
-- processor's output limit: it echoed the whole entry back as JSON, so a
-- long saved session was cut off mid-string. The processor no longer does
-- that, and the embedding input is capped below the model's token limit, so
-- give every failed entry one more pass. Migrations run once, so an entry
-- that fails again stays in 'error' with its new reason.
--
-- Nothing is deleted: full_text is untouched, and processing fills in the
-- summary, tags and embedding. Idempotent: a no-op once no 'error' rows
-- remain.

SET LOCAL statement_timeout = 0;

UPDATE journal_entry
   SET processing_status = 'pending',
       last_error = NULL,
       updated_at = now()
 WHERE processing_status = 'error';

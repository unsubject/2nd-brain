-- 032_requeue_nul_errors.sql
--
-- Two archive rows failed on 2026-10-08 because the model wrote a NUL
-- character into the excerpt it copied, which Postgres TEXT can't hold.
-- The processor now drops NUL characters from the model's output, so give
-- the rows that failed that way one more pass. Until they are processed,
-- the old rows they replace stay in search. Migrations run once, so a row
-- that fails again stays in 'error' with its new reason.
--
-- Nothing is deleted: raw_source is untouched. A no-op once no such rows
-- remain.

UPDATE public_artifact
   SET processing_status = 'pending',
       last_error = NULL,
       claim_token = NULL,
       claimed_at = NULL,
       updated_at = now()
 WHERE processing_status = 'error'
   AND last_error LIKE '%invalid byte sequence for encoding "UTF8": 0x00%';

-- With the morning briefing retired, only some of the Google data the sync
-- used to copy has a use left, and the sync now collects only that:
--   * Gmail: the 30-day sent / starred / family mail sync is gone (it fed
--     the briefing and the family bot; email linking never ran, since no
--     email_ref row ever had an embedding). The Writing-label archive
--     collector is separate and unaffected.
--   * Calendar: only event titles and times (linking).
--   * Contacts: only names (linking).
-- This clears the copies already stored for data that is no longer
-- collected. Google keeps the originals; nothing here is the only copy.
-- Idempotent.

SET LOCAL statement_timeout = 0;

DELETE FROM link_edge WHERE target_type = 'email_ref';
DELETE FROM email_ref;

UPDATE calendar_event_ref
   SET description = NULL, attendees = NULL, location = NULL
 WHERE description IS NOT NULL OR attendees IS NOT NULL OR location IS NOT NULL;

UPDATE person_ref
   SET primary_email = NULL, primary_phone = NULL, notes = NULL
 WHERE primary_email IS NOT NULL OR primary_phone IS NOT NULL OR notes IS NOT NULL;

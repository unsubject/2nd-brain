-- 021_repair_double_encoded_jsonb.sql
--
-- Some MCP tools bound jsonb as `${JSON.stringify(x)}::jsonb`. On
-- postgres-js that serialises twice, so the column held a JSON *string*
-- whose text is the intended object or array (PR #63 fixed the amendment
-- writers; close_cycle and record_pick were fixed with this migration).
-- This unwraps such rows back to the object/array they were meant to be.
--
-- Guarantees:
--   * idempotent, and a no-op on clean or empty tables;
--   * only rows whose value is a jsonb string are touched, and only when
--     unwrapping yields an object or array (strings that aren't JSON text
--     are left exactly as they are);
--   * the amendment cooldown triggers only pin proposed_at/cooldown_until
--     on UPDATE, so those are unchanged.
-- Readers keep tolerating both shapes (unwrapJsonb in the Worker).

-- The monolith's pool sets statement_timeout = 10s and runs each migration
-- file as one implicit transaction; lift the limit for this file only so a
-- large backlog can't fail (and crash-loop) the boot.
SET LOCAL statement_timeout = 0;

DO $$
DECLARE
  target RECORD;
  r RECORD;
  v jsonb;
  depth int;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('undertaking_cycles', 'streak_summary'),
      ('editorial_pick', 'keywords'),
      ('editorial_pick', 'tags'),
      ('editorial_pick', 'urls'),
      ('constitution_amendments', 'proposed_payload'),
      ('goal_amendments', 'proposed_payload')
    ) AS t(tbl, col)
  LOOP
    FOR r IN EXECUTE format(
      'SELECT id, %1$I AS val FROM %2$I WHERE jsonb_typeof(%1$I) = ''string''',
      target.col, target.tbl
    )
    LOOP
      v := r.val;
      depth := 0;
      WHILE jsonb_typeof(v) = 'string' AND depth < 5 LOOP
        BEGIN
          v := (v #>> '{}')::jsonb;
        EXCEPTION WHEN data_exception THEN
          EXIT;
        END;
        depth := depth + 1;
      END LOOP;
      IF jsonb_typeof(v) IN ('object', 'array') THEN
        EXECUTE format('UPDATE %I SET %I = $1 WHERE id = $2', target.tbl, target.col)
          USING v, r.id;
      END IF;
    END LOOP;
  END LOOP;
END $$;

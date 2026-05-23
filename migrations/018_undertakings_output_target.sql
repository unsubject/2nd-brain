-- 018_undertakings_output_target.sql
--
-- Rename undertakings.outcome → output_target. Surfaced + deferred in
-- PR #54 (constitution split, 2026-05-18). After the split:
--   - The SMART `goals` layer owns *outcome* via `outcome_metric`
--     ("lose 10 lbs" — outcome, what gets measured at quarterly review).
--   - Undertakings semantically produce *output* (deliverables
--     evaluated against `test_criteria`).
--
-- The column name was a vestige of the pre-split conflation where the
-- single goal layer mixed direction with measurement. Renaming the
-- column aligns the schema with the 4-layer mental model.
--
-- Greenfield: live DB has 0 rows in undertakings, so the rename is
-- purely structural.

ALTER TABLE undertakings RENAME COLUMN outcome TO output_target;

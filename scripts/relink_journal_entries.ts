// One-shot backfill: wipe and regenerate the entity-driven link types on every
// processed journal_entry. Embedding-derived links (relates_to_email,
// echoes_artifact) and the keyword-based linkRelatedTasks output are preserved.
//
// Run once from a workstation with DATABASE_URL pointed at production, AFTER
// the linker rewrite is deployed:
//   tsx scripts/relink_journal_entries.ts
//
// Idempotent: re-running just re-wipes and re-emits the same link types.

import { pool } from "../src/db/client";
import { generateLinks } from "../src/google/linker";

// Link types this script regenerates (and therefore wipes first to avoid
// stacking old + new rows on the unique index).
const STALE_LINK_TYPES = [
  "mentions_person",
  "mentions_entity",
  "same_day_as_event",
  "relates_to_event",
  "relates_to_location",
];

interface JournalRow {
  id: string;
  full_text: string;
  tags: string[] | null;
  created_at: Date;
  embedding: string | null; // pgvector returns as text literal "[0.1,0.2,...]"
}

function parseVector(literal: string | null): number[] {
  if (!literal) return [];
  // postgres-driver returns pgvector as a string starting with '[' and ending with ']'
  if (!literal.startsWith("[") || !literal.endsWith("]")) return [];
  return literal
    .slice(1, -1)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

async function main() {
  console.log(`[relink] wiping stale link types: ${STALE_LINK_TYPES.join(", ")}`);
  const wiped = await pool.query(
    `DELETE FROM link_edge
       WHERE source_type='journal_entry'
         AND link_type = ANY($1::text[])`,
    [STALE_LINK_TYPES]
  );
  console.log(`[relink] deleted ${wiped.rowCount ?? 0} stale link_edge rows`);

  const { rows } = await pool.query<JournalRow>(
    `SELECT id, full_text, tags, created_at, embedding::text AS embedding
       FROM journal_entry
      WHERE processing_status = 'processed'
        AND embedding IS NOT NULL
      ORDER BY created_at ASC`
  );
  console.log(`[relink] regenerating links for ${rows.length} journal_entry rows`);

  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await generateLinks({
        id: row.id,
        full_text: row.full_text,
        tags: row.tags ?? [],
        created_at: row.created_at,
        embedding: parseVector(row.embedding),
      });
      succeeded++;
    } catch (err) {
      failed++;
      console.error(`[relink] entry ${row.id} failed:`, err);
    }
  }
  console.log(`[relink] done: ${succeeded} ok, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error("[relink] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

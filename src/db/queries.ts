import { pool, DB } from "./client";
import { ProcessingResult } from "../processor";

export async function findPendingEntry(
  stitchWindowMs: number
): Promise<{ id: string; full_text: string } | null> {
  const cutoff = new Date(Date.now() - stitchWindowMs);
  const { rows } = await pool.query(
    `SELECT id, full_text
     FROM journal_entry
     WHERE processing_status = 'pending'
       AND stitch_window_end < $1
     ORDER BY stitch_window_end ASC
     LIMIT 1`,
    [cutoff]
  );
  return rows[0] || null;
}

export async function saveProcessingResult(
  id: string,
  result: ProcessingResult,
  embedding: number[]
): Promise<void> {
  const vectorStr = `[${embedding.join(",")}]`;
  await pool.query(
    `UPDATE journal_entry
     SET clean_text = $2,
         summary = $3,
         language = $4,
         tags = $5,
         primary_type = $6,
         primary_type_confidence = $7,
         suggested_actions = $8,
         embedding = $9::vector,
         processing_status = 'processed',
         last_error = NULL,
         updated_at = now()
     WHERE id = $1`,
    [
      id,
      result.clean_text,
      result.summary,
      result.language,
      result.tags,
      result.primary_type,
      result.primary_type_confidence,
      JSON.stringify(result.suggested_actions),
      vectorStr,
    ]
  );
}

export async function saveAiFeedbackResult(
  id: string,
  cleanText: string,
  tags: string[],
  embedding: number[]
): Promise<void> {
  const vectorStr = `[${embedding.join(",")}]`;
  await pool.query(
    `UPDATE journal_entry
     SET clean_text = $2,
         summary = NULL,
         language = 'en',
         tags = $3,
         primary_type = 'archive_only',
         primary_type_confidence = 1.0,
         suggested_actions = '[]'::jsonb,
         embedding = $4::vector,
         processing_status = 'processed',
         last_error = NULL,
         updated_at = now()
     WHERE id = $1`,
    [id, cleanText, tags, vectorStr]
  );
}

export async function findSimilarEntries(
  embedding: number[],
  excludeId: string,
  limit: number = 5
): Promise<
  { id: string; summary: string; tags: string[]; similarity: number }[]
> {
  const vectorStr = `[${embedding.join(",")}]`;
  const { rows } = await pool.query(
    `SELECT id, summary, tags,
            1 - (embedding <=> $1::vector) AS similarity
     FROM journal_entry
     WHERE processing_status = 'processed'
       AND id != $2
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, excludeId, limit]
  );
  return rows;
}

export async function markProcessingError(
  id: string,
  errorMessage: string
): Promise<void> {
  await pool.query(
    `UPDATE journal_entry
     SET processing_status = 'error',
         last_error = $2,
         updated_at = now()
     WHERE id = $1`,
    [id, errorMessage]
  );
}

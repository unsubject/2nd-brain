// Run step 2 over everything staged: one candidate per source item,
// rewritten on every run so improved rules apply to all of it, then a pass
// that keeps one copy of each newsletter issue.

import { pool, type DB } from "../../../db/client";
import { extract, charCount, EXTRACTOR_VERSION, type Candidate, type StagedItem } from ".";
import { recordError, type CollectStats } from "../gmail";

export interface ExtractStats extends CollectStats {
  scanned: number;
  written: number;
  duplicates: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
}

export function emptyExtractStats(): ExtractStats {
  return {
    listed: 0,
    skippedExisting: 0,
    retriedIncomplete: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    attachmentsExtracted: 0,
    rateLimitPauses: 0,
    failed: 0,
    errors: [],
    scanned: 0,
    written: 0,
    duplicates: 0,
    byKind: {},
    byStatus: {},
  };
}

const BATCH = 100;

interface Row {
  id: string;
  source: StagedItem["source"];
  source_ref: string;
  container_ref: string | null;
  title: string | null;
  authored_at: Date | null;
  raw_text: string | null;
  raw_html: string | null;
  metadata: Record<string, unknown>;
  // For a Gmail attachment, its message's recipients (null otherwise).
  parent_to: unknown;
  parent_cc: unknown;
}

// An attachment row is staged without recipients: they are its message's,
// and the column, outlet and self-draft rules need them (extract/gmail.ts).
function stagedMetadata(r: Row): Record<string, unknown> {
  const m = r.metadata ?? {};
  return r.source === "gmail" && m.kind === "attachment" ? { ...m, to: r.parent_to, cc: r.parent_cc } : m;
}

async function writeCandidate(itemId: string, source: string, c: Candidate, db: DB): Promise<"inserted" | "updated"> {
  const { rows } = await db.query<{ inserted: boolean }>(
    `INSERT INTO archive_candidate
       (source_item_id, source, kind, status, reasons, title, outlet, column_name, published_at,
        date_source, is_published, body_text, note, dedupe_key, char_count, extractor_version, extracted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
     ON CONFLICT (source_item_id) DO UPDATE SET
       source = EXCLUDED.source, kind = EXCLUDED.kind, status = EXCLUDED.status, reasons = EXCLUDED.reasons,
       title = EXCLUDED.title, outlet = EXCLUDED.outlet, column_name = EXCLUDED.column_name,
       published_at = EXCLUDED.published_at, date_source = EXCLUDED.date_source,
       is_published = EXCLUDED.is_published, body_text = EXCLUDED.body_text, note = EXCLUDED.note,
       dedupe_key = EXCLUDED.dedupe_key, char_count = EXCLUDED.char_count,
       extractor_version = EXCLUDED.extractor_version, extracted_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      itemId,
      source,
      c.kind,
      c.status,
      c.reasons,
      c.title,
      c.outlet,
      c.column,
      c.publishedAt,
      c.dateSource,
      c.isPublished,
      c.bodyText,
      c.note,
      c.dedupeKey,
      charCount(c),
      EXTRACTOR_VERSION,
    ]
  );
  return rows[0].inserted ? "inserted" : "updated";
}

// Several addresses received each newsletter issue: keep the earliest copy.
export async function markDuplicateNewsletters(db: DB = pool): Promise<number> {
  const { rowCount } = await db.query(
    `WITH ranked AS (
       SELECT c.id,
              first_value(c.id) OVER w AS keeper,
              row_number() OVER w AS rn
         FROM archive_candidate c
         JOIN archive_source_item s ON s.id = c.source_item_id
        WHERE c.dedupe_key IS NOT NULL AND c.kind = 'newsletter'
       WINDOW w AS (PARTITION BY c.dedupe_key ORDER BY s.authored_at NULLS LAST, s.source_ref)
     )
     UPDATE archive_candidate c
        SET kind = 'duplicate', status = 'drop',
            reasons = array_append(c.reasons, 'duplicate-of:' || r.keeper::text)
       FROM ranked r
      WHERE c.id = r.id AND r.rn > 1`
  );
  return rowCount ?? 0;
}

export async function runExtraction(
  stats: ExtractStats,
  onProgress: () => Promise<void>,
  shouldStop: () => boolean = () => false,
  db: DB = pool
): Promise<void> {
  const { rows: total } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM archive_source_item`);
  stats.listed = total[0].n;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    if (shouldStop()) return;
    const { rows } = await db.query<Row>(
      `SELECT s.id, s.source, s.source_ref, s.container_ref, s.title, s.authored_at, s.raw_text, s.raw_html,
              s.metadata, p.metadata->'to' AS parent_to, p.metadata->'cc' AS parent_cc
         FROM archive_source_item s
         LEFT JOIN archive_source_item p
           ON s.source = 'gmail' AND s.metadata->>'kind' = 'attachment'
          AND p.source = 'gmail' AND p.source_ref = s.metadata->>'parentMessageId'
        WHERE s.id > $1 ORDER BY s.id LIMIT $2`,
      [after, BATCH]
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      stats.scanned += 1;
      try {
        const c = extract({
          id: r.id,
          source: r.source,
          sourceRef: r.source_ref,
          containerRef: r.container_ref,
          title: r.title,
          authoredAt: r.authored_at,
          rawText: r.raw_text,
          rawHtml: r.raw_html,
          metadata: stagedMetadata(r),
        });
        stats[await writeCandidate(r.id, r.source, c, db)] += 1;
        stats.written += 1;
        stats.byKind[c.kind] = (stats.byKind[c.kind] ?? 0) + 1;
        stats.byStatus[c.status] = (stats.byStatus[c.status] ?? 0) + 1;
      } catch (err) {
        recordError(stats, `${r.source}:${r.source_ref}`, err);
      }
    }
    after = rows[rows.length - 1].id;
    await onProgress();
  }
  stats.duplicates = await markDuplicateNewsletters(db);
  if (stats.duplicates > 0) {
    stats.byKind.newsletter = (stats.byKind.newsletter ?? 0) - stats.duplicates;
    stats.byKind.duplicate = (stats.byKind.duplicate ?? 0) + stats.duplicates;
    stats.byStatus.keep = (stats.byStatus.keep ?? 0) - stats.duplicates;
    stats.byStatus.drop = (stats.byStatus.drop ?? 0) + stats.duplicates;
  }
}

export async function candidateSummary(db: DB = pool): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `SELECT source, kind, status, count(*)::int AS n, sum(char_count)::bigint AS chars,
            min(published_at) AS earliest, max(published_at) AS latest
       FROM archive_candidate GROUP BY source, kind, status ORDER BY source, kind, status`
  );
  return rows;
}

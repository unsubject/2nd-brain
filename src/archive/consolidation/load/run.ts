// Step 4: write every work (step 3) to public_artifact as one row with
// source_system 'archive', keyed by the source item of its canonical text,
// and point the rows it replaces at it. A replaced row leaves search
// (status 'superseded') once its replacement has been processed; the worker
// retires it then (retireReplacedRows). Rows from the first import that
// match no work stay searchable, flagged 'unmatched'. Nothing is deleted,
// and everything is written in one transaction.

import { Pool } from "pg";
import { pool, type DB } from "../../../db/client";
import type { CollectStats } from "../gmail";
import { units } from "../match/similarity";
import { IMPORT_CUT, matchLegacy } from "./legacy";

// Bump with every change to what a load writes: the rows are loaded again
// on boot.
export const LOADER_VERSION = 1;

export const ARCHIVE_SOURCE = "archive";
// Rows that are not from the first import: video transcripts and this
// step's own rows.
const NOT_LEGACY = ["youtube", ARCHIVE_SOURCE];
const BATCH = 200;

export interface LoadStats extends CollectStats {
  loaderVersion: number;
  works: number;
  // Works loaded flagged 'review'.
  flaggedReview: number;
  // Archive rows no work has as its canonical text any more.
  retired: number;
  // Rows whose replacement was processed while the load was writing.
  retiredLate: number;
  // When the works it read were matched (max matched_at, as text so no
  // precision is lost): the next load is due once a match is newer.
  worksMatchedAt: string | null;
  legacy: { rows: number; matched: number; hidden: number; waiting: number; unmatched: number };
}

export function emptyLoadStats(): LoadStats {
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
    loaderVersion: LOADER_VERSION,
    works: 0,
    flaggedReview: 0,
    retired: 0,
    retiredLate: 0,
    worksMatchedAt: null,
    legacy: { rows: 0, matched: 0, hidden: 0, waiting: 0, unmatched: 0 },
  };
}

interface WorkRow {
  ref: string;
  title: string | null;
  published_at: Date | null;
  outlet: string | null;
  column_name: string | null;
  outlets: string[];
  status: "keep" | "review";
  body_text: string;
  link: string | null;
}

interface MemberRow {
  candidate_id: string;
  body_text: string;
  member_ref: string;
  work_ref: string;
}

// A work with no title is named by the start of its text.
export function titleFor(title: string | null, text: string): string {
  if (title?.trim()) return title.trim();
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || "(untitled)";
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function loadWorks(db: DB): Promise<WorkRow[]> {
  // A published WordPress member's link is the work's URL, the canonical's
  // own first.
  const { rows } = await db.query<WorkRow>(
    `SELECT s.source || ':' || s.source_ref AS ref, w.title, w.published_at, w.outlet, w.column_name,
            w.outlets, w.status, c.body_text,
            (SELECT ms.metadata->>'link'
               FROM archive_work_member m
               JOIN archive_candidate mc ON mc.id = m.candidate_id
               JOIN archive_source_item ms ON ms.id = mc.source_item_id
              WHERE m.work_id = w.id AND ms.source = 'wordpress' AND mc.is_published
                AND ms.metadata->>'link' ~ '^https?://'
              ORDER BY m.role = 'canonical' DESC, mc.published_at NULLS LAST
              LIMIT 1) AS link
       FROM archive_work w
       JOIN archive_candidate c ON c.id = w.canonical_candidate_id
       JOIN archive_source_item s ON s.id = c.source_item_id
      WHERE c.body_text IS NOT NULL
      ORDER BY w.published_at NULLS LAST, ref`
  );
  return rows;
}

async function loadMembers(db: DB): Promise<MemberRow[]> {
  const { rows } = await db.query<MemberRow>(
    `SELECT m.candidate_id, c.body_text,
            s.source || ':' || s.source_ref AS member_ref,
            cs.source || ':' || cs.source_ref AS work_ref
       FROM archive_work_member m
       JOIN archive_work w ON w.id = m.work_id
       JOIN archive_candidate c ON c.id = m.candidate_id
       JOIN archive_source_item s ON s.id = c.source_item_id
       JOIN archive_candidate cc ON cc.id = w.canonical_candidate_id
       JOIN archive_source_item cs ON cs.id = cc.source_item_id
      WHERE c.body_text IS NOT NULL`
  );
  return rows;
}

// Insert or update the works' rows. A row whose text changed goes back to
// the worker; one whose text is the same keeps its summary, chunks and
// embedding.
async function upsertWorks(works: WorkRow[], q: DB): Promise<Map<string, { id: string; created: boolean; requeued: boolean }>> {
  const out = new Map<string, { id: string; created: boolean; requeued: boolean }>();
  for (const batch of chunks(works, BATCH)) {
    const records = batch.map((w) => ({
      ref: w.ref,
      title: titleFor(w.title, w.body_text),
      published_at: w.published_at,
      raw_source: w.body_text,
      canonical_url: w.link,
      series: w.column_name ?? w.outlet,
      outlets: w.outlets,
      flag: w.status === "review" ? "review" : null,
      word_count: units(w.body_text).length,
    }));
    const { rows } = await q.query<{ ref: string; id: string; created: boolean; requeued: boolean }>(
      `WITH r AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
           ref text, title text, published_at timestamptz, raw_source text, canonical_url text,
           series text, outlets jsonb, flag text, word_count int)
       ), old AS (
         SELECT a.source_external_id AS ref, a.raw_source FROM public_artifact a
          WHERE a.source_system = $2 AND a.source_external_id IN (SELECT ref FROM r)
       )
       INSERT INTO public_artifact AS a
         (user_id, type, title, published_at, raw_source, canonical_url, series, outlets, flag,
          word_count, source_system, source_external_id, source_last_synced_at, status, processing_status)
       SELECT 'default', 'essay', r.title, r.published_at, r.raw_source, r.canonical_url, r.series,
              ARRAY(SELECT jsonb_array_elements_text(r.outlets)), r.flag, r.word_count,
              $2, r.ref, now(), 'published', 'pending'
         FROM r
       ON CONFLICT (source_system, source_external_id) DO UPDATE SET
         title = EXCLUDED.title,
         published_at = EXCLUDED.published_at,
         raw_source = EXCLUDED.raw_source,
         canonical_url = EXCLUDED.canonical_url,
         series = EXCLUDED.series,
         outlets = EXCLUDED.outlets,
         flag = EXCLUDED.flag,
         word_count = EXCLUDED.word_count,
         status = 'published',
         superseded_by = NULL,
         source_last_synced_at = now(),
         updated_at = CASE WHEN a.raw_source = EXCLUDED.raw_source AND a.title = EXCLUDED.title
                           THEN a.updated_at ELSE now() END,
         summary = CASE WHEN a.raw_source = EXCLUDED.raw_source THEN a.summary ELSE NULL END,
         processing_status = CASE WHEN a.raw_source = EXCLUDED.raw_source THEN a.processing_status ELSE 'pending' END,
         last_error = CASE WHEN a.raw_source = EXCLUDED.raw_source THEN a.last_error ELSE NULL END
       RETURNING a.source_external_id AS ref, a.id,
                 NOT EXISTS (SELECT 1 FROM old WHERE old.ref = a.source_external_id) AS created,
                 NOT EXISTS (SELECT 1 FROM old WHERE old.ref = a.source_external_id
                                                 AND old.raw_source = a.raw_source) AS requeued`,
      [JSON.stringify(records), ARCHIVE_SOURCE]
    );
    for (const r of rows) out.set(r.ref, { id: r.id, created: r.created, requeued: r.requeued });
  }
  return out;
}

interface Pointer {
  id: string;
  // The row that replaces this one, if any.
  target: string | null;
  legacy: boolean;
}

// Point rows at their replacements. A row with a processed replacement
// leaves search now, one whose replacement is still queued stays until the
// worker has processed it, and a row nothing replaces is hidden (an archive
// row) or flagged 'unmatched' (a row from the first import). Statuses other
// than published/superseded are left alone.
async function pointRows(pointers: Pointer[], q: DB): Promise<Map<string, { status: string; target: string | null }>> {
  const out = new Map<string, { status: string; target: string | null }>();
  for (const batch of chunks(pointers, BATCH * 5)) {
    const { rows } = await q.query<{ id: string; status: string; target: string | null }>(
      `UPDATE public_artifact a SET
         superseded_by = r.target,
         flag = CASE WHEN r.target IS NULL AND r.legacy THEN 'unmatched' ELSE NULL END,
         status = CASE WHEN a.status NOT IN ('published', 'superseded') THEN a.status
                       WHEN r.target IS NULL THEN CASE WHEN r.legacy THEN 'published' ELSE 'superseded' END
                       WHEN t.processing_status = 'processed' THEN 'superseded'
                       ELSE 'published' END,
         updated_at = CASE WHEN a.superseded_by IS NOT DISTINCT FROM r.target THEN a.updated_at ELSE now() END
         FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, target uuid, legacy boolean)
         LEFT JOIN public_artifact t ON t.id = r.target
        WHERE a.id = r.id
       RETURNING a.id, a.status, a.superseded_by AS target`,
      [JSON.stringify(batch)]
    );
    for (const r of rows) out.set(r.id, { status: r.status, target: r.target });
  }
  return out;
}

async function inTransaction<T>(db: DB, begin: string, fn: (q: DB) => Promise<T>): Promise<T> {
  // One connection for the transaction: a pool would spread it over several.
  const client = db instanceof Pool ? await db.connect() : null;
  const q = client ?? db;
  try {
    await q.query(begin);
    const out = await fn(q);
    await q.query("COMMIT");
    return out;
  } catch (err) {
    await q.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client?.release();
  }
}

export async function runLoad(
  stats: LoadStats,
  onProgress: () => Promise<void>,
  shouldStop: () => boolean = () => false,
  db: DB = pool
): Promise<void> {
  // One snapshot, so a match run finishing meanwhile can't leave works and
  // members out of step.
  const { matchedAt, works, members, legacy, archived } = await inTransaction(
    db,
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    async (q) => ({
      matchedAt: (await q.query<{ t: string | null }>("SELECT max(matched_at)::text AS t FROM archive_work")).rows[0].t,
      works: await loadWorks(q),
      members: await loadMembers(q),
      legacy: (
        await q.query<{ id: string; text: string; truncated: boolean }>(
          `SELECT id, coalesce(clean_text, raw_source) AS text, length(raw_source) = $1 AS truncated
             FROM public_artifact WHERE NOT (source_system = ANY($2))`,
          [IMPORT_CUT, NOT_LEGACY]
        )
      ).rows,
      archived: (
        await q.query<{ id: string; ref: string }>(
          `SELECT id, source_external_id AS ref FROM public_artifact WHERE source_system = $1`,
          [ARCHIVE_SOURCE]
        )
      ).rows,
    })
  );
  stats.worksMatchedAt = matchedAt;
  stats.listed = stats.works = works.length;
  stats.flaggedReview = works.filter((w) => w.status === "review").length;
  stats.legacy.rows = legacy.length;
  await onProgress();
  if (shouldStop()) return;

  const matches = matchLegacy(
    legacy,
    members.map((m) => ({ id: m.candidate_id, text: m.body_text }))
  );
  const workOfCandidate = new Map(members.map((m) => [m.candidate_id, m.work_ref]));
  const workOfMember = new Map(members.map((m) => [m.member_ref, m.work_ref]));
  if (shouldStop()) return;

  await inTransaction(db, "BEGIN", async (q) => {
    const loaded = await upsertWorks(works, q);
    for (const r of loaded.values()) {
      if (r.created) stats.inserted++;
      else if (r.requeued) stats.updated++;
      else stats.unchanged++;
    }
    const rowOfWork = (ref: string | undefined) => (ref ? loaded.get(ref)?.id ?? null : null);

    // An archive row whose text is no longer any work's canonical: replaced
    // by the work its item belongs to now, if any.
    const retired = archived
      .filter((a) => !loaded.has(a.ref))
      .map((a) => ({ id: a.id, target: rowOfWork(workOfMember.get(a.ref)), legacy: false }));
    stats.retired = retired.length;
    const pointers = [
      ...retired,
      ...legacy.map((l) => {
        const m = matches.get(l.id);
        return { id: l.id, target: m ? rowOfWork(workOfCandidate.get(m.pieceId)) : null, legacy: true };
      }),
    ];
    const results = await pointRows(pointers, q);
    await moveLinks(q);
    for (const p of pointers) {
      const r = results.get(p.id);
      if (!p.legacy || !r) continue;
      if (r.target === null) stats.legacy.unmatched++;
      else {
        stats.legacy.matched++;
        if (r.status === "superseded") stats.legacy.hidden++;
        else stats.legacy.waiting++;
      }
    }

    // A work with no URL of its own keeps the first import's link, if the
    // row it replaces had one.
    await q.query(
      `UPDATE public_artifact a SET canonical_url = l.canonical_url
         FROM (SELECT DISTINCT ON (superseded_by) superseded_by, canonical_url
                 FROM public_artifact
                WHERE superseded_by IS NOT NULL AND NOT (source_system = ANY($1))
                  AND canonical_url ~ '^https?://'
                ORDER BY superseded_by, published_at NULLS LAST, id) l
        WHERE a.id = l.superseded_by AND a.canonical_url IS NULL`,
      [NOT_LEGACY]
    );
  });
  // A replacement the worker finished while the transaction was open
  // retired nothing (its rows did not point at it yet): retire them now.
  stats.retiredLate = await retireReplacedRows(null, db);
}

// The works are not the ones the last successful load by this
// LOADER_VERSION read (or none has run): their rows are out of date. Each
// match writes one generation with one matched_at, so a different max
// means a different generation, an empty one included. Compared with what
// the load read, not when it started: a load that starts while a match is
// writing still reads the works before it.
export async function loadStale(db: DB = pool): Promise<boolean> {
  const { rows } = await db.query<{ stale: boolean }>(
    `SELECT (SELECT max(matched_at) FROM archive_work) IS DISTINCT FROM
            (SELECT (stats->>'worksMatchedAt')::timestamptz FROM archive_collect_run
              WHERE source = 'load' AND status = 'succeeded'
                AND (stats->>'loaderVersion')::int = $1
              ORDER BY started_at DESC LIMIT 1) AS stale`,
    [LOADER_VERSION]
  );
  return rows[0].stale;
}

// Links the calendar/task linker made to a row that has left search
// (journal echoes, shared entities) move to the row that replaced it, so
// they keep showing the piece. A link that would point at its own source
// is dropped.
async function moveLinks(db: DB): Promise<void> {
  await db.query(
    `WITH moved AS (
       SELECT e.id, a.superseded_by AS target
         FROM link_edge e
         JOIN public_artifact a ON e.target_type = 'public_artifact' AND a.id = e.target_id
        WHERE a.status = 'superseded' AND a.superseded_by IS NOT NULL
     ), copied AS (
       INSERT INTO link_edge
         (user_id, source_type, source_id, target_type, target_id, link_type, confidence, explanation, created_by, created_at)
       SELECT e.user_id, e.source_type, e.source_id, e.target_type, m.target, e.link_type, e.confidence,
              e.explanation, e.created_by, e.created_at
         FROM link_edge e JOIN moved m ON m.id = e.id
        WHERE NOT (e.source_type = 'public_artifact' AND e.source_id = m.target)
       ON CONFLICT (source_type, source_id, target_type, target_id, link_type) DO NOTHING
     )
     DELETE FROM link_edge e USING moved m WHERE e.id = m.id`
  );
}

// Rows whose replacement is processed leave search: those replaced by row
// `id` (the worker calls this once it has processed a row), or by any row
// when `id` is null.
export async function retireReplacedRows(id: string | null, db: DB = pool): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE public_artifact a SET status = 'superseded', updated_at = now()
       FROM public_artifact t
      WHERE t.id = a.superseded_by AND t.processing_status = 'processed'
        AND a.status = 'published' AND ($1::uuid IS NULL OR t.id = $1::uuid)`,
    [id]
  );
  if ((rowCount ?? 0) > 0) await moveLinks(db);
  return rowCount ?? 0;
}

export async function loadSummary(db: DB = pool): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `SELECT source_system, status, flag, processing_status, count(*)::int AS rows
       FROM public_artifact
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`
  );
  return rows;
}

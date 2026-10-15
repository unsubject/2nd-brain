// Step 4: write every work (step 3) to public_artifact as one row with
// source_system 'archive', keyed by the source item of its canonical text,
// and point the rows it replaces at it. A replaced row leaves search
// (status 'superseded') once its replacement has been processed; the worker
// retires it then (retireReplacedRows). A row from the first import that is
// no copy of any version goes where Simon's rules of 2026-10-15 send it
// (placeUnmatched): a video's transcript row, the work of the same title, a
// fuller old row, out of search (a fragment), or nowhere: kept as the only
// copy. Nothing is deleted, and everything is written in one transaction.

import { createHash } from "crypto";
import { Pool } from "pg";
import { pool, type DB } from "../../../db/client";
import type { CollectStats } from "../gmail";
import { units } from "../match/similarity";
import { IMPORT_CUT, matchLegacy, placeUnmatched } from "./legacy";

// Bump with every change to what a load writes: the rows are loaded again
// on boot. 2: the report of the old rows no work replaces. 3: Simon's
// rules for the old rows that are no copy (2026-10-15).
export const LOADER_VERSION = 3;

export const ARCHIVE_SOURCE = "archive";
// Rows that are not from the first import: video transcripts and this
// step's own rows.
const VIDEO_SOURCE = "youtube";
const NOT_LEGACY = [VIDEO_SOURCE, ARCHIVE_SOURCE];
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
  // The rows from the first import: how many each rule replaced (a copy
  // of a version, the same title, a video's transcript row, a fuller old
  // row), how many of those have left search or still wait for their
  // replacement; and those nothing replaces: kept as the only copy, a
  // video with no transcript row (flagged 'video'), or a fragment (hidden).
  legacy: {
    rows: number;
    replaced: { text: number; title: number; video: number; duplicate: number };
    superseded: number;
    waiting: number;
    kept: number;
    video: number;
    fragments: number;
  };
  // Where the old rows nothing replaces come from: for each source system
  // and year of publication, the old rows and how many of them nothing
  // replaces; and a digest of which rows those are, and why.
  legacyUnreplaced: { bySource: Record<string, Record<string, { rows: number; unreplaced: number }>>; digest: string | null };
  // The videos an old row is a copy of that have no transcript row: once
  // one is imported, the next load is due (loadStale).
  videosWaiting: string[];
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
    legacy: {
      rows: 0,
      replaced: { text: 0, title: 0, video: 0, duplicate: 0 },
      superseded: 0,
      waiting: 0,
      kept: 0,
      video: 0,
      fragments: 0,
    },
    legacyUnreplaced: { bySource: {}, digest: null },
    videosWaiting: [],
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
  title: string | null;
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
    `SELECT m.candidate_id, c.body_text, c.title,
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
// the worker (a pass on the old text loses its claim); one whose text is
// the same keeps its summary, chunks and embedding, and a pass on it keeps
// its claim. members_only (033) is not the load's: a row keeps what it has.
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
         last_error = CASE WHEN a.raw_source = EXCLUDED.raw_source THEN a.last_error ELSE NULL END,
         claim_token = CASE WHEN a.raw_source = EXCLUDED.raw_source THEN a.claim_token ELSE NULL END,
         claimed_at = CASE WHEN a.raw_source = EXCLUDED.raw_source THEN a.claimed_at ELSE NULL END
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

interface LegacyRow {
  id: string;
  text: string;
  truncated: boolean;
  source_system: string;
  title: string;
  published_at: Date | null;
  canonical_url: string | null;
}

function hostOf(url: string | null): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

// Lines of the list of rows nothing replaces logged at a time, then a
// pause: the platform drops log lines beyond a few hundred a second.
const LIST_BURST = 100;
const LIST_PAUSE_MS = 500;

// Why nothing replaces an old row: the only copy, a video with no
// transcript row, or a fragment.
type Unreplaced = "kept" | "video" | "fragment";

// Where the old rows nothing replaces come from, in the run's stats; and,
// when they are not the ones the last load left (or no load recorded
// them), each of them in the log, with why.
async function reportUnreplaced(
  legacy: LegacyRow[],
  unreplaced: Map<string, Unreplaced>,
  stats: LoadStats,
  lastDigest: string | null
): Promise<void> {
  const yearOf = (l: LegacyRow) => (l.published_at ? String(l.published_at.getUTCFullYear()) : "undated");
  // Maps, not objects: a source named like an Object property (Codex on
  // #105) is a source like any other.
  const bySource = new Map<string, Map<string, { rows: number; unreplaced: number }>>();
  for (const l of legacy) {
    let years = bySource.get(l.source_system);
    if (!years) bySource.set(l.source_system, (years = new Map()));
    let year = years.get(yearOf(l));
    if (!year) years.set(yearOf(l), (year = { rows: 0, unreplaced: 0 }));
    year.rows++;
    if (unreplaced.has(l.id)) year.unreplaced++;
  }
  const sorted = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256")
    .update(sorted(unreplaced).map(([id, why]) => `${id}:${why}`).join(","))
    .digest("hex")
    .slice(0, 16);
  stats.legacyUnreplaced = {
    bySource: Object.fromEntries(sorted(bySource).map(([source, years]) => [source, Object.fromEntries(sorted(years))])),
    digest,
  };

  const { replaced, kept, video, fragments } = stats.legacy;
  console.log(
    `[consolidation] load: of ${legacy.length} old rows, replaced: ${replaced.text} copies, ${replaced.title} by title, ` +
      `${replaced.video} by a video's transcript, ${replaced.duplicate} by a fuller old row; nothing replaces ${kept} kept, ` +
      `${video} videos with no transcript row, ${fragments} fragments (hidden)`
  );
  for (const [source, years] of sorted(bySource)) {
    const counts = sorted(years)
      .map(([year, c]) => `${year} ${c.unreplaced}/${c.rows}`)
      .join(", ");
    console.log(`[consolidation] load: unreplaced/old rows by year, ${source}: ${counts}`);
  }

  if (lastDigest === digest) return;
  const rows = legacy
    .filter((l) => unreplaced.has(l.id))
    .sort(
      (a, b) =>
        a.source_system.localeCompare(b.source_system) ||
        (a.published_at?.getTime() ?? Infinity) - (b.published_at?.getTime() ?? Infinity) ||
        a.title.localeCompare(b.title)
    );
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  for (const [i, l] of rows.entries()) {
    if (i > 0 && i % LIST_BURST === 0) await new Promise((r) => setTimeout(r, LIST_PAUSE_MS));
    const date = l.published_at ? l.published_at.toISOString().slice(0, 10) : "undated";
    console.log(
      `[consolidation] old row, ${unreplaced.get(l.id)}: ${date} ${l.source_system} ${l.text.length} chars${l.truncated ? " (cut)" : ""} ` +
        `${hostOf(l.canonical_url) ?? "-"} "${oneLine(l.title)}" | ${oneLine(l.text).slice(0, 40)}`
    );
  }
}

interface Pointer {
  id: string;
  // The row that replaces this one, if any.
  target: string | null;
  legacy: boolean;
  // For a row nothing replaces: 'video' or 'fragment' (which also leaves
  // search), else none.
  flag: "video" | "fragment" | null;
  hide: boolean;
}

// Point rows at their replacements. A row with a processed replacement
// leaves search now, one whose replacement is still queued stays until the
// worker has processed it. Of the rows nothing replaces, an archive row
// leaves search (status 'superseded'), a fragment too (status 'hidden'),
// and any other old row stays. Statuses other than published, superseded
// and hidden are left alone.
async function pointRows(pointers: Pointer[], q: DB): Promise<Map<string, { status: string; target: string | null }>> {
  const out = new Map<string, { status: string; target: string | null }>();
  for (const batch of chunks(pointers, BATCH * 5)) {
    const { rows } = await q.query<{ id: string; status: string; target: string | null }>(
      `UPDATE public_artifact a SET
         superseded_by = r.target,
         flag = r.flag,
         status = CASE WHEN a.status NOT IN ('published', 'superseded', 'hidden') THEN a.status
                       WHEN r.hide THEN 'hidden'
                       WHEN r.target IS NULL THEN CASE WHEN r.legacy THEN 'published' ELSE 'superseded' END
                       WHEN t.processing_status = 'processed' THEN 'superseded'
                       ELSE 'published' END,
         updated_at = CASE WHEN a.superseded_by IS NOT DISTINCT FROM r.target AND a.flag IS NOT DISTINCT FROM r.flag
                           THEN a.updated_at ELSE now() END
         FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, target uuid, legacy boolean, flag text, hide boolean)
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
  const { matchedAt, works, members, legacy, archived, videos, lastDigest } = await inTransaction(
    db,
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    async (q) => ({
      matchedAt: (await q.query<{ t: string | null }>("SELECT max(matched_at)::text AS t FROM archive_work")).rows[0].t,
      works: await loadWorks(q),
      members: await loadMembers(q),
      legacy: (
        await q.query<LegacyRow>(
          `SELECT id, coalesce(clean_text, raw_source) AS text, length(raw_source) = $1 AS truncated,
                  source_system, title, published_at, canonical_url
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
      // Video transcripts, by video id: what an old copy of one goes to.
      videos: (
        await q.query<{ id: string; video: string }>(
          `SELECT id, source_external_id AS video FROM public_artifact WHERE source_system = $1`,
          [VIDEO_SOURCE]
        )
      ).rows,
      // Which old rows nothing replaced at the last load (reportUnreplaced).
      lastDigest:
        (
          await q.query<{ digest: string | null }>(
            `SELECT stats->'legacyUnreplaced'->>'digest' AS digest FROM archive_collect_run
              WHERE source = 'load' AND status = 'succeeded' ORDER BY started_at DESC LIMIT 1`
          )
        ).rows[0]?.digest ?? null,
    })
  );
  stats.worksMatchedAt = matchedAt;
  stats.listed = stats.works = works.length;
  stats.flaggedReview = works.filter((w) => w.status === "review").length;
  stats.legacy.rows = legacy.length;
  await onProgress();
  if (shouldStop()) return;

  const workOfCandidate = new Map(members.map((m) => [m.candidate_id, m.work_ref]));
  const workOfMember = new Map(members.map((m) => [m.member_ref, m.work_ref]));
  // A copy of a version whose work has no row (its canonical has no text)
  // is placed like a row that is no copy.
  const loadedWorks = new Set(works.map((w) => w.ref));
  const copies = matchLegacy(
    legacy,
    members.map((m) => ({ id: m.candidate_id, text: m.body_text }))
  );
  for (const [id, m] of copies) if (!loadedWorks.has(workOfCandidate.get(m.pieceId) ?? "")) copies.delete(id);
  const workTitle = new Map(works.map((w) => [w.ref, w.title]));
  const placements = placeUnmatched(
    legacy.filter((l) => !copies.has(l.id)).map((l) => ({ ...l, url: l.canonical_url })),
    members
      .filter((m) => loadedWorks.has(m.work_ref))
      .map((m) => ({ id: m.candidate_id, text: m.body_text, titles: [workTitle.get(m.work_ref) ?? null, m.title] })),
    legacy.filter((l) => copies.has(l.id)).map((l) => ({ ...l, url: l.canonical_url }))
  );
  const videoRow = new Map(videos.map((v) => [v.video, v.id]));
  if (shouldStop()) return;

  const unreplaced = new Map<string, Unreplaced>();
  const waiting = new Set<string>();
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
    const retired: Pointer[] = archived
      .filter((a) => !loaded.has(a.ref))
      .map((a) => ({ id: a.id, target: rowOfWork(workOfMember.get(a.ref)), legacy: false, flag: null, hide: false }));
    stats.retired = retired.length;
    // Each old row's replacement, and the rule that found it. A duplicate
    // of a row a work replaces goes to that work.
    const rule = new Map<string, keyof LoadStats["legacy"]["replaced"]>();
    const workReplacing = (id: string): string | null => {
      const copy = copies.get(id);
      if (copy) return rowOfWork(workOfCandidate.get(copy.pieceId));
      const p = placements.get(id);
      return p?.kind === "title" ? rowOfWork(workOfCandidate.get(p.pieceId)) : null;
    };
    const oldRows: Pointer[] = legacy.map((l) => {
      const pointer = (target: string | null, by: keyof LoadStats["legacy"]["replaced"]): Pointer => {
        if (target) rule.set(l.id, by);
        return { id: l.id, target, legacy: true, flag: null, hide: false };
      };
      const copy = copies.get(l.id);
      if (copy) return pointer(rowOfWork(workOfCandidate.get(copy.pieceId)), "text");
      const p = placements.get(l.id)!;
      switch (p.kind) {
        case "title":
          return pointer(rowOfWork(workOfCandidate.get(p.pieceId)), "title");
        case "duplicate":
          return pointer(workReplacing(p.rowId) ?? p.rowId, "duplicate");
        case "video": {
          const target = videoRow.get(p.videoId) ?? null;
          if (!target) waiting.add(p.videoId);
          return target ? pointer(target, "video") : { id: l.id, target: null, legacy: true, flag: "video", hide: false };
        }
        case "fragment":
          return { id: l.id, target: null, legacy: true, flag: "fragment", hide: true };
        case "kept":
          return { id: l.id, target: null, legacy: true, flag: null, hide: false };
      }
    });
    const results = await pointRows([...retired, ...oldRows], q);
    await moveLinks(q);
    for (const p of oldRows) {
      const r = results.get(p.id);
      if (!r) continue;
      if (r.target !== null) {
        stats.legacy.replaced[rule.get(p.id)!]++;
        if (r.status === "superseded") stats.legacy.superseded++;
        else stats.legacy.waiting++;
      } else {
        const why: Unreplaced = p.flag === "video" ? "video" : p.flag === "fragment" ? "fragment" : "kept";
        unreplaced.set(p.id, why);
        if (why === "fragment") stats.legacy.fragments++;
        else stats.legacy[why]++;
      }
    }

    // A work, or an old row a duplicate merged into, with no URL of its
    // own keeps the first import's link, if a row it replaces had one (Codex
    // on #114). Not a video's transcript row: that has its own.
    await q.query(
      `UPDATE public_artifact a SET canonical_url = l.canonical_url
         FROM (SELECT DISTINCT ON (superseded_by) superseded_by, canonical_url
                 FROM public_artifact
                WHERE superseded_by IS NOT NULL AND NOT (source_system = ANY($1))
                  AND canonical_url ~ '^https?://'
                ORDER BY superseded_by, published_at NULLS LAST, id) l
        WHERE a.id = l.superseded_by AND a.canonical_url IS NULL AND a.source_system <> $2`,
      [NOT_LEGACY, VIDEO_SOURCE]
    );
  });
  stats.videosWaiting = [...waiting].sort();
  // A replacement the worker finished while the transaction was open
  // retired nothing (its rows did not point at it yet): retire them now.
  stats.retiredLate = await retireReplacedRows(null, db);
  await reportUnreplaced(legacy, unreplaced, stats, lastDigest);
}

// The works are not the ones the last successful load by this
// LOADER_VERSION read (or none has run): their rows are out of date. Each
// match writes one generation with one matched_at, so a different max
// means a different generation, an empty one included. Compared with what
// the load read, not when it started: a load that starts while a match is
// writing still reads the works before it. Due too once a video an old row
// is a copy of, with no transcript row at that load, has one now (Codex on
// #114): the load points the copy at it. Only the ids the load itself
// found waiting count, so the load that links them is not due again.
export async function loadStale(db: DB = pool): Promise<boolean> {
  const { rows } = await db.query<{ stale: boolean }>(
    `WITH last AS (
       SELECT stats FROM archive_collect_run
        WHERE source = 'load' AND status = 'succeeded'
          AND (stats->>'loaderVersion')::int = $1
        ORDER BY started_at DESC LIMIT 1
     )
     SELECT (SELECT max(matched_at) FROM archive_work) IS DISTINCT FROM
            (SELECT (stats->>'worksMatchedAt')::timestamptz FROM last)
         OR EXISTS (
              SELECT 1 FROM public_artifact
               WHERE source_system = $2
                 AND source_external_id IN (
                       SELECT jsonb_array_elements_text(coalesce(stats->'videosWaiting', '[]'::jsonb)) FROM last)
            ) AS stale`,
    [LOADER_VERSION, VIDEO_SOURCE]
  );
  return rows[0].stale;
}

// Links to a row that has left search move to the row that replaced it,
// so they keep showing the piece: those the journal linker made
// (journal echoes, shared entities; one that would point at its own source
// is dropped), and idea links ('became', 'revisits', in any status, so a
// rejected pair stays remembered). An idea link records the row it pointed
// at in its history; where the idea already has that link to the
// replacement, the old one stays as it is.
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
  await db.query(
    `WITH moved AS (
       SELECT DISTINCT ON (l.source_idea_id, a.superseded_by, l.link_type)
              l.id, a.id AS old_target, a.superseded_by AS target
         FROM idea_link l
         JOIN public_artifact a ON a.id = l.target_artifact_id
        WHERE a.status = 'superseded' AND a.superseded_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM idea_link d
                           WHERE d.source_idea_id = l.source_idea_id
                             AND d.target_artifact_id = a.superseded_by
                             AND d.link_type = l.link_type)
        ORDER BY l.source_idea_id, a.superseded_by, l.link_type, (l.status = 'accepted') DESC, l.proposed_at
     )
     UPDATE idea_link l SET
       target_artifact_id = m.target,
       history = l.history || jsonb_build_array(jsonb_build_object(
         'target_artifact_id', m.old_target, 'retargeted_at', now(), 'retargeted_by', 'archive-consolidation'))
       FROM moved m
      WHERE l.id = m.id`
  );
}

// Rows whose replacement is processed leave search: those replaced by row
// `id` (the worker calls this once it has processed a row), or by any row
// when `id` is null.
export async function retireReplacedRows(id: string | null, db: DB = pool): Promise<number> {
  // With the links' move, so a failure leaves both as they were.
  return inTransaction(db, "BEGIN", async (q) => {
    const { rowCount } = await q.query(
      `UPDATE public_artifact a SET status = 'superseded', updated_at = now()
         FROM public_artifact t
        WHERE t.id = a.superseded_by AND t.processing_status = 'processed'
          AND a.status = 'published' AND ($1::uuid IS NULL OR t.id = $1::uuid)`,
      [id]
    );
    if ((rowCount ?? 0) > 0) await moveLinks(q);
    return rowCount ?? 0;
  });
}

export async function loadSummary(db: DB = pool): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `SELECT source_system, status, flag, processing_status, count(*)::int AS rows
       FROM public_artifact
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`
  );
  return rows;
}

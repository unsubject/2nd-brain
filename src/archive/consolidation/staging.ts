import { createHash } from "crypto";
import { Pool } from "pg";
import { pool, type DB } from "../../db/client";

export type ArchiveSource = "gmail" | "gdrive" | "wordpress" | "substack";
// "extract" (step 2), "match" (step 3) and "load" (step 4) are tracked
// like collectors.
export type CollectorSource = "gmail" | "gdrive" | "extract" | "match" | "load";

export interface SourceItem {
  source: ArchiveSource;
  sourceRef: string;
  containerRef: string | null;
  title: string | null;
  authoredAt: Date | null;
  rawText: string | null;
  rawHtml: string | null;
  metadata: Record<string, unknown>;
}

export type UpsertResult = "inserted" | "updated" | "unchanged";

// A live run heartbeats every 30 s (runner.ts) whatever its progress, so a
// 'running' row silent for this long belongs to a process that is gone.
export const STALE_RUN_SECONDS = 120;

export function contentHash(rawText: string | null, rawHtml: string | null): string {
  return createHash("sha256")
    .update(rawText ?? "")
    .update("\u0000")
    .update(rawHtml ?? "")
    .digest("hex");
}

// Postgres TEXT can't hold NUL; a few old exports contain stray ones.
function stripNul(s: string | null): string | null {
  return s === null ? null : s.replace(/\u0000/g, "");
}

export async function upsertSourceItem(item: SourceItem, db: DB = pool): Promise<UpsertResult> {
  const rawText = stripNul(item.rawText);
  const rawHtml = stripNul(item.rawHtml);
  if (rawText === null && rawHtml === null) {
    throw new Error(`source item ${item.source}:${item.sourceRef} has no body`);
  }
  const hash = contentHash(rawText, rawHtml);
  // Only touch the row when something about it changed, so `unchanged`
  // re-runs leave fetched_at alone and the result reports real changes.
  const { rows } = await db.query<{ inserted: boolean }>(
    `INSERT INTO archive_source_item
       (source, source_ref, container_ref, title, authored_at, raw_text, raw_html, metadata, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (source, source_ref) DO UPDATE
       SET container_ref = EXCLUDED.container_ref,
           title = EXCLUDED.title,
           authored_at = EXCLUDED.authored_at,
           raw_text = EXCLUDED.raw_text,
           raw_html = EXCLUDED.raw_html,
           metadata = EXCLUDED.metadata,
           content_hash = EXCLUDED.content_hash,
           fetched_at = now()
       WHERE archive_source_item.content_hash IS DISTINCT FROM EXCLUDED.content_hash
          OR archive_source_item.metadata IS DISTINCT FROM EXCLUDED.metadata
          OR archive_source_item.title IS DISTINCT FROM EXCLUDED.title
          OR archive_source_item.authored_at IS DISTINCT FROM EXCLUDED.authored_at
          OR archive_source_item.container_ref IS DISTINCT FROM EXCLUDED.container_ref
     RETURNING (xmax = 0) AS inserted`,
    [
      item.source,
      item.sourceRef,
      item.containerRef,
      stripNul(item.title),
      item.authoredAt,
      rawText,
      rawHtml,
      JSON.stringify(item.metadata),
      hash,
    ]
  );
  if (rows.length === 0) return "unchanged";
  return rows[0].inserted ? "inserted" : "updated";
}

export async function existingSourceRefs(
  source: ArchiveSource,
  refs: string[],
  db: DB = pool
): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const { rows } = await db.query<{ source_ref: string }>(
    `SELECT source_ref FROM archive_source_item WHERE source = $1 AND source_ref = ANY($2)`,
    [source, refs]
  );
  return new Set(rows.map((r) => r.source_ref));
}

// Staged Gmail messages (among `refs`) with an expected attachment row
// missing; the collector fetches these again even without refetch.
export async function incompleteGmailMessages(refs: string[], db: DB = pool): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const { rows } = await db.query<{ source_ref: string }>(
    `SELECT m.source_ref
       FROM archive_source_item m
      WHERE m.source = 'gmail' AND m.source_ref = ANY($1)
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(coalesce(m.metadata->'expectedAttachmentRefs', '[]'::jsonb)) AS r(ref)
           WHERE NOT EXISTS (
             SELECT 1 FROM archive_source_item a WHERE a.source = 'gmail' AND a.source_ref = r.ref
           )
        )`,
    [refs]
  );
  return new Set(rows.map((r) => r.source_ref));
}

export class RunAlreadyActiveError extends Error {
  constructor(source: CollectorSource, message = `another ${source} run is in progress`) {
    super(message);
  }
}

// Extraction reads everything staged, so it doesn't start while a Gmail or
// Drive collection is live; the collection starts it when it ends
// (runner.ts). A subclass, so callers that leave an active run alone treat
// this the same way.
export class RunBlockedError extends RunAlreadyActiveError {
  constructor(readonly blockedBy: CollectorSource) {
    super("extract", `a ${blockedBy} collection run is in progress; extraction starts by itself when it ends`);
  }
}

const INTERRUPTED = `interrupted: no heartbeat for ${STALE_RUN_SECONDS} s (server restart?)`;

// Record a new 'running' run. With `replaces` (the resume sweeper), the
// interrupted run it continues is marked failed in the same transaction, so
// if the new row can't be written the old one stays 'running' and the next
// sweep tries again; RunAlreadyActiveError when that run is no longer a
// silent 'running' row (resumed by another process, or alive after all).
export async function startRun(
  source: CollectorSource,
  params: Record<string, unknown>,
  db: DB = pool,
  replaces?: string
): Promise<string> {
  // One connection for the transaction: a pool would spread it over several.
  const client = db instanceof Pool ? await db.connect() : null;
  const q = client ?? db;
  try {
    await q.query("BEGIN");
    if (replaces) {
      const { rowCount } = await q.query(
        `UPDATE archive_collect_run SET status = 'failed', error = $2, finished_at = now()
          WHERE id = $1 AND status = 'running'
            AND heartbeat_at < now() - make_interval(secs => ${STALE_RUN_SECONDS})`,
        [replaces, INTERRUPTED]
      );
      if (!rowCount) throw new RunAlreadyActiveError(source, `run ${replaces} was already taken over, or is live again`);
    } else {
      await q.query(
        `UPDATE archive_collect_run
            SET status = 'failed', error = 'abandoned: no heartbeat for ${STALE_RUN_SECONDS} s (server restart?)',
                finished_at = now()
          WHERE source = $1 AND status = 'running'
            AND heartbeat_at < now() - make_interval(secs => ${STALE_RUN_SECONDS})`,
        [source]
      );
    }
    if (source === "extract") {
      // Not atomic with the insert: a collection that starts in between is
      // covered by the check at the end of the extraction, whatever its
      // outcome (runner.nextStep).
      const { rows } = await q.query<{ source: CollectorSource }>(
        `SELECT source FROM archive_collect_run
          WHERE source IN ('gmail', 'gdrive') AND status = 'running'
            AND heartbeat_at >= now() - make_interval(secs => ${STALE_RUN_SECONDS})
          LIMIT 1`
      );
      if (rows[0]) throw new RunBlockedError(rows[0].source);
    }
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO archive_collect_run (source, params) VALUES ($1, $2::jsonb) RETURNING id`,
      [source, JSON.stringify(params)]
    );
    await q.query("COMMIT");
    return rows[0].id;
  } catch (err) {
    await q.query("ROLLBACK").catch(() => undefined);
    if ((err as { code?: string }).code === "23505") throw new RunAlreadyActiveError(source);
    throw err;
  } finally {
    client?.release();
  }
}

// False when the row is no longer 'running' (another process declared the
// run interrupted and took it over): the caller should stop.
export async function heartbeatRun(
  runId: string,
  stats: Record<string, unknown>,
  db: DB = pool
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE archive_collect_run SET stats = $2::jsonb, heartbeat_at = now()
      WHERE id = $1 AND status = 'running'`,
    [runId, JSON.stringify(stats)]
  );
  return (rowCount ?? 0) > 0;
}

export async function finishRun(
  runId: string,
  status: "succeeded" | "failed",
  stats: Record<string, unknown>,
  error: string | null,
  db: DB = pool
): Promise<boolean> {
  // Only a run still marked running: a run taken over as interrupted keeps
  // that outcome even if its old process finishes later (false then).
  const { rowCount } = await db.query(
    `UPDATE archive_collect_run
        SET status = $2, stats = $3::jsonb, error = $4, finished_at = now(), heartbeat_at = now()
      WHERE id = $1 AND status = 'running'`,
    [runId, status, JSON.stringify(stats), error ? error.slice(0, 2000) : null]
  );
  return (rowCount ?? 0) > 0;
}

export interface InterruptedRun {
  id: string;
  source: CollectorSource;
  params: Record<string, unknown>;
}

// Runs whose process is gone (no heartbeat for STALE_RUN_SECONDS), oldest
// first. Reading them claims nothing: startRun(..., replaces) or
// markInterrupted does, so each row is taken over by exactly one caller.
export async function interruptedRuns(db: DB = pool): Promise<InterruptedRun[]> {
  const { rows } = await db.query<InterruptedRun>(
    `SELECT id, source, params FROM archive_collect_run
      WHERE status = 'running'
        AND heartbeat_at < now() - make_interval(secs => ${STALE_RUN_SECONDS})
      ORDER BY started_at`
  );
  return rows;
}

// Mark an interrupted run failed without continuing it; false when it was
// no longer a silent 'running' row.
export async function markInterrupted(runId: string, db: DB = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE archive_collect_run SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1 AND status = 'running'
        AND heartbeat_at < now() - make_interval(secs => ${STALE_RUN_SECONDS})`,
    [runId, INTERRUPTED]
  );
  return (rowCount ?? 0) > 0;
}

// True when a `source` run succeeded after run `runId` started: one that
// ended while `runId` was live, so the step it starts after itself was
// refused if `runId` is that step (one run per source).
export async function succeededSince(source: CollectorSource, runId: string, db: DB = pool): Promise<boolean> {
  const { rows } = await db.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM archive_collect_run
        WHERE source = $1 AND status = 'succeeded'
          AND finished_at >= (SELECT started_at FROM archive_collect_run WHERE id = $2)
     ) AS found`,
    [source, runId]
  );
  return rows[0].found;
}

export async function getStagingStatus(db: DB = pool): Promise<{
  items: { source: string; items: number; earliest: Date | null; latest: Date | null }[];
  runs: Record<string, unknown>[];
}> {
  const { rows: items } = await db.query(
    `SELECT source, count(*)::int AS items, min(authored_at) AS earliest, max(authored_at) AS latest
       FROM archive_source_item GROUP BY source ORDER BY source`
  );
  const { rows: runs } = await db.query(
    `SELECT id, source, params, status, stats, error, started_at, heartbeat_at, finished_at
       FROM archive_collect_run ORDER BY started_at DESC LIMIT 10`
  );
  return { items, runs };
}

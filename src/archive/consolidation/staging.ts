import { createHash } from "crypto";
import { pool, type DB } from "../../db/client";

export type ArchiveSource = "gmail" | "gdrive" | "wordpress" | "substack";
export type CollectorSource = "gmail" | "gdrive";

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

// A run with no progress for this long is treated as abandoned.
const STALE_RUN_MINUTES = 15;

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

export class RunAlreadyActiveError extends Error {
  constructor(source: CollectorSource) {
    super(`a ${source} collection run is already in progress`);
  }
}

export async function startRun(
  source: CollectorSource,
  params: Record<string, unknown>,
  db: DB = pool
): Promise<string> {
  await db.query(
    `UPDATE archive_collect_run
        SET status = 'failed', error = 'abandoned: no progress for ${STALE_RUN_MINUTES} minutes (server restart?)',
            finished_at = now()
      WHERE source = $1 AND status = 'running'
        AND heartbeat_at < now() - interval '${STALE_RUN_MINUTES} minutes'`,
    [source]
  );
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO archive_collect_run (source, params) VALUES ($1, $2::jsonb) RETURNING id`,
      [source, JSON.stringify(params)]
    );
    return rows[0].id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new RunAlreadyActiveError(source);
    throw err;
  }
}

export async function heartbeatRun(
  runId: string,
  stats: Record<string, unknown>,
  db: DB = pool
): Promise<void> {
  await db.query(
    `UPDATE archive_collect_run SET stats = $2::jsonb, heartbeat_at = now() WHERE id = $1`,
    [runId, JSON.stringify(stats)]
  );
}

export async function finishRun(
  runId: string,
  status: "succeeded" | "failed",
  stats: Record<string, unknown>,
  error: string | null,
  db: DB = pool
): Promise<void> {
  await db.query(
    `UPDATE archive_collect_run
        SET status = $2, stats = $3::jsonb, error = $4, finished_at = now(), heartbeat_at = now()
      WHERE id = $1`,
    [runId, status, JSON.stringify(stats), error ? error.slice(0, 2000) : null]
  );
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

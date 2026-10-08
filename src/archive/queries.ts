import { PoolClient } from "pg";
import { pool } from "../db/client";

export async function upsertArtifact(params: {
  userId: string;
  type: string;
  title: string;
  slug: string | null;
  publishedAt: Date | null;
  rawSource: string;
  canonicalUrl: string | null;
  series: string | null;
  seriesPosition: number | null;
  tags: string[] | null;
  sourceSystem: string;
  sourceExternalId: string;
  sourceSummary?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const { rows } = await pool.query(
    `INSERT INTO public_artifact
       (user_id, type, title, slug, published_at, raw_source,
        canonical_url, series, series_position, tags,
        source_system, source_external_id, summary,
        source_last_synced_at,
        word_count, processing_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(),
             array_length(regexp_split_to_array(trim($6), '\s+'), 1),
             'pending')
     ON CONFLICT (source_system, source_external_id) DO UPDATE
       SET title = EXCLUDED.title,
           slug = EXCLUDED.slug,
           published_at = EXCLUDED.published_at,
           raw_source = EXCLUDED.raw_source,
           canonical_url = EXCLUDED.canonical_url,
           series = EXCLUDED.series,
           series_position = EXCLUDED.series_position,
           tags = EXCLUDED.tags,
           -- Invariant: when a row is pending, summary is either NULL or
           -- source-provided. Never a stale prior LLM output.
           summary = CASE
             WHEN EXCLUDED.summary IS NOT NULL THEN EXCLUDED.summary
             WHEN public_artifact.raw_source = EXCLUDED.raw_source THEN public_artifact.summary
             ELSE NULL
           END,
           word_count = EXCLUDED.word_count,
           source_last_synced_at = now(),
           updated_at = now(),
           processing_status = CASE
             WHEN public_artifact.raw_source = EXCLUDED.raw_source
             THEN public_artifact.processing_status
             ELSE 'pending'
           END,
           -- Mirror processing_status: when the row is re-queued because
           -- raw_source changed, clear the stale error text. Otherwise
           -- leave it as-is (preserves the current error while the row
           -- sits in 'error', and a no-op for 'processed' / 'pending').
           last_error = CASE
             WHEN public_artifact.raw_source = EXCLUDED.raw_source
             THEN public_artifact.last_error
             ELSE NULL
           END
     RETURNING id,
       (xmax = 0) AS created`,
    [
      params.userId,
      params.type,
      params.title,
      params.slug,
      params.publishedAt,
      params.rawSource,
      params.canonicalUrl,
      params.series,
      params.seriesPosition,
      params.tags,
      params.sourceSystem,
      params.sourceExternalId,
      params.sourceSummary ?? null,
    ]
  );
  return { id: rows[0].id, created: rows[0].created };
}

export async function findPendingArtifact(): Promise<{
  id: string;
  raw_source: string;
  title: string;
  tags: string[] | null;
  summary: string | null;
} | null> {
  const { rows } = await pool.query(
    `UPDATE public_artifact
     SET processing_status = 'processing'
     WHERE id = (
       SELECT id FROM public_artifact
       WHERE processing_status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, raw_source, title, tags, summary`
  );
  return rows[0] || null;
}

// Whether the row still holds `rawSource`: the worker stops a pass on a
// changed text before its entity calls. The save checks it again, under
// the row's lock.
export async function artifactHoldsText(id: string, rawSource: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM public_artifact WHERE id = $1 AND raw_source = $2`,
    [id, rawSource]
  );
  return (rowCount ?? 0) > 0;
}

// Everything one pass of the worker writes, in one transaction that first
// locks the row and checks it still holds `claimedRawSource`, the text the
// worker processed. A load that changes the text (and queues the row again)
// either waits for the commit or leaves this pass writing nothing. So the
// results for an old text never land beside, or after, those for the new
// one, even when a second worker processes the new text meanwhile and
// finishes first (Codex on #99). The lock is the one an update takes, so a
// load pointing an older row at this one (superseded_by) need not wait.
// Returns whether it saved. A saved row is 'processed' and can be found.
export async function completeArtifactProcessing(
  id: string,
  claimedRawSource: string,
  params: {
    cleanText: string;
    summary: string;
    excerpt: string;
    tags: string[];
    language: string;
    embedding: number[];
    embeddingModel: string;
    chunks: {
      chunkIndex: number;
      chunkText: string;
      chunkTokens: number;
      headingPath: string[];
      startOffset: number;
      endOffset: number;
      embedding: number[];
    }[];
    // entity_ref ids, upserted beforehand (upsertEntity)
    entities: { entityRefId: string; mentionText: string | null; salience: number | null }[];
  },
  minShared: number = 2
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A load holds every row it writes until it commits, which can take
    // longer than the pool's 10 s statement timeout: wait for it rather
    // than fail the row. The other statements here are short.
    await client.query("SET LOCAL statement_timeout = '5min'");
    const { rowCount: held } = await client.query(
      `SELECT 1 FROM public_artifact WHERE id = $1 AND raw_source = $2 FOR NO KEY UPDATE`,
      [id, claimedRawSource]
    );
    if (!held) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `UPDATE public_artifact
       SET clean_text = $2,
           summary = $3,
           excerpt = $4,
           tags = $5,
           language = $6,
           embedding = $7::vector,
           embedding_model = $8,
           processing_status = 'processed',
           last_error = NULL,
           updated_at = now()
       WHERE id = $1`,
      [
        id,
        params.cleanText,
        params.summary,
        params.excerpt,
        params.tags,
        params.language,
        `[${params.embedding.join(",")}]`,
        params.embeddingModel,
      ]
    );

    await client.query(`DELETE FROM public_artifact_chunk WHERE public_artifact_id = $1`, [id]);
    for (const chunk of params.chunks) {
      await client.query(
        `INSERT INTO public_artifact_chunk
           (public_artifact_id, chunk_index, chunk_text, chunk_tokens,
            heading_path, start_offset, end_offset, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [
          id,
          chunk.chunkIndex,
          chunk.chunkText,
          chunk.chunkTokens,
          chunk.headingPath,
          chunk.startOffset,
          chunk.endOffset,
          `[${chunk.embedding.join(",")}]`,
        ]
      );
    }

    // One row per entity: two names the extractor returned for the same
    // entity would otherwise count twice towards a shared link.
    await client.query(`DELETE FROM public_artifact_entity WHERE public_artifact_id = $1`, [id]);
    await client.query(
      `INSERT INTO public_artifact_entity (public_artifact_id, entity_ref_id, mention_text, salience)
       SELECT DISTINCT ON (e.entity_ref_id) $1, e.entity_ref_id, e.mention_text, e.salience
         FROM unnest($2::uuid[], $3::text[], $4::real[]) AS e(entity_ref_id, mention_text, salience)
        ORDER BY e.entity_ref_id, e.salience DESC NULLS LAST`,
      [
        id,
        params.entities.map((e) => e.entityRefId),
        params.entities.map((e) => e.mentionText),
        params.entities.map((e) => e.salience),
      ]
    );

    await writeSharedEntityLinks(client, id, minShared);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertEntity(
  userId: string,
  entityType: string,
  displayName: string,
  aliases: string[]
): Promise<string> {
  const normalized = displayName.toLowerCase().trim();
  const { rows } = await pool.query(
    `INSERT INTO entity_ref (user_id, entity_type, normalized_name, display_name, aliases)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, entity_type, normalized_name) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           aliases = EXCLUDED.aliases,
           updated_at = now()
     RETURNING id`,
    [userId, entityType, normalized, displayName, aliases]
  );
  return rows[0].id;
}

// With `claimedRawSource`, recorded only if the row still holds that text:
// a failed attempt on an old text must not mark the new one, queued
// meanwhile, as failed.
export async function markArtifactError(
  id: string,
  errorMessage: string,
  claimedRawSource: string | null = null
): Promise<void> {
  await pool.query(
    `UPDATE public_artifact
     SET processing_status = 'error',
         last_error = $2,
         updated_at = now()
     WHERE id = $1 AND ($3::text IS NULL OR raw_source = $3)`,
    [id, errorMessage, claimedRawSource]
  );
}

// This artifact's links to the artifacts sharing at least `minShared` of
// its salient entities, rebuilt from its current entities: links from an
// earlier pass (an older text, or an attempt abandoned because the text
// changed under it) are dropped, not left beside the new ones. Entities
// are counted once each: rows saved before completeArtifactProcessing can
// hold one entity twice. Runs inside completeArtifactProcessing's
// transaction.
async function writeSharedEntityLinks(client: PoolClient, artifactId: string, minShared: number): Promise<number> {
  await client.query(
    `DELETE FROM link_edge
      WHERE source_type = 'public_artifact' AND source_id = $1 AND link_type = 'shared_entities'`,
    [artifactId]
  );
  const { rowCount } = await client.query(
    `INSERT INTO link_edge
       (user_id, source_type, source_id, target_type, target_id, link_type, confidence, explanation)
     SELECT 'default', 'public_artifact', $1, 'public_artifact', r.other_artifact_id, 'shared_entities',
            NULL, r.shared_count || ' shared entities'
       FROM (SELECT pae2.public_artifact_id AS other_artifact_id,
                    COUNT(DISTINCT pae1.entity_ref_id) AS shared_count
               FROM public_artifact_entity pae1
               JOIN public_artifact_entity pae2 ON pae1.entity_ref_id = pae2.entity_ref_id
              WHERE pae1.public_artifact_id = $1
                AND pae2.public_artifact_id != $1
                AND (pae1.salience IS NULL OR pae1.salience >= 0.5)
                AND (pae2.salience IS NULL OR pae2.salience >= 0.5)
              GROUP BY pae2.public_artifact_id
             HAVING COUNT(DISTINCT pae1.entity_ref_id) >= $2
              ORDER BY COUNT(DISTINCT pae1.entity_ref_id) DESC
              LIMIT 20) r
     ON CONFLICT (source_type, source_id, target_type, target_id, link_type) DO NOTHING`,
    [artifactId, minShared]
  );
  return rowCount ?? 0;
}

// --- Search queries ---

export async function vectorSearchChunks(
  queryEmbedding: number[],
  limit: number,
  filters: {
    types?: string[];
    dateFrom?: string;
    dateTo?: string;
    tags?: string[];
  }
): Promise<
  {
    chunk_id: string;
    artifact_id: string;
    chunk_text: string;
    heading_path: string[];
    similarity: number;
    title: string;
    type: string;
    published_at: Date | null;
    tags: string[] | null;
    summary: string | null;
    flag: string | null;
  }[]
> {
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  // Rows another has replaced (archive consolidation) are left out.
  const conditions: string[] = ["pa.processing_status = 'processed'", "pa.status = 'published'"];
  const params: unknown[] = [vectorStr, limit];
  let paramIdx = 3;

  if (filters.types?.length) {
    conditions.push(`pa.type = ANY($${paramIdx})`);
    params.push(filters.types);
    paramIdx++;
  }
  if (filters.dateFrom) {
    conditions.push(`pa.published_at >= $${paramIdx}`);
    params.push(filters.dateFrom);
    paramIdx++;
  }
  if (filters.dateTo) {
    conditions.push(`pa.published_at <= $${paramIdx}`);
    params.push(filters.dateTo);
    paramIdx++;
  }
  if (filters.tags?.length) {
    conditions.push(`pa.tags && $${paramIdx}`);
    params.push(filters.tags);
    paramIdx++;
  }

  const where = conditions.join(" AND ");
  const { rows } = await pool.query(
    `SELECT c.id AS chunk_id, pa.id AS artifact_id,
            c.chunk_text, c.heading_path,
            1 - (c.embedding <=> $1::vector) AS similarity,
            pa.title, pa.type, pa.published_at, pa.tags, pa.summary, pa.flag
     FROM public_artifact_chunk c
     JOIN public_artifact pa ON pa.id = c.public_artifact_id
     WHERE ${where}
       AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    params
  );
  return rows;
}

export async function bm25SearchChunks(
  query: string,
  limit: number,
  filters: {
    types?: string[];
    dateFrom?: string;
    dateTo?: string;
    tags?: string[];
  }
): Promise<
  {
    chunk_id: string;
    artifact_id: string;
    chunk_text: string;
    heading_path: string[];
    rank: number;
    title: string;
    type: string;
    published_at: Date | null;
    tags: string[] | null;
    summary: string | null;
    flag: string | null;
  }[]
> {
  const tsQuery = query
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((w) => w.length > 0)
    .join(" & ");

  if (!tsQuery) return [];

  // Rows another has replaced (archive consolidation) are left out.
  const conditions: string[] = ["pa.processing_status = 'processed'", "pa.status = 'published'"];
  const params: unknown[] = [tsQuery, limit];
  let paramIdx = 3;

  if (filters.types?.length) {
    conditions.push(`pa.type = ANY($${paramIdx})`);
    params.push(filters.types);
    paramIdx++;
  }
  if (filters.dateFrom) {
    conditions.push(`pa.published_at >= $${paramIdx}`);
    params.push(filters.dateFrom);
    paramIdx++;
  }
  if (filters.dateTo) {
    conditions.push(`pa.published_at <= $${paramIdx}`);
    params.push(filters.dateTo);
    paramIdx++;
  }
  if (filters.tags?.length) {
    conditions.push(`pa.tags && $${paramIdx}`);
    params.push(filters.tags);
    paramIdx++;
  }

  const where = conditions.join(" AND ");
  const { rows } = await pool.query(
    `SELECT c.id AS chunk_id, pa.id AS artifact_id,
            c.chunk_text, c.heading_path,
            ts_rank(c.fulltext_tsv, to_tsquery('english', $1)) AS rank,
            pa.title, pa.type, pa.published_at, pa.tags, pa.summary, pa.flag
     FROM public_artifact_chunk c
     JOIN public_artifact pa ON pa.id = c.public_artifact_id
     WHERE ${where}
       AND c.fulltext_tsv @@ to_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT $2`,
    params
  );
  return rows;
}

export async function graphSearchArtifacts(
  entityIds: string[],
  limit: number
): Promise<
  {
    artifact_id: string;
    title: string;
    type: string;
    published_at: Date | null;
    tags: string[] | null;
    summary: string | null;
    flag: string | null;
    entity_count: number;
  }[]
> {
  if (entityIds.length === 0) return [];

  const { rows } = await pool.query(
    `SELECT pa.id AS artifact_id, pa.title, pa.type,
            pa.published_at, pa.tags, pa.summary, pa.flag,
            COUNT(DISTINCT pae.entity_ref_id) AS entity_count
     FROM public_artifact_entity pae
     JOIN public_artifact pa ON pa.id = pae.public_artifact_id
     WHERE pae.entity_ref_id = ANY($1)
       AND pa.processing_status = 'processed'
       AND pa.status = 'published'
     GROUP BY pa.id
     ORDER BY entity_count DESC
     LIMIT $2`,
    [entityIds, limit]
  );
  return rows;
}

export async function findEntitiesByName(
  query: string
): Promise<{ id: string; entity_type: string; display_name: string }[]> {
  const pattern = `%${query.toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT id, entity_type, display_name
     FROM entity_ref
     WHERE normalized_name LIKE $1
        OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) LIKE $1)
     LIMIT 10`,
    [pattern]
  );
  return rows;
}

export async function getProcessingDiagnostics(): Promise<{
  statusCounts: { processing_status: string; count: number }[];
  reprocessedCount: number;
  oldestPending: { id: string; title: string; created_at: Date } | null;
  recentProcessed: { title: string; updated_at: Date; reprocess_seconds: number | null }[];
}> {
  const { rows: statusCounts } = await pool.query(
    `SELECT processing_status, count(*)::int AS count
     FROM public_artifact GROUP BY processing_status`
  );

  const { rows: reprocessed } = await pool.query(
    `SELECT count(*)::int AS count
     FROM public_artifact
     WHERE processing_status = 'processed'
       AND updated_at - created_at > interval '10 minutes'`
  );

  const { rows: pending } = await pool.query(
    `SELECT id, title, created_at
     FROM public_artifact
     WHERE processing_status = 'pending'
     ORDER BY created_at ASC LIMIT 1`
  );

  const { rows: recent } = await pool.query(
    `SELECT title, updated_at,
            EXTRACT(EPOCH FROM (updated_at - created_at))::int AS reprocess_seconds
     FROM public_artifact
     WHERE processing_status = 'processed'
     ORDER BY updated_at DESC LIMIT 10`
  );

  return {
    statusCounts,
    reprocessedCount: reprocessed[0].count,
    oldestPending: pending[0] || null,
    recentProcessed: recent,
  };
}

export async function resetErroredArtifacts(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE public_artifact
     SET processing_status = 'pending',
         last_error = NULL
     WHERE processing_status IN ('error', 'processing')`
  );
  return rowCount ?? 0;
}

export async function getArtifactStats(): Promise<{
  total: number;
  processed: number;
  pending: number;
  error: number;
  byType: { type: string; count: number }[];
}> {
  const { rows: statusRows } = await pool.query(
    `SELECT processing_status, count(*)::int AS count
     FROM public_artifact GROUP BY processing_status`
  );
  const { rows: typeRows } = await pool.query(
    `SELECT type, count(*)::int AS count
     FROM public_artifact GROUP BY type ORDER BY count DESC`
  );

  const stats = { total: 0, processed: 0, pending: 0, error: 0, byType: typeRows };
  for (const r of statusRows) {
    stats[r.processing_status as keyof typeof stats] = r.count;
    stats.total += r.count;
  }
  return stats;
}

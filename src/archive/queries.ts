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
}): Promise<{ id: string; created: boolean }> {
  const { rows } = await pool.query(
    `INSERT INTO public_artifact
       (user_id, type, title, slug, published_at, raw_source,
        canonical_url, series, series_position, tags,
        source_system, source_external_id, source_last_synced_at,
        word_count, processing_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(),
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
           word_count = EXCLUDED.word_count,
           source_last_synced_at = now(),
           updated_at = now(),
           processing_status = CASE
             WHEN public_artifact.raw_source = EXCLUDED.raw_source
             THEN public_artifact.processing_status
             ELSE 'pending'
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
    ]
  );
  return { id: rows[0].id, created: rows[0].created };
}

export async function findPendingArtifact(): Promise<{
  id: string;
  raw_source: string;
  title: string;
  tags: string[] | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT id, raw_source, title, tags
     FROM public_artifact
     WHERE processing_status = 'pending'
     ORDER BY created_at ASC
     LIMIT 1`
  );
  return rows[0] || null;
}

export async function saveArtifactProcessingResult(
  id: string,
  params: {
    cleanText: string;
    summary: string;
    excerpt: string;
    tags: string[];
    language: string;
    embedding: number[];
    embeddingModel: string;
  }
): Promise<void> {
  const vectorStr = `[${params.embedding.join(",")}]`;
  await pool.query(
    `UPDATE public_artifact
     SET clean_text = $2,
         summary = $3,
         excerpt = $4,
         tags = $5,
         language = $6,
         embedding = $7::vector,
         embedding_model = $8,
         processing_status = 'processed',
         updated_at = now()
     WHERE id = $1`,
    [
      id,
      params.cleanText,
      params.summary,
      params.excerpt,
      params.tags,
      params.language,
      vectorStr,
      params.embeddingModel,
    ]
  );
}

export async function insertChunks(
  artifactId: string,
  chunks: {
    chunkIndex: number;
    chunkText: string;
    chunkTokens: number;
    headingPath: string[];
    startOffset: number;
    endOffset: number;
    embedding: number[];
  }[]
): Promise<void> {
  await pool.query(
    `DELETE FROM public_artifact_chunk WHERE public_artifact_id = $1`,
    [artifactId]
  );

  for (const chunk of chunks) {
    const vectorStr = `[${chunk.embedding.join(",")}]`;
    await pool.query(
      `INSERT INTO public_artifact_chunk
         (public_artifact_id, chunk_index, chunk_text, chunk_tokens,
          heading_path, start_offset, end_offset, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
      [
        artifactId,
        chunk.chunkIndex,
        chunk.chunkText,
        chunk.chunkTokens,
        chunk.headingPath,
        chunk.startOffset,
        chunk.endOffset,
        vectorStr,
      ]
    );
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

export async function insertArtifactEntity(
  artifactId: string,
  entityRefId: string,
  mentionText: string | null,
  salience: number | null
): Promise<void> {
  await pool.query(
    `INSERT INTO public_artifact_entity
       (public_artifact_id, entity_ref_id, mention_text, salience)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (public_artifact_id, entity_ref_id, mention_offset) DO NOTHING`,
    [artifactId, entityRefId, mentionText, salience]
  );
}

export async function clearArtifactEntities(artifactId: string): Promise<void> {
  await pool.query(
    `DELETE FROM public_artifact_entity WHERE public_artifact_id = $1`,
    [artifactId]
  );
}

export async function markArtifactError(id: string): Promise<void> {
  await pool.query(
    `UPDATE public_artifact
     SET processing_status = 'error', updated_at = now()
     WHERE id = $1`,
    [id]
  );
}

export async function findArtifactsSharingEntities(
  artifactId: string,
  minShared: number = 2
): Promise<{ other_artifact_id: string; shared_count: number }[]> {
  const { rows } = await pool.query(
    `SELECT pae2.public_artifact_id AS other_artifact_id,
            COUNT(*) AS shared_count
     FROM public_artifact_entity pae1
     JOIN public_artifact_entity pae2
       ON pae1.entity_ref_id = pae2.entity_ref_id
     WHERE pae1.public_artifact_id = $1
       AND pae2.public_artifact_id != $1
       AND (pae1.salience IS NULL OR pae1.salience >= 0.5)
       AND (pae2.salience IS NULL OR pae2.salience >= 0.5)
     GROUP BY pae2.public_artifact_id
     HAVING COUNT(*) >= $2
     ORDER BY COUNT(*) DESC
     LIMIT 20`,
    [artifactId, minShared]
  );
  return rows;
}

export async function insertLinkEdge(
  sourceType: string,
  sourceId: string,
  targetType: string,
  targetId: string,
  linkType: string,
  confidence: number | null,
  explanation: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO link_edge
       (user_id, source_type, source_id, target_type, target_id, link_type, confidence, explanation)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_type, source_id, target_type, target_id, link_type) DO NOTHING`,
    [sourceType, sourceId, targetType, targetId, linkType, confidence, explanation]
  );
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
  }[]
> {
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  const conditions: string[] = ["pa.processing_status = 'processed'"];
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
            pa.title, pa.type, pa.published_at, pa.tags, pa.summary
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
  }[]
> {
  const tsQuery = query
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter((w) => w.length > 0)
    .join(" & ");

  if (!tsQuery) return [];

  const conditions: string[] = ["pa.processing_status = 'processed'"];
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
            pa.title, pa.type, pa.published_at, pa.tags, pa.summary
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
    entity_count: number;
  }[]
> {
  if (entityIds.length === 0) return [];

  const { rows } = await pool.query(
    `SELECT pa.id AS artifact_id, pa.title, pa.type,
            pa.published_at, pa.tags, pa.summary,
            COUNT(DISTINCT pae.entity_ref_id) AS entity_count
     FROM public_artifact_entity pae
     JOIN public_artifact pa ON pa.id = pae.public_artifact_id
     WHERE pae.entity_ref_id = ANY($1)
       AND pa.processing_status = 'processed'
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

export async function resetErroredArtifacts(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE public_artifact
     SET processing_status = 'pending'
     WHERE processing_status = 'error'`
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

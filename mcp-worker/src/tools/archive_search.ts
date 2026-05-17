import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { EMBEDDING_DIMENSIONS, vectorLiteral } from '../embeddings';

const inputSchema = z.object({
  query_embedding: z
    .array(z.number())
    .length(EMBEDDING_DIMENSIONS, {
      message: `query_embedding must have exactly ${EMBEDDING_DIMENSIONS} dimensions (text-embedding-3-small)`,
    }),
  top_k: z.number().int().min(1).max(50).optional(),
});

export async function archiveSearchHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const topK = parsed.data.top_k ?? 10;
  const hits = await runArchiveVectorSearch(env, ctx, parsed.data.query_embedding, topK);
  return {
    content: [{ type: 'text', text: JSON.stringify({ count: hits.length, hits }, null, 2) }],
  };
}

export type ArchiveHit = {
  id: string;
  title: string;
  url: string | null;
  published_at: string | null;
  similarity: number;
  type: 'essay' | 'episode';
};

export async function runArchiveVectorSearch(
  env: Env,
  ctx: ExecutionContext,
  vector: number[],
  topK: number,
): Promise<ArchiveHit[]> {
  const v = vectorLiteral(vector);
  const sql = getDb(env);
  try {
    const rows = await sql<
      Array<{
        id: string;
        title: string;
        canonical_url: string | null;
        published_at: Date | string | null;
        source_system: string;
        similarity: number;
      }>
    >`
      SELECT id, title, canonical_url, published_at, source_system,
             1 - (embedding <=> ${v}::vector) AS similarity
      FROM public_artifact
      WHERE processing_status = 'processed'
        AND status = 'published'
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${v}::vector
      LIMIT ${topK}
    `;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.canonical_url,
      published_at:
        r.published_at instanceof Date
          ? r.published_at.toISOString()
          : r.published_at
            ? String(r.published_at)
            : null,
      similarity: roundTo(Number(r.similarity), 4),
      type: mapSourceSystem(r.source_system),
    }));
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function mapSourceSystem(source: string): 'essay' | 'episode' {
  return source === 'youtube' ? 'episode' : 'essay';
}

function roundTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

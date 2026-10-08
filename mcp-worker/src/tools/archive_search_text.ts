import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { embed, vectorLiteral } from '../embeddings';

const inputSchema = z.object({
  query: z.string().min(1).max(8000),
  top_k: z.number().int().min(1).max(50).optional(),
});

export async function archiveSearchTextHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const topK = parsed.data.top_k ?? 10;

  let vector: number[];
  try {
    vector = await embed(parsed.data.query, env.OPENAI_API_KEY);
  } catch (e) {
    return errorResult(`Embedding failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const hits = await runArchiveVectorSearch(env, ctx, vector, topK);
    return {
      content: [{ type: 'text', text: JSON.stringify({ count: hits.length, hits }, null, 2) }],
    };
  } catch (e) {
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type ArchiveHit = {
  id: string;
  title: string;
  url: string | null;
  published_at: string | null;
  similarity: number;
  type: 'essay' | 'episode';
  // 'review' or 'unmatched': a piece the archive consolidation has not
  // confirmed yet; null otherwise.
  flag: string | null;
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
        flag: string | null;
        similarity: number;
      }>
    >`
      SELECT id, title, canonical_url, published_at, source_system, flag,
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
      flag: r.flag ?? null,
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

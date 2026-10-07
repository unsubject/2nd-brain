import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { snippet } from '../ideas/text';
import { DEFAULT_MIN_SIMILARITY, embedQuery, findIdeaHits } from '../ideas/search';
import { dbError, errorResult, ideaKindSchema, ideaStatusSchema, ok, toIso } from './idea_shared';

// Hybrid search (src/ideas/search.ts, shared with explore_topic): vector
// similarity over embedded ideas + ILIKE over all text fields.

const inputSchema = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(50).optional(),
    statuses: z.array(ideaStatusSchema).min(1).optional(),
    kind: ideaKindSchema.optional(),
    min_similarity: z.number().min(0).max(1).optional(),
  })
  .strict();

const ALL_STATUSES = ['parked', 'exploring', 'used', 'composted'];

export async function searchIdeasHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const limit = args.limit ?? 10;
  const statuses = args.statuses ?? ALL_STATUSES;
  const minSimilarity = args.min_similarity ?? DEFAULT_MIN_SIMILARITY;
  const { vector, warnings } = await embedQuery(args.query, env);

  const sql = getDb(env);
  try {
    const found = await findIdeaHits(sql, env.BRAIN_USER_ID, {
      query: args.query,
      vector,
      statuses,
      kind: args.kind,
      limit,
      minSimilarity,
    });

    const unembedded = await sql<Array<{ n: string | number }>>`
      SELECT count(*) AS n, now() AS as_of FROM idea
       WHERE user_id = ${env.BRAIN_USER_ID} AND embedding IS NULL
    `;

    const hits = found.map((h) => ({
      id: h.id,
      title: h.title,
      status: h.status,
      kind: h.kind,
      captured_at: toIso(h.captured_at),
      similarity: h.similarity,
      match: h.match,
      snippet: snippet(h.snippet_src, 240),
    }));

    return ok({
      count: hits.length,
      unembedded_count: Number(unembedded[0]?.n ?? 0),
      ...(warnings.length > 0 ? { warnings } : {}),
      hits,
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

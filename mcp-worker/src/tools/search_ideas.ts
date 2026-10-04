import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { embed, vectorLiteral } from '../embeddings';
import { escapeLike, searchTerms, snippet } from '../ideas/text';
import {
  dbError,
  errorResult,
  ideaKindSchema,
  ideaStatusSchema,
  ok,
  textArray,
  toIso,
} from './idea_shared';

// Hybrid search: vector similarity (embedded ideas) + ILIKE over all
// text fields. ILIKE covers Chinese queries (the english tsvector doesn't)
// and ideas filed seconds ago that the sweeper hasn't embedded yet.

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

type HitRow = {
  id: string;
  title: string;
  status: string;
  kind: string;
  captured_at: Date;
  snippet_src: string | null;
};

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
  // Semantic hits below this are noise (see the similarity guide in the protocol).
  const minSimilarity = args.min_similarity ?? 0.25;
  const terms = searchTerms(args.query);
  const warnings: string[] = [];

  let vector: number[] | null = null;
  try {
    vector = await embed(args.query, env.OPENAI_API_KEY);
  } catch (e) {
    warnings.push(`Semantic search unavailable (${e instanceof Error ? e.message : String(e)}); text matches only.`);
  }

  const sql = getDb(env);
  try {
    const common = sql`
      i.user_id = ${env.BRAIN_USER_ID}
      AND i.status = ANY(${textArray(sql, statuses)})
      AND ${args.kind ? sql`i.kind = ${args.kind}` : sql`TRUE`}
    `;
    const snippetCol = sql`left(COALESCE(i.framing, i.why_interesting, i.thoughts, i.source_excerpt), 600) AS snippet_src`;

    const semantic = vector
      ? await sql<Array<HitRow & { similarity: number }>>`
          SELECT i.id, i.title, i.status, i.kind, i.captured_at, ${snippetCol},
                 1 - (i.embedding <=> ${vectorLiteral(vector)}::vector) AS similarity,
                 now() AS as_of
            FROM idea i
           WHERE ${common} AND i.embedding IS NOT NULL
             AND 1 - (i.embedding <=> ${vectorLiteral(vector)}::vector) >= ${minSimilarity}
           ORDER BY i.embedding <=> ${vectorLiteral(vector)}::vector
           LIMIT ${limit * 2}
        `
      : [];

    const termConds = terms.reduce(
      (acc, t) => sql`${acc} AND x.hay ILIKE ${`%${escapeLike(t)}%`}`,
      sql`TRUE`,
    );
    const textual =
      terms.length > 0
        ? await sql<Array<HitRow>>`
            SELECT x.id, x.title, x.status, x.kind, x.captured_at, x.snippet_src, now() AS as_of
              FROM (
                SELECT i.id, i.title, i.status, i.kind, i.captured_at, ${snippetCol},
                       concat_ws(' ', i.title, i.encountered_where, i.source_title, i.source_excerpt,
                                 i.why_interesting, i.thoughts, i.framing,
                                 array_to_string(i.tags, ' '),
                                 (SELECT string_agg(n->>'text', ' ') FROM jsonb_array_elements(i.notes) n)
                       ) AS hay
                  FROM idea i
                 WHERE ${common}
              ) x
             WHERE ${termConds}
             ORDER BY x.captured_at DESC
             LIMIT ${limit * 2}
          `
        : [];

    const unembedded = await sql<Array<{ n: string | number }>>`
      SELECT count(*) AS n, now() AS as_of FROM idea
       WHERE user_id = ${env.BRAIN_USER_ID} AND embedding IS NULL
    `;

    type Hit = HitRow & { similarity: number | null; match: string[]; score: number };
    const byId = new Map<string, Hit>();
    for (const r of semantic) {
      const sim = Math.round(Number(r.similarity) * 10000) / 10000;
      byId.set(r.id, { ...r, similarity: sim, match: ['semantic'], score: sim });
    }
    const lowerTerms = terms.map((t) => t.toLowerCase());
    for (const r of textual) {
      const titleMatch = lowerTerms.every((t) => r.title.toLowerCase().includes(t));
      const textScore = titleMatch ? 0.8 : 0.6;
      const prev = byId.get(r.id);
      if (prev) {
        prev.match.push('text');
        prev.score = Math.max(prev.score, textScore);
      } else {
        byId.set(r.id, { ...r, similarity: null, match: ['text'], score: textScore });
      }
    }

    const hits = [...byId.values()]
      .sort((a, b) => b.score - a.score || toIso(b.captured_at).localeCompare(toIso(a.captured_at)))
      .slice(0, limit)
      .map((h) => ({
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

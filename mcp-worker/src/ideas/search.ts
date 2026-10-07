// Hybrid idea search shared by search_ideas and explore_topic: vector
// similarity over embedded ideas plus ILIKE over all text fields. ILIKE
// covers Chinese queries (the english tsvector doesn't) and ideas filed
// seconds ago that the sweeper hasn't embedded yet.
//
// Every read here carries `now() AS as_of` like the idea tools (Hyperdrive
// cache bypass; test/ideas.fixes.test.ts scans this file too).

import type { Env } from '../env';
import { embed, vectorLiteral } from '../embeddings';
import { escapeLike, searchTerms } from './text';
import { textArray, toIso, type Q } from '../tools/idea_shared';

// Semantic hits below this are noise (see the similarity guide in the protocol).
export const DEFAULT_MIN_SIMILARITY = 0.25;

export type IdeaHit = {
  id: string;
  title: string;
  status: string;
  kind: string;
  captured_at: Date;
  snippet_src: string | null;
  similarity: number | null;
  match: string[];
  score: number;
};

// Embed the query; on failure the caller searches by text only and passes
// the warning on.
export async function embedQuery(query: string, env: Env): Promise<{ vector: number[] | null; warnings: string[] }> {
  try {
    return { vector: await embed(query, env.OPENAI_API_KEY), warnings: [] };
  } catch (e) {
    return {
      vector: null,
      warnings: [`Semantic search unavailable (${e instanceof Error ? e.message : String(e)}); text matches only.`],
    };
  }
}

type HitRow = Omit<IdeaHit, 'similarity' | 'match' | 'score'>;

// Ranked hits: semantic score is the similarity; a text match scores 0.8
// when every term is in the title, else 0.6; an idea found both ways keeps
// its best score. Ties go to the newest capture.
export async function findIdeaHits(
  sql: Q,
  userId: string,
  opts: {
    query: string;
    vector: number[] | null;
    statuses: readonly string[];
    kind?: string;
    limit: number;
    minSimilarity: number;
  },
): Promise<IdeaHit[]> {
  const terms = searchTerms(opts.query);
  const common = sql`
    i.user_id = ${userId}
    AND i.status = ANY(${textArray(sql, opts.statuses)})
    AND ${opts.kind ? sql`i.kind = ${opts.kind}` : sql`TRUE`}
  `;
  const snippetCol = sql`left(COALESCE(i.framing, i.why_interesting, i.thoughts, i.source_excerpt), 600) AS snippet_src`;

  const semantic = opts.vector
    ? await sql<Array<HitRow & { similarity: number }>>`
        SELECT i.id, i.title, i.status, i.kind, i.captured_at, ${snippetCol},
               1 - (i.embedding <=> ${vectorLiteral(opts.vector)}::vector) AS similarity,
               now() AS as_of
          FROM idea i
         WHERE ${common} AND i.embedding IS NOT NULL
           AND 1 - (i.embedding <=> ${vectorLiteral(opts.vector)}::vector) >= ${opts.minSimilarity}
         ORDER BY i.embedding <=> ${vectorLiteral(opts.vector)}::vector
         LIMIT ${opts.limit * 2}
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
           LIMIT ${opts.limit * 2}
        `
      : [];

  const byId = new Map<string, IdeaHit>();
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

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || toIso(b.captured_at).localeCompare(toIso(a.captured_at)))
    .slice(0, opts.limit);
}

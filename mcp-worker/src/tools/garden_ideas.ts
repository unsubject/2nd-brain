import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { snippet } from '../ideas/text';
import { dbError, errorResult, ideaStatusSchema, ok, parseJsonb, textArray, toIso, toIsoOrNull } from './idea_shared';

// Gardening step 1 (docs/idea-parking-lot-protocol.md §2): pull CANDIDATE
// pairs for the agent to judge. Read-only — candidates are not links.
// Pairs already proposed / accepted / rejected / retracted are excluded;
// withdrawn ones may resurface.

const inputSchema = z
  .object({
    mode: z.enum(['near', 'band', 'orphans', 'outputs']),
    focus_idea_id: z.string().uuid().optional(),
    min_similarity: z.number().min(-1).max(1).optional(),
    max_similarity: z.number().min(-1).max(1).optional(),
    limit: z.number().int().min(1).max(30).optional(),
    per_idea_cap: z.number().int().min(1).max(10).optional(),
    cross_domain: z.boolean().optional(),
    include_statuses: z.array(ideaStatusSchema).min(1).optional(),
  })
  .strict();

const DEFAULTS = {
  near: { min: 0.5, max: 1 },
  band: { min: 0.3, max: 0.45 },
  orphans: { min: 0.3, max: 1 },
  outputs: { min: 0.45, max: 1 },
} as const;

type IdeaBrief = { id: string; title: string; kind: string; status: string; snippet: string | null; tags: string[] };

export async function gardenIdeasHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const minSim = args.min_similarity ?? DEFAULTS[args.mode].min;
  const maxSim = args.max_similarity ?? DEFAULTS[args.mode].max;
  if (minSim > maxSim) return errorResult('Invalid arguments: min_similarity > max_similarity');
  const limit = args.limit ?? (args.mode === 'orphans' ? 8 : 12);
  const perIdeaCap = args.per_idea_cap ?? 2;
  const statuses = args.include_statuses ?? ['parked', 'exploring', 'used'];

  const sql = getDb(env);
  try {
    const stats = await sql<Array<{ embedded: string | number; unembedded: string | number }>>`
      SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
             count(*) FILTER (WHERE embedding IS NULL) AS unembedded,
             now() AS as_of
        FROM idea WHERE user_id = ${env.BRAIN_USER_ID}
    `;
    const statsOut = { embedded: Number(stats[0].embedded), unembedded: Number(stats[0].unembedded) };

    if (args.focus_idea_id) {
      const f = await sql`
        SELECT 1, now() AS as_of FROM idea WHERE id = ${args.focus_idea_id} AND user_id = ${env.BRAIN_USER_ID}
      `;
      if (f.length === 0) return errorResult(`Idea not found: ${args.focus_idea_id}`);
    }

    const toBrief = (r: Record<string, unknown>, p: 'a' | 'b'): IdeaBrief => ({
      id: r[`${p}_id`] as string,
      title: r[`${p}_title`] as string,
      kind: r[`${p}_kind`] as string,
      status: r[`${p}_status`] as string,
      snippet: snippet(r[`${p}_snip`] as string | null, 400),
      tags: parseJsonb<string[]>(r[`${p}_tags`], []),
    });
    const overlap = (a: string[], b: string[]) => {
      const s = new Set(a.map((t) => t.toLowerCase()));
      return b.some((t) => s.has(t.toLowerCase()));
    };

    if (args.mode === 'outputs') {
      // Ideas without an accepted `became`, each with its nearest own
      // published outputs (public_artifact rows are user 'default').
      const rows = await sql<Array<Record<string, unknown>>>`
        SELECT i.id AS a_id, i.title AS a_title, i.kind AS a_kind, i.status AS a_status,
               left(COALESCE(i.framing, i.why_interesting, i.thoughts, i.source_excerpt), 600) AS a_snip,
               to_jsonb(i.tags) AS a_tags, i.captured_at AS a_captured_at,
               art.id AS art_id, art.title AS art_title, art.canonical_url AS art_url,
               art.published_at AS art_published_at, art.type AS art_type, art.similarity,
               now() AS as_of
          FROM (
            SELECT * FROM idea x
             WHERE x.user_id = ${env.BRAIN_USER_ID}
               AND x.embedding IS NOT NULL
               AND x.status = ANY(${textArray(sql, statuses)})
               AND ${args.focus_idea_id ? sql`x.id = ${args.focus_idea_id}` : sql`TRUE`}
               AND NOT EXISTS (SELECT 1 FROM idea_link l
                                WHERE l.source_idea_id = x.id AND l.status = 'accepted'
                                  AND l.link_type = 'became')
             ORDER BY x.captured_at DESC
             LIMIT 40
          ) i
          CROSS JOIN LATERAL (
            SELECT a.id, a.title, a.canonical_url, a.published_at, a.type,
                   1 - (a.embedding <=> i.embedding) AS similarity
              FROM public_artifact a
             WHERE a.processing_status = 'processed'
               AND a.status = 'published'
               AND a.embedding IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM idea_link l
                                WHERE l.source_idea_id = i.id AND l.target_artifact_id = a.id
                                  AND l.status IN ('proposed', 'accepted', 'rejected', 'retracted'))
             ORDER BY a.embedding <=> i.embedding
             LIMIT 3
          ) art
         WHERE art.similarity >= ${minSim} AND art.similarity <= ${maxSim}
         ORDER BY art.similarity DESC
      `;
      const perIdea = new Map<string, number>();
      const candidates = [];
      for (const r of rows) {
        const n = perIdea.get(r.a_id as string) ?? 0;
        if (n >= perIdeaCap) continue;
        perIdea.set(r.a_id as string, n + 1);
        const published = r.art_published_at ? new Date(r.art_published_at as string | Date) : null;
        const captured = new Date(r.a_captured_at as string | Date);
        candidates.push({
          a: toBrief(r, 'a'),
          artifact: {
            id: r.art_id,
            title: r.art_title,
            url: r.art_url,
            published_at: toIsoOrNull(r.art_published_at as Date | null),
            type: r.art_type,
          },
          similarity: round4(r.similarity),
          hint: published && published >= captured ? 'became?' : 'revisits?',
        });
        if (candidates.length >= limit) break;
      }
      return ok({ as_of: toIso(rows[0]?.as_of as Date ?? new Date()), mode: args.mode, stats: statsOut, ...footer(), candidates });
    }

    if (args.mode === 'orphans') {
      const orphans = await sql<Array<Record<string, unknown>>>`
        SELECT i.id AS a_id, i.title AS a_title, i.kind AS a_kind, i.status AS a_status,
               left(COALESCE(i.framing, i.why_interesting, i.thoughts, i.source_excerpt), 600) AS a_snip,
               to_jsonb(i.tags) AS a_tags, (i.embedding IS NOT NULL) AS embedded,
               now() AS as_of
          FROM idea i
         WHERE i.user_id = ${env.BRAIN_USER_ID}
           AND i.status = ANY(${textArray(sql, statuses)})
           AND ${args.focus_idea_id ? sql`i.id = ${args.focus_idea_id}` : sql`TRUE`}
           AND NOT EXISTS (SELECT 1 FROM idea_link l
                            WHERE l.status = 'accepted'
                              AND (l.source_idea_id = i.id OR l.target_idea_id = i.id))
         ORDER BY i.captured_at ASC
         LIMIT ${limit}
      `;
      const out = [];
      for (const o of orphans) {
        const neighbours = o.embedded
          ? await sql<Array<Record<string, unknown>>>`
              SELECT b.id AS b_id, b.title AS b_title, b.kind AS b_kind, b.status AS b_status,
                     left(COALESCE(b.framing, b.why_interesting, b.thoughts, b.source_excerpt), 600) AS b_snip,
                     to_jsonb(b.tags) AS b_tags,
                     1 - (b.embedding <=> a.embedding) AS similarity,
                     now() AS as_of
                FROM idea a
                JOIN idea b ON b.user_id = a.user_id AND b.id <> a.id AND b.embedding IS NOT NULL
               WHERE a.id = ${o.a_id as string}
                 AND b.status = ANY(${textArray(sql, statuses)})
                 AND 1 - (b.embedding <=> a.embedding) BETWEEN ${minSim} AND ${maxSim}
                 AND NOT EXISTS (
                   SELECT 1 FROM idea_link l
                    WHERE LEAST(l.source_idea_id, l.target_idea_id) = LEAST(a.id, b.id)
                      AND GREATEST(l.source_idea_id, l.target_idea_id) = GREATEST(a.id, b.id)
                      AND l.status IN ('proposed', 'accepted', 'rejected', 'retracted'))
               ORDER BY b.embedding <=> a.embedding
               LIMIT 3
            `
          : [];
        out.push({
          idea: toBrief(o, 'a'),
          embedded: o.embedded,
          neighbours: neighbours.map((n) => ({ b: toBrief(n, 'b'), similarity: round4(n.similarity) })),
        });
      }
      return ok({ as_of: toIso(orphans[0]?.as_of as Date ?? new Date()), mode: args.mode, stats: statsOut, ...footer(), orphans: out });
    }

    // near / band: idea pairs within the similarity range.
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT a.id AS a_id, a.title AS a_title, a.kind AS a_kind, a.status AS a_status,
             left(COALESCE(a.framing, a.why_interesting, a.thoughts, a.source_excerpt), 600) AS a_snip,
             to_jsonb(a.tags) AS a_tags,
             b.id AS b_id, b.title AS b_title, b.kind AS b_kind, b.status AS b_status,
             left(COALESCE(b.framing, b.why_interesting, b.thoughts, b.source_excerpt), 600) AS b_snip,
             to_jsonb(b.tags) AS b_tags,
             1 - (a.embedding <=> b.embedding) AS similarity,
             now() AS as_of
        FROM idea a
        JOIN idea b ON b.user_id = a.user_id AND a.id < b.id
       WHERE a.user_id = ${env.BRAIN_USER_ID}
         AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
         AND a.status = ANY(${textArray(sql, statuses)})
         AND b.status = ANY(${textArray(sql, statuses)})
         AND ${args.focus_idea_id ? sql`(a.id = ${args.focus_idea_id} OR b.id = ${args.focus_idea_id})` : sql`TRUE`}
         AND 1 - (a.embedding <=> b.embedding) BETWEEN ${minSim} AND ${maxSim}
         AND NOT EXISTS (
           SELECT 1 FROM idea_link l
            WHERE LEAST(l.source_idea_id, l.target_idea_id) = a.id
              AND GREATEST(l.source_idea_id, l.target_idea_id) = b.id
              AND l.status IN ('proposed', 'accepted', 'rejected', 'retracted'))
       ORDER BY similarity DESC, a.id, b.id
       LIMIT ${limit * 5}
    `;
    const perIdea = new Map<string, number>();
    const candidates = [];
    for (const r of rows) {
      const a = toBrief(r, 'a');
      const b = toBrief(r, 'b');
      if (args.cross_domain && overlap(a.tags, b.tags)) continue;
      const na = perIdea.get(a.id) ?? 0;
      const nb = perIdea.get(b.id) ?? 0;
      if (na >= perIdeaCap || nb >= perIdeaCap) continue;
      perIdea.set(a.id, na + 1);
      perIdea.set(b.id, nb + 1);
      const sim = round4(r.similarity);
      candidates.push({ a, b, similarity: sim, hint: sim >= 0.9 ? 'possible_duplicate' : null });
      if (candidates.length >= limit) break;
    }
    return ok({
      as_of: toIso((rows[0]?.as_of as Date) ?? new Date()),
      mode: args.mode,
      range: { min_similarity: minSim, max_similarity: maxSim },
      stats: statsOut,
      ...footer(),
      candidates,
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function round4(v: unknown): number {
  return Math.round(Number(v) * 10000) / 10000;
}

function footer() {
  return {
    reminder:
      'Candidates are NOT links. Judge each pair, propose only defensible typed links with propose_idea_links, and let the user accept or reject them (decide_idea_links). Proposing nothing is fine.',
  };
}

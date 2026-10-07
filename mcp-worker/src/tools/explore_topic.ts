import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { DEFAULT_MIN_SIMILARITY, embedQuery, findIdeaHits } from '../ideas/search';
import { buildExplore, type ExploreLink } from '../ideas/explore';
import { dbError, errorResult, isInInbox, ok, textArray, toIso, uuidArrayLiteral } from './idea_shared';

// "What do I have on X?" (brief §4, retrieval): the ideas the hybrid search
// finds for a topic, plus their linked clusters with glosses, grouped by
// connected component rather than returned as a flat list. Read-only.

const inputSchema = z
  .object({
    query: z.string().min(1).max(500),
    depth: z.number().int().min(1).max(2).optional(),
    max_ideas: z.number().int().min(1).max(100).optional(),
    include_pending: z.boolean().optional(),
  })
  .strict();

// Composted ideas are set aside; search_ideas still finds them.
const LIVE_STATUSES = ['parked', 'exploring', 'used'];
const MAX_SEEDS = 10;

export async function exploreTopicHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const depth = args.depth ?? 1;
  const maxIdeas = args.max_ideas ?? 40;
  const linkStatuses = args.include_pending ? ['accepted', 'proposed'] : ['accepted'];
  const { vector, warnings } = await embedQuery(args.query, env);

  const sql = getDb(env);
  try {
    const hits = await findIdeaHits(sql, env.BRAIN_USER_ID, {
      query: args.query,
      vector,
      statuses: LIVE_STATUSES,
      limit: Math.min(MAX_SEEDS, maxIdeas),
      minSimilarity: DEFAULT_MIN_SIMILARITY,
    });

    // Expand hop by hop over links between live ideas (outputs are leaves).
    // One more pass over the last hop picks up the links among the ideas
    // already reached and their outputs.
    const reached = new Set(hits.map((h) => h.id));
    const links = new Map<string, ExploreLink>();
    let frontier = [...reached];
    for (let d = 0; d <= depth && frontier.length > 0; d++) {
      const ids = uuidArrayLiteral(frontier);
      const rows = await sql<Array<ExploreLink>>`
        SELECT l.id, l.source_idea_id, l.target_idea_id, l.target_artifact_id, l.link_type, l.status, l.rationale,
               now() AS as_of
          FROM idea_link l
          JOIN idea s ON s.id = l.source_idea_id
          LEFT JOIN idea t ON t.id = l.target_idea_id
         WHERE l.user_id = ${env.BRAIN_USER_ID}
           AND l.status = ANY(${textArray(sql, linkStatuses)})
           AND (l.source_idea_id = ANY(${ids}::uuid[]) OR l.target_idea_id = ANY(${ids}::uuid[]))
           AND s.status = ANY(${textArray(sql, LIVE_STATUSES)})
           AND (l.target_idea_id IS NULL OR t.status = ANY(${textArray(sql, LIVE_STATUSES)}))
      `;
      const next: string[] = [];
      for (const r of rows) {
        links.set(r.id, { ...r });
        if (d === depth) continue;
        for (const id of [r.source_idea_id, r.target_idea_id]) {
          if (id && !reached.has(id)) {
            reached.add(id);
            next.push(id);
          }
        }
      }
      frontier = next;
    }

    const ideaRows =
      reached.size > 0
        ? await sql<
            Array<{ id: string; title: string; status: string; kind: string; reviewed_at: Date | null; as_of: Date }>
          >`
            SELECT i.id, i.title, i.status, i.kind, i.reviewed_at, now() AS as_of
              FROM idea i
             WHERE i.user_id = ${env.BRAIN_USER_ID}
               AND i.id = ANY(${uuidArrayLiteral([...reached])}::uuid[])
          `
        : [];
    const asOf = ideaRows[0]?.as_of ?? (await sql<Array<{ as_of: Date }>>`SELECT now() AS as_of`)[0].as_of;

    // Published outputs only, as in the html map and garden_ideas. Not
    // scoped to BRAIN_USER_ID: the archive sync writes every public_artifact
    // row as user 'default' (see garden_ideas).
    const artifactIds = [...new Set([...links.values()].map((l) => l.target_artifact_id).filter((x): x is string => !!x))];
    const artifactRows =
      artifactIds.length > 0
        ? await sql<Array<{ id: string; title: string; url: string | null }>>`
            SELECT id, title, canonical_url AS url, now() AS as_of
              FROM public_artifact
             WHERE id = ANY(${uuidArrayLiteral(artifactIds)}::uuid[])
               AND status = 'published'
          `
        : [];

    const result = buildExplore(
      hits.map((h) => ({ id: h.id, title: h.title, similarity: h.similarity, match: h.match })),
      ideaRows.map((r) => ({ id: r.id, title: r.title, status: r.status, kind: r.kind, inbox: isInInbox(r) })),
      [...links.values()],
      artifactRows.map((a) => ({ id: a.id, title: a.title, url: a.url })),
      { depth, max_ideas: maxIdeas },
    );

    return ok({ query: args.query, as_of: toIso(asOf), ...result, warnings });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

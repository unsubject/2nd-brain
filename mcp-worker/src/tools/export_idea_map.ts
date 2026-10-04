import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import {
  buildIdeaMap,
  MERMAID_MAX_NODES,
  toGraphML,
  toMermaid,
  type MapArtifact,
  type MapIdea,
  type MapLink,
} from '../ideas/graph';
import type { LinkType } from '../ideas/linkTypes';
import {
  dbError,
  errorResult,
  ideaStatusSchema,
  isoDateTimeSchema,
  ok,
  parseJsonb,
  textArray,
  toIso,
  toIsoOrNull,
  uuidArrayLiteral,
  uuidSchema,
} from './idea_shared';

// Read-only graph export for any agent's visualisation tool
// (docs/idea-parking-lot-protocol.md §3). JSON (idea-map/v1) is canonical;
// GraphML suits Gephi / yEd / Cytoscape; Mermaid suits inline chat.

const inputSchema = z
  .object({
    format: z.enum(['json', 'graphml', 'mermaid']).optional(),
    focus_idea_id: uuidSchema.optional(),
    depth: z.number().int().min(1).max(4).optional(),
    statuses: z.array(ideaStatusSchema).min(1).optional(),
    since: isoDateTimeSchema.optional(),
    include_outputs: z.boolean().optional(),
    include_pending: z.boolean().optional(),
    include_isolated: z.boolean().optional(),
    max_nodes: z.number().int().min(10).max(1000).optional(),
  })
  .strict();

export async function exportIdeaMapHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const format = args.format ?? 'json';
  const statuses = args.statuses ?? ['parked', 'exploring', 'used'];
  const includeOutputs = args.include_outputs ?? true;
  const includePending = args.include_pending ?? false;
  const requestedMax = args.max_nodes ?? 300;
  const maxNodes = format === 'mermaid' ? Math.min(requestedMax, MERMAID_MAX_NODES) : requestedMax;

  const sql = getDb(env);
  try {
    const ideaRows = await sql<
      Array<{
        id: string;
        title: string;
        kind: 'unit' | 'synthesis';
        intent: string | null;
        status: string;
        captured_at: Date;
        tags: unknown;
        as_of: Date;
      }>
    >`
      SELECT id, title, kind, intent, status, captured_at, to_jsonb(tags) AS tags, now() AS as_of
        FROM idea
       WHERE user_id = ${env.BRAIN_USER_ID}
         AND status = ANY(${textArray(sql, statuses)})
         AND ${args.since ? sql`captured_at >= ${args.since}::timestamptz` : sql`TRUE`}
    `;
    if (args.focus_idea_id && !ideaRows.some((r) => r.id === args.focus_idea_id)) {
      return errorResult(`Focus idea not found (or excluded by the status/since filters): ${args.focus_idea_id}`);
    }

    const linkRows = await sql<
      Array<{
        id: string;
        source_idea_id: string;
        target_idea_id: string | null;
        target_artifact_id: string | null;
        link_type: LinkType;
        status: 'accepted' | 'proposed';
        rationale: string;
      }>
    >`
      SELECT id, source_idea_id, target_idea_id, target_artifact_id, link_type, status, rationale,
             now() AS as_of
        FROM idea_link
       WHERE user_id = ${env.BRAIN_USER_ID}
         AND status IN ('accepted', 'proposed')
    `;

    const artifactIds = [...new Set(linkRows.map((l) => l.target_artifact_id).filter((x): x is string => !!x))];
    const artifactRows =
      artifactIds.length > 0
        ? await sql<
            Array<{ id: string; title: string; url: string | null; published_at: Date | null; type: string | null }>
          >`
            SELECT id, title, canonical_url AS url, published_at, type, now() AS as_of
              FROM public_artifact
             WHERE id = ANY(${uuidArrayLiteral(artifactIds)}::uuid[])
          `
        : [];

    const ideas: MapIdea[] = ideaRows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      intent: r.intent,
      status: r.status,
      captured_at: toIso(r.captured_at),
      tags: parseJsonb<string[]>(r.tags, []),
    }));
    const artifacts: MapArtifact[] = artifactRows.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      published_at: toIsoOrNull(a.published_at),
      type: a.type,
    }));
    const links: MapLink[] = linkRows.map((l) => ({ ...l }));

    const generatedAt = ideaRows[0]?.as_of ? toIso(ideaRows[0].as_of) : new Date().toISOString();
    const map = buildIdeaMap(ideas, links, artifacts, {
      focus_idea_id: args.focus_idea_id,
      depth: args.depth ?? 2,
      include_outputs: includeOutputs,
      include_pending: includePending,
      include_isolated: args.include_isolated ?? true,
      max_nodes: maxNodes,
      generated_at: generatedAt,
      filters: {
        format,
        focus_idea_id: args.focus_idea_id ?? null,
        depth: args.focus_idea_id ? (args.depth ?? 2) : null,
        statuses,
        since: args.since ?? null,
        include_outputs: includeOutputs,
        include_pending: includePending,
        include_isolated: args.include_isolated ?? true,
        max_nodes: maxNodes,
      },
    });

    if (format === 'json') return ok(map);

    const meta = {
      format: format === 'graphml' ? 'graphml' : 'mermaid',
      generated_at: map.generated_at,
      stats: map.stats,
      truncated: map.truncated,
      omitted_count: map.omitted_count,
      ...(format === 'mermaid' && requestedMax > MERMAID_MAX_NODES
        ? { note: `Mermaid output is capped at ${MERMAID_MAX_NODES} nodes; use json or graphml for larger maps.` }
        : {}),
      legend: map.legend,
    };
    const body = format === 'graphml' ? toGraphML(map) : toMermaid(map);
    return {
      content: [
        { type: 'text', text: JSON.stringify(meta, null, 2) },
        { type: 'text', text: body },
      ],
    };
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

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
import { htmlFilename, toHtml } from '../ideas/mapHtml';
import type { LinkType } from '../ideas/linkTypes';
import {
  dbError,
  errorResult,
  ideaStatusSchema,
  isInInbox,
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
// GraphML suits Gephi / yEd / Cytoscape; Mermaid suits inline chat; HTML
// is a self-contained interactive page to hand over as a file (D5).

const inputSchema = z
  .object({
    format: z.enum(['json', 'graphml', 'mermaid', 'html']).optional(),
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

// The html page is about 27 KB of script and style plus ~330 bytes per
// idea, and the assistant has to save it unchanged. Clients cut tool
// results off (Claude Code at 25k tokens by default), so html defaults to
// fewer nodes, and the meta warns past the budget.
const HTML_DEFAULT_MAX_NODES = 150;
const HTML_BYTE_BUDGET = 75_000;

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
  const requestedMax = args.max_nodes ?? (format === 'html' ? HTML_DEFAULT_MAX_NODES : 300);
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
        created_at: Date;
        reviewed_at: Date | null;
        promoted_at: Date | null;
        as_of: Date;
      }>
    >`
      SELECT id, title, kind, intent, status, captured_at, to_jsonb(tags) AS tags,
             created_at, reviewed_at, promoted_at, now() AS as_of
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
        proposed_at: Date;
        decided_at: Date | null;
      }>
    >`
      SELECT id, source_idea_id, target_idea_id, target_artifact_id, link_type, status, rationale,
             proposed_at, decided_at, now() AS as_of
        FROM idea_link
       WHERE user_id = ${env.BRAIN_USER_ID}
         AND status IN ('accepted', 'proposed')
    `;

    // The html file is portable (easily forwarded), so it carries only
    // published outputs; links to any other output are left out of it (and
    // so out of degree, orphans and cluster names too).
    const artifactIds = [...new Set(linkRows.map((l) => l.target_artifact_id).filter((x): x is string => !!x))];
    const artifactRows =
      artifactIds.length > 0
        ? await sql<
            Array<{ id: string; title: string; url: string | null; published_at: Date | null; type: string | null }>
          >`
            SELECT id, title, canonical_url AS url, published_at, type, now() AS as_of
              FROM public_artifact
             WHERE id = ANY(${uuidArrayLiteral(artifactIds)}::uuid[])
               AND ${format === 'html' ? sql`status = 'published'` : sql`TRUE`}
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
      created_at: toIso(r.created_at),
      inbox: isInInbox(r),
      promoted_at: toIsoOrNull(r.promoted_at),
    }));
    const artifacts: MapArtifact[] = artifactRows.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      published_at: toIsoOrNull(a.published_at),
      type: a.type,
    }));
    const shownArtifacts = new Set(artifactRows.map((a) => a.id));
    const shownLinks =
      format === 'html'
        ? linkRows.filter((l) => !l.target_artifact_id || shownArtifacts.has(l.target_artifact_id))
        : linkRows;
    const links: MapLink[] = shownLinks.map((l) => ({
      id: l.id,
      source_idea_id: l.source_idea_id,
      target_idea_id: l.target_idea_id,
      target_artifact_id: l.target_artifact_id,
      link_type: l.link_type,
      status: l.status,
      rationale: l.rationale,
      proposed_at: toIso(l.proposed_at),
      decided_at: toIsoOrNull(l.decided_at),
    }));

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

    if (format === 'html') {
      const html = toHtml(map);
      const bytes = new TextEncoder().encode(html).length;
      const meta = {
        format: 'html',
        generated_at: map.generated_at,
        stats: map.stats,
        truncated: map.truncated,
        omitted_count: map.omitted_count,
        filename: htmlFilename(map),
        bytes,
        note: 'Save the second text block, unchanged, as `filename` (it should be exactly `bytes` bytes) and hand it over as a file; it opens offline in any browser.',
        ...(bytes > HTML_BYTE_BUDGET
          ? {
              warning: `The page is ${Math.round(bytes / 1000)} KB. Some clients cut tool results off near 25k tokens; if the page arrived cut off or the saved file is not \`bytes\` bytes, call again with a lower max_nodes, focus_idea_id + depth, or since.`,
            }
          : {}),
      };
      return {
        content: [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          { type: 'text', text: html },
        ],
      };
    }

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

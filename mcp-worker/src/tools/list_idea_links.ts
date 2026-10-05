import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { LINK_TYPE_INFO, type LinkType } from '../ideas/linkTypes';
import { snippet } from '../ideas/text';
import {
  dbError,
  errorResult,
  linkStatusSchema,
  linkTypeSchema,
  ok,
  parseJsonb,
  textArray,
  toIso,
  toIsoOrNull,
  uuidSchema,
} from './idea_shared';

const inputSchema = z
  .object({
    statuses: z.array(linkStatusSchema).min(1).optional(),
    idea_id: uuidSchema.optional(),
    link_type: linkTypeSchema.optional(),
    proposed_by: z.enum(['gardening', 'import', 'synthesis']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export async function listIdeaLinksHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const statuses = args.statuses ?? ['proposed'];
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  const sql = getDb(env);
  try {
    const rows = await sql<
      Array<{
        id: string;
        link_type: LinkType;
        status: string;
        rationale: string;
        similarity: number | null;
        proposed_by: string;
        proposed_via: unknown;
        decided_via: unknown;
        proposed_at: Date;
        decided_at: Date | null;
        decision_note: string | null;
        s_id: string;
        s_title: string;
        s_kind: string;
        s_status: string;
        s_snip: string | null;
        t_id: string | null;
        t_title: string | null;
        t_kind: string | null;
        t_status: string | null;
        t_snip: string | null;
        a_id: string | null;
        a_title: string | null;
        a_url: string | null;
        a_published_at: Date | null;
        a_type: string | null;
        total: string | number;
        as_of: Date;
      }>
    >`
      SELECT l.id, l.link_type, l.status, l.rationale, l.similarity, l.proposed_by,
             l.proposed_via, l.proposed_at, l.decided_at, l.decided_via, l.decision_note,
             s.id AS s_id, s.title AS s_title, s.kind AS s_kind, s.status AS s_status,
             left(COALESCE(s.framing, s.why_interesting, s.thoughts, s.source_excerpt), 600) AS s_snip,
             t.id AS t_id, t.title AS t_title, t.kind AS t_kind, t.status AS t_status,
             left(COALESCE(t.framing, t.why_interesting, t.thoughts, t.source_excerpt), 600) AS t_snip,
             a.id AS a_id, a.title AS a_title, a.canonical_url AS a_url,
             a.published_at AS a_published_at, a.type AS a_type,
             count(*) OVER () AS total,
             now() AS as_of
        FROM idea_link l
        JOIN idea s ON s.id = l.source_idea_id
        LEFT JOIN idea t ON t.id = l.target_idea_id
        LEFT JOIN public_artifact a ON a.id = l.target_artifact_id
       WHERE l.user_id = ${env.BRAIN_USER_ID}
         AND l.status = ANY(${textArray(sql, statuses)})
         AND ${args.idea_id ? sql`(l.source_idea_id = ${args.idea_id} OR l.target_idea_id = ${args.idea_id})` : sql`TRUE`}
         AND ${args.link_type ? sql`l.link_type = ${args.link_type}` : sql`TRUE`}
         AND ${args.proposed_by ? sql`l.proposed_by = ${args.proposed_by}` : sql`TRUE`}
       ORDER BY l.proposed_at, l.id
       LIMIT ${limit} OFFSET ${offset}
    `;

    return ok({
      as_of: rows[0]?.as_of ? toIso(rows[0].as_of) : new Date().toISOString(),
      total: rows.length > 0 ? Number(rows[0].total) : 0,
      count: rows.length,
      offset,
      links: rows.map((r) => ({
        link_id: r.id,
        link_type: r.link_type,
        directed: LINK_TYPE_INFO[r.link_type].directed,
        status: r.status,
        rationale: r.rationale,
        similarity: r.similarity,
        proposed_by: r.proposed_by,
        proposed_via: parseJsonb<Record<string, unknown> | null>(r.proposed_via, null),
        proposed_at: toIso(r.proposed_at),
        decided_at: toIsoOrNull(r.decided_at),
        decided_via: parseJsonb<Record<string, unknown> | null>(r.decided_via, null),
        decision_note: r.decision_note,
        source: { id: r.s_id, title: r.s_title, kind: r.s_kind, status: r.s_status, snippet: snippet(r.s_snip, 240) },
        ...(r.a_id
          ? {
              target_artifact: {
                id: r.a_id,
                title: r.a_title,
                url: r.a_url,
                published_at: toIsoOrNull(r.a_published_at),
                type: r.a_type,
              },
            }
          : {
              target: {
                id: r.t_id,
                title: r.t_title,
                kind: r.t_kind,
                status: r.t_status,
                snippet: snippet(r.t_snip, 240),
              },
            }),
      })),
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

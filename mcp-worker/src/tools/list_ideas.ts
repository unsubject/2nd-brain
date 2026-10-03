import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { snippet } from '../ideas/text';
import {
  dbError,
  errorResult,
  ideaKindSchema,
  ideaStatusSchema,
  isoDateTimeSchema,
  ok,
  parseJsonb,
  textArray,
  toIso,
} from './idea_shared';

const inputSchema = z
  .object({
    statuses: z.array(ideaStatusSchema).min(1).optional(),
    kind: ideaKindSchema.optional(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    source_system: z.enum(['librarian', 'notion', 'gtasks_subjects', 'gardening']).optional(),
    since: isoDateTimeSchema.optional(),
    until: isoDateTimeSchema.optional(),
    unlinked: z.boolean().optional(),
    has_output: z.boolean().optional(),
    sort: z.enum(['captured_at', 'updated_at']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export const DEFAULT_LIVE_STATUSES = ['parked', 'exploring', 'used'] as const;

export async function listIdeasHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const statuses = args.statuses ?? [...DEFAULT_LIVE_STATUSES];
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  const sql = getDb(env);
  try {
    const rows = await sql<
      Array<{
        id: string;
        title: string;
        kind: string;
        intent: string | null;
        status: string;
        captured_at: Date;
        updated_at: Date;
        tags: unknown;
        snippet_src: string | null;
        link_count: string | number;
        pending_count: string | number;
        has_output: boolean;
        embedded: boolean;
        total: string | number;
        as_of: Date;
      }>
    >`
      WITH base AS (
        SELECT i.id, i.title, i.kind, i.intent, i.status, i.captured_at, i.updated_at,
               to_jsonb(i.tags) AS tags,
               left(COALESCE(i.framing, i.why_interesting, i.thoughts, i.source_excerpt), 600) AS snippet_src,
               (i.embedding IS NOT NULL) AS embedded,
               (SELECT count(*) FROM idea_link l
                 WHERE l.user_id = i.user_id AND l.status = 'accepted'
                   AND (l.source_idea_id = i.id OR l.target_idea_id = i.id)) AS link_count,
               (SELECT count(*) FROM idea_link l
                 WHERE l.user_id = i.user_id AND l.status = 'proposed'
                   AND (l.source_idea_id = i.id OR l.target_idea_id = i.id)) AS pending_count,
               EXISTS (SELECT 1 FROM idea_link l
                        WHERE l.source_idea_id = i.id AND l.status = 'accepted'
                          AND l.link_type = 'became') AS has_output
          FROM idea i
         WHERE i.user_id = ${env.BRAIN_USER_ID}
           AND i.status = ANY(${textArray(sql, statuses)})
           AND ${args.kind ? sql`i.kind = ${args.kind}` : sql`TRUE`}
           AND ${args.tags && args.tags.length > 0 ? sql`i.tags @> ${textArray(sql, args.tags)}` : sql`TRUE`}
           AND ${
             args.source_system
               ? sql`EXISTS (SELECT 1 FROM idea_source s WHERE s.idea_id = i.id AND s.source_system = ${args.source_system})`
               : sql`TRUE`
           }
           AND ${args.since ? sql`i.captured_at >= ${args.since}::timestamptz` : sql`TRUE`}
           AND ${args.until ? sql`i.captured_at <= ${args.until}::timestamptz` : sql`TRUE`}
      )
      SELECT b.*, count(*) OVER () AS total, now() AS as_of
        FROM base b
       WHERE ${args.unlinked === undefined ? sql`TRUE` : args.unlinked ? sql`b.link_count = 0` : sql`b.link_count > 0`}
         AND ${args.has_output === undefined ? sql`TRUE` : sql`b.has_output = ${args.has_output}`}
       ORDER BY ${args.sort === 'updated_at' ? sql`b.updated_at` : sql`b.captured_at`} DESC, b.id
       LIMIT ${limit} OFFSET ${offset}
    `;

    return ok({
      as_of: rows[0]?.as_of ? toIso(rows[0].as_of) : new Date().toISOString(),
      total: rows.length > 0 ? Number(rows[0].total) : 0,
      count: rows.length,
      offset,
      ideas: rows.map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        intent: r.intent,
        status: r.status,
        captured_at: toIso(r.captured_at),
        tags: parseJsonb<string[]>(r.tags, []),
        snippet: snippet(r.snippet_src, 240),
        link_count: Number(r.link_count),
        pending_count: Number(r.pending_count),
        has_output: r.has_output,
        embedded: r.embedded,
      })),
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

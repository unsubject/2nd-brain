import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  days: z.number().int().min(1).max(365).optional(),
  scope: z.enum(['personal', 'family', 'all']).optional(),
  primary_type: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export async function listRecentHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const days = parsed.data.days ?? 7;
  const scope = parsed.data.scope ?? 'personal';
  const limit = parsed.data.limit ?? 50;
  const primaryType = parsed.data.primary_type;

  const sql = getDb(env);
  try {
    const rows = await sql<
      Array<{
        id: string;
        summary: string | null;
        tags: string[] | null;
        primary_type: string | null;
        created_at: Date | string;
      }>
    >`
      SELECT id, summary,
             to_jsonb(tags) AS tags,
             primary_type, created_at
      FROM journal_entry
      WHERE processing_status = 'processed'
        AND created_at >= now() - make_interval(days => ${days})
        AND ${scope === 'all' ? sql`TRUE` : sql`scope = ${scope}`}
        AND ${primaryType ? sql`primary_type = ${primaryType}` : sql`TRUE`}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    const entries = rows.map((r) => ({
      id: r.id,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      primary_type: r.primary_type,
      tags: Array.isArray(r.tags) ? r.tags : [],
      summary: r.summary,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: entries.length, days, scope, entries }, null, 2),
        },
      ],
    };
  } catch (err) {
    return errorResult(`DB error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

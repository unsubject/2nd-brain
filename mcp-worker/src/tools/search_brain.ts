import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { embed, vectorLiteral } from '../embeddings';
import { getDb } from '../db';

const inputSchema = z.object({
  query: z.string().min(1).max(8000),
  limit: z.number().int().min(1).max(50).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
  primary_type: z
    .enum(['task_candidate', 'goal_candidate', 'knowledge_candidate', 'archive_only'])
    .optional(),
  scope: z.enum(['personal', 'family', 'all']).optional(),
});

export async function searchBrainHandler(
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
  const scope = args.scope ?? 'personal';

  let vector: number[];
  try {
    vector = await embed(args.query, env.OPENAI_API_KEY);
  } catch (e) {
    return errorResult(`Embedding failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const v = vectorLiteral(vector);

  const sql = getDb(env);
  try {
    const rows = await sql<
      Array<{
        id: string;
        summary: string | null;
        clean_text: string | null;
        tags: string[] | null;
        primary_type: string | null;
        created_at: Date | string;
        similarity: number;
      }>
    >`
      SELECT id, summary, clean_text, tags, primary_type, created_at,
             1 - (embedding <=> ${v}::vector) AS similarity
      FROM journal_entry
      WHERE processing_status = 'processed'
        AND embedding IS NOT NULL
        AND ${scope === 'all' ? sql`TRUE` : sql`scope = ${scope}`}
        AND ${args.since ? sql`created_at >= ${args.since}` : sql`TRUE`}
        AND ${args.until ? sql`created_at <= ${args.until}` : sql`TRUE`}
        AND ${args.tags && args.tags.length > 0 ? sql`tags @> ${args.tags}` : sql`TRUE`}
        AND ${args.primary_type ? sql`primary_type = ${args.primary_type}` : sql`TRUE`}
      ORDER BY embedding <=> ${v}::vector
      LIMIT ${limit}
    `;

    const hits = rows.map((r) => ({
      id: r.id,
      similarity: roundTo(Number(r.similarity), 4),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      primary_type: r.primary_type,
      tags: r.tags ?? [],
      summary: r.summary,
      preview: r.clean_text ? r.clean_text.slice(0, 400) : null,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: hits.length, hits }, null, 2),
        },
      ],
    };
  } catch (e) {
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function roundTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

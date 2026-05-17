import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  cycle_id: z.string().uuid(),
  streak_summary: z.record(z.unknown()).optional(),
  reformulation_notes: z.string().max(8000).optional(),
});

export async function closeCycleHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { cycle_id, streak_summary, reformulation_notes } = parsed.data;

  const summaryJson = streak_summary ? JSON.stringify(streak_summary) : null;

  const sql = getDb(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      UPDATE undertaking_cycles c
         SET status = 'closed',
             closed_at = now(),
             streak_summary = COALESCE(${summaryJson}::jsonb, c.streak_summary),
             reformulation_notes = COALESCE(${reformulation_notes ?? null}::text, c.reformulation_notes)
        FROM undertakings u
       WHERE c.id = ${cycle_id}
         AND c.status = 'active'
         AND u.id = c.undertaking_id
         AND u.user_id = ${env.BRAIN_USER_ID}
       RETURNING c.id
    `;
    if (rows.length === 0) {
      const existing = await sql<Array<{ status: string }>>`
        SELECT c.status FROM undertaking_cycles c
        JOIN undertakings u ON u.id = c.undertaking_id
         WHERE c.id = ${cycle_id} AND u.user_id = ${env.BRAIN_USER_ID}
      `;
      if (existing.length === 0) {
        return errorResult(`Cycle not found: ${cycle_id}`);
      }
      return errorResult(`Cycle is ${existing[0].status}; cannot close`);
    }
    return ok({ ok: true });
  } catch (e) {
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function ok(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

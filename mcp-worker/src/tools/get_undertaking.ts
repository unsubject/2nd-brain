import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  id: z.string().uuid(),
});

export async function getUndertakingHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { id } = parsed.data;

  const sql = getDb(env);
  try {
    const rows = await sql`
      SELECT id, name, purpose, outcome, test_criteria,
             primary_goal_id,
             COALESCE(to_jsonb(secondary_goal_ids), '[]'::jsonb) AS secondary_goal_ids,
             kind, gtasks_parent_id, status,
             started_at, target_date, created_at, updated_at
        FROM undertakings
       WHERE id = ${id} AND user_id = ${env.BRAIN_USER_ID}
    `;
    if (rows.length === 0) {
      return errorResult(`Undertaking not found: ${id}`);
    }

    const currentCycle = await sql`
      SELECT id, cycle_number, start_date, end_date, status,
             streak_summary, reformulation_notes, created_at
        FROM undertaking_cycles
       WHERE undertaking_id = ${id} AND status = 'active'
       LIMIT 1
    `;

    const pastCycles = await sql`
      SELECT id, cycle_number, start_date, end_date, status,
             streak_summary, reformulation_notes, created_at, closed_at
        FROM undertaking_cycles
       WHERE undertaking_id = ${id} AND status = 'closed'
       ORDER BY cycle_number DESC
    `;

    return ok({
      undertaking: rows[0],
      current_cycle: currentCycle.length > 0 ? currentCycle[0] : null,
      past_cycles: pastCycles,
    });
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

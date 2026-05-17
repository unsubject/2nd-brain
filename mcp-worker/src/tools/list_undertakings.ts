import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  status: z
    .enum(['active', 'completed', 'archived', 'sleeping', 'all'])
    .optional(),
  goal_id: z.string().uuid().optional(),
});

export async function listUndertakingsHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const status = parsed.data.status ?? 'active';
  const goalId = parsed.data.goal_id ?? null;
  const allStatuses = status === 'all';
  const noGoalFilter = goalId === null;

  const sql = getDb(env);
  try {
    const rows = await sql`
      SELECT id, name, purpose, outcome, test_criteria,
             primary_goal_id,
             COALESCE(to_jsonb(secondary_goal_ids), '[]'::jsonb) AS secondary_goal_ids,
             kind, gtasks_parent_id, status,
             started_at, target_date, created_at, updated_at
        FROM undertakings
       WHERE user_id = ${env.BRAIN_USER_ID}
         AND (${allStatuses} OR status = ${status})
         AND (${noGoalFilter} OR primary_goal_id = ${goalId})
       ORDER BY started_at DESC
    `;
    return ok({ count: rows.length, undertakings: rows });
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

import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  id: z.string().uuid(),
});

export async function getGoalHandler(
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
    const goals = await sql`
      SELECT id, statement, specific, measurable, achievable, relevant,
             time_bound, crisis_origin, status, merged_into_id,
             created_at, last_amended_at
        FROM goals
       WHERE id = ${id} AND user_id = ${env.BRAIN_USER_ID}
    `;
    if (goals.length === 0) {
      return errorResult(`Goal not found: ${id}`);
    }

    const undertakings = await sql`
      SELECT id, name, status, kind
        FROM undertakings
       WHERE primary_goal_id = ${id} AND user_id = ${env.BRAIN_USER_ID}
       ORDER BY started_at DESC
    `;

    const amendments = await sql`
      SELECT id, kind, status, proposed_at, committed_at,
             cooldown_until, rationale
        FROM goal_amendments
       WHERE goal_id = ${id} AND user_id = ${env.BRAIN_USER_ID}
       ORDER BY proposed_at DESC
       LIMIT 20
    `;

    return ok({ goal: goals[0], undertakings, amendments });
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

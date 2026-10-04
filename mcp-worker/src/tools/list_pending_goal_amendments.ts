import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { unwrapJsonb } from './idea_shared';

const inputSchema = z.object({}).strict();

export async function listPendingGoalAmendmentsHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }

  const sql = getDb(env);
  try {
    const rows = await sql`
      SELECT id, kind, goal_id,
             COALESCE(to_jsonb(source_goal_ids), '[]'::jsonb) AS source_goal_ids,
             proposed_payload, rationale,
             proposed_at, cooldown_until,
             GREATEST(0, EXTRACT(EPOCH FROM (cooldown_until - now())))::bigint
               AS cooldown_remaining_seconds
        FROM goal_amendments
       WHERE user_id = ${env.BRAIN_USER_ID}
         AND status = 'proposed'
       ORDER BY proposed_at DESC
    `;
    // Payloads proposed before PR #63 may be stored as JSON strings.
    const amendments = rows.map((r) => ({ ...r, proposed_payload: unwrapJsonb(r.proposed_payload) }));
    return ok({ count: amendments.length, amendments });
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

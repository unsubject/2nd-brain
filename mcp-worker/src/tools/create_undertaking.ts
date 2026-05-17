import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { undertakingKindSchema } from './goal_types';

const inputSchema = z.object({
  name: z.string().min(1).max(200),
  purpose: z.string().min(3).max(4000),
  outcome: z.string().min(3).max(4000),
  test_criteria: z.string().min(3).max(4000),
  primary_goal_id: z.string().uuid(),
  secondary_goal_ids: z.array(z.string().uuid()).optional(),
  kind: undertakingKindSchema.optional(),
  gtasks_parent_id: z.string().max(255).optional(),
  target_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function createUndertakingHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const kind = args.kind ?? 'outcome';
  const secondaryIds = args.secondary_goal_ids ?? [];
  const secondaryLiteral =
    secondaryIds.length > 0 ? `{${secondaryIds.join(',')}}` : '{}';

  const sql = getDb(env);
  try {
    const goal = await sql<Array<{ status: string }>>`
      SELECT status FROM goals
       WHERE id = ${args.primary_goal_id} AND user_id = ${env.BRAIN_USER_ID}
    `;
    if (goal.length === 0) {
      return errorResult(`Primary goal not found: ${args.primary_goal_id}`);
    }
    if (goal[0].status !== 'active') {
      return errorResult(
        `Primary goal ${args.primary_goal_id} is ${goal[0].status}, not active`,
      );
    }

    if (secondaryIds.length > 0) {
      const found = await sql<Array<{ id: string }>>`
        SELECT id FROM goals
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND id = ANY(${secondaryLiteral}::uuid[])
           AND status = 'active'
      `;
      if (found.length !== secondaryIds.length) {
        return errorResult('One or more secondary goals not found or not active');
      }
    }

    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO undertakings (
        user_id, name, purpose, outcome, test_criteria,
        primary_goal_id, secondary_goal_ids, kind,
        gtasks_parent_id, target_date
      ) VALUES (
        ${env.BRAIN_USER_ID},
        ${args.name},
        ${args.purpose},
        ${args.outcome},
        ${args.test_criteria},
        ${args.primary_goal_id},
        ${secondaryLiteral}::uuid[],
        ${kind},
        ${args.gtasks_parent_id ?? null},
        ${args.target_date ?? null}
      )
      RETURNING id
    `;
    return ok({ undertaking_id: rows[0].id });
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

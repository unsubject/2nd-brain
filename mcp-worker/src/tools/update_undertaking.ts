import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { undertakingStatusSchema } from './goal_types';

const inputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  purpose: z.string().min(3).max(4000).optional(),
  outcome: z.string().min(3).max(4000).optional(),
  test_criteria: z.string().min(3).max(4000).optional(),
  secondary_goal_ids: z.array(z.string().uuid()).optional(),
  status: undertakingStatusSchema.optional(),
  gtasks_parent_id: z.string().max(255).nullable().optional(),
  target_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

export async function updateUndertakingHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { id, ...fields } = parsed.data;

  const allOmitted = (
    [
      'name',
      'purpose',
      'outcome',
      'test_criteria',
      'secondary_goal_ids',
      'status',
      'gtasks_parent_id',
      'target_date',
    ] as const
  ).every((k) => (fields as Record<string, unknown>)[k] === undefined);
  if (allOmitted) {
    return errorResult('No fields to update');
  }

  // Tri-state for nullable fields:
  //   undefined → leave column unchanged
  //   null      → clear the column
  //   value     → set the column
  const gtasksOmitted = fields.gtasks_parent_id === undefined;
  const targetOmitted = fields.target_date === undefined;
  const secondaryLiteral =
    fields.secondary_goal_ids === undefined
      ? null
      : fields.secondary_goal_ids.length > 0
        ? `{${fields.secondary_goal_ids.join(',')}}`
        : '{}';

  const sql = getDb(env);
  try {
    // Validate secondary_goal_ids before any write — mirrors
    // create_undertaking's validation since Postgres can't FK array
    // elements. Without this, an update could leave an undertaking
    // pointing at retired, missing, or another user's goals, silently
    // corrupting the graph returned by list_undertakings/get_undertaking.
    if (
      fields.secondary_goal_ids !== undefined &&
      fields.secondary_goal_ids.length > 0
    ) {
      const literal = `{${fields.secondary_goal_ids.join(',')}}`;
      const found = await sql<Array<{ id: string }>>`
        SELECT id FROM goals
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND id = ANY(${literal}::uuid[])
           AND status = 'active'
      `;
      if (found.length !== fields.secondary_goal_ids.length) {
        return errorResult(
          'One or more secondary goals not found, not active, or not yours',
        );
      }
    }

    const result = await sql<Array<{ id: string }>>`
      UPDATE undertakings SET
        name          = COALESCE(${fields.name          ?? null}::text, name),
        purpose       = COALESCE(${fields.purpose       ?? null}::text, purpose),
        outcome       = COALESCE(${fields.outcome       ?? null}::text, outcome),
        test_criteria = COALESCE(${fields.test_criteria ?? null}::text, test_criteria),
        secondary_goal_ids = CASE
          WHEN ${secondaryLiteral}::text IS NULL THEN secondary_goal_ids
          ELSE ${secondaryLiteral}::uuid[]
        END,
        status        = COALESCE(${fields.status ?? null}::text, status),
        gtasks_parent_id = CASE
          WHEN ${gtasksOmitted} THEN gtasks_parent_id
          ELSE ${fields.gtasks_parent_id ?? null}
        END,
        target_date = CASE
          WHEN ${targetOmitted} THEN target_date
          ELSE ${fields.target_date ?? null}::date
        END,
        updated_at = now()
      WHERE id = ${id} AND user_id = ${env.BRAIN_USER_ID}
      RETURNING id
    `;
    if (result.length === 0) {
      return errorResult(`Undertaking not found: ${id}`);
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

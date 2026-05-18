import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  id: z.string().uuid(),
});

export async function getConstitutionDomainHandler(
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
    const domains = await sql`
      SELECT id, label, statement, crisis_origin, status, merged_into_id,
             created_at, last_amended_at
        FROM constitution_domains
       WHERE id = ${id} AND user_id = ${env.BRAIN_USER_ID}
    `;
    if (domains.length === 0) {
      return errorResult(`Constitution domain not found: ${id}`);
    }

    // Child goals (one layer down). Use get_goal for the SMART breakdown
    // and undertaking list — kept summary-level here to keep the
    // get_constitution_domain payload one-page-readable.
    const goals = await sql`
      SELECT id, statement, outcome_metric, target_date, status,
             last_reviewed_at
        FROM goals
       WHERE constitution_domain_id = ${id}
         AND user_id = ${env.BRAIN_USER_ID}
       ORDER BY created_at ASC
    `;

    const amendments = await sql`
      SELECT id, kind, status, proposed_at, committed_at,
             cooldown_until, rationale, crisis_justification
        FROM constitution_amendments
       WHERE constitution_domain_id = ${id}
         AND user_id = ${env.BRAIN_USER_ID}
       ORDER BY proposed_at DESC
       LIMIT 20
    `;

    return ok({ domain: domains[0], goals, amendments });
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

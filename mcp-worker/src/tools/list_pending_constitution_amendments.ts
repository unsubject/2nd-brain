import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({}).strict();

export async function listPendingConstitutionAmendmentsHandler(
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
      SELECT id, kind, constitution_domain_id,
             COALESCE(to_jsonb(source_constitution_domain_ids), '[]'::jsonb)
               AS source_constitution_domain_ids,
             proposed_payload, rationale, crisis_justification,
             proposed_at, cooldown_until,
             GREATEST(0, EXTRACT(EPOCH FROM (cooldown_until - now())))::bigint
               AS cooldown_remaining_seconds
        FROM constitution_amendments
       WHERE user_id = ${env.BRAIN_USER_ID}
         AND status = 'proposed'
       ORDER BY proposed_at DESC
    `;
    return ok({ count: rows.length, amendments: rows });
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

import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  status: z.enum(['active', 'merged', 'retired', 'all']).optional(),
});

export async function listConstitutionDomainsHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const status = parsed.data.status ?? 'active';

  const sql = getDb(env);
  try {
    const rows = status === 'all'
      ? await sql`
          SELECT id, label, statement, crisis_origin, status, merged_into_id,
                 created_at, last_amended_at
            FROM constitution_domains
           WHERE user_id = ${env.BRAIN_USER_ID}
           ORDER BY created_at ASC
        `
      : await sql`
          SELECT id, label, statement, crisis_origin, status, merged_into_id,
                 created_at, last_amended_at
            FROM constitution_domains
           WHERE user_id = ${env.BRAIN_USER_ID} AND status = ${status}
           ORDER BY created_at ASC
        `;
    return ok({ count: rows.length, domains: rows });
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

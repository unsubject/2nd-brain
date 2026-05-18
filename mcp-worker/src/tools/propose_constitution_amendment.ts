import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { constitutionFieldsSchema, constitutionFieldsPartialSchema } from './constitution_types';

// crisis_justification is required on EVERY kind. The constitution is the
// crisis-rooted layer — any change requires the user name the
// precipitating event/insight, not just for kind='new'.
const inputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    payload: constitutionFieldsSchema,
    rationale: z.string().min(3).max(4000),
    crisis_justification: z.string().min(3).max(4000),
  }),
  z.object({
    kind: z.literal('amend'),
    constitution_domain_id: z.string().uuid(),
    payload: constitutionFieldsPartialSchema,
    rationale: z.string().min(3).max(4000),
    crisis_justification: z.string().min(3).max(4000),
  }),
  z.object({
    kind: z.literal('synthesize'),
    source_constitution_domain_ids: z.array(z.string().uuid()).min(2),
    payload: constitutionFieldsSchema,
    rationale: z.string().min(3).max(4000),
    crisis_justification: z.string().min(3).max(4000),
  }),
  z.object({
    kind: z.literal('retire'),
    constitution_domain_id: z.string().uuid(),
    rationale: z.string().min(3).max(4000),
    crisis_justification: z.string().min(3).max(4000),
  }),
]);

export async function proposeConstitutionAmendmentHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;

  const sql = getDb(env);
  try {
    if (args.kind === 'amend' || args.kind === 'retire') {
      const existing = await sql<Array<{ id: string }>>`
        SELECT id FROM constitution_amendments
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND constitution_domain_id = ${args.constitution_domain_id}
           AND status = 'proposed'
         LIMIT 1
      `;
      if (existing.length > 0) {
        return errorResult(
          `Conflict: open proposal ${existing[0].id} already exists for domain ${args.constitution_domain_id}. Commit, withdraw, or wait before stacking another.`,
        );
      }
      const domain = await sql<Array<{ status: string }>>`
        SELECT status FROM constitution_domains
         WHERE id = ${args.constitution_domain_id} AND user_id = ${env.BRAIN_USER_ID}
      `;
      if (domain.length === 0) {
        return errorResult(`Constitution domain not found: ${args.constitution_domain_id}`);
      }
      if (domain[0].status !== 'active') {
        return errorResult(
          `Domain ${args.constitution_domain_id} is ${domain[0].status}; cannot amend/retire`,
        );
      }
    }

    if (args.kind === 'synthesize') {
      const ids = args.source_constitution_domain_ids;
      const sourceLiteral = `{${ids.join(',')}}`;
      const found = await sql<Array<{ id: string; status: string }>>`
        SELECT id, status FROM constitution_domains
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND id = ANY(${sourceLiteral}::uuid[])
      `;
      if (found.length !== ids.length) {
        return errorResult(`One or more source domains not found among: ${ids.join(', ')}`);
      }
      const nonActive = found.filter((r) => r.status !== 'active');
      if (nonActive.length > 0) {
        return errorResult(
          `Source domains must all be active. Non-active: ${nonActive.map((r) => r.id).join(', ')}`,
        );
      }
    }

    const payload = 'payload' in args ? args.payload : {};
    const domainId =
      args.kind === 'amend' || args.kind === 'retire' ? args.constitution_domain_id : null;
    const sourceIds = args.kind === 'synthesize' ? args.source_constitution_domain_ids : [];
    const sourceLiteral = sourceIds.length > 0 ? `{${sourceIds.join(',')}}` : '{}';

    const rows = await sql<Array<{ id: string; cooldown_until: Date | string }>>`
      INSERT INTO constitution_amendments (
        user_id, kind, constitution_domain_id, source_constitution_domain_ids,
        proposed_payload, rationale, crisis_justification
      )
      VALUES (
        ${env.BRAIN_USER_ID},
        ${args.kind},
        ${domainId},
        ${sourceLiteral}::uuid[],
        ${JSON.stringify(payload)}::jsonb,
        ${args.rationale},
        ${args.crisis_justification}
      )
      RETURNING id, cooldown_until
    `;
    return ok({
      amendment_id: rows[0].id,
      kind: args.kind,
      cooldown_until: toIso(rows[0].cooldown_until),
      note:
        'Proposal staged. Call commit_constitution_amendment after the 14-day cooldown elapses (except the founding bypass: first 5 lifetime kind="new" commits skip cooldown — sized for the typical 5-domain bootstrap).',
    });
  } catch (e) {
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function ok(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

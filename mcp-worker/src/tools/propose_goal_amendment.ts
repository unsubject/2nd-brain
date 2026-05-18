import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { goalFieldsSchema, goalFieldsPartialSchema } from './goal_types';

// Goal-layer payload for 'new' / 'synthesize' kinds requires the parent
// constitution_domain_id. For 'amend' the parent is immutable — to
// re-parent a goal, abandon + new under the new domain.
const newOrSynthesizePayload = goalFieldsSchema.extend({
  constitution_domain_id: z.string().uuid(),
});

const inputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    payload: newOrSynthesizePayload,
    rationale: z.string().min(3).max(4000),
  }),
  z.object({
    kind: z.literal('amend'),
    goal_id: z.string().uuid(),
    payload: goalFieldsPartialSchema,
    rationale: z.string().min(3).max(4000),
  }),
  z.object({
    kind: z.literal('synthesize'),
    source_goal_ids: z.array(z.string().uuid()).min(2),
    payload: newOrSynthesizePayload,
    rationale: z.string().min(3).max(4000),
  }),
  z.object({
    kind: z.literal('achieve'),
    goal_id: z.string().uuid(),
    rationale: z.string().min(3).max(4000),
  }),
  z.object({
    kind: z.literal('abandon'),
    goal_id: z.string().uuid(),
    rationale: z.string().min(3).max(4000),
  }),
]);

export async function proposeGoalAmendmentHandler(
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
    if (args.kind === 'amend' || args.kind === 'achieve' || args.kind === 'abandon') {
      const existing = await sql<Array<{ id: string }>>`
        SELECT id FROM goal_amendments
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND goal_id = ${args.goal_id}
           AND status = 'proposed'
         LIMIT 1
      `;
      if (existing.length > 0) {
        return errorResult(
          `Conflict: open proposal ${existing[0].id} already exists for goal ${args.goal_id}. Commit, withdraw, or wait before stacking another.`,
        );
      }
      const goal = await sql<Array<{ status: string }>>`
        SELECT status FROM goals
         WHERE id = ${args.goal_id} AND user_id = ${env.BRAIN_USER_ID}
      `;
      if (goal.length === 0) {
        return errorResult(`Goal not found: ${args.goal_id}`);
      }
      if (goal[0].status !== 'active') {
        return errorResult(
          `Goal ${args.goal_id} is ${goal[0].status}; cannot amend/achieve/abandon`,
        );
      }
    }

    if (args.kind === 'new') {
      const domain = await sql<Array<{ status: string }>>`
        SELECT status FROM constitution_domains
         WHERE id = ${args.payload.constitution_domain_id}
           AND user_id = ${env.BRAIN_USER_ID}
      `;
      if (domain.length === 0) {
        return errorResult(
          `Constitution domain not found: ${args.payload.constitution_domain_id}`,
        );
      }
      if (domain[0].status !== 'active') {
        return errorResult(
          `Domain ${args.payload.constitution_domain_id} is ${domain[0].status}; cannot add goals under it`,
        );
      }
    }

    if (args.kind === 'synthesize') {
      const ids = args.source_goal_ids;
      const sourceLiteral = `{${ids.join(',')}}`;
      const found = await sql<Array<{ id: string; status: string; constitution_domain_id: string }>>`
        SELECT id, status, constitution_domain_id FROM goals
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND id = ANY(${sourceLiteral}::uuid[])
      `;
      if (found.length !== ids.length) {
        return errorResult(`One or more source goals not found among: ${ids.join(', ')}`);
      }
      const nonActive = found.filter((r) => r.status !== 'active');
      if (nonActive.length > 0) {
        return errorResult(
          `Source goals must all be active. Non-active: ${nonActive.map((r) => r.id).join(', ')}`,
        );
      }
      // Synthesis must stay within one domain — cross-domain merges are
      // a constitution-level change, not a goal-level one.
      const uniqDomains = new Set(found.map((r) => r.constitution_domain_id));
      if (uniqDomains.size !== 1) {
        return errorResult(
          'Source goals must all belong to the same constitution_domain. Cross-domain synthesis requires a constitution amendment first.',
        );
      }
      const sourceDomain = found[0].constitution_domain_id;
      if (args.payload.constitution_domain_id !== sourceDomain) {
        return errorResult(
          `Synthesized goal's constitution_domain_id (${args.payload.constitution_domain_id}) must match the source goals' shared domain (${sourceDomain}).`,
        );
      }
    }

    const payload = 'payload' in args ? args.payload : {};
    const goalId =
      args.kind === 'amend' || args.kind === 'achieve' || args.kind === 'abandon'
        ? args.goal_id
        : null;
    const sourceIds = args.kind === 'synthesize' ? args.source_goal_ids : [];
    const sourceLiteral = sourceIds.length > 0 ? `{${sourceIds.join(',')}}` : '{}';

    const rows = await sql<Array<{ id: string; cooldown_until: Date | string }>>`
      INSERT INTO goal_amendments (
        user_id, kind, goal_id, source_goal_ids,
        proposed_payload, rationale
      )
      VALUES (
        ${env.BRAIN_USER_ID},
        ${args.kind},
        ${goalId},
        ${sourceLiteral}::uuid[],
        ${JSON.stringify(payload)}::jsonb,
        ${args.rationale}
      )
      RETURNING id, cooldown_until
    `;
    return ok({
      amendment_id: rows[0].id,
      kind: args.kind,
      cooldown_until: toIso(rows[0].cooldown_until),
      note:
        'Proposal staged. Call commit_goal_amendment after the 72h cooldown elapses. No founding bypass at this layer — overlapping proposals are fine.',
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

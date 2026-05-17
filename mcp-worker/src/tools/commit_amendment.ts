import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  amendment_id: z.string().uuid(),
});

type AmendmentRow = {
  id: string;
  kind: 'new' | 'amend' | 'synthesize' | 'retire';
  goal_id: string | null;
  source_goal_ids: string[];
  proposed_payload: Record<string, unknown>;
  rationale: string;
  irreducibility_justification: string | null;
  status: string;
  proposed_at: Date | string;
  cooldown_until: Date | string;
};

export async function commitAmendmentHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { amendment_id } = parsed.data;

  const sql = getDb(env);
  try {
    const committed = await sql.begin(async (tx) => {
      const rows = await tx<Array<AmendmentRow>>`
        SELECT id, kind, goal_id,
               -- Coerce text[] → JS array via to_jsonb (fetch_types: false
               -- skips OID resolution so raw text[] returns as a PG literal
               -- string otherwise).
               COALESCE(to_jsonb(source_goal_ids), '[]'::jsonb) AS source_goal_ids,
               proposed_payload, rationale, irreducibility_justification,
               status, proposed_at, cooldown_until
          FROM goal_amendments
         WHERE id = ${amendment_id} AND user_id = ${env.BRAIN_USER_ID}
         FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new HandlerError('not_found', `Amendment not found: ${amendment_id}`);
      }
      const a = rows[0];
      if (a.status !== 'proposed') {
        throw new HandlerError(
          'conflict',
          `Amendment is ${a.status}; cannot commit`,
        );
      }

      // Founding bypass: kind='new' AND fewer than 3 lifetime committed
      // 'new' amendments. Irreversible — counted from the audit log, so
      // retire/merge don't refund the counter.
      let bypassCooldown = false;
      if (a.kind === 'new') {
        const counted = await tx<Array<{ n: string }>>`
          SELECT count(*)::text AS n FROM goal_amendments
           WHERE user_id = ${env.BRAIN_USER_ID}
             AND kind = 'new' AND status = 'committed'
        `;
        if (Number(counted[0].n) < 3) {
          bypassCooldown = true;
        }
      }

      if (!bypassCooldown) {
        const now = new Date();
        const cooldownUntil =
          a.cooldown_until instanceof Date
            ? a.cooldown_until
            : new Date(String(a.cooldown_until));
        if (now < cooldownUntil) {
          const secondsLeft = Math.ceil(
            (cooldownUntil.getTime() - now.getTime()) / 1000,
          );
          throw new HandlerError(
            'cooldown_active',
            `Cooldown not elapsed: ${secondsLeft}s remaining (cooldown_until=${cooldownUntil.toISOString()}). Constitutional gravity is the point — sit with the proposal.`,
          );
        }
      }

      const payload = a.proposed_payload as {
        statement?: string;
        specific?: string;
        measurable?: string;
        achievable?: string;
        relevant?: string;
        time_bound?: string;
        crisis_origin?: string;
      };

      let resultGoalId: string;

      if (a.kind === 'new' || a.kind === 'synthesize') {
        ensureFullPayload(payload);
        const ins = await tx<Array<{ id: string }>>`
          INSERT INTO goals (
            user_id, statement, specific, measurable, achievable, relevant,
            time_bound, crisis_origin, status
          ) VALUES (
            ${env.BRAIN_USER_ID},
            ${payload.statement},
            ${payload.specific},
            ${payload.measurable},
            ${payload.achievable},
            ${payload.relevant},
            ${payload.time_bound},
            ${payload.crisis_origin},
            'active'
          )
          RETURNING id
        `;
        resultGoalId = ins[0].id;

        if (a.kind === 'synthesize') {
          const sourceList = Array.isArray(a.source_goal_ids) ? a.source_goal_ids : [];
          if (sourceList.length < 2) {
            throw new HandlerError(
              'invalid_state',
              'synthesize amendment must have >=2 source_goal_ids',
            );
          }
          const sourceLiteral = `{${sourceList.join(',')}}`;
          await tx`
            UPDATE goals
               SET status = 'merged',
                   merged_into_id = ${resultGoalId},
                   last_amended_at = now()
             WHERE id = ANY(${sourceLiteral}::uuid[])
               AND user_id = ${env.BRAIN_USER_ID}
          `;
        }
      } else if (a.kind === 'amend') {
        if (!a.goal_id) {
          throw new HandlerError('invalid_state', 'amend amendment has no goal_id');
        }
        await tx`
          UPDATE goals SET
            statement       = COALESCE(${payload.statement     ?? null}::text, statement),
            specific        = COALESCE(${payload.specific      ?? null}::text, specific),
            measurable      = COALESCE(${payload.measurable    ?? null}::text, measurable),
            achievable      = COALESCE(${payload.achievable    ?? null}::text, achievable),
            relevant        = COALESCE(${payload.relevant      ?? null}::text, relevant),
            time_bound      = COALESCE(${payload.time_bound    ?? null}::text, time_bound),
            crisis_origin   = COALESCE(${payload.crisis_origin ?? null}::text, crisis_origin),
            last_amended_at = now()
          WHERE id = ${a.goal_id} AND user_id = ${env.BRAIN_USER_ID}
        `;
        resultGoalId = a.goal_id;
      } else if (a.kind === 'retire') {
        if (!a.goal_id) {
          throw new HandlerError('invalid_state', 'retire amendment has no goal_id');
        }
        await tx`
          UPDATE goals
             SET status = 'retired',
                 last_amended_at = now()
           WHERE id = ${a.goal_id} AND user_id = ${env.BRAIN_USER_ID}
        `;
        resultGoalId = a.goal_id;
      } else {
        throw new HandlerError('invalid_state', `Unknown kind: ${String(a.kind)}`);
      }

      await tx`
        UPDATE goal_amendments
           SET status = 'committed',
               committed_at = now(),
               goal_id = ${resultGoalId}
         WHERE id = ${amendment_id}
      `;

      return { goal_id: resultGoalId, kind: a.kind, bypassed_cooldown: bypassCooldown };
    });
    return ok({ ok: true, ...committed });
  } catch (e) {
    if (e instanceof HandlerError) {
      return errorResult(`${e.code}: ${e.message}`);
    }
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function ensureFullPayload(p: Record<string, unknown>): asserts p is {
  statement: string;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  time_bound: string;
  crisis_origin: string;
} {
  const required = [
    'statement',
    'specific',
    'measurable',
    'achievable',
    'relevant',
    'time_bound',
    'crisis_origin',
  ] as const;
  for (const k of required) {
    const v = p[k];
    if (typeof v !== 'string' || v.length < 1) {
      throw new HandlerError(
        'invalid_state',
        `Amendment payload missing required SMART field: ${k}`,
      );
    }
  }
}

class HandlerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function ok(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

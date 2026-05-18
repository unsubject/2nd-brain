import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  amendment_id: z.string().uuid(),
});

type AmendmentRow = {
  id: string;
  kind: 'new' | 'amend' | 'synthesize' | 'achieve' | 'abandon';
  goal_id: string | null;
  source_goal_ids: string[];
  proposed_payload: Record<string, unknown>;
  rationale: string;
  status: string;
  proposed_at: Date | string;
  cooldown_until: Date | string;
};

export async function commitGoalAmendmentHandler(
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
               COALESCE(to_jsonb(source_goal_ids), '[]'::jsonb) AS source_goal_ids,
               proposed_payload, rationale,
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
          `Cooldown not elapsed: ${secondsLeft}s remaining (cooldown_until=${cooldownUntil.toISOString()}).`,
        );
      }

      const payload = a.proposed_payload as {
        constitution_domain_id?: string;
        statement?: string;
        specific?: string;
        measurable?: string;
        achievable?: string;
        relevant?: string;
        time_bound?: string;
        outcome_metric?: string;
        target_date?: string | null;
      };

      let resultGoalId: string;

      if (a.kind === 'new' || a.kind === 'synthesize') {
        ensureFullGoalPayload(payload);
        const ins = await tx<Array<{ id: string }>>`
          INSERT INTO goals (
            user_id, constitution_domain_id, statement,
            specific, measurable, achievable, relevant, time_bound,
            outcome_metric, target_date, status
          ) VALUES (
            ${env.BRAIN_USER_ID},
            ${payload.constitution_domain_id},
            ${payload.statement},
            ${payload.specific},
            ${payload.measurable},
            ${payload.achievable},
            ${payload.relevant},
            ${payload.time_bound},
            ${payload.outcome_metric},
            ${payload.target_date ?? null}::date,
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
        // target_date is the only nullable field; for the rest, COALESCE
        // preserves the existing value when the payload omits the key.
        // target_date supports null-to-clear if explicitly null in payload,
        // otherwise omitted = leave; not adding explicit tri-state because
        // the proposal flow encourages full-payload re-statement at
        // quarterly review.
        await tx`
          UPDATE goals SET
            statement       = COALESCE(${payload.statement       ?? null}::text, statement),
            specific        = COALESCE(${payload.specific        ?? null}::text, specific),
            measurable      = COALESCE(${payload.measurable      ?? null}::text, measurable),
            achievable      = COALESCE(${payload.achievable      ?? null}::text, achievable),
            relevant        = COALESCE(${payload.relevant        ?? null}::text, relevant),
            time_bound      = COALESCE(${payload.time_bound      ?? null}::text, time_bound),
            outcome_metric  = COALESCE(${payload.outcome_metric  ?? null}::text, outcome_metric),
            target_date     = COALESCE(${payload.target_date     ?? null}::date, target_date),
            last_reviewed_at = now(),
            last_amended_at  = now()
          WHERE id = ${a.goal_id} AND user_id = ${env.BRAIN_USER_ID}
        `;
        resultGoalId = a.goal_id;
      } else if (a.kind === 'achieve') {
        if (!a.goal_id) {
          throw new HandlerError('invalid_state', 'achieve amendment has no goal_id');
        }
        await tx`
          UPDATE goals
             SET status = 'achieved',
                 last_amended_at = now()
           WHERE id = ${a.goal_id} AND user_id = ${env.BRAIN_USER_ID}
        `;
        resultGoalId = a.goal_id;
      } else if (a.kind === 'abandon') {
        if (!a.goal_id) {
          throw new HandlerError('invalid_state', 'abandon amendment has no goal_id');
        }
        await tx`
          UPDATE goals
             SET status = 'abandoned',
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

      return { goal_id: resultGoalId, kind: a.kind };
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

function ensureFullGoalPayload(p: Record<string, unknown>): asserts p is {
  constitution_domain_id: string;
  statement: string;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  time_bound: string;
  outcome_metric: string;
  target_date?: string | null;
} {
  const required = [
    'constitution_domain_id',
    'statement',
    'specific',
    'measurable',
    'achievable',
    'relevant',
    'time_bound',
    'outcome_metric',
  ] as const;
  for (const k of required) {
    const v = p[k];
    if (typeof v !== 'string' || v.length < 1) {
      throw new HandlerError(
        'invalid_state',
        `Amendment payload missing required goal field: ${k}`,
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

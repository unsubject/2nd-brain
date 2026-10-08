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

      // Pre-fix rows (before propose_goal_amendment switched to sql.json)
      // stored proposed_payload as a JSONB STRING wrapping the JSON text
      // — double-encoded. parseJsonbPayload recursively unwraps strings
      // up to 3 levels, so existing 'proposed' rows still commit cleanly.
      // New rows (post-fix) come back as objects on first read and
      // short-circuit immediately.
      const payload = parseJsonbPayload(a.proposed_payload) as {
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
        // The proposal checked the domain, but a retire or merge can commit
        // during the cooldown; nothing new goes under an inactive domain.
        // FOR SHARE holds off a concurrent retire until this commits.
        const domain = await tx<Array<{ status: string }>>`
          SELECT status, now() AS as_of FROM constitution_domains
           WHERE id = ${payload.constitution_domain_id} AND user_id = ${env.BRAIN_USER_ID}
           FOR SHARE
        `;
        if (domain[0]?.status !== 'active') {
          throw new HandlerError(
            'invalid_state',
            `Domain ${payload.constitution_domain_id} is ${domain[0]?.status ?? 'not found'}; cannot add goals under it`,
          );
        }
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
          // Only still-active sources merge: one achieved or abandoned
          // during the cooldown keeps its status, and the commit fails.
          const merged = await tx`
            UPDATE goals
               SET status = 'merged',
                   merged_into_id = ${resultGoalId},
                   last_amended_at = now()
             WHERE id = ANY(${sourceLiteral}::uuid[])
               AND user_id = ${env.BRAIN_USER_ID}
               AND status = 'active'
          `;
          if (merged.count !== sourceList.length) {
            throw new HandlerError(
              'invalid_state',
              'Source goals are no longer all active; cannot merge them',
            );
          }
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

// Recursively unwrap JSON-encoded strings up to MAX_UNWRAP_DEPTH levels.
// Handles:
//   - Proper jsonb object   → returned as-is
//   - jsonb string holding JSON text (pre-fix bug) → 1 JSON.parse
//   - jsonb string holding a JSON-encoded JSON string → 2 JSON.parses
// Returns {} on any unrecoverable shape so the caller's ensureFullGoalPayload
// produces a clear "missing required field" error rather than a runtime crash.
const MAX_UNWRAP_DEPTH = 3;
function parseJsonbPayload(v: unknown): Record<string, unknown> {
  let cur: unknown = v;
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    if (cur === null || cur === undefined) return {};
    if (typeof cur === 'object' && !Array.isArray(cur)) {
      return cur as Record<string, unknown>;
    }
    if (typeof cur === 'string') {
      try {
        cur = JSON.parse(cur);
        continue;
      } catch {
        return {};
      }
    }
    return {};
  }
  return {};
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

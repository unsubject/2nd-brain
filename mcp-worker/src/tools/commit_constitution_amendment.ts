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
  constitution_domain_id: string | null;
  source_constitution_domain_ids: string[];
  proposed_payload: Record<string, unknown>;
  rationale: string;
  crisis_justification: string;
  status: string;
  proposed_at: Date | string;
  cooldown_until: Date | string;
};

// Founding bypass size for the constitution layer. The first N lifetime
// committed kind='new' amendments skip the 14-day cooldown so the user
// can bootstrap their domain set in one session. Sized for the user's
// 5-domain framework (Mind / Body / Family / Wealth / Social). After N,
// gravity (14 days) applies forever; retire/merge don't refund the counter.
const FOUNDING_BYPASS_LIMIT = 5;

export async function commitConstitutionAmendmentHandler(
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
        SELECT id, kind, constitution_domain_id,
               -- Coerce text[]/uuid[] → JS array via to_jsonb (raw uuid[]
               -- returns as a PG literal string otherwise).
               COALESCE(to_jsonb(source_constitution_domain_ids), '[]'::jsonb)
                 AS source_constitution_domain_ids,
               proposed_payload, rationale, crisis_justification,
               status, proposed_at, cooldown_until
          FROM constitution_amendments
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

      let bypassCooldown = false;
      if (a.kind === 'new') {
        const counted = await tx<Array<{ n: string }>>`
          SELECT count(*)::text AS n FROM constitution_amendments
           WHERE user_id = ${env.BRAIN_USER_ID}
             AND kind = 'new' AND status = 'committed'
        `;
        if (Number(counted[0].n) < FOUNDING_BYPASS_LIMIT) {
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
        label?: string;
        statement?: string;
        crisis_origin?: string;
      };

      let resultDomainId: string;

      if (a.kind === 'new' || a.kind === 'synthesize') {
        ensureFullPayload(payload);
        const ins = await tx<Array<{ id: string }>>`
          INSERT INTO constitution_domains (
            user_id, label, statement, crisis_origin, status
          ) VALUES (
            ${env.BRAIN_USER_ID},
            ${payload.label},
            ${payload.statement},
            ${payload.crisis_origin},
            'active'
          )
          RETURNING id
        `;
        resultDomainId = ins[0].id;

        if (a.kind === 'synthesize') {
          const sourceList = Array.isArray(a.source_constitution_domain_ids)
            ? a.source_constitution_domain_ids
            : [];
          if (sourceList.length < 2) {
            throw new HandlerError(
              'invalid_state',
              'synthesize amendment must have >=2 source_constitution_domain_ids',
            );
          }
          const sourceLiteral = `{${sourceList.join(',')}}`;
          await tx`
            UPDATE constitution_domains
               SET status = 'merged',
                   merged_into_id = ${resultDomainId},
                   last_amended_at = now()
             WHERE id = ANY(${sourceLiteral}::uuid[])
               AND user_id = ${env.BRAIN_USER_ID}
          `;
        }
      } else if (a.kind === 'amend') {
        if (!a.constitution_domain_id) {
          throw new HandlerError('invalid_state', 'amend amendment has no constitution_domain_id');
        }
        await tx`
          UPDATE constitution_domains SET
            label           = COALESCE(${payload.label         ?? null}::text, label),
            statement       = COALESCE(${payload.statement     ?? null}::text, statement),
            crisis_origin   = COALESCE(${payload.crisis_origin ?? null}::text, crisis_origin),
            last_amended_at = now()
          WHERE id = ${a.constitution_domain_id} AND user_id = ${env.BRAIN_USER_ID}
        `;
        resultDomainId = a.constitution_domain_id;
      } else if (a.kind === 'retire') {
        if (!a.constitution_domain_id) {
          throw new HandlerError('invalid_state', 'retire amendment has no constitution_domain_id');
        }
        await tx`
          UPDATE constitution_domains
             SET status = 'retired',
                 last_amended_at = now()
           WHERE id = ${a.constitution_domain_id} AND user_id = ${env.BRAIN_USER_ID}
        `;
        resultDomainId = a.constitution_domain_id;
      } else {
        throw new HandlerError('invalid_state', `Unknown kind: ${String(a.kind)}`);
      }

      await tx`
        UPDATE constitution_amendments
           SET status = 'committed',
               committed_at = now(),
               constitution_domain_id = ${resultDomainId}
         WHERE id = ${amendment_id}
      `;

      return {
        constitution_domain_id: resultDomainId,
        kind: a.kind,
        bypassed_cooldown: bypassCooldown,
      };
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
  label: string;
  statement: string;
  crisis_origin: string;
} {
  const required = ['label', 'statement', 'crisis_origin'] as const;
  for (const k of required) {
    const v = p[k];
    if (typeof v !== 'string' || v.length < 1) {
      throw new HandlerError(
        'invalid_state',
        `Amendment payload missing required constitution field: ${k}`,
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

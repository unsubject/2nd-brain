import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import type { Principal } from '../auth/principal';
import { getDb } from '../db';
import { canonicalPair, endpointError, isSymmetric, type LinkType } from '../ideas/linkTypes';
import { credentialLabel, errorResult, HandlerError, jsonParam, linkTypeSchema, ok } from './idea_shared';

// Record the user's verdicts on proposals (docs/idea-parking-lot-protocol.md §2).
// Transitions: proposed → accept | reject | withdraw; accepted → retract.
// Only these decisions turn proposals into links (besides create_synthesis).

const decisionSchema = z
  .object({
    link_id: z.string().uuid(),
    decision: z.enum(['accept', 'reject', 'withdraw', 'retract']),
    link_type: linkTypeSchema.optional(),
    reverse: z.boolean().optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    decisions: z.array(decisionSchema).min(1).max(50),
  })
  .strict();

const NEXT_STATUS = {
  accept: 'accepted',
  reject: 'rejected',
  withdraw: 'withdrawn',
  retract: 'retracted',
} as const;

type Result = {
  link_id: string;
  result: (typeof NEXT_STATUS)[keyof typeof NEXT_STATUS] | 'error';
  link_type?: string;
  superseded?: string;
  error?: string;
};

export async function decideIdeaLinksHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const ids = parsed.data.decisions.map((d) => d.link_id.toLowerCase());
  if (new Set(ids).size !== ids.length) {
    return errorResult('Invalid arguments: each link_id may appear only once per call');
  }

  const decidedVia = { credential: credentialLabel(principal) };
  const sql = getDb(env);
  const results: Result[] = [];
  const hints: string[] = [];
  try {
    for (const d of parsed.data.decisions) {
      try {
        const r = await sql.begin(async (tx): Promise<Result> => {
          const rows = await tx<
            Array<{
              id: string;
              status: string;
              link_type: LinkType;
              source_idea_id: string;
              target_idea_id: string | null;
              target_artifact_id: string | null;
              rationale: string;
              source_status: string;
              source_title: string;
            }>
          >`
            SELECT l.id, l.status, l.link_type, l.source_idea_id, l.target_idea_id, l.target_artifact_id,
                   l.rationale, i.status AS source_status, i.title AS source_title, now() AS as_of
              FROM idea_link l JOIN idea i ON i.id = l.source_idea_id
             WHERE l.id = ${d.link_id} AND l.user_id = ${env.BRAIN_USER_ID}
             FOR UPDATE OF l
          `;
          if (rows.length === 0) throw new HandlerError('not_found', `link ${d.link_id}`);
          const link = rows[0];

          const allowed =
            (link.status === 'proposed' && d.decision !== 'retract') ||
            (link.status === 'accepted' && d.decision === 'retract');
          if (!allowed) {
            throw new HandlerError('invalid_transition', `cannot ${d.decision} a link that is ${link.status}`);
          }
          if ((d.link_type || d.reverse) && d.decision !== 'accept') {
            throw new HandlerError('invalid', 'link_type / reverse are only allowed with decision=accept');
          }

          let type = link.link_type;
          let source = link.source_idea_id;
          let target = link.target_idea_id;
          if (d.decision === 'accept' && (d.link_type || d.reverse)) {
            type = d.link_type ?? link.link_type;
            const shapeErr = endpointError(type, link);
            if (shapeErr) throw new HandlerError('invalid', `cannot retype to ${type}: ${shapeErr}`);
            if (d.reverse) {
              if (!target) throw new HandlerError('invalid', 'reverse only applies to idea → idea links');
              if (isSymmetric(type)) throw new HandlerError('invalid', `reverse is meaningless for symmetric ${type}`);
              [source, target] = [target, source];
            }
            if (target) {
              const c = canonicalPair(type, source, target);
              source = c.source;
              target = c.target;
            }
          }

          const next = NEXT_STATUS[d.decision];
          let resultId = link.id;
          let superseded: string | undefined;

          // A retype can collide with an older row of the new type for the
          // same pair. A live one (proposed/accepted) is a real conflict; a
          // dead one (withdrawn/rejected/retracted) is revived as the
          // accepted link, since the user has just said yes to it.
          const retyped =
            d.decision === 'accept' &&
            (type !== link.link_type || source !== link.source_idea_id || target !== link.target_idea_id);
          if (retyped) {
            const clash = await tx<Array<{ id: string; status: string }>>`
              SELECT id, status, now() AS as_of FROM idea_link
               WHERE user_id = ${env.BRAIN_USER_ID}
                 AND id <> ${link.id}
                 AND link_type = ${type}
                 AND ${
                   target
                     ? tx`LEAST(source_idea_id, target_idea_id) = LEAST(${source}::uuid, ${target}::uuid)
                          AND GREATEST(source_idea_id, target_idea_id) = GREATEST(${source}::uuid, ${target}::uuid)`
                     : tx`source_idea_id = ${source} AND target_artifact_id = ${link.target_artifact_id}`
                 }
               FOR UPDATE
            `;
            if (clash.length > 0) {
              const c = clash[0];
              if (c.status === 'proposed' || c.status === 'accepted') {
                throw new HandlerError(
                  'conflict',
                  `a ${type} link for this pair already exists (link ${c.id}, ${c.status}); decide that one instead`,
                );
              }
              // The revived row takes over the accepted proposal: its
              // rationale and its proposer; the old ones go to history.
              await tx`
                UPDATE idea_link SET
                  history = history || jsonb_build_array(jsonb_build_object(
                    'status', status, 'rationale', rationale, 'link_type', link_type,
                    'source_idea_id', source_idea_id, 'decided_at', decided_at,
                    'decision_note', decision_note, 'proposed_by', proposed_by,
                    'proposed_via', proposed_via, 'proposed_at', proposed_at, 'similarity', similarity,
                    'decided_via', decided_via, 'revived_at', now()
                  )),
                  status = 'accepted',
                  source_idea_id = ${source},
                  target_idea_id = ${target},
                  rationale = ${link.rationale},
                  proposed_by = (SELECT p.proposed_by FROM idea_link p WHERE p.id = ${link.id}),
                  proposed_via = (SELECT p.proposed_via FROM idea_link p WHERE p.id = ${link.id}),
                  proposed_at = (SELECT p.proposed_at FROM idea_link p WHERE p.id = ${link.id}),
                  similarity = (SELECT p.similarity FROM idea_link p WHERE p.id = ${link.id}),
                  decided_at = now(),
                  decided_via = ${jsonParam(tx, decidedVia)},
                  decision_note = ${d.note ?? null}
                WHERE id = ${c.id}
              `;
              await tx`
                UPDATE idea_link SET
                  status = 'withdrawn',
                  decided_at = now(),
                  decided_via = ${jsonParam(tx, decidedVia)},
                  decision_note = ${`superseded: accepted as ${type} on link ${c.id}`}
                WHERE id = ${link.id}
              `;
              resultId = c.id;
              superseded = link.id;
            }
          }

          if (!superseded) {
            // Retracting overwrites the accept: keep who accepted it, and when.
            // Accepting with a different type or direction overwrites the
            // proposal: keep what was proposed, and by whom.
            await tx`
              UPDATE idea_link SET
                history = CASE
                  WHEN status = 'accepted' THEN history || jsonb_build_array(jsonb_build_object(
                    'status', status, 'link_type', link_type, 'decided_at', decided_at,
                    'decided_via', decided_via, 'decision_note', decision_note, 'retracted_at', now()
                  ))
                  WHEN link_type IS DISTINCT FROM ${type}
                    OR source_idea_id IS DISTINCT FROM ${source}
                    OR target_idea_id IS DISTINCT FROM ${target}
                  THEN history || jsonb_build_array(jsonb_build_object(
                    'status', status, 'link_type', link_type, 'source_idea_id', source_idea_id,
                    'target_idea_id', target_idea_id, 'rationale', rationale, 'proposed_by', proposed_by,
                    'proposed_via', proposed_via, 'proposed_at', proposed_at, 'similarity', similarity,
                    'retyped_at', now()
                  ))
                  ELSE history END,
                status = ${next},
                link_type = ${type},
                source_idea_id = ${source},
                target_idea_id = ${target},
                decided_at = now(),
                decided_via = ${jsonParam(tx, decidedVia)},
                decision_note = ${d.note ?? null}
              WHERE id = ${link.id}
            `;
          }

          if (next === 'accepted' && type === 'became' && link.source_status !== 'used') {
            hints.push(
              `"${link.source_title}" now has a \`became\` link but its status is ${link.source_status}; ask the user whether to mark it used (update_idea).`,
            );
          }
          return { link_id: resultId, result: next, link_type: type, ...(superseded ? { superseded } : {}) };
        });
        results.push(r);
      } catch (e) {
        const msg =
          e instanceof HandlerError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
        results.push({ link_id: d.link_id, result: 'error', error: msg });
      }
    }
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.result] = (counts[r.result] ?? 0) + 1;
  return ok({ counts, results, ...(hints.length > 0 ? { hints } : {}) });
}

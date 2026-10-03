import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { canonicalPair, endpointError, isSymmetric, type LinkType } from '../ideas/linkTypes';
import { errorResult, HandlerError, linkTypeSchema, ok } from './idea_shared';

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
  error?: string;
};

export async function decideIdeaLinksHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const ids = parsed.data.decisions.map((d) => d.link_id.toLowerCase());
  if (new Set(ids).size !== ids.length) {
    return errorResult('Invalid arguments: each link_id may appear only once per call');
  }

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
              source_status: string;
              source_title: string;
            }>
          >`
            SELECT l.id, l.status, l.link_type, l.source_idea_id, l.target_idea_id, l.target_artifact_id,
                   i.status AS source_status, i.title AS source_title
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
          try {
            await tx`
              UPDATE idea_link SET
                status = ${next},
                link_type = ${type},
                source_idea_id = ${source},
                target_idea_id = ${target},
                decided_at = now(),
                decision_note = ${d.note ?? null}
              WHERE id = ${link.id}
            `;
          } catch (e) {
            if ((e as { code?: string }).code === '23505') {
              throw new HandlerError('conflict', `a ${type} link between these ideas already exists`);
            }
            throw e;
          }

          if (next === 'accepted' && type === 'became' && link.source_status !== 'used') {
            hints.push(
              `"${link.source_title}" now has a \`became\` link but its status is ${link.source_status}; ask the user whether to mark it used (update_idea).`,
            );
          }
          return { link_id: link.id, result: next, link_type: type };
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

import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import type { Principal } from '../auth/principal';
import { getDb } from '../db';
import { canonicalPair, endpointError } from '../ideas/linkTypes';
import {
  capturedViaSchema,
  credentialLabel,
  errorResult,
  HandlerError,
  jsonParam,
  linkTypeSchema,
  ok,
} from './idea_shared';

// Gardening step 2 (docs/idea-parking-lot-protocol.md §2): stage typed
// link PROPOSALS. Nothing becomes a link until the user accepts it via
// decide_idea_links. A pair the user rejected or retracted (any type) is
// refused unless reconsider_rejected=true; withdrawn proposals reopen.

const linkSchema = z
  .object({
    source_idea_id: z.string().uuid(),
    target_idea_id: z.string().uuid().optional(),
    target_artifact_id: z.string().uuid().optional(),
    link_type: linkTypeSchema,
    rationale: z
      .string()
      .min(10)
      .max(300)
      .regex(/^[^\r\n]+$/, 'rationale must be a single line'),
    similarity: z.number().min(-1).max(1).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    origin: z.enum(['gardening', 'import']),
    proposed_via: capturedViaSchema.optional(),
    reconsider_rejected: z.boolean().optional(),
    links: z.array(linkSchema).min(1).max(20),
  })
  .strict();

type Result = {
  index: number;
  result: 'proposed' | 'reopened' | 'skipped_duplicate' | 'skipped_rejected' | 'error';
  link_id?: string;
  existing_status?: string;
  existing_link_type?: string;
  error?: string;
};

export async function proposeIdeaLinksHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const reconsider = args.reconsider_rejected ?? false;
  const via = { ...(args.proposed_via ?? {}), credential: credentialLabel(principal) };

  const sql = getDb(env);
  const results: Result[] = [];
  try {
    for (const [index, link] of args.links.entries()) {
      try {
        const shapeErr = endpointError(link.link_type, link);
        if (shapeErr) throw new HandlerError('invalid', shapeErr);

        const r = await sql.begin(async (tx): Promise<Result> => {
          let source = link.source_idea_id.toLowerCase();
          let targetIdea = link.target_idea_id?.toLowerCase() ?? null;
          const targetArtifact = link.target_artifact_id?.toLowerCase() ?? null;
          if (targetIdea) {
            const c = canonicalPair(link.link_type, source, targetIdea);
            source = c.source;
            targetIdea = c.target;
          }

          const owned = await tx<Array<{ id: string }>>`
            SELECT id, now() AS as_of FROM idea
             WHERE user_id = ${env.BRAIN_USER_ID}
               AND id IN (${source}, ${targetIdea ?? source})
          `;
          const need = targetIdea ? 2 : 1;
          if (owned.length < need) throw new HandlerError('not_found', 'idea endpoint not found');
          if (targetArtifact) {
            const art = await tx`SELECT 1 AS found, now() AS as_of FROM public_artifact WHERE id = ${targetArtifact}`;
            if (art.length === 0) throw new HandlerError('not_found', `public_artifact ${targetArtifact}`);
          }

          // Pair-level memory of the user's negative decisions.
          const pairFilter = targetIdea
            ? tx`LEAST(source_idea_id, target_idea_id) = LEAST(${source}::uuid, ${targetIdea}::uuid)
                 AND GREATEST(source_idea_id, target_idea_id) = GREATEST(${source}::uuid, ${targetIdea}::uuid)`
            : tx`source_idea_id = ${source} AND target_artifact_id = ${targetArtifact}`;
          if (!reconsider) {
            const neg = await tx<Array<{ id: string; status: string; link_type: string }>>`
              SELECT id, status, link_type, now() AS as_of FROM idea_link
               WHERE user_id = ${env.BRAIN_USER_ID} AND ${pairFilter}
                 AND status IN ('rejected', 'retracted')
               LIMIT 1
            `;
            if (neg.length > 0) {
              return {
                index,
                result: 'skipped_rejected',
                link_id: neg[0].id,
                existing_status: neg[0].status,
                existing_link_type: neg[0].link_type,
              };
            }
          }

          const inserted = await tx<Array<{ id: string }>>`
            INSERT INTO idea_link (
              user_id, source_idea_id, target_idea_id, target_artifact_id,
              link_type, rationale, similarity, proposed_by, proposed_via
            ) VALUES (
              ${env.BRAIN_USER_ID}, ${source}, ${targetIdea}, ${targetArtifact},
              ${link.link_type}, ${link.rationale}, ${link.similarity ?? null},
              ${args.origin}, ${jsonParam(tx, via)}
            )
            ON CONFLICT DO NOTHING
            RETURNING id
          `;
          if (inserted.length > 0) return { index, result: 'proposed', link_id: inserted[0].id };

          const existing = await tx<Array<{ id: string; status: string }>>`
            SELECT id, status, now() AS as_of FROM idea_link
             WHERE user_id = ${env.BRAIN_USER_ID} AND ${pairFilter}
               AND link_type = ${link.link_type}
             FOR UPDATE
          `;
          if (existing.length === 0) throw new HandlerError('conflict', 'link exists but could not be read');
          const ex = existing[0];
          const reopenable = ex.status === 'withdrawn' || (reconsider && (ex.status === 'rejected' || ex.status === 'retracted'));
          if (!reopenable) {
            return { index, result: 'skipped_duplicate', link_id: ex.id, existing_status: ex.status };
          }
          await tx`
            UPDATE idea_link SET
              history = history || jsonb_build_array(jsonb_build_object(
                'status', status, 'rationale', rationale, 'link_type', link_type,
                'source_idea_id', source_idea_id, 'decided_at', decided_at,
                'decision_note', decision_note, 'reopened_at', now()
              )),
              source_idea_id = ${source},
              target_idea_id = ${targetIdea},
              status = 'proposed',
              rationale = ${link.rationale},
              similarity = ${link.similarity ?? null},
              proposed_by = ${args.origin},
              proposed_via = ${jsonParam(tx, via)},
              proposed_at = now(),
              decided_at = NULL,
              decision_note = NULL
            WHERE id = ${ex.id}
          `;
          return { index, result: 'reopened', link_id: ex.id, existing_status: ex.status };
        });
        results.push(r);
      } catch (e) {
        const msg =
          e instanceof HandlerError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
        results.push({ index, result: 'error', error: msg });
      }
    }
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }

  const counts: Record<Result['result'], number> = {
    proposed: 0,
    reopened: 0,
    skipped_duplicate: 0,
    skipped_rejected: 0,
    error: 0,
  };
  for (const r of results) counts[r.result]++;
  return ok({
    counts,
    results,
    note: 'Proposals are pending until the user decides. Present them as a numbered list and record exactly their verdicts with decide_idea_links.',
  });
}

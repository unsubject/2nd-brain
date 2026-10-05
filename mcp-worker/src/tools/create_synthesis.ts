import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import type { Principal } from '../auth/principal';
import { getDb } from '../db';
import { truncateChars } from '../ideas/text';
import {
  capturedViaSchema,
  cleanTags,
  credentialLabel,
  dbError,
  errorResult,
  HandlerError,
  ideaIntentSchema,
  ideaStatusSchema,
  jsonParam,
  LIMITS,
  ok,
  tagsSchema,
  textArray,
  uuidArrayLiteral,
} from './idea_shared';

// Combine ideas into something bigger (an episode seed, essay, series…)
// on the user's explicit decision (docs/idea-parking-lot-protocol.md §2).
// The decision itself is the confirmation, so part_of links are written
// as accepted.

const inputSchema = z
  .object({
    title: z.string().min(1).max(LIMITS.title),
    intent: ideaIntentSchema,
    part_ids: z.array(z.string().uuid()).min(2).max(30),
    thoughts: z.string().max(LIMITS.thoughts).optional(),
    framing: z.string().max(LIMITS.framing).optional(),
    why_interesting: z.string().max(LIMITS.why_interesting).optional(),
    tags: tagsSchema.optional(),
    status: ideaStatusSchema.optional(),
    // Trimmed to match the btrim-based CHECK on idea_link.rationale.
    part_rationales: z
      .record(
        z.string().uuid(),
        z
          .string()
          .transform((r) => r.trim())
          .pipe(z.string().min(3).max(300)),
      )
      .optional(),
    captured_via: capturedViaSchema.optional(),
  })
  .strict();

export async function createSynthesisHandler(
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
  const title = args.title.trim();
  if (!title) return errorResult('Invalid arguments: title is blank');
  const partIds = [...new Set(args.part_ids.map((p) => p.toLowerCase()))];
  if (partIds.length < 2) return errorResult('Invalid arguments: a synthesis needs at least 2 distinct parts');
  const rationales = Object.fromEntries(
    Object.entries(args.part_rationales ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const blankToNull = (s: string | undefined) => (s !== undefined && s.trim() !== '' ? s : null);

  const sql = getDb(env);
  try {
    const out = await sql.begin(async (tx) => {
      const found = await tx<Array<{ id: string; title: string; status: string }>>`
        SELECT id, title, status, now() AS as_of FROM idea
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND id = ANY(${uuidArrayLiteral(partIds)}::uuid[])
      `;
      if (found.length !== partIds.length) {
        const have = new Set(found.map((f) => f.id));
        throw new HandlerError('not_found', `parts not found: ${partIds.filter((p) => !have.has(p)).join(', ')}`);
      }

      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO idea (
          user_id, kind, intent, title, status, thoughts, framing, why_interesting,
          tags, captured_via
        ) VALUES (
          ${env.BRAIN_USER_ID}, 'synthesis', ${args.intent}, ${title}, ${args.status ?? 'exploring'},
          ${blankToNull(args.thoughts)}, ${blankToNull(args.framing)}, ${blankToNull(args.why_interesting)},
          ${textArray(tx, cleanTags(args.tags))},
          ${jsonParam(tx, { ...(args.captured_via ?? {}), role: 'gardener', credential: credentialLabel(principal) })}
        )
        RETURNING id
      `;
      const synthesisId = rows[0].id;
      await tx`
        INSERT INTO idea_source (idea_id, user_id, source_system)
        VALUES (${synthesisId}, ${env.BRAIN_USER_ID}, 'gardening')
      `;
      const credential = credentialLabel(principal);
      for (const p of partIds) {
        const rationale = rationales[p] ?? `Included by the user in synthesis "${truncateChars(title, 200)}"`;
        await tx`
          INSERT INTO idea_link (
            user_id, source_idea_id, target_idea_id, link_type, status,
            rationale, proposed_by, proposed_via, decided_at, decided_via
          ) VALUES (
            ${env.BRAIN_USER_ID}, ${p}, ${synthesisId}, 'part_of', 'accepted',
            ${rationale}, 'synthesis', ${jsonParam(tx, { ...(args.captured_via ?? {}), credential })},
            now(), ${jsonParam(tx, { credential })}
          )
        `;
      }
      return { synthesisId, parts: found.map((f) => ({ id: f.id, title: f.title, status: f.status })) };
    });

    return ok({
      synthesis_id: out.synthesisId,
      intent: args.intent,
      parts: out.parts,
      embedding: 'pending',
    });
  } catch (e) {
    if (e instanceof HandlerError) return errorResult(`${e.code}: ${e.message}`);
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

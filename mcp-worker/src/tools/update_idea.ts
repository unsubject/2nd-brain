import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import type { Principal } from '../auth/principal';
import { getDb } from '../db';
import {
  cleanTags,
  credentialLabel,
  dbError,
  errorResult,
  HandlerError,
  ideaIntentSchema,
  ideaStatusSchema,
  isoDateTimeSchema,
  jsonParam,
  LIMITS,
  ok,
  parseJsonb,
  tagsSchema,
  textArray,
  uuidSchema,
  type Note,
} from './idea_shared';

// Tri-state text fields: undefined → leave, null → clear, string → set.
const optText = (max: number) => z.string().max(max).nullable().optional();

const inputSchema = z
  .object({
    id: uuidSchema,
    title: z
      .string()
      .max(LIMITS.title)
      .refine((t) => t.trim().length > 0, 'title cannot be blank')
      .optional(),
    encountered_where: optText(LIMITS.encountered_where),
    source_url: z.string().url().max(LIMITS.source_url).nullable().optional(),
    source_title: optText(LIMITS.source_title),
    source_excerpt: optText(LIMITS.source_excerpt),
    why_interesting: optText(LIMITS.why_interesting),
    framing: optText(LIMITS.framing),
    thoughts: optText(LIMITS.thoughts),
    tags: tagsSchema.optional(),
    add_tags: tagsSchema.optional(),
    remove_tags: tagsSchema.optional(),
    status: ideaStatusSchema.optional(),
    intent: ideaIntentSchema.optional(),
    append_note: z
      .object({
        text: z.string().min(1).max(LIMITS.note),
        by: z.enum(['simon', 'agent']),
        at: isoDateTimeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const TEXT_FIELDS = [
  'encountered_where',
  'source_url',
  'source_title',
  'source_excerpt',
  'why_interesting',
  'framing',
  'thoughts',
] as const;

export async function updateIdeaHandler(
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
  if (args.tags && (args.add_tags || args.remove_tags)) {
    return errorResult('Invalid arguments: use either tags (replace) or add_tags/remove_tags, not both');
  }
  const touched = [
    'title',
    ...TEXT_FIELDS,
    'tags',
    'add_tags',
    'remove_tags',
    'status',
    'intent',
    'append_note',
  ].filter((k) => (args as Record<string, unknown>)[k] !== undefined);
  if (touched.length === 0) return errorResult('No fields to update');

  const sql = getDb(env);
  try {
    const result = await sql.begin(async (tx) => {
      const cur = await tx<
        Array<{ kind: string; status: string; tags: unknown; title: string; embedded: boolean }>
      >`
        SELECT kind, status, to_jsonb(tags) AS tags, title, (embedding IS NOT NULL) AS embedded,
               now() AS as_of
          FROM idea
         WHERE id = ${args.id} AND user_id = ${env.BRAIN_USER_ID}
         FOR UPDATE
      `;
      if (cur.length === 0) throw new HandlerError('not_found', `Idea not found: ${args.id}`);
      const before = cur[0];
      if (args.intent !== undefined && before.kind !== 'synthesis') {
        throw new HandlerError('invalid', 'intent applies only to syntheses');
      }

      const currentTags = parseJsonb<string[]>(before.tags, []);
      let nextTags: string[] | null = null;
      if (args.tags) nextTags = cleanTags(args.tags);
      else if (args.add_tags || args.remove_tags) {
        const remove = new Set(cleanTags(args.remove_tags).map((t) => t.toLowerCase()));
        nextTags = cleanTags([...currentTags, ...cleanTags(args.add_tags)]).filter(
          (t) => !remove.has(t.toLowerCase()),
        );
      }

      const now = new Date().toISOString();
      const credential = credentialLabel(principal);
      const newNotes: Note[] = [];
      if (args.status !== undefined && args.status !== before.status) {
        newNotes.push({ at: now, by: 'system', text: `status: ${before.status} → ${args.status}`, credential });
      }
      if (args.append_note) {
        newNotes.push({
          at: args.append_note.at ?? now,
          by: args.append_note.by,
          text: args.append_note.text,
          credential,
        });
      }

      const omit = (k: (typeof TEXT_FIELDS)[number]) => args[k] === undefined;
      const val = (k: (typeof TEXT_FIELDS)[number]) => (args[k] === undefined ? null : args[k]);

      const rows = await tx<Array<{ embedded: boolean }>>`
        UPDATE idea SET
          title = COALESCE(${args.title?.trim() || null}::text, title),
          encountered_where = CASE WHEN ${omit('encountered_where')} THEN encountered_where ELSE ${val('encountered_where')}::text END,
          source_url        = CASE WHEN ${omit('source_url')} THEN source_url ELSE ${val('source_url')}::text END,
          source_title      = CASE WHEN ${omit('source_title')} THEN source_title ELSE ${val('source_title')}::text END,
          source_excerpt    = CASE WHEN ${omit('source_excerpt')} THEN source_excerpt ELSE ${val('source_excerpt')}::text END,
          why_interesting   = CASE WHEN ${omit('why_interesting')} THEN why_interesting ELSE ${val('why_interesting')}::text END,
          framing           = CASE WHEN ${omit('framing')} THEN framing ELSE ${val('framing')}::text END,
          thoughts          = CASE WHEN ${omit('thoughts')} THEN thoughts ELSE ${val('thoughts')}::text END,
          tags = ${nextTags === null ? tx`tags` : textArray(tx, nextTags)},
          status = COALESCE(${args.status ?? null}::text, status),
          intent = COALESCE(${args.intent ?? null}::text, intent),
          notes = notes || ${jsonParam(tx, newNotes)},
          edit_log = edit_log || ${jsonParam(tx, [{ at: now, credential, tool: 'update_idea', fields: touched }])},
          updated_at = now()
        WHERE id = ${args.id} AND user_id = ${env.BRAIN_USER_ID}
        RETURNING (embedding IS NOT NULL) AS embedded
      `;
      return { embeddedBefore: before.embedded, embeddedAfter: rows[0].embedded };
    });

    return ok({
      ok: true,
      idea_id: args.id,
      changed: touched,
      embedding: result.embeddedBefore && result.embeddedAfter ? 'unchanged' : 'pending',
    });
  } catch (e) {
    if (e instanceof HandlerError) return errorResult(`${e.code}: ${e.message}`);
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

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

// A promotion to the Google Tasks "Subjects" list (refocus D1): Simon or
// Muse writes the task; this only records it. Trimmed to match the
// btrim-based CHECK idea_promoted_pair.
const promotedSchema = z
  .object({
    title: z
      .string()
      .transform((t) => t.trim())
      .pipe(z.string().min(1).max(LIMITS.title)),
    at: isoDateTimeSchema.optional(),
  })
  .strict();

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
    reviewed: z.boolean().optional(),
    promoted: promotedSchema.nullable().optional(),
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
  // Never in the future: a minute of slack for clock skew here, and the
  // stored value is clamped to the database clock below.
  if (args.promoted?.at && Date.parse(args.promoted.at) > Date.now() + 60 * 1000) {
    return errorResult('Invalid arguments: promoted.at is in the future');
  }
  const touched = [
    'title',
    ...TEXT_FIELDS,
    'tags',
    'add_tags',
    'remove_tags',
    'status',
    'intent',
    'reviewed',
    'promoted',
    'append_note',
  ].filter((k) => (args as Record<string, unknown>)[k] !== undefined);
  if (touched.length === 0) return errorResult('No fields to update');

  const sql = getDb(env);
  try {
    const result = await sql.begin(async (tx) => {
      const cur = await tx<
        Array<{
          kind: string;
          status: string;
          tags: unknown;
          title: string;
          embedded: boolean;
          reviewed_at: Date | null;
          promoted_title: string | null;
        }>
      >`
        SELECT kind, status, to_jsonb(tags) AS tags, title, (embedding IS NOT NULL) AS embedded,
               reviewed_at, promoted_title, now() AS as_of
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

      // Recording a promotion moves a parked or composted idea to
      // exploring (refocus D15); an explicit status in the same call wins.
      const nextStatus =
        args.status ??
        (args.promoted && (before.status === 'parked' || before.status === 'composted') ? 'exploring' : undefined);
      // A promotion is a review decision, so it also takes the idea out of
      // the inbox; an explicit `reviewed` in the same call wins.
      const reviewedAt =
        args.reviewed === true
          ? tx`now()`
          : args.reviewed === false
            ? tx`NULL`
            : args.promoted
              ? tx`COALESCE(reviewed_at, now())`
              : tx`reviewed_at`;
      const fields = [
        ...touched,
        ...(args.status === undefined && nextStatus !== undefined && nextStatus !== before.status ? ['status'] : []),
        ...(args.reviewed === undefined && args.promoted && before.reviewed_at === null ? ['reviewed'] : []),
      ];

      const now = new Date().toISOString();
      const credential = credentialLabel(principal);
      const newNotes: Note[] = [];
      if (args.promoted) {
        newNotes.push({ at: now, by: 'system', text: `promoted to Subjects as "${args.promoted.title}"`, credential });
      } else if (args.promoted === null && before.promoted_title !== null) {
        newNotes.push({ at: now, by: 'system', text: `promotion cleared (was "${before.promoted_title}")`, credential });
      }
      if (nextStatus !== undefined && nextStatus !== before.status) {
        newNotes.push({ at: now, by: 'system', text: `status: ${before.status} → ${nextStatus}`, credential });
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
          status = COALESCE(${nextStatus ?? null}::text, status),
          intent = COALESCE(${args.intent ?? null}::text, intent),
          reviewed_at = ${reviewedAt},
          promoted_at = ${
            args.promoted === undefined
              ? tx`promoted_at`
              : args.promoted === null
                ? tx`NULL`
                : tx`LEAST(COALESCE(${args.promoted.at ?? null}::timestamptz, now()), now())`
          },
          promoted_title = ${
            args.promoted === undefined ? tx`promoted_title` : tx`${args.promoted?.title ?? null}::text`
          },
          notes = notes || ${jsonParam(tx, newNotes)},
          edit_log = edit_log || ${jsonParam(tx, [{ at: now, credential, tool: 'update_idea', fields }])},
          updated_at = now()
        WHERE id = ${args.id} AND user_id = ${env.BRAIN_USER_ID}
        RETURNING (embedding IS NOT NULL) AS embedded
      `;

      // A composted idea is set aside, so proposals waiting on it are taken
      // back the way decide_idea_links withdraws them. Accepted links stay.
      // Runs whenever composted is sent, so composting again also clears
      // proposals made on an idea that was already composted.
      let withdrawn: number | undefined;
      if (nextStatus === 'composted') {
        const w = await tx`
          UPDATE idea_link SET
            status = 'withdrawn',
            decided_at = now(),
            decided_via = ${jsonParam(tx, { credential })},
            decision_note = 'endpoint composted'
          WHERE user_id = ${env.BRAIN_USER_ID}
            AND status = 'proposed'
            AND (source_idea_id = ${args.id} OR target_idea_id = ${args.id})
          RETURNING id
        `;
        withdrawn = w.length;
      }
      return { embeddedBefore: before.embedded, embeddedAfter: rows[0].embedded, fields, withdrawn };
    });

    return ok({
      ok: true,
      idea_id: args.id,
      changed: result.fields,
      embedding: result.embeddedBefore && result.embeddedAfter ? 'unchanged' : 'pending',
      ...(result.withdrawn !== undefined ? { withdrawn_proposals: result.withdrawn } : {}),
    });
  } catch (e) {
    if (e instanceof HandlerError) return errorResult(`${e.code}: ${e.message}`);
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import type { Principal } from '../auth/principal';
import { getDb } from '../db';
import { isValidTimeZone, parseCapturedAt, parseUtcOffset, splitDatedNotes, type LocalZone } from '../ideas/parse';
import { normalizeTags } from '../ideas/text';
import {
  capturedViaSchema,
  cleanTags,
  credentialLabel,
  errorResult,
  HandlerError,
  ideaStatusSchema,
  jsonParam,
  LIMITS,
  ok,
  parseJsonb,
  tagsSchema,
  textArray,
  toIso,
  uuidSchema,
  withdrawProposalsOf,
  type Note,
} from './idea_shared';

// One-time import (docs/idea-parking-lot-protocol.md §4). The agent maps
// each source row to these fields; the raw row travels in import_payload
// so nothing is lost. Idempotent on (user, source_system, source_external_id).
// Items are validated one by one, so a bad row never sinks its batch.
//
// Subjects items are recorded as promoted (refocus D1, D2), from the
// synced task rather than from anything the agent sends: promoted_at is
// the task's first_synced_at (task_ref.created_at, which the protocol
// also sends as captured_at) and promoted_title is the task title. The
// first promotion on an idea is kept. Recording one moves a parked or
// composted idea to exploring unless the item carries a status (D15).
// Unlike update_idea, the import leaves reviewed_at alone: every imported
// idea starts in the inbox (§4, D14). Phase 7 drops task_ref, so this
// lookup goes before that migration does.

const itemSchema = z
  .object({
    source_external_id: z.string().min(1).max(500),
    import_payload: z.record(z.unknown()),
    merge_into_idea_id: uuidSchema.optional(),
    title: z.string().min(1).max(LIMITS.title).optional(),
    captured_at: z.string().max(100).optional(),
    encountered_where: z.string().max(LIMITS.encountered_where).optional(),
    source_url: z.string().url().max(LIMITS.source_url).optional(),
    source_title: z.string().max(LIMITS.source_title).optional(),
    source_excerpt: z.string().max(LIMITS.source_excerpt).optional(),
    why_interesting: z.string().max(LIMITS.why_interesting).optional(),
    framing: z.string().max(LIMITS.framing).optional(),
    thoughts: z.string().max(LIMITS.thoughts).optional(),
    tags: tagsSchema.optional(),
    status: ideaStatusSchema.optional(),
    notes_raw: z.string().max(40000).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    source_system: z.enum(['notion', 'gtasks_subjects']),
    timezone: z.string().min(1).max(64).optional(),
    default_utc_offset: z.string().max(10).optional(),
    captured_via: capturedViaSchema.optional(),
    items: z.array(z.unknown()).min(1).max(25),
  })
  .strict();

type Item = z.infer<typeof itemSchema>;
type ItemResult = {
  index: number;
  source_external_id: string | null;
  result: 'created' | 'merged' | 'already_imported' | 'error';
  idea_id?: string;
  // Subjects items only: whether this call recorded the promotion, the
  // idea already had one, or someone cleared it with update_idea and the
  // import leaves it cleared. Absent for a subtask merged into its
  // parent's idea.
  promotion?: 'recorded' | 'already_recorded' | 'cleared';
  error?: string;
};

const SOURCE_LABEL: Record<string, string> = {
  notion: 'Notion Idea Parking Lot',
  gtasks_subjects: 'Google Tasks "Subjects" list',
};

export async function importIdeasHandler(
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
  let zone: LocalZone;
  if (args.timezone) {
    if (!isValidTimeZone(args.timezone)) {
      return errorResult(`Invalid arguments: unknown timezone "${args.timezone}" (use an IANA name such as "Europe/London")`);
    }
    zone = { timeZone: args.timezone };
  } else {
    const offset = args.default_utc_offset ?? '+00:00';
    if (parseUtcOffset(offset) === null) {
      return errorResult(`Invalid arguments: default_utc_offset "${offset}" (use e.g. "+08:00", "-05:00" or "Z")`);
    }
    zone = { offset };
  }
  const capturedVia = { ...(args.captured_via ?? {}), role: 'importer', credential: credentialLabel(principal) };
  // gtasks notes are the user's own words; Notion notes were mostly AI-written.
  const noteBy: Note['by'] = args.source_system === 'gtasks_subjects' ? 'simon' : 'import';

  const sql = getDb(env);
  const results: ItemResult[] = [];
  try {
    for (const [index, raw] of args.items.entries()) {
      const ext =
        raw && typeof raw === 'object' && typeof (raw as { source_external_id?: unknown }).source_external_id === 'string'
          ? ((raw as { source_external_id: string }).source_external_id as string)
          : null;
      const item = itemSchema.safeParse(raw);
      if (!item.success) {
        results.push({ index, source_external_id: ext, result: 'error', error: `invalid item: ${item.error.message}` });
        continue;
      }
      try {
        results.push({
          index,
          ...(await importOne(sql, env, item.data, args.source_system, zone, capturedVia, noteBy)),
        });
      } catch (e) {
        const msg =
          e instanceof HandlerError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
        results.push({ index, source_external_id: ext, result: 'error', error: msg });
      }
    }
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }

  const counts = { created: 0, merged: 0, already_imported: 0, error: 0, promoted: 0 };
  for (const r of results) {
    counts[r.result]++;
    if (r.promotion === 'recorded') counts.promoted++;
  }
  return ok({ source_system: args.source_system, counts, results });
}

// A Subjects task as the Google sync stored it. The same rows as
// list_subjects_for_import: task_ref is written with user_id 'default',
// so it is not filtered on BRAIN_USER_ID. parent_idea_id is the idea a
// subtask's parent was imported into, if it was.
type SubjectsTask = { title: string; first_synced_at: Date | string; parent_idea_id: string | null };

async function findSubjectsTask(sql: ReturnType<typeof getDb>, userId: string, ext: string): Promise<SubjectsTask | null> {
  const rows = await sql<Array<SubjectsTask>>`
    SELECT t.title, t.created_at AS first_synced_at, ps.idea_id AS parent_idea_id, now() AS as_of
      FROM task_ref t
      JOIN project_ref p ON p.id = t.project_ref_id AND p.list_type = 'subjects'
      LEFT JOIN idea_source ps
             ON ps.user_id = ${userId}
            AND ps.source_system = 'gtasks_subjects'
            AND ps.source_external_id = t.parent_external_task_id
     WHERE t.external_task_id = ${ext}
       AND t.scope = 'personal'
  `;
  return rows[0] ?? null;
}

type Promotion = { title: string; at: string };

// Trimmed and cut to LIMITS.title characters (code points, as Postgres
// counts them), so the idea_promoted_pair CHECK holds even for a longer
// Google Tasks title. The full title stays in import_payload.
function promotionTitle(s: string | undefined): string {
  return Array.from((s ?? '').trim()).slice(0, LIMITS.title).join('').trim();
}

// What a Subjects item records on `ideaId` (null for a new idea). A
// subtask merged into its parent's idea records nothing: the parent's own
// promotion stands. Anywhere else it records its own.
function promotionFor(task: SubjectsTask, item: Item, ideaId: string | null): Promotion | null {
  if (task.parent_idea_id !== null && task.parent_idea_id === ideaId) return null;
  const title = promotionTitle(task.title) || promotionTitle(item.title);
  if (!title) throw new HandlerError('invalid', 'the Subjects task has a blank title: send a title to record its promotion');
  return { title, at: toIso(task.first_synced_at) };
}

const promotionNote = (title: string) => `promoted to Subjects as "${title}" (Subjects import)`;

// An edit_log entry that set or cleared the promotion (update_idea logs
// every change to it). Neither a merge nor a re-sent item brings back a
// promotion the user cleared.
const PROMOTION_EDITED = [{ fields: ['promoted'] }];

type PromotionPlan = { status: string; fields: string[]; notes: Note[] };

// The change that recording `promo` makes to an existing idea, or null
// when the idea already has a promotion (the first one is kept).
function planPromotion(
  before: { status: string; promoted: boolean },
  promo: Promotion,
  explicitStatus: string | undefined,
  credential: string,
  at: string,
): PromotionPlan | null {
  if (before.promoted) return null;
  const status =
    explicitStatus ?? (before.status === 'parked' || before.status === 'composted' ? 'exploring' : before.status);
  const notes: Note[] = [{ at, by: 'system', text: promotionNote(promo.title), credential }];
  const fields = ['promoted'];
  if (status !== before.status) {
    notes.push({ at, by: 'system', text: `status: ${before.status} → ${status}`, credential });
    fields.push('status');
  }
  return { status, fields, notes };
}

async function importOne(
  sql: ReturnType<typeof getDb>,
  env: Env,
  item: Item,
  sourceSystem: 'notion' | 'gtasks_subjects',
  zone: LocalZone,
  capturedVia: Record<string, unknown>,
  noteBy: Note['by'],
): Promise<Omit<ItemResult, 'index'>> {
  const ext = item.source_external_id;
  let capturedAt: string | null = null;
  if (item.captured_at !== undefined && item.captured_at.trim() !== '') {
    capturedAt = parseCapturedAt(item.captured_at, zone);
    if (!capturedAt) throw new HandlerError('invalid_date', `unparseable captured_at "${item.captured_at}"`);
  }

  const credential = capturedVia.credential as string;
  const nowIso = new Date().toISOString();

  const already = await sql<Array<{ idea_id: string; promoted: boolean; edited: boolean }>>`
    SELECT s.idea_id, (i.promoted_at IS NOT NULL) AS promoted,
           COALESCE(i.edit_log @> ${jsonParam(sql, PROMOTION_EDITED)}, false) AS edited,
           now() AS as_of
      FROM idea_source s
      LEFT JOIN idea i ON i.id = s.idea_id
     WHERE s.user_id = ${env.BRAIN_USER_ID}
       AND s.source_system = ${sourceSystem}
       AND s.source_external_id = ${ext}
  `;
  const task = sourceSystem === 'gtasks_subjects' ? await findSubjectsTask(sql, env.BRAIN_USER_ID, ext) : null;
  if (already.length > 0) {
    const { idea_id, promoted, edited } = already[0];
    const done = { source_external_id: ext, result: 'already_imported' as const, idea_id };
    const promo = task ? promotionFor(task, item, idea_id) : null;
    if (!promo) return done;
    if (promoted) return { ...done, promotion: 'already_recorded' as const };
    if (edited) return { ...done, promotion: 'cleared' as const };
    // Imported by a pass that did not record promotions yet: record it now,
    // under the status rule alone. The item's status was that pass's to
    // apply, and the user may have changed the status since.
    const outcome = await sql.begin(async (tx): Promise<'recorded' | 'already_recorded' | 'cleared'> => {
      const cur = await tx<Array<{ status: string; promoted: boolean; edited: boolean }>>`
        SELECT status, (promoted_at IS NOT NULL) AS promoted,
               (edit_log @> ${jsonParam(tx, PROMOTION_EDITED)}) AS edited, now() AS as_of
          FROM idea WHERE id = ${idea_id} AND user_id = ${env.BRAIN_USER_ID}
         FOR UPDATE
      `;
      if (cur.length > 0 && !cur[0].promoted && cur[0].edited) return 'cleared';
      const plan = cur.length > 0 ? planPromotion(cur[0], promo, undefined, credential, nowIso) : null;
      if (!plan) return 'already_recorded';
      await tx`
        UPDATE idea SET
          status = ${plan.status},
          promoted_at = LEAST(${promo.at}::timestamptz, now()),
          promoted_title = ${promo.title},
          notes = notes || ${jsonParam(tx, plan.notes)},
          edit_log = edit_log || ${jsonParam(tx, [{ at: nowIso, credential, tool: 'import_ideas', fields: plan.fields }])},
          updated_at = now()
        WHERE id = ${idea_id}
      `;
      if (plan.status === 'composted') await withdrawProposalsOf(tx, env.BRAIN_USER_ID, idea_id, credential);
      return 'recorded';
    });
    return { ...done, promotion: outcome };
  }
  if (sourceSystem === 'gtasks_subjects' && !task) {
    throw new HandlerError('not_found', 'no synced Subjects task has this source_external_id (see list_subjects_for_import)');
  }

  const tags = cleanTags(item.tags);

  try {
    if (item.merge_into_idea_id) {
      const target = item.merge_into_idea_id;
      const promo = task ? promotionFor(task, item, target) : null;
      return await sql.begin(async (tx) => {
        const found = await tx<Array<{ id: string; tags: unknown; status: string; promoted: boolean; edited: boolean }>>`
          SELECT id, to_jsonb(tags) AS tags, status, (promoted_at IS NOT NULL) AS promoted,
                 (edit_log @> ${jsonParam(tx, PROMOTION_EDITED)}) AS edited, now() AS as_of
            FROM idea WHERE id = ${target} AND user_id = ${env.BRAIN_USER_ID}
           FOR UPDATE
        `;
        if (found.length === 0) throw new HandlerError('not_found', `merge target idea ${target}`);
        // Case-insensitive, order-preserving union (existing tags first).
        const mergedTags = normalizeTags([...parseJsonb<string[]>(found[0].tags, []), ...tags]);

        const parts = [`[Merged from ${SOURCE_LABEL[sourceSystem]}] ${item.title ?? ''}`.trimEnd()];
        if (item.thoughts && item.thoughts.trim()) parts.push(item.thoughts);
        if (item.notes_raw && item.notes_raw.trim()) parts.push(item.notes_raw);
        const note: Note = { at: capturedAt ?? nowIso, by: noteBy, text: parts.join('\n\n'), credential };
        // item.status applies to a merge only with the promotion it records.
        const cleared = promo !== null && !found[0].promoted && found[0].edited;
        const plan = promo && !cleared ? planPromotion(found[0], promo, item.status, credential, nowIso) : null;

        await tx`
          UPDATE idea SET
            captured_at = CASE
              WHEN ${capturedAt}::timestamptz IS NULL THEN captured_at
              ELSE LEAST(captured_at, ${capturedAt}::timestamptz)
            END,
            tags = ${textArray(tx, mergedTags)},
            status = COALESCE(${plan?.status ?? null}::text, status),
            promoted_at = ${plan && promo ? tx`LEAST(${promo.at}::timestamptz, now())` : tx`promoted_at`},
            promoted_title = ${plan && promo ? tx`${promo.title}::text` : tx`promoted_title`},
            notes = notes || ${jsonParam(tx, [note, ...(plan?.notes ?? [])])},
            edit_log = edit_log || ${jsonParam(tx, [
              { at: nowIso, credential, tool: 'import_ideas', ...(plan ? { fields: plan.fields } : {}) },
            ])},
            updated_at = now()
          WHERE id = ${target}
        `;
        if (plan?.status === 'composted') await withdrawProposalsOf(tx, env.BRAIN_USER_ID, target, credential);
        await tx`
          INSERT INTO idea_source (idea_id, user_id, source_system, source_external_id, import_payload, merged)
          VALUES (${target}, ${env.BRAIN_USER_ID}, ${sourceSystem}, ${ext}, ${jsonParam(tx, item.import_payload)}, true)
        `;
        return {
          source_external_id: ext,
          result: 'merged' as const,
          idea_id: target,
          ...(promo
            ? { promotion: plan ? ('recorded' as const) : cleared ? ('cleared' as const) : ('already_recorded' as const) }
            : {}),
        };
      });
    }

    const title = item.title?.trim();
    if (!title) throw new HandlerError('invalid', 'title is required unless merge_into_idea_id is given');

    const promo = task ? promotionFor(task, item, null) : null;
    const notes: Note[] = item.notes_raw
      ? splitDatedNotes(item.notes_raw, capturedAt ?? nowIso, zone).map((n) => ({ ...n, by: noteBy, credential }))
      : [];
    if (promo) notes.push({ at: nowIso, by: 'system', text: promotionNote(promo.title), credential });
    const blankToNull = (s: string | undefined) => (s !== undefined && s.trim() !== '' ? s : null);

    return await sql.begin(async (tx) => {
      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO idea (
          user_id, title, status, captured_at, encountered_where,
          source_url, source_title, source_excerpt, why_interesting,
          framing, thoughts, tags, notes, captured_via,
          promoted_at, promoted_title
        ) VALUES (
          ${env.BRAIN_USER_ID}, ${title}, ${item.status ?? (promo ? 'exploring' : 'parked')},
          COALESCE(${capturedAt}::timestamptz, now()),
          ${blankToNull(item.encountered_where)}, ${blankToNull(item.source_url)},
          ${blankToNull(item.source_title)}, ${blankToNull(item.source_excerpt)},
          ${blankToNull(item.why_interesting)}, ${blankToNull(item.framing)},
          ${blankToNull(item.thoughts)}, ${textArray(tx, tags)},
          ${jsonParam(tx, notes)}, ${jsonParam(tx, capturedVia)},
          ${promo ? tx`LEAST(${promo.at}::timestamptz, now())` : tx`NULL`}, ${promo?.title ?? null}
        )
        RETURNING id
      `;
      await tx`
        INSERT INTO idea_source (idea_id, user_id, source_system, source_external_id, import_payload)
        VALUES (${rows[0].id}, ${env.BRAIN_USER_ID}, ${sourceSystem}, ${ext}, ${jsonParam(tx, item.import_payload)})
      `;
      return {
        source_external_id: ext,
        result: 'created' as const,
        idea_id: rows[0].id,
        ...(promo ? { promotion: 'recorded' as const } : {}),
      };
    });
  } catch (e) {
    // A concurrent run imported the same source key first.
    if ((e as { code?: string }).code === '23505') {
      const again = await sql<Array<{ idea_id: string }>>`
        SELECT idea_id, now() AS as_of FROM idea_source
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND source_system = ${sourceSystem}
           AND source_external_id = ${ext}
      `;
      if (again.length > 0) {
        return { source_external_id: ext, result: 'already_imported', idea_id: again[0].idea_id };
      }
    }
    throw e;
  }
}

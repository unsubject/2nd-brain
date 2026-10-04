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
  uuidSchema,
  type Note,
} from './idea_shared';

// One-time import (docs/idea-parking-lot-protocol.md §4). The agent maps
// each source row to these fields; the raw row travels in import_payload
// so nothing is lost. Idempotent on (user, source_system, source_external_id).
// Items are validated one by one, so a bad row never sinks its batch.

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
  principal?: Principal,
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

  const counts = { created: 0, merged: 0, already_imported: 0, error: 0 };
  for (const r of results) counts[r.result]++;
  return ok({ source_system: args.source_system, counts, results });
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

  const already = await sql<Array<{ idea_id: string }>>`
    SELECT idea_id, now() AS as_of FROM idea_source
     WHERE user_id = ${env.BRAIN_USER_ID}
       AND source_system = ${sourceSystem}
       AND source_external_id = ${ext}
  `;
  if (already.length > 0) {
    return { source_external_id: ext, result: 'already_imported', idea_id: already[0].idea_id };
  }

  const tags = cleanTags(item.tags);
  const nowIso = new Date().toISOString();

  try {
    if (item.merge_into_idea_id) {
      const target = item.merge_into_idea_id;
      return await sql.begin(async (tx) => {
        const found = await tx<Array<{ id: string; tags: unknown }>>`
          SELECT id, to_jsonb(tags) AS tags, now() AS as_of
            FROM idea WHERE id = ${target} AND user_id = ${env.BRAIN_USER_ID}
           FOR UPDATE
        `;
        if (found.length === 0) throw new HandlerError('not_found', `merge target idea ${target}`);
        // Case-insensitive, order-preserving union (existing tags first).
        const mergedTags = normalizeTags([...parseJsonb<string[]>(found[0].tags, []), ...tags]);

        const parts = [`[Merged from ${SOURCE_LABEL[sourceSystem]}] ${item.title ?? ''}`.trimEnd()];
        if (item.thoughts && item.thoughts.trim()) parts.push(item.thoughts);
        if (item.notes_raw && item.notes_raw.trim()) parts.push(item.notes_raw);
        const note: Note = { at: capturedAt ?? nowIso, by: noteBy, text: parts.join('\n\n') };

        await tx`
          UPDATE idea SET
            captured_at = CASE
              WHEN ${capturedAt}::timestamptz IS NULL THEN captured_at
              ELSE LEAST(captured_at, ${capturedAt}::timestamptz)
            END,
            tags = ${textArray(tx, mergedTags)},
            notes = notes || ${jsonParam(tx, [note])},
            updated_at = now()
          WHERE id = ${target}
        `;
        await tx`
          INSERT INTO idea_source (idea_id, user_id, source_system, source_external_id, import_payload, merged)
          VALUES (${target}, ${env.BRAIN_USER_ID}, ${sourceSystem}, ${ext}, ${jsonParam(tx, item.import_payload)}, true)
        `;
        return { source_external_id: ext, result: 'merged' as const, idea_id: target };
      });
    }

    const title = item.title?.trim();
    if (!title) throw new HandlerError('invalid', 'title is required unless merge_into_idea_id is given');

    const notes: Note[] = item.notes_raw
      ? splitDatedNotes(item.notes_raw, capturedAt ?? nowIso, zone).map((n) => ({ ...n, by: noteBy }))
      : [];
    const blankToNull = (s: string | undefined) => (s !== undefined && s.trim() !== '' ? s : null);

    return await sql.begin(async (tx) => {
      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO idea (
          user_id, title, status, captured_at, encountered_where,
          source_url, source_title, source_excerpt, why_interesting,
          framing, thoughts, tags, notes, captured_via
        ) VALUES (
          ${env.BRAIN_USER_ID}, ${title}, ${item.status ?? 'parked'},
          COALESCE(${capturedAt}::timestamptz, now()),
          ${blankToNull(item.encountered_where)}, ${blankToNull(item.source_url)},
          ${blankToNull(item.source_title)}, ${blankToNull(item.source_excerpt)},
          ${blankToNull(item.why_interesting)}, ${blankToNull(item.framing)},
          ${blankToNull(item.thoughts)}, ${textArray(tx, tags)},
          ${jsonParam(tx, notes)}, ${jsonParam(tx, capturedVia)}
        )
        RETURNING id
      `;
      await tx`
        INSERT INTO idea_source (idea_id, user_id, source_system, source_external_id, import_payload)
        VALUES (${rows[0].id}, ${env.BRAIN_USER_ID}, ${sourceSystem}, ${ext}, ${jsonParam(tx, item.import_payload)})
      `;
      return { source_external_id: ext, result: 'created' as const, idea_id: rows[0].id };
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

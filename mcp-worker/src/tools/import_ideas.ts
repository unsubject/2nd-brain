import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { parseCapturedAt, parseUtcOffset, splitDatedNotes } from '../ideas/parse';
import {
  capturedViaSchema,
  cleanTags,
  errorResult,
  ideaStatusSchema,
  ok,
  tagsSchema,
  textArray,
  HandlerError,
  jsonParam,
  type Note,
} from './idea_shared';

// One-time import (docs/idea-parking-lot-protocol.md §4). The agent maps
// each source row to these fields; the raw row travels in import_payload
// so nothing is lost. Idempotent on (user, source_system, source_external_id).

const itemSchema = z
  .object({
    source_external_id: z.string().min(1).max(500),
    import_payload: z.record(z.unknown()),
    merge_into_idea_id: z.string().uuid().optional(),
    title: z.string().min(1).max(500).optional(),
    captured_at: z.string().max(100).optional(),
    encountered_where: z.string().max(2000).optional(),
    source_url: z.string().url().max(2048).optional(),
    source_title: z.string().max(1000).optional(),
    source_excerpt: z.string().max(8000).optional(),
    why_interesting: z.string().max(8000).optional(),
    framing: z.string().max(12000).optional(),
    thoughts: z.string().max(20000).optional(),
    tags: tagsSchema.optional(),
    status: ideaStatusSchema.optional(),
    notes_raw: z.string().max(40000).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    source_system: z.enum(['notion', 'gtasks_subjects']),
    default_utc_offset: z.string().max(10).optional(),
    captured_via: capturedViaSchema.optional(),
    items: z.array(itemSchema).min(1).max(25),
  })
  .strict();

type Item = z.infer<typeof itemSchema>;
type ItemResult = {
  source_external_id: string;
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
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const offset = args.default_utc_offset ?? '+00:00';
  if (parseUtcOffset(offset) === null) {
    return errorResult(`Invalid arguments: default_utc_offset "${offset}" (use e.g. "+08:00", "-05:00" or "Z")`);
  }
  const capturedVia = { ...(args.captured_via ?? {}), role: 'importer' };
  // gtasks notes are the user's own words; Notion notes were mostly AI-written.
  const noteBy: Note['by'] = args.source_system === 'gtasks_subjects' ? 'simon' : 'import';

  const sql = getDb(env);
  const results: ItemResult[] = [];
  try {
    for (const item of args.items) {
      try {
        results.push(await importOne(sql, env, item, args.source_system, offset, capturedVia, noteBy));
      } catch (e) {
        const msg =
          e instanceof HandlerError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
        results.push({ source_external_id: item.source_external_id, result: 'error', error: msg });
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
  offset: string,
  capturedVia: Record<string, unknown>,
  noteBy: Note['by'],
): Promise<ItemResult> {
  const ext = item.source_external_id;
  let capturedAt: string | null = null;
  if (item.captured_at !== undefined && item.captured_at.trim() !== '') {
    capturedAt = parseCapturedAt(item.captured_at, offset);
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
        const found = await tx<Array<{ id: string }>>`
          SELECT id FROM idea WHERE id = ${target} AND user_id = ${env.BRAIN_USER_ID} FOR UPDATE
        `;
        if (found.length === 0) throw new HandlerError('not_found', `merge target idea ${target}`);

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
            tags = ARRAY(SELECT DISTINCT unnest(tags || ${textArray(tx, tags)})),
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
      ? splitDatedNotes(item.notes_raw, capturedAt ?? nowIso).map((n) => ({ ...n, by: noteBy }))
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

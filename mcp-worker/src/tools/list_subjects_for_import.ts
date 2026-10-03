import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { titlesLikelySame } from '../ideas/text';
import { dbError, errorResult, ok, parseJsonb, toIso, toIsoOrNull } from './idea_shared';

// Read-only source listing for the one-time Subjects import
// (docs/idea-parking-lot-protocol.md §4). task_ref / project_ref rows are
// written by the Google sync with user_id 'default', so this deliberately
// does NOT filter task rows on BRAIN_USER_ID; idea rows are still scoped.

const inputSchema = z
  .object({
    include_completed: z.boolean().optional(),
    only_not_imported: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export async function listSubjectsForImportHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const includeCompleted = parsed.data.include_completed ?? true;
  const onlyNotImported = parsed.data.only_not_imported ?? false;
  const limit = parsed.data.limit ?? 100;
  const offset = parsed.data.offset ?? 0;

  const sql = getDb(env);
  try {
    const rows = await sql<
      Array<{
        external_task_id: string;
        title: string;
        notes: string | null;
        status: string;
        completed_at: Date | null;
        due_at: Date | null;
        first_synced_at: Date;
        list_title: string;
        parent_external_task_id: string | null;
        parent_title: string | null;
        imported_idea_id: string | null;
        total: string | number;
        as_of: Date;
      }>
    >`
      SELECT t.external_task_id, t.title, t.notes, t.status, t.completed_at, t.due_at,
             t.created_at AS first_synced_at, p.name AS list_title,
             t.parent_external_task_id, parent.title AS parent_title,
             s.idea_id AS imported_idea_id,
             count(*) OVER () AS total,
             now() AS as_of
        FROM task_ref t
        JOIN project_ref p ON p.id = t.project_ref_id AND p.list_type = 'subjects'
        LEFT JOIN task_ref parent
               ON parent.external_system = t.external_system
              AND parent.external_task_id = t.parent_external_task_id
        LEFT JOIN idea_source s
               ON s.user_id = ${env.BRAIN_USER_ID}
              AND s.source_system = 'gtasks_subjects'
              AND s.source_external_id = t.external_task_id
       WHERE t.scope = 'personal'
         AND ${includeCompleted ? sql`TRUE` : sql`t.status <> 'completed'`}
         AND ${onlyNotImported ? sql`s.idea_id IS NULL` : sql`TRUE`}
       ORDER BY t.parent_external_task_id NULLS FIRST, t.created_at, t.external_task_id
       LIMIT ${limit} OFFSET ${offset}
    `;

    // Title-level duplicate hints against every idea already filed
    // (e.g. Notion rows that originally came from Google Tasks).
    const ideas = await sql<Array<{ id: string; title: string; source_systems: unknown }>>`
      SELECT i.id, i.title,
             COALESCE(
               (SELECT jsonb_agg(DISTINCT s.source_system) FROM idea_source s WHERE s.idea_id = i.id),
               '[]'::jsonb
             ) AS source_systems,
             now() AS as_of
        FROM idea i
       WHERE i.user_id = ${env.BRAIN_USER_ID}
    `;

    const tasks = rows.map((r) => {
      const possible = r.imported_idea_id
        ? []
        : ideas
            .filter((i) => titlesLikelySame(i.title, r.title))
            .map((i) => ({
              idea_id: i.id,
              title: i.title,
              source_systems: parseJsonb<string[]>(i.source_systems, []),
            }));
      return {
        external_task_id: r.external_task_id,
        title: r.title,
        notes: r.notes,
        status: r.status,
        completed_at: toIsoOrNull(r.completed_at),
        due_at: toIsoOrNull(r.due_at),
        first_synced_at: toIso(r.first_synced_at),
        list_title: r.list_title,
        parent_external_task_id: r.parent_external_task_id,
        parent_title: r.parent_title,
        already_imported: r.imported_idea_id !== null,
        imported_idea_id: r.imported_idea_id,
        possible_duplicates: possible,
      };
    });

    return ok({
      as_of: rows[0]?.as_of ? toIso(rows[0].as_of) : new Date().toISOString(),
      total: rows.length > 0 ? Number(rows[0].total) : 0,
      count: tasks.length,
      offset,
      note:
        'first_synced_at is when 2nd-brain first synced the task, not when it was created in Google Tasks (Google does not expose that). due_at is shown for context only — ideas have no due dates.',
      tasks,
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

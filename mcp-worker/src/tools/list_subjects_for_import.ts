import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { titleMatch, type TitleMatch } from '../ideas/text';
import { dbError, errorResult, ok, parseJsonb, toIso, toIsoOrNull } from './idea_shared';

// Read-only source listing for the one-time Subjects import
// (docs/idea-parking-lot-protocol.md §4). task_ref / project_ref rows are
// written by the Google sync with user_id 'default', so this deliberately
// does NOT filter task rows on BRAIN_USER_ID; idea rows are still scoped.

const inputSchema = z
  .object({
    include_completed: z.boolean().optional(),
    only_not_imported: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

// The better of an idea's two titles for a task title: exact beats
// contains, and the idea's own title wins a tie.
function bestMatch(
  i: { title: string; promoted_title: string | null },
  taskTitle: string,
): { match: TitleMatch; matched_on: 'title' | 'promoted_title' } | null {
  const byTitle = titleMatch(i.title, taskTitle);
  const byPromoted = i.promoted_title ? titleMatch(i.promoted_title, taskTitle) : null;
  if (byTitle && (byTitle === 'exact' || byPromoted !== 'exact')) return { match: byTitle, matched_on: 'title' };
  if (byPromoted) return { match: byPromoted, matched_on: 'promoted_title' };
  return null;
}

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
  const limit = parsed.data.limit ?? 200;
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
        last_seen_at: Date;
        stale: boolean;
        list_title: string;
        parent_external_task_id: string | null;
        parent_title: string | null;
        imported_idea_id: string | null;
        imported_promoted_at: Date | null;
        imported_promoted_title: string | null;
        total: string | number;
        as_of: Date;
      }>
    >`
      SELECT t.external_task_id, t.title, t.notes, t.status, t.completed_at, t.due_at,
             t.created_at AS first_synced_at, t.updated_at AS last_seen_at,
             -- Every sync stamps the list, then each task it still returns;
             -- a task older than its list's stamp was not in the latest sync
             -- (deleted or moved in Google Tasks).
             (t.updated_at < p.updated_at) AS stale,
             p.name AS list_title,
             t.parent_external_task_id, parent.title AS parent_title,
             s.idea_id AS imported_idea_id,
             ii.promoted_at AS imported_promoted_at, ii.promoted_title AS imported_promoted_title,
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
        LEFT JOIN idea ii ON ii.id = s.idea_id AND ii.user_id = ${env.BRAIN_USER_ID}
       WHERE t.scope = 'personal'
         AND ${includeCompleted ? sql`TRUE` : sql`t.status <> 'completed'`}
         AND ${onlyNotImported ? sql`s.idea_id IS NULL` : sql`TRUE`}
       ORDER BY t.parent_external_task_id NULLS FIRST, t.created_at, t.external_task_id
       LIMIT ${limit} OFFSET ${offset}
    `;

    // Title-level duplicate hints against every idea already filed
    // (e.g. Notion rows that originally came from Google Tasks), on its
    // title or on the task title an earlier promotion recorded.
    const ideas = await sql<
      Array<{ id: string; title: string; promoted_at: Date | null; promoted_title: string | null; source_systems: unknown }>
    >`
      SELECT i.id, i.title, i.promoted_at, i.promoted_title,
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
            .flatMap((i) => {
              const m = bestMatch(i, r.title);
              return m ? [{ i, ...m }] : [];
            })
            .sort((a, b) => (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1))
            .map(({ i, match, matched_on }) => ({
              idea_id: i.id,
              title: i.title,
              match,
              matched_on,
              promoted: i.promoted_at ? { at: toIso(i.promoted_at), title: i.promoted_title } : null,
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
        last_seen_at: toIso(r.last_seen_at),
        stale: r.stale,
        list_title: r.list_title,
        parent_external_task_id: r.parent_external_task_id,
        parent_title: r.parent_title,
        already_imported: r.imported_idea_id !== null,
        imported_idea_id: r.imported_idea_id,
        imported_idea_promoted: r.imported_promoted_at
          ? { at: toIso(r.imported_promoted_at), title: r.imported_promoted_title }
          : null,
        possible_duplicates: possible,
      };
    });

    return ok({
      as_of: rows[0]?.as_of ? toIso(rows[0].as_of) : new Date().toISOString(),
      total: rows.length > 0 ? Number(rows[0].total) : 0,
      count: tasks.length,
      offset,
      next_offset: offset + tasks.length < (rows.length > 0 ? Number(rows[0].total) : 0) ? offset + tasks.length : null,
      note:
        'Page with next_offset over the full list (only_not_imported shrinks as you import, so offsets shift — use it only for a final check). first_synced_at is when 2nd-brain first synced the task, not when it was created in Google Tasks (Google does not expose that). stale=true means the task was not in the latest sync (probably deleted or moved) — confirm with the user before importing it. due_at is context only — ideas have no due dates. import_ideas records each item as promoted from the task itself (at first_synced_at, with the task title); imported_idea_promoted is the promotion on the imported idea ({at, title}), or null. possible_duplicates match the task title against each idea\'s title and its promoted title (matched_on), and show any recorded promotion.',
      tasks,
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

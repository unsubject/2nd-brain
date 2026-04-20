import { google } from "googleapis";
import { getAuthenticatedClient } from "./auth";
import { pool } from "../db/client";

const LIST_TYPE_MAP: Record<string, string> = {
  do: "do",
  subjects: "subjects",
  learn: "learn",
};

function inferListType(name: string): string | null {
  const lower = name.toLowerCase().trim();
  return LIST_TYPE_MAP[lower] || null;
}

function inferListScope(name: string): "personal" | "family" {
  return name.toLowerCase().trim() === "family" ? "family" : "personal";
}

export async function syncTasks(): Promise<void> {
  const auth = await getAuthenticatedClient();
  const service = google.tasks({ version: "v1", auth });

  const { data: taskLists } = await service.tasklists.list({ maxResults: 100 });
  if (!taskLists.items) return;

  for (const list of taskLists.items) {
    if (!list.id || !list.title) continue;

    const listType = inferListType(list.title);
    const listScope = inferListScope(list.title);

    const { rows: projectRows } = await pool.query(
      `INSERT INTO project_ref (user_id, external_system, external_list_id, name, list_type, updated_at)
       VALUES ('default', 'google_tasks', $1, $2, $3, now())
       ON CONFLICT (external_system, external_list_id) DO UPDATE
         SET name = EXCLUDED.name, list_type = EXCLUDED.list_type, updated_at = now()
       RETURNING id`,
      [list.id, list.title, listType]
    );
    const projectRefId = projectRows[0].id;

    // First pass: upsert all tasks with parent_external_task_id
    let pageToken: string | undefined;
    do {
      const { data } = await service.tasks.list({
        tasklist: list.id,
        maxResults: 100,
        showCompleted: true,
        showHidden: true,
        pageToken,
      });

      for (const task of data.items || []) {
        if (!task.id || !task.title) continue;

        await pool.query(
          `INSERT INTO task_ref
             (user_id, external_system, external_task_id, external_list_id,
              project_ref_id, title, notes, status, due_at, completed_at,
              parent_external_task_id, position, scope, updated_at)
           VALUES ('default', 'google_tasks', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (external_system, external_task_id) DO UPDATE
             SET title = EXCLUDED.title,
                 notes = EXCLUDED.notes,
                 status = EXCLUDED.status,
                 due_at = EXCLUDED.due_at,
                 completed_at = EXCLUDED.completed_at,
                 parent_external_task_id = EXCLUDED.parent_external_task_id,
                 position = EXCLUDED.position,
                 scope = EXCLUDED.scope,
                 updated_at = now()`,
          [
            task.id,
            list.id,
            projectRefId,
            task.title,
            task.notes || null,
            task.status || "needsAction",
            task.due ? new Date(task.due) : null,
            task.completed ? new Date(task.completed) : null,
            task.parent || null,
            task.position || null,
            listScope,
          ]
        );
      }

      pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    // Second pass: resolve parent_task_ref_id from parent_external_task_id
    await pool.query(
      `UPDATE task_ref child
       SET parent_task_ref_id = parent.id
       FROM task_ref parent
       WHERE child.parent_external_task_id IS NOT NULL
         AND child.parent_task_ref_id IS DISTINCT FROM parent.id
         AND child.external_list_id = $1
         AND parent.external_system = 'google_tasks'
         AND parent.external_task_id = child.parent_external_task_id`,
      [list.id]
    );
  }
}

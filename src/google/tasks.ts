import { google } from "googleapis";
import { getAuthenticatedClient } from "./auth";
import { pool } from "../db/client";

export async function syncTasks(): Promise<void> {
  const auth = await getAuthenticatedClient();
  const service = google.tasks({ version: "v1", auth });

  const { data: taskLists } = await service.tasklists.list({ maxResults: 100 });
  if (!taskLists.items) return;

  for (const list of taskLists.items) {
    if (!list.id || !list.title) continue;

    const { rows: projectRows } = await pool.query(
      `INSERT INTO project_ref (user_id, external_system, external_list_id, name, updated_at)
       VALUES ('default', 'google_tasks', $1, $2, now())
       ON CONFLICT (external_system, external_list_id) DO UPDATE
         SET name = EXCLUDED.name, updated_at = now()
       RETURNING id`,
      [list.id, list.title]
    );
    const projectRefId = projectRows[0].id;

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
              project_ref_id, title, notes, status, due_at, completed_at, updated_at)
           VALUES ('default', 'google_tasks', $1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (external_system, external_task_id) DO UPDATE
             SET title = EXCLUDED.title,
                 notes = EXCLUDED.notes,
                 status = EXCLUDED.status,
                 due_at = EXCLUDED.due_at,
                 completed_at = EXCLUDED.completed_at,
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
          ]
        );
      }

      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
  }
}

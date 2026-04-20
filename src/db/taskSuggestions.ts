import { pool } from "./client";

export type Scope = "personal" | "family";
export type SuggestionStatus = "pending" | "added" | "skipped" | "expired";

export interface TaskSuggestion {
  id: string;
  journal_entry_id: string;
  scope: Scope;
  suggested_title: string;
  suggested_list_name: string;
  suggested_due_at: Date | null;
  status: SuggestionStatus;
  telegram_chat_id: string | null;
  telegram_message_id: string | null;
  external_task_id: string | null;
  created_at: Date;
  posted_at: Date | null;
  resolved_at: Date | null;
}

export async function createTaskSuggestion(params: {
  journalEntryId: string;
  scope: Scope;
  suggestedTitle: string;
  suggestedListName: string;
  suggestedDueAt?: Date | null;
  telegramChatId: string | null;
}): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO task_suggestion
       (journal_entry_id, scope, suggested_title, suggested_list_name,
        suggested_due_at, telegram_chat_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (journal_entry_id) DO NOTHING
     RETURNING id`,
    [
      params.journalEntryId,
      params.scope,
      params.suggestedTitle,
      params.suggestedListName,
      params.suggestedDueAt ?? null,
      params.telegramChatId,
    ]
  );
  return rows[0]?.id ?? null;
}

export async function findPostableSuggestions(
  limit: number
): Promise<TaskSuggestion[]> {
  const { rows } = await pool.query<TaskSuggestion>(
    `SELECT *
     FROM task_suggestion
     WHERE status = 'pending'
       AND posted_at IS NULL
       AND telegram_chat_id IS NOT NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function markSuggestionPosted(
  id: string,
  telegramMessageId: string
): Promise<void> {
  await pool.query(
    `UPDATE task_suggestion
     SET posted_at = now(),
         telegram_message_id = $2
     WHERE id = $1 AND posted_at IS NULL`,
    [id, telegramMessageId]
  );
}

export async function getSuggestionById(
  id: string
): Promise<TaskSuggestion | null> {
  const { rows } = await pool.query<TaskSuggestion>(
    `SELECT * FROM task_suggestion WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// Transition pending → added, atomically. Returns the row only if we
// were the one to flip it (prevents double-adding from rapid taps).
export async function markSuggestionAdded(
  id: string,
  resolvedByUserId: string,
  externalTaskId: string
): Promise<TaskSuggestion | null> {
  const { rows } = await pool.query<TaskSuggestion>(
    `UPDATE task_suggestion
     SET status = 'added',
         resolved_at = now(),
         resolved_by_user_id = $2,
         external_task_id = $3
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, resolvedByUserId, externalTaskId]
  );
  return rows[0] ?? null;
}

export async function markSuggestionSkipped(
  id: string,
  resolvedByUserId: string
): Promise<TaskSuggestion | null> {
  const { rows } = await pool.query<TaskSuggestion>(
    `UPDATE task_suggestion
     SET status = 'skipped',
         resolved_at = now(),
         resolved_by_user_id = $2
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, resolvedByUserId]
  );
  return rows[0] ?? null;
}

export async function expireStaleSuggestions(
  maxAgeMs: number
): Promise<TaskSuggestion[]> {
  const seconds = Math.max(1, Math.floor(maxAgeMs / 1000));
  const { rows } = await pool.query<TaskSuggestion>(
    `UPDATE task_suggestion
     SET status = 'expired',
         resolved_at = now()
     WHERE status = 'pending'
       AND created_at + ($1::int * interval '1 second') < now()
     RETURNING *`,
    [seconds]
  );
  return rows;
}

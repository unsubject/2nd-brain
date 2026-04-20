import { DB, pool } from "./client";

export async function findFamilyDraft(
  db: DB,
  userId: string,
  chatId: string
): Promise<{ id: string; full_text: string; updated_at: Date } | null> {
  const { rows } = await db.query(
    `SELECT id, full_text, updated_at
     FROM journal_entry
     WHERE user_id = $1
       AND chat_id = $2
       AND scope = 'family'
       AND processing_status = 'drafting'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId, chatId]
  );
  return rows[0] || null;
}

export async function createFamilyDraft(
  db: DB,
  params: {
    userId: string;
    chatId: string;
    channelMessageId: string;
    rawText: string;
    receivedAt: Date;
  }
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO journal_entry
       (user_id, channel, chat_id, scope, processing_status,
        created_at, updated_at, stitch_window_start, stitch_window_end, full_text)
     VALUES ($1, 'telegram', $2, 'family', 'drafting', $3, $3, $3, $3, $4)
     RETURNING id`,
    [params.userId, params.chatId, params.receivedAt, params.rawText]
  );
  const journalEntryId = rows[0].id;

  await db.query(
    `INSERT INTO capture_event
       (user_id, channel, chat_id, scope, channel_message_id, raw_text,
        received_at, journal_entry_id)
     VALUES ($1, 'telegram', $2, 'family', $3, $4, $5, $6)`,
    [
      params.userId,
      params.chatId,
      params.channelMessageId,
      params.rawText,
      params.receivedAt,
      journalEntryId,
    ]
  );

  return journalEntryId;
}

export async function appendToFamilyDraft(
  db: DB,
  params: {
    draftId: string;
    userId: string;
    chatId: string;
    channelMessageId: string;
    rawText: string;
    receivedAt: Date;
  }
): Promise<void> {
  await db.query(
    `UPDATE journal_entry
     SET full_text = full_text || E'\n' || $2,
         updated_at = $3,
         stitch_window_end = $3
     WHERE id = $1 AND processing_status = 'drafting'`,
    [params.draftId, params.rawText, params.receivedAt]
  );

  await db.query(
    `INSERT INTO capture_event
       (user_id, channel, chat_id, scope, channel_message_id, raw_text,
        received_at, journal_entry_id)
     VALUES ($1, 'telegram', $2, 'family', $3, $4, $5, $6)`,
    [
      params.userId,
      params.chatId,
      params.channelMessageId,
      params.rawText,
      params.receivedAt,
      params.draftId,
    ]
  );
}

// Backdating stitch_window_end by 11 minutes means the pending-entry worker
// (which waits for stitch_window_end < now - stitch_window, default 10 min)
// picks this up on its next tick rather than waiting out a stitch window
// that doesn't apply to an explicitly-confirmed draft.
export async function confirmFamilyDraft(
  db: DB,
  id: string
): Promise<{ confirmed: boolean }> {
  const res = await db.query(
    `UPDATE journal_entry
     SET processing_status = 'pending',
         stitch_window_end = now() - interval '11 minutes',
         updated_at = now()
     WHERE id = $1 AND processing_status = 'drafting'`,
    [id]
  );
  return { confirmed: (res.rowCount ?? 0) > 0 };
}

export async function cancelFamilyDraft(
  db: DB,
  id: string
): Promise<{ cancelled: boolean }> {
  const res = await db.query(
    `UPDATE journal_entry
     SET processing_status = 'cancelled',
         updated_at = now()
     WHERE id = $1 AND processing_status = 'drafting'`,
    [id]
  );
  return { cancelled: (res.rowCount ?? 0) > 0 };
}

export async function confirmStaleFamilyDrafts(
  autoSaveMs: number
): Promise<string[]> {
  const seconds = Math.max(1, Math.floor(autoSaveMs / 1000));
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE journal_entry
     SET processing_status = 'pending',
         stitch_window_end = now() - interval '11 minutes',
         updated_at = now()
     WHERE scope = 'family'
       AND processing_status = 'drafting'
       AND updated_at + ($1::int * interval '1 second') < now()
     RETURNING id`,
    [seconds]
  );
  return rows.map((r) => r.id);
}

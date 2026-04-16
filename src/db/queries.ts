import { DB } from "./client";

export async function findRecentJournalEntry(
  db: DB,
  userId: string,
  channel: string,
  receivedAt: Date,
  windowMs: number
): Promise<{ id: string } | null> {
  const cutoff = new Date(receivedAt.getTime() - windowMs);
  const { rows } = await db.query(
    `SELECT je.id
     FROM journal_entry je
     WHERE je.user_id = $1
       AND je.channel = $2
       AND je.stitch_window_end > $3
       AND NOT EXISTS (
         SELECT 1 FROM capture_event ce
         WHERE ce.user_id = $1
           AND ce.channel = $2
           AND ce.is_system_command = true
           AND ce.system_command_type = 'new_note'
           AND ce.received_at > je.stitch_window_end
       )
     ORDER BY je.stitch_window_end DESC
     LIMIT 1`,
    [userId, channel, cutoff]
  );
  return rows[0] || null;
}

export async function createJournalEntry(
  db: DB,
  params: {
    userId: string;
    channel: string;
    rawText: string;
    receivedAt: Date;
  }
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO journal_entry
       (user_id, channel, created_at, updated_at, stitch_window_start, stitch_window_end, full_text)
     VALUES ($1, $2, $3, $3, $3, $3, $4)
     RETURNING id`,
    [params.userId, params.channel, params.receivedAt, params.rawText]
  );
  return rows[0].id;
}

export async function appendToJournalEntry(
  db: DB,
  id: string,
  rawText: string,
  receivedAt: Date
): Promise<void> {
  await db.query(
    `UPDATE journal_entry
     SET full_text = full_text || E'\n' || $2,
         updated_at = $3,
         stitch_window_end = $3
     WHERE id = $1`,
    [id, rawText, receivedAt]
  );
}

export async function insertCaptureEvent(
  db: DB,
  params: {
    userId: string;
    channel: string;
    channelMessageId: string;
    rawText: string;
    receivedAt: Date;
    journalEntryId: string | null;
    isSystemCommand: boolean;
    systemCommandType: string | null;
  }
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO capture_event
       (user_id, channel, channel_message_id, raw_text, received_at,
        journal_entry_id, is_system_command, system_command_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      params.userId,
      params.channel,
      params.channelMessageId,
      params.rawText,
      params.receivedAt,
      params.journalEntryId,
      params.isSystemCommand,
      params.systemCommandType,
    ]
  );
  return rows[0].id;
}

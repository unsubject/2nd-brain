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

// ---------- /ask retrievers ----------

function extractKeywords(q: string): string[] {
  const matches = q.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
  return Array.from(new Set(matches)).slice(0, 6);
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function searchJournalForAsk(
  embedding: number[],
  scopes: string[],
  limit: number
): Promise<
  {
    id: string;
    created_at: Date;
    summary: string | null;
    full_text: string;
    scope: string;
    similarity: number;
  }[]
> {
  const { rows } = await pool.query(
    `SELECT id, created_at, summary, full_text, scope,
            1 - (embedding <=> $1::vector) AS similarity
     FROM journal_entry
     WHERE processing_status = 'processed'
       AND embedding IS NOT NULL
       AND scope = ANY($2)
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral(embedding), scopes, limit]
  );
  return rows;
}

export async function searchEmailsForAsk(
  embedding: number[],
  scopes: string[],
  limit: number
): Promise<
  {
    id: string;
    subject: string | null;
    from_address: string;
    sent_at: Date | null;
    snippet: string | null;
    body_text: string | null;
    scope: string;
    similarity: number;
  }[]
> {
  const { rows } = await pool.query(
    `SELECT id, subject, from_address, sent_at, snippet, body_text, scope,
            1 - (embedding <=> $1::vector) AS similarity
     FROM email_ref
     WHERE embedding IS NOT NULL
       AND scope = ANY($2)
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral(embedding), scopes, limit]
  );
  return rows;
}

export async function searchCalendarForAsk(
  question: string,
  scopes: string[],
  limit: number
): Promise<
  {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    start_at: Date;
    scope: string;
  }[]
> {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) return [];

  const params: unknown[] = [scopes, limit];
  const placeholders = keywords.map((k) => {
    params.push(`%${k}%`);
    return `$${params.length}`;
  });

  const anyMatch = placeholders
    .map(
      (p) =>
        `(title ILIKE ${p} OR description ILIKE ${p} OR location ILIKE ${p})`
    )
    .join(" OR ");
  const score = placeholders
    .map(
      (p) =>
        `(CASE WHEN title ILIKE ${p} OR description ILIKE ${p} OR location ILIKE ${p} THEN 1 ELSE 0 END)`
    )
    .join(" + ");

  const { rows } = await pool.query(
    `SELECT id, title, description, location, start_at, scope,
            (${score}) AS score
     FROM calendar_event_ref
     WHERE scope = ANY($1)
       AND (${anyMatch})
     ORDER BY score DESC, start_at DESC
     LIMIT $2`,
    params
  );
  return rows;
}

export async function searchTasksForAsk(
  question: string,
  scopes: string[],
  limit: number
): Promise<
  {
    id: string;
    title: string;
    notes: string | null;
    due_at: Date | null;
    list_name: string | null;
    scope: string;
  }[]
> {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) return [];

  const params: unknown[] = [scopes, limit];
  const placeholders = keywords.map((k) => {
    params.push(`%${k}%`);
    return `$${params.length}`;
  });

  const anyMatch = placeholders
    .map((p) => `(t.title ILIKE ${p} OR t.notes ILIKE ${p})`)
    .join(" OR ");
  const score = placeholders
    .map(
      (p) =>
        `(CASE WHEN t.title ILIKE ${p} OR t.notes ILIKE ${p} THEN 1 ELSE 0 END)`
    )
    .join(" + ");

  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.notes, t.due_at, t.scope, p.name AS list_name,
            (${score}) AS score
     FROM task_ref t
     LEFT JOIN project_ref p ON t.project_ref_id = p.id
     WHERE t.scope = ANY($1)
       AND t.status = 'needsAction'
       AND (${anyMatch})
     ORDER BY score DESC, t.due_at ASC NULLS LAST
     LIMIT $2`,
    params
  );
  return rows;
}

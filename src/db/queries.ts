import { pool, DB } from "./client";
import { ProcessingResult } from "../processor";

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

export async function findPendingEntry(
  stitchWindowMs: number
): Promise<{ id: string; full_text: string } | null> {
  const cutoff = new Date(Date.now() - stitchWindowMs);
  const { rows } = await pool.query(
    `SELECT id, full_text
     FROM journal_entry
     WHERE processing_status = 'pending'
       AND stitch_window_end < $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [cutoff]
  );
  return rows[0] || null;
}

export async function saveProcessingResult(
  id: string,
  result: ProcessingResult,
  embedding: number[]
): Promise<void> {
  const vectorStr = `[${embedding.join(",")}]`;
  await pool.query(
    `UPDATE journal_entry
     SET clean_text = $2,
         summary = $3,
         language = $4,
         tags = $5,
         primary_type = $6,
         primary_type_confidence = $7,
         suggested_actions = $8,
         embedding = $9::vector,
         processing_status = 'processed'
     WHERE id = $1`,
    [
      id,
      result.clean_text,
      result.summary,
      result.language,
      result.tags,
      result.primary_type,
      result.primary_type_confidence,
      JSON.stringify(result.suggested_actions),
      vectorStr,
    ]
  );
}

export async function findSimilarEntries(
  embedding: number[],
  excludeId: string,
  limit: number = 5
): Promise<
  { id: string; summary: string; tags: string[]; similarity: number }[]
> {
  const vectorStr = `[${embedding.join(",")}]`;
  const { rows } = await pool.query(
    `SELECT id, summary, tags,
            1 - (embedding <=> $1::vector) AS similarity
     FROM journal_entry
     WHERE processing_status = 'processed'
       AND id != $2
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorStr, excludeId, limit]
  );
  return rows;
}

export async function markProcessingError(id: string): Promise<void> {
  await pool.query(
    `UPDATE journal_entry SET processing_status = 'error' WHERE id = $1`,
    [id]
  );
}

export async function getEntriesForReview(
  days: number
): Promise<
  {
    id: string;
    full_text: string;
    summary: string | null;
    tags: string[] | null;
    primary_type: string | null;
    primary_type_confidence: number | null;
    suggested_actions: unknown;
    created_at: Date;
    channel: string;
  }[]
> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const { rows } = await pool.query(
    `SELECT id, full_text, summary, tags, primary_type,
            primary_type_confidence, suggested_actions, created_at, channel
     FROM journal_entry
     WHERE processing_status = 'processed'
       AND created_at > $1
     ORDER BY created_at DESC`,
    [cutoff]
  );
  return rows;
}

export async function saveReview(
  reviewDate: string,
  content: string,
  contentHtml: string,
  entryCount: number
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO morning_review (review_date, content, content_html, entry_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (review_date) DO UPDATE
       SET content = EXCLUDED.content,
           content_html = EXCLUDED.content_html,
           entry_count = EXCLUDED.entry_count,
           created_at = now()
     RETURNING id`,
    [reviewDate, content, contentHtml, entryCount]
  );
  return rows[0].id;
}

export async function getRecentReviews(
  limit: number = 20
): Promise<
  {
    id: string;
    review_date: string;
    content_html: string;
    entry_count: number;
    created_at: Date;
  }[]
> {
  const { rows } = await pool.query(
    `SELECT id, review_date, content_html, entry_count, created_at
     FROM morning_review
     ORDER BY review_date DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getTodayCalendarEvents(
  timezone: string
): Promise<
  {
    id: string;
    title: string;
    description: string | null;
    start_at: Date;
    end_at: Date;
    location: string | null;
    attendees: unknown;
  }[]
> {
  const { rows } = await pool.query(
    `SELECT id, title, description, start_at, end_at, location, attendees
     FROM calendar_event_ref
     WHERE user_id = 'default'
       AND (start_at AT TIME ZONE $1)::date =
           (now() AT TIME ZONE $1)::date
     ORDER BY start_at ASC`,
    [timezone]
  );
  return rows;
}

export async function getOpenTasks(daysAhead: number = 7): Promise<
  {
    id: string;
    title: string;
    notes: string | null;
    due_at: Date | null;
    list_name: string | null;
    list_type: string | null;
    parent_title: string | null;
  }[]
> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.notes, t.due_at,
            p.name AS list_name, p.list_type,
            parent.title AS parent_title
     FROM task_ref t
     LEFT JOIN project_ref p ON t.project_ref_id = p.id
     LEFT JOIN task_ref parent ON t.parent_task_ref_id = parent.id
     WHERE t.user_id = 'default'
       AND t.status = 'needsAction'
       AND (t.due_at IS NULL OR t.due_at <= $1)
     ORDER BY
       CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
       t.due_at ASC
     LIMIT 40`,
    [cutoff]
  );
  return rows;
}

export async function getStarredEmails(days: number = 30): Promise<
  {
    id: string;
    subject: string | null;
    from_address: string;
    snippet: string | null;
    sent_at: Date | null;
  }[]
> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const { rows } = await pool.query(
    `SELECT id, subject, from_address, snippet, sent_at
     FROM email_ref
     WHERE user_id = 'default'
       AND is_starred = true
       AND (sent_at IS NULL OR sent_at >= $1)
     ORDER BY sent_at DESC NULLS LAST
     LIMIT 15`,
    [cutoff]
  );
  return rows;
}

export async function getLinksForRecentEntries(days: number = 7): Promise<
  {
    link_type: string;
    confidence: number | null;
    explanation: string | null;
    target_type: string;
    journal_summary: string | null;
    journal_created_at: Date;
  }[]
> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const { rows } = await pool.query(
    `SELECT le.link_type, le.confidence, le.explanation, le.target_type,
            je.summary AS journal_summary,
            je.created_at AS journal_created_at
     FROM link_edge le
     JOIN journal_entry je ON je.id = le.source_id AND le.source_type = 'journal_entry'
     WHERE je.created_at >= $1
       AND (le.confidence IS NULL OR le.confidence >= 0.5)
     ORDER BY le.confidence DESC NULLS LAST, le.created_at DESC
     LIMIT 25`,
    [cutoff]
  );
  return rows;
}

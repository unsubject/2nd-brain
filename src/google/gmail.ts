import { google } from "googleapis";
import { getAuthenticatedClient } from "./auth";
import { pool } from "../db/client";

async function fetchMessages(
  query: string,
  isSent: boolean,
  isStarred: boolean
): Promise<void> {
  const auth = await getAuthenticatedClient();
  const service = google.gmail({ version: "v1", auth });

  let pageToken: string | undefined;
  do {
    const { data } = await service.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });

    for (const msg of data.messages || []) {
      if (!msg.id) continue;

      // Skip if already stored
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM email_ref WHERE external_system = 'gmail' AND external_message_id = $1`,
        [msg.id]
      );
      if (existing.length > 0) continue;

      const { data: full } = await service.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const headers = full.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value || null;

      const subject = getHeader("subject");
      const from = getHeader("from") || "";
      const to = getHeader("to") || "";
      const date = getHeader("date");
      const toAddresses = to
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);

      // Extract plain text body
      const bodyText = extractTextBody(full.payload) || "";

      await pool.query(
        `INSERT INTO email_ref
           (user_id, external_system, external_message_id, thread_id,
            subject, from_address, to_addresses, snippet, body_text,
            label_ids, is_starred, is_sent, sent_at, updated_at)
         VALUES ('default', 'gmail', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (external_system, external_message_id) DO UPDATE
           SET is_starred = EXCLUDED.is_starred,
               label_ids = EXCLUDED.label_ids,
               updated_at = now()`,
        [
          msg.id,
          full.threadId || null,
          subject,
          from,
          toAddresses,
          full.snippet || null,
          bodyText.slice(0, 10000),
          full.labelIds || [],
          isStarred,
          isSent,
          date ? new Date(date) : null,
        ]
      );
    }

    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextBody(payload: any): string | null {
  if (!payload) return null;

  const mimeType = payload.mimeType as string | undefined;
  const body = payload.body as { data?: string } | undefined;
  const parts = payload.parts as any[] | undefined;

  if (mimeType === "text/plain" && body?.data) {
    return Buffer.from(body.data, "base64url").toString("utf-8");
  }

  if (parts) {
    for (const part of parts) {
      const text = extractTextBody(part);
      if (text) return text;
    }
  }

  return null;
}

export async function syncGmail(): Promise<void> {
  console.log("Syncing sent mail...");
  await fetchMessages("in:sent newer_than:30d", true, false);

  console.log("Syncing starred mail...");
  await fetchMessages("is:starred", false, true);
}

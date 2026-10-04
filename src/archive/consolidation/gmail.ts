// Collect every message under a Gmail label (default "Writing") into
// archive_source_item, verbatim. Gmail messages never change, so re-runs
// only fetch messages not already staged (unless refetch is set).

import { google } from "googleapis";
import mammoth from "mammoth";
import { getAuthenticatedClient } from "../../google/auth";
import { describeGoogleError } from "../../google/errors";
import { extractBodies, header, isDocxAttachment, splitAddresses } from "./mime";
import { existingSourceRefs, upsertSourceItem, type UpsertResult } from "./staging";

type Gmail = ReturnType<typeof google.gmail>;

export interface GmailCollectParams {
  label: string;
  refetch?: boolean;
}

export interface CollectStats {
  [key: string]: unknown;
  listed: number;
  skippedExisting: number;
  inserted: number;
  updated: number;
  unchanged: number;
  attachmentsExtracted: number;
  failed: number;
  errors: { ref: string; error: string }[];
}

const CONCURRENCY = 4;
const MAX_ERRORS_KEPT = 50;

export function emptyStats(): CollectStats {
  return {
    listed: 0,
    skippedExisting: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    attachmentsExtracted: 0,
    failed: 0,
    errors: [],
  };
}

export function count(stats: CollectStats, r: UpsertResult): void {
  stats[r] += 1;
}

export function recordError(stats: CollectStats, ref: string, err: unknown): void {
  stats.failed += 1;
  if (stats.errors.length < MAX_ERRORS_KEPT) {
    // Google API errors: the safe summary (message, status, Google's code),
    // never the request config, which can hold the OAuth token request.
    const isGoogle = !!err && typeof err === "object" && ("response" in err || "config" in err);
    const error = isGoogle ? describeGoogleError(err) : err instanceof Error ? err.message : String(err);
    stats.errors.push({ ref, error: error.slice(0, 500) });
  }
}

async function resolveLabelId(gmail: Gmail, name: string): Promise<{ id: string; names: Map<string, string> }> {
  const { data } = await gmail.users.labels.list({ userId: "me" });
  const names = new Map<string, string>();
  for (const l of data.labels ?? []) if (l.id && l.name) names.set(l.id, l.name);
  const exact = (data.labels ?? []).find((l) => l.name === name);
  const loose = exact ?? (data.labels ?? []).find((l) => l.name?.toLowerCase() === name.toLowerCase());
  if (!loose?.id) throw new Error(`Gmail label not found: ${name}`);
  return { id: loose.id, names };
}

async function listMessageIds(gmail: Gmail, labelId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId],
      maxResults: 500,
      includeSpamTrash: false,
      pageToken,
    });
    for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

async function collectMessage(
  gmail: Gmail,
  id: string,
  labelNames: Map<string, string>,
  stats: CollectStats
): Promise<void> {
  const { data: msg } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const headers = msg.payload?.headers;
  const bodies = extractBodies(msg.payload);
  const labelIds = msg.labelIds ?? [];
  const subject = header(headers, "subject");
  const authoredAt = msg.internalDate ? new Date(Number(msg.internalDate)) : null;
  const threadId = msg.threadId ?? null;

  const metadata = {
    kind: "message",
    threadId,
    from: header(headers, "from"),
    to: splitAddresses(header(headers, "to")),
    cc: splitAddresses(header(headers, "cc")),
    dateHeader: header(headers, "date"),
    messageIdHeader: header(headers, "message-id"),
    inReplyTo: header(headers, "in-reply-to"),
    labelIds,
    labelNames: labelIds.map((l) => labelNames.get(l) ?? l),
    isSent: labelIds.includes("SENT"),
    attachments: bodies.attachments.map(({ partId, filename, mimeType, size }) => ({
      partId,
      filename,
      mimeType,
      size,
    })),
    ...(bodies.unknownCharsets.length > 0 ? { unknownCharsets: bodies.unknownCharsets } : {}),
    ...(bodies.text === null && bodies.html === null ? { emptyBody: true } : {}),
  };

  count(
    stats,
    await upsertSourceItem({
      source: "gmail",
      sourceRef: id,
      containerRef: threadId,
      title: subject,
      authoredAt,
      // Attachment-only messages still get a row so the thread is complete.
      rawText: bodies.text ?? (bodies.html === null ? "" : null),
      rawHtml: bodies.html,
      metadata,
    })
  );

  // Column drafts were sometimes sent as Word attachments: stage their text
  // as candidate copies too, keyed by the (stable) MIME part id.
  for (const att of bodies.attachments.filter(isDocxAttachment)) {
    const ref = `${id}#${att.partId}`;
    try {
      const { data } = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: id,
        id: att.attachmentId,
      });
      if (!data.data) throw new Error("empty attachment");
      const buffer = Buffer.from(data.data, "base64url");
      const [{ value: text }, { value: html }] = await Promise.all([
        mammoth.extractRawText({ buffer }),
        mammoth.convertToHtml({ buffer }),
      ]);
      count(
        stats,
        await upsertSourceItem({
          source: "gmail",
          sourceRef: ref,
          containerRef: threadId,
          title: att.filename,
          authoredAt,
          rawText: text,
          rawHtml: html,
          metadata: {
            kind: "attachment",
            parentMessageId: id,
            threadId,
            subject,
            filename: att.filename,
            mimeType: att.mimeType,
            isSent: metadata.isSent,
            from: metadata.from,
          },
        })
      );
      stats.attachmentsExtracted += 1;
    } catch (err) {
      recordError(stats, ref, err);
    }
  }
}

export async function collectGmail(
  params: GmailCollectParams,
  stats: CollectStats,
  onProgress: () => Promise<void>
): Promise<void> {
  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: "v1", auth });
  const { id: labelId, names } = await resolveLabelId(gmail, params.label);

  const ids = await listMessageIds(gmail, labelId);
  stats.listed = ids.length;

  let todo = ids;
  if (!params.refetch) {
    const existing = new Set<string>();
    for (let i = 0; i < ids.length; i += 1000) {
      for (const r of await existingSourceRefs("gmail", ids.slice(i, i + 1000))) existing.add(r);
    }
    todo = ids.filter((id) => !existing.has(id));
    stats.skippedExisting = ids.length - todo.length;
  }

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++];
      try {
        await collectMessage(gmail, id, names, stats);
      } catch (err) {
        recordError(stats, id, err);
      }
      if (++done % 50 === 0) await onProgress();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

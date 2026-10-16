// Collect every message under a Gmail label (default "Writing") into
// archive_source_item, verbatim. Gmail messages never change, so re-runs
// only fetch messages not already staged (unless refetch is set), and
// those staged incomplete or garbled by an older decoder. The boot check
// collects without a label: just the garbled ones, by id.

import { google } from "googleapis";
import mammoth from "mammoth";
import { pool, type DB } from "../../db/client";
import { getAuthenticatedClient } from "../../google/auth";
import { describeGoogleError } from "../../google/errors";
import { DECODER_VERSION, decodeBody, extractBodies, header, isDocxAttachment, splitAddresses, type ExternalBody } from "./mime";
import { RateLimiter, unlimited, type CallRunner } from "./ratelimit";
import {
  allGarbledGmailMessages,
  existingSourceRefs,
  garbledGmailMessages,
  incompleteGmailMessages,
  markGarbledGone,
  upsertSourceItem,
  type UpsertResult,
} from "./staging";

export type Gmail = ReturnType<typeof google.gmail>;

// The label the archive's writing is filed under.
export const DEFAULT_GMAIL_LABEL = "Writing";

export type GmailCollectParams =
  | { label: string; refetch?: boolean }
  // No label: only the staged messages an older decoder garbled, fetched
  // by id whatever label they came from (the boot check, extract/auto.ts).
  | { garbledOnly: true };

export interface CollectStats {
  [key: string]: unknown;
  listed: number;
  skippedExisting: number;
  // Staged messages fetched again because an attachment row is missing.
  retriedIncomplete: number;
  // Staged messages fetched again because an older decoder garbled them.
  retriedGarbled?: number;
  inserted: number;
  updated: number;
  unchanged: number;
  attachmentsExtracted: number;
  // Times the run paused because Google answered "quota exceeded".
  rateLimitPauses: number;
  failed: number;
  errors: { ref: string; error: string }[];
}

const CONCURRENCY = 4;
const MAX_ERRORS_KEPT = 50;

// Each Gmail call used here costs 5 quota units. Start at 10 calls/s
// (3,000 units/min) across all workers; the limiter halves that on every
// "quota exceeded" and pauses 15 s, 30 s, … up to 2 min before retrying.
// Each pause also records progress, so a paused run never looks abandoned.
export function gmailRateLimiter(stats: CollectStats, onPause: () => void = () => {}): RateLimiter {
  return new RateLimiter({
    minIntervalMs: 100,
    maxIntervalMs: 2_000,
    retries: 8,
    basePauseMs: 15_000,
    maxPauseMs: 120_000,
    onLimited: () => {
      stats.rateLimitPauses += 1;
      onPause();
    },
  });
}

export function emptyStats(): CollectStats {
  return {
    listed: 0,
    skippedExisting: 0,
    retriedIncomplete: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    attachmentsExtracted: 0,
    rateLimitPauses: 0,
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

// The label's id (null without a name) and every label's name by id.
async function resolveLabelId(
  gmail: Gmail,
  name: string | null,
  limiter: CallRunner
): Promise<{ id: string | null; names: Map<string, string> }> {
  const { data } = await limiter.run(() => gmail.users.labels.list({ userId: "me" }));
  const names = new Map<string, string>();
  for (const l of data.labels ?? []) if (l.id && l.name) names.set(l.id, l.name);
  if (name === null) return { id: null, names };
  const exact = (data.labels ?? []).find((l) => l.name === name);
  const loose = exact ?? (data.labels ?? []).find((l) => l.name?.toLowerCase() === name.toLowerCase());
  if (!loose?.id) throw new Error(`Gmail label not found: ${name}`);
  return { id: loose.id, names };
}

async function listMessageIds(gmail: Gmail, labelId: string, limiter: CallRunner): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await limiter.run(() =>
      gmail.users.messages.list({
        userId: "me",
        labelIds: [labelId],
        maxResults: 500,
        includeSpamTrash: false,
        pageToken,
      })
    );
    for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

// Large bodies come back as an attachment id instead of inline data.
async function fetchExternalBody(
  gmail: Gmail,
  messageId: string,
  ext: ExternalBody,
  unknownCharsets: string[],
  limiter: CallRunner
): Promise<string> {
  const { data } = await limiter.run(() =>
    gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: ext.attachmentId,
    })
  );
  if (!data.data) throw new Error("empty message body attachment");
  return decodeBody(data.data, ext.charset, unknownCharsets);
}

export async function collectMessage(
  gmail: Gmail,
  id: string,
  labelNames: Map<string, string>,
  stats: CollectStats,
  limiter: CallRunner = unlimited
): Promise<void> {
  const msg = await limiter.run(() => gmail.users.messages.get({ userId: "me", id, format: "full" })).then(
    (r) => r.data,
    async (err) => {
      // Gone from Gmail: a copy an older decoder garbled can't be fetched
      // again, so the boot check stops collecting for it.
      if (notFound(err)) await markGarbledGone(id);
      throw err;
    }
  );
  const headers = msg.payload?.headers;
  const bodies = extractBodies(msg.payload);
  // Fetched before the row is written: if this fails the message stays
  // unstaged, so the next run retries it instead of keeping an empty body.
  const text = bodies.textExternal
    ? await fetchExternalBody(gmail, id, bodies.textExternal, bodies.unknownCharsets, limiter)
    : bodies.text;
  const html = bodies.htmlExternal
    ? await fetchExternalBody(gmail, id, bodies.htmlExternal, bodies.unknownCharsets, limiter)
    : bodies.html;
  const externalBodies = [
    ...(bodies.textExternal ? ["text/plain"] : []),
    ...(bodies.htmlExternal ? ["text/html"] : []),
  ];
  const docxAttachments = bodies.attachments.filter(isDocxAttachment);
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
    // The attachment rows this message should have; a run that finds one
    // missing fetches the message again (staging.incompleteGmailMessages).
    expectedAttachmentRefs: docxAttachments.map((a) => `${id}#${a.partId}`),
    ...(externalBodies.length > 0 ? { externalBodies } : {}),
    ...(bodies.unknownCharsets.length > 0 ? { unknownCharsets: bodies.unknownCharsets } : {}),
    decoderVersion: DECODER_VERSION,
    ...(text === null && html === null ? { emptyBody: true } : {}),
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
      rawText: text ?? (html === null ? "" : null),
      rawHtml: html,
      metadata,
    })
  );

  // Column drafts were sometimes sent as Word attachments: stage their text
  // as candidate copies too, keyed by the (stable) MIME part id.
  for (const att of docxAttachments) {
    const ref = `${id}#${att.partId}`;
    try {
      const { data } = await limiter.run(() =>
        gmail.users.messages.attachments.get({
          userId: "me",
          messageId: id,
          id: att.attachmentId,
        })
      );
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

// What a collection fetches: of the messages its label lists, those not
// staged yet (all of them with refetch), staged incomplete, or garbled by
// an older decoder; without a label (ids null), the staged messages an
// older decoder garbled, by id.
export async function messagesToFetch(
  ids: string[] | null,
  refetch: boolean,
  stats: CollectStats,
  db: DB = pool
): Promise<string[]> {
  if (ids === null) {
    const garbled = await allGarbledGmailMessages(db);
    stats.retriedGarbled = garbled.length;
    return garbled;
  }
  let todo = ids;
  if (!refetch) {
    // Staged messages are skipped unless one of their attachment rows is
    // missing (a fetch failed, or the run stopped between the two writes),
    // or an older decoder garbled their body.
    const existing = new Set<string>();
    const incomplete = new Set<string>();
    const garbled = new Set<string>();
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      for (const r of await existingSourceRefs("gmail", chunk, db)) existing.add(r);
      for (const r of await incompleteGmailMessages(chunk, db)) incomplete.add(r);
      for (const r of await garbledGmailMessages(chunk, db)) garbled.add(r);
    }
    todo = ids.filter((id) => !existing.has(id) || incomplete.has(id) || garbled.has(id));
    stats.retriedIncomplete = incomplete.size;
    stats.retriedGarbled = garbled.size;
    stats.skippedExisting = ids.length - todo.length;
  }
  return todo;
}

const notFound = (err: unknown): boolean => {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  return e?.response?.status === 404 || e?.status === 404 || e?.code === 404;
};

export async function collectGmail(
  params: GmailCollectParams,
  stats: CollectStats,
  onProgress: () => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<void> {
  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: "v1", auth });
  const limiter = gmailRateLimiter(stats, () => void onProgress());
  const byLabel = "label" in params ? params : null;
  const { id: labelId, names } = await resolveLabelId(gmail, byLabel?.label ?? null, limiter);

  const ids = labelId === null ? null : await listMessageIds(gmail, labelId, limiter);
  stats.listed = ids?.length ?? 0;
  const todo = await messagesToFetch(ids, byLabel?.refetch ?? false, stats);

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < todo.length && !shouldStop()) {
      const id = todo[next++];
      try {
        await collectMessage(gmail, id, names, stats, limiter);
      } catch (err) {
        recordError(stats, id, err);
      }
      if (++done % 50 === 0) await onProgress();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

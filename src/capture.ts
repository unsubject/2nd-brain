import { pool, withTransaction } from "./db/client";
import * as queries from "./db/queries";

const NEW_NOTE_COMMANDS = new Set([
  "new note",
  "another note",
  "separate note",
  "different note",
  "different thought",
]);

const STITCH_WINDOW_MS = 10 * 60 * 1000;

export interface IncomingMessage {
  userId: string;
  channel: string;
  channelMessageId: string;
  rawText: string;
  receivedAt: Date;
}

export async function handleMessage(
  msg: IncomingMessage
): Promise<{ isSystemCommand: boolean }> {
  const normalized = msg.rawText.trim().toLowerCase();

  if (NEW_NOTE_COMMANDS.has(normalized)) {
    await queries.insertCaptureEvent(pool, {
      ...msg,
      journalEntryId: null,
      isSystemCommand: true,
      systemCommandType: "new_note",
    });
    return { isSystemCommand: true };
  }

  await withTransaction(async (client) => {
    const recentEntry = await queries.findRecentJournalEntry(
      client,
      msg.userId,
      msg.channel,
      msg.receivedAt,
      STITCH_WINDOW_MS
    );

    let journalEntryId: string;

    if (recentEntry) {
      journalEntryId = recentEntry.id;
      await queries.appendToJournalEntry(
        client,
        journalEntryId,
        msg.rawText,
        msg.receivedAt
      );
    } else {
      journalEntryId = await queries.createJournalEntry(client, {
        userId: msg.userId,
        channel: msg.channel,
        rawText: msg.rawText,
        receivedAt: msg.receivedAt,
      });
    }

    await queries.insertCaptureEvent(client, {
      ...msg,
      journalEntryId,
      isSystemCommand: false,
      systemCommandType: null,
    });
  });

  return { isSystemCommand: false };
}

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  findPostableSuggestions,
  markSuggestionPosted,
  expireStaleSuggestions,
  TaskSuggestion,
} from "./db/taskSuggestions";

const POST_INTERVAL_MS = 30_000;
const EXPIRY_INTERVAL_MS = 5 * 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 10;

export interface SuggestionBots {
  personalBot: Bot;
  familyBot?: Bot;
}

function keyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u2705 Add", `suggest:add:${id}`)
    .text("\u2717 Skip", `suggest:skip:${id}`);
}

function formatPrompt(s: TaskSuggestion): string {
  return `\ud83d\udcdd Add as a task?\n\n"${s.suggested_title}"\n\u2192 ${s.suggested_list_name}`;
}

function botFor(bots: SuggestionBots, scope: string): Bot | undefined {
  return scope === "family" ? bots.familyBot : bots.personalBot;
}

async function postBatch(bots: SuggestionBots): Promise<void> {
  const suggestions = await findPostableSuggestions(BATCH_SIZE);
  for (const s of suggestions) {
    const bot = botFor(bots, s.scope);
    if (!bot || !s.telegram_chat_id) continue;
    try {
      const msg = await bot.api.sendMessage(
        s.telegram_chat_id,
        formatPrompt(s),
        { reply_markup: keyboard(s.id) }
      );
      await markSuggestionPosted(s.id, msg.message_id.toString());
    } catch (err) {
      console.error(
        `[taskSuggestSweeper] post failed for ${s.id} (chat ${s.telegram_chat_id}):`,
        err
      );
    }
  }
}

async function expireBatch(bots: SuggestionBots): Promise<void> {
  const expired = await expireStaleSuggestions(MAX_AGE_MS);
  if (expired.length === 0) return;
  for (const s of expired) {
    if (!s.telegram_chat_id || !s.telegram_message_id) continue;
    const bot = botFor(bots, s.scope);
    if (!bot) continue;
    const messageId = parseInt(s.telegram_message_id, 10);
    if (!Number.isFinite(messageId)) continue;
    try {
      await bot.api.editMessageText(
        s.telegram_chat_id,
        messageId,
        `(Task suggestion expired)\n\n"${s.suggested_title}"`
      );
    } catch {
      // Message was deleted, bot was removed from chat, etc. Don't care.
    }
  }
  console.log(
    `[taskSuggestSweeper] Expired ${expired.length} stale suggestion(s)`
  );
}

export function startTaskSuggestionSweeper(bots: SuggestionBots): void {
  const postTick = async () => {
    try {
      await postBatch(bots);
    } catch (err) {
      console.error("[taskSuggestSweeper] post tick error:", err);
    } finally {
      setTimeout(postTick, POST_INTERVAL_MS);
    }
  };
  const expireTick = async () => {
    try {
      await expireBatch(bots);
    } catch (err) {
      console.error("[taskSuggestSweeper] expire tick error:", err);
    } finally {
      setTimeout(expireTick, EXPIRY_INTERVAL_MS);
    }
  };
  postTick();
  expireTick();
}

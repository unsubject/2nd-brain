import { Bot, Context, InlineKeyboard } from "grammy";
import type { MessageEntity } from "grammy/types";
import { pool } from "./db/client";
import {
  findFamilyDraft,
  createFamilyDraft,
  appendToFamilyDraft,
  confirmFamilyDraft,
  cancelFamilyDraft,
  confirmStaleFamilyDrafts,
} from "./db/familyQueries";
import { askFamilyArchive, AskScope } from "./familyAsk";
import { insertTask } from "./google/tasks";
import { handleSuggestionCallback } from "./taskSuggestionCallback";

export interface FamilyBotConfig {
  groupChatId: string;
  familyUserIds: Set<string>;
}

type BotInfo = { id: number; username?: string };

const AUTO_SAVE_MS = 5 * 60 * 1000;
const DRAFT_PREVIEW_MAX = 500;
const MAX_REPLY_CHARS = 4000;

function stripEntities(text: string, entities?: MessageEntity[]): string {
  if (!entities) return text;
  const toStrip = entities
    .filter((e) => e.type === "mention" || e.type === "bot_command")
    .sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const e of toStrip) {
    out = out.slice(0, e.offset) + out.slice(e.offset + e.length);
  }
  return out.replace(/\s+/g, " ").trim();
}

function isDoneSignal(text: string): boolean {
  const n = text.trim().toLowerCase().replace(/[.!?]$/, "");
  return n === "done" || n === "/done";
}

function isCancelSignal(text: string): boolean {
  const n = text.trim().toLowerCase();
  return n === "cancel" || n === "/cancel";
}

function draftKeyboard(draftId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u2705 Save", `family:save:${draftId}`)
    .text("\u2795 Add more", `family:add:${draftId}`)
    .text("\u274c Cancel", `family:cancel:${draftId}`);
}

function formatDraftReply(fullText: string): string {
  const preview =
    fullText.length > DRAFT_PREVIEW_MAX
      ? fullText.slice(0, DRAFT_PREVIEW_MAX - 1) + "\u2026"
      : fullText;
  return `\ud83d\udcdd Drafting:\n\n${preview}\n\n(Say "done" or tap \u2705 to save. Auto-saves after 5 min.)`;
}

function authorize(ctx: Context, config: FamilyBotConfig): boolean {
  const chatType = ctx.chat?.type;
  if (chatType === "group" || chatType === "supergroup") {
    return ctx.chat?.id?.toString() === config.groupChatId;
  }
  if (chatType === "private") {
    return config.familyUserIds.has(ctx.from?.id?.toString() ?? "");
  }
  return false;
}

function isCaptureTrigger(ctx: Context, botInfo: BotInfo): boolean {
  const chatType = ctx.chat?.type;
  if (chatType === "private") return true;

  if (ctx.message?.reply_to_message?.from?.id === botInfo.id) return true;

  const text = ctx.message?.text || "";
  const entities = ctx.message?.entities || [];
  const botUsernameLower = botInfo.username?.toLowerCase();
  if (!botUsernameLower) return false;

  for (const e of entities) {
    if (e.type === "mention") {
      const mention = text
        .slice(e.offset + 1, e.offset + e.length)
        .toLowerCase();
      if (mention === botUsernameLower) return true;
    } else if (e.type === "bot_command") {
      const cmd = text.slice(e.offset, e.offset + e.length).toLowerCase();
      if (cmd.endsWith("@" + botUsernameLower)) return true;
    }
  }
  return false;
}

function determineAskScopes(ctx: Context): AskScope[] {
  const simonId = process.env.SIMON_TELEGRAM_USER_ID;
  const userId = ctx.from?.id?.toString();
  const isDM = ctx.chat?.type === "private";
  if (isDM && simonId && userId === simonId) {
    return ["personal", "family"];
  }
  return ["family"];
}

function determineTaskList(ctx: Context): string {
  const simonId = process.env.SIMON_TELEGRAM_USER_ID;
  const userId = ctx.from?.id?.toString();
  const isDM = ctx.chat?.type === "private";
  if (isDM && simonId && userId === simonId) {
    return "Do";
  }
  return "Family";
}

function truncateForTelegram(text: string): string {
  return text.length > MAX_REPLY_CHARS
    ? text.slice(0, MAX_REPLY_CHARS - 15) + "\n…(truncated)"
    : text;
}

export function createFamilyBot(token: string, config: FamilyBotConfig): Bot {
  const bot = new Bot(token);

  bot.command("whoami", async (ctx) => {
    const chatId = ctx.chat?.id?.toString() ?? "unknown";
    const chatType = ctx.chat?.type ?? "unknown";
    const userId = ctx.from?.id?.toString() ?? "unknown";
    const allowed = authorize(ctx, config);
    await ctx.reply(
      `Chat ID: ${chatId}\nChat type: ${chatType}\nYour user ID: ${userId}\nAuthorized: ${allowed}`
    );
  });

  bot.command("ask", async (ctx) => {
    if (!authorize(ctx, config)) return;
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Usage: /ask <your question>");
      return;
    }

    const scopes = determineAskScopes(ctx);

    await ctx.replyWithChatAction("typing");
    try {
      const answer = await askFamilyArchive(query, scopes);
      await ctx.reply(truncateForTelegram(answer));
    } catch (err) {
      console.error("[familyAsk] Error:", err);
      await ctx.reply("Sorry, couldn't search the archive right now.");
    }
  });

  bot.command("task", async (ctx) => {
    if (!authorize(ctx, config)) return;
    const title = ctx.match?.trim();
    if (!title) {
      await ctx.reply("Usage: /task <title>");
      return;
    }
    const listName = determineTaskList(ctx);
    try {
      const result = await insertTask({ listName, title });
      await ctx.reply(`✅ Added to "${result.listTitle}" tasklist.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[familyBot] /task error:", err);
      await ctx.reply(`Couldn't add task: ${msg}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!authorize(ctx, config)) return;
    if (!bot.botInfo) return;
    if (!isCaptureTrigger(ctx, bot.botInfo)) return;

    const userId = ctx.from!.id.toString();
    const chatId = ctx.chat!.id.toString();
    const channelMessageId = ctx.message.message_id.toString();
    const receivedAt = new Date(ctx.message.date * 1000);
    const text = stripEntities(ctx.message.text, ctx.message.entities);

    if (!text) return;

    const draft = await findFamilyDraft(pool, userId, chatId);

    if (draft && isDoneSignal(text)) {
      const res = await confirmFamilyDraft(pool, draft.id);
      if (res.confirmed) {
        await ctx.reply("✅ Saved to the family knowledge base.");
      }
      return;
    }

    if (draft && isCancelSignal(text)) {
      const res = await cancelFamilyDraft(pool, draft.id);
      if (res.cancelled) {
        await ctx.reply("❌ Draft cancelled.");
      }
      return;
    }

    let draftId: string;
    let fullText: string;
    if (draft) {
      await appendToFamilyDraft(pool, {
        draftId: draft.id,
        userId,
        chatId,
        channelMessageId,
        rawText: text,
        receivedAt,
      });
      draftId = draft.id;
      fullText = draft.full_text + "\n" + text;
    } else {
      draftId = await createFamilyDraft(pool, {
        userId,
        chatId,
        channelMessageId,
        rawText: text,
        receivedAt,
      });
      fullText = text;
    }

    await ctx.reply(formatDraftReply(fullText), {
      reply_markup: draftKeyboard(draftId),
    });
  });

  bot.callbackQuery(/^family:(save|add|cancel):(.+)$/, async (ctx) => {
    if (!authorize(ctx, config)) {
      await ctx.answerCallbackQuery({ text: "Unauthorized" });
      return;
    }
    const action = ctx.match![1];
    const draftId = ctx.match![2];

    if (action === "add") {
      await ctx.answerCallbackQuery({ text: "Keep writing." });
      return;
    }

    if (action === "save") {
      const res = await confirmFamilyDraft(pool, draftId);
      if (res.confirmed) {
        await ctx.answerCallbackQuery({ text: "Saved." });
        await ctx.editMessageText("✅ Saved to the family knowledge base.");
      } else {
        await ctx.answerCallbackQuery({ text: "Already saved or cancelled." });
      }
      return;
    }

    if (action === "cancel") {
      const res = await cancelFamilyDraft(pool, draftId);
      if (res.cancelled) {
        await ctx.answerCallbackQuery({ text: "Cancelled." });
        await ctx.editMessageText("❌ Draft cancelled.");
      } else {
        await ctx.answerCallbackQuery({ text: "Already saved or cancelled." });
      }
      return;
    }
  });

  bot.callbackQuery(/^suggest:(add|skip):(.+)$/, async (ctx) => {
    if (!authorize(ctx, config)) {
      await ctx.answerCallbackQuery({ text: "Unauthorized" });
      return;
    }
    const action = ctx.match![1] as "add" | "skip";
    const id = ctx.match![2];
    await handleSuggestionCallback(ctx, action, id);
  });

  return bot;
}

export function startFamilyDraftSweeper(): void {
  const tick = async () => {
    try {
      const confirmed = await confirmStaleFamilyDrafts(AUTO_SAVE_MS);
      if (confirmed.length > 0) {
        console.log(
          `[familyBot] Auto-saved ${confirmed.length} stale draft(s)`
        );
      }
    } catch (err) {
      console.error("[familyBot] Sweeper error:", err);
    } finally {
      setTimeout(tick, 60_000);
    }
  };
  tick();
}

import { Bot, GrammyError, HttpError, webhookCallback } from "grammy";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { handleMessage } from "./capture";
import { getAuthUrl, handleCallback } from "./google/auth";
import { googleAuthRoutes, secretMatches } from "./google/routes";
import { describeGoogleError } from "./google/errors";
import { describeError } from "./telegram/errors";
import { ownerOnly } from "./telegram/owner";
import { WEBHOOK_PATH } from "./telegram/webhook";
import { archiveRoutes } from "./archive/routes";
import { ask, formatForTelegram } from "./archive/ask";
import { insertTask } from "./google/tasks";
import { handleSuggestionCallback } from "./taskSuggestionCallback";

export function createBot(token: string, owners: Set<string>): Bot {
  const bot = new Bot(token);

  // A failing handler must not reject the webhook request: Express 4 leaves
  // the rejection unhandled (the process exits), and Telegram would then
  // redeliver the same update after the restart. Log a line without the
  // token or message text, tell the sender, and answer Telegram normally.
  // When Telegram itself failed (often the reply after a successful
  // capture), another reply would most likely fail too, so none is sent.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error(`[bot] update ${ctx.update.update_id} failed: ${describeError(err)}`);
      if (ctx.chat && !(err instanceof GrammyError || err instanceof HttpError)) {
        await ctx.reply("Sorry, something went wrong, so that may not have been saved. Please check and send it again.").catch(() => {});
      }
    }
  });
  bot.use(ownerOnly(owners));

  bot.command("ask", async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Usage: /ask <your question>");
      return;
    }

    await ctx.replyWithChatAction("typing");
    try {
      const result = await ask(query);
      const message = formatForTelegram(result);
      const truncated =
        message.length > 4000 ? message.slice(0, 3990) + "\n…(truncated)" : message;
      await ctx.reply(truncated);
    } catch (err) {
      console.error("[ask] Error:", describeError(err));
      await ctx.reply("Sorry, couldn't search the archive right now.");
    }
  });

  bot.command("task", async (ctx) => {
    const title = ctx.match?.trim();
    if (!title) {
      await ctx.reply("Usage: /task <title>");
      return;
    }
    try {
      const result = await insertTask({ listName: "Do", title });
      await ctx.reply(`✅ Added to "${result.listTitle}" tasklist.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bot] /task error:", describeGoogleError(err));
      await ctx.reply(`Couldn't add task: ${msg}`);
    }
  });

  bot.callbackQuery(/^suggest:(add|skip):(.+)$/, async (ctx) => {
    const action = ctx.match![1] as "add" | "skip";
    const id = ctx.match![2];
    await handleSuggestionCallback(ctx, action, id);
  });

  bot.on("message:text", async (ctx) => {
    const result = await handleMessage({
      userId: ctx.from.id.toString(),
      channel: "telegram",
      chatId: ctx.chat.id.toString(),
      channelMessageId: ctx.message.message_id.toString(),
      rawText: ctx.message.text,
      receivedAt: new Date(ctx.message.date * 1000),
    });

    if (result.isSystemCommand) {
      await ctx.reply("Got it.");
    } else {
      await ctx.reply("Captured.");
    }
  });

  return bot;
}

export type AppOptions = {
  /** X-Telegram-Bot-Api-Secret-Token value registered with setWebhook. */
  secretToken: string;
  /** ARCHIVE_API_KEY; the archive routes refuse every request without it. */
  archiveApiKey: string | undefined;
  /** OWNER_SECRET for /auth/google. */
  ownerSecret: string | undefined;
};

export function createApp(bot: Bot, opts: AppOptions): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // The secret header is checked before the body is parsed, so the public
  // path never runs the JSON parser for anyone but Telegram. onTimeout
  // "return": a slow handler (e.g. /ask) keeps running, but Telegram gets
  // its answer before its own timeout and does not redeliver.
  app.post(
    WEBHOOK_PATH,
    (req: Request, res: Response, next: NextFunction) => {
      if (!secretMatches(req.header("X-Telegram-Bot-Api-Secret-Token"), opts.secretToken)) {
        res.sendStatus(401);
        return;
      }
      next();
    },
    express.json(),
    webhookCallback(bot, "express", {
      secretToken: opts.secretToken,
      onTimeout: "return",
      timeoutMilliseconds: 9_000,
    })
  );
  // A malformed or oversized body gets a bare status, not Express's
  // default error page and logged stack trace.
  app.use(WEBHOOK_PATH, (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown })?.status;
    const code = typeof status === "number" && status >= 400 && status < 500 ? status : 500;
    if (code === 500) console.error(`[bot] webhook request failed: ${describeError(err)}`);
    res.sendStatus(code);
  });

  app.use(
    googleAuthRoutes({
      secret: opts.ownerSecret,
      getAuthUrl,
      handleCallback,
    })
  );

  // Archive routes: bearer auth. Mounted by path so Express's own matching
  // decides what is "/archive": routing is case-insensitive, and a string
  // prefix check let /Archive/... through to the routes unauthenticated.
  app.use("/archive", (req, res, next) => {
    const auth = req.headers.authorization;
    const given = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    if (!secretMatches(given, opts.archiveApiKey)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  app.use(archiveRoutes());

  return app;
}

export function startWebhook(bot: Bot, port: number, secretToken: string): void {
  const app = createApp(bot, {
    secretToken,
    archiveApiKey: process.env.ARCHIVE_API_KEY || undefined,
    ownerSecret: process.env.OWNER_SECRET?.trim() || undefined,
  });
  app.listen(port, () => {
    console.log(`Webhook server listening on port ${port}`);
  });
}

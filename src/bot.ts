import { Bot, webhookCallback } from "grammy";
import { randomUUID } from "crypto";
import express from "express";
import { handleMessage } from "./capture";
import { generateRssFeed } from "./feed";
import * as queries from "./db/queries";
import { getAuthUrl, handleCallback } from "./google/auth";
import { archiveRoutes } from "./archive/routes";
import { ask, formatForTelegram } from "./archive/ask";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

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
      console.error("[ask] Error:", err);
      await ctx.reply("Sorry, couldn't search the archive right now.");
    }
  });

  bot.on("message:text", async (ctx) => {
    const result = await handleMessage({
      userId: ctx.from.id.toString(),
      channel: "telegram",
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

export function startWebhook(
  bot: Bot,
  port: number,
  webhookSecret: string
): void {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post(
    `/webhook/${webhookSecret}`,
    express.json(),
    webhookCallback(bot, "express")
  );

  app.post("/capture", express.json(), async (req, res) => {
    const apiKey = process.env.CAPTURE_API_KEY;
    if (!apiKey || req.headers.authorization !== `Bearer ${apiKey}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { text, channel, channel_message_id, user_id } = req.body;
    if (!text || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    try {
      const result = await handleMessage({
        userId: user_id || "default",
        channel: channel || "email",
        channelMessageId: channel_message_id || randomUUID(),
        rawText: text.trim(),
        receivedAt: new Date(),
      });
      res.json({ status: result.isSystemCommand ? "command" : "captured" });
    } catch (err) {
      console.error("Capture API error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/auth/google", (_req, res) => {
    const url = getAuthUrl();
    res.redirect(url);
  });

  app.get("/auth/google/callback", async (req, res) => {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).send("Missing authorization code");
      return;
    }

    try {
      await handleCallback(code);
      res.send("Google account connected successfully! You can close this tab.");
    } catch (err) {
      console.error("Google OAuth callback error:", err);
      res.status(500).send("Failed to connect Google account");
    }
  });

  // Archive routes (bearer auth checked per-route by middleware)
  const apiKey = process.env.CAPTURE_API_KEY;
  const archiveRouter = archiveRoutes();
  app.use((req, res, next) => {
    if (req.path.startsWith("/archive")) {
      if (!apiKey || req.headers.authorization !== `Bearer ${apiKey}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    next();
  });
  app.use(archiveRouter);

  app.get("/feed", async (_req, res) => {
    try {
      const reviews = await queries.getRecentReviews(20);
      const baseUrl = process.env.WEBHOOK_URL || `http://localhost:${port}`;
      const xml = generateRssFeed(reviews, baseUrl);
      res.type("application/rss+xml").send(xml);
    } catch (err) {
      console.error("Feed error:", err);
      res.status(500).send("Feed generation failed");
    }
  });

  app.listen(port, () => {
    console.log(`Webhook server listening on port ${port}`);
  });
}

import { Bot, webhookCallback } from "grammy";
import express from "express";
import { handleMessage } from "./capture";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

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

  app.listen(port, () => {
    console.log(`Webhook server listening on port ${port}`);
  });
}

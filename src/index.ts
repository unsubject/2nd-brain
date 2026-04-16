import { migrate } from "./db/migrate";
import { createBot, startWebhook } from "./bot";
import { startWorker } from "./worker";
import { startScheduler } from "./scheduler";
import { startGoogleSync } from "./google/sync";

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const webhookUrl = process.env.WEBHOOK_URL;
  const port = parseInt(process.env.PORT || "3000", 10);

  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!webhookSecret) throw new Error("WEBHOOK_SECRET is required");
  if (!webhookUrl) throw new Error("WEBHOOK_URL is required");

  console.log("Running migrations...");
  await migrate();

  const bot = createBot(token);

  const fullWebhookUrl = `${webhookUrl}/webhook/${webhookSecret}`;
  await bot.api.setWebhook(fullWebhookUrl);
  console.log("Telegram webhook registered");

  startWebhook(bot, port, webhookSecret);
  startWorker();
  startScheduler();
  startGoogleSync();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

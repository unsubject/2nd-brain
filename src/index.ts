import { migrate } from "./db/migrate";
import { createBot, startWebhook } from "./bot";
import { startWorker } from "./worker";
import { startGoogleSync } from "./google/sync";
import { startArchiveWorker } from "./archive/worker";
import { startIdeaEmbeddingWorker } from "./ideas/worker";
import { startMcpRetention } from "./mcp/retention";
import { startTaskSuggestionSweeper } from "./taskSuggestionSweeper";
import { describeError } from "./telegram/errors";
import { parseOwnerIds } from "./telegram/owner";
import { WEBHOOK_PATH, registerWebhook, webhookSecretToken } from "./telegram/webhook";

// Node prints an unhandled error in full, nested properties included, which
// for grammY and Google errors means the bot token, the webhook secret or a
// refresh token. Log a safe line instead. A stray rejected promise is logged
// and the process keeps serving; an uncaught exception still exits.
process.on("unhandledRejection", (reason) => {
  console.error(`[process] unhandled rejection: ${describeError(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[process] uncaught exception: ${describeError(err)}`);
  process.exit(1);
});

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const webhookUrl = process.env.WEBHOOK_URL?.replace(/\/+$/, "");
  const port = parseInt(process.env.PORT || "3000", 10);

  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!webhookSecret) throw new Error("WEBHOOK_SECRET is required");
  if (!webhookUrl) throw new Error("WEBHOOK_URL is required");

  const owners = parseOwnerIds(process.env.OWNER_TELEGRAM_USER_IDS);
  if (owners.size === 0) {
    console.warn("[bot] OWNER_TELEGRAM_USER_IDS is not set: the bot will ignore every message until it is");
  }

  console.log("Running migrations...");
  await migrate();

  const bot = createBot(token, owners);
  await bot.init();

  const secretToken = webhookSecretToken(webhookSecret);
  await registerWebhook(bot.api, `${webhookUrl}${WEBHOOK_PATH}`, secretToken);
  console.log("Telegram webhook registered");

  startWebhook(bot, port, secretToken);
  startWorker();
  startGoogleSync();
  startArchiveWorker();
  startIdeaEmbeddingWorker();
  startMcpRetention();
  startTaskSuggestionSweeper(bot);
}

main().catch((err) => {
  console.error(`Fatal error: ${describeError(err)}`);
  process.exit(1);
});

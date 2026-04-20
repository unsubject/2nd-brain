import { migrate } from "./db/migrate";
import { createBot, startWebhook } from "./bot";
import { createFamilyBot, startFamilyDraftSweeper } from "./familyBot";
import { startWorker } from "./worker";
import { startScheduler } from "./scheduler";
import { startGoogleSync } from "./google/sync";
import { startArchiveWorker } from "./archive/worker";

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
  await bot.init();

  const fullWebhookUrl = `${webhookUrl}/webhook/${webhookSecret}`;
  await bot.api.setWebhook(fullWebhookUrl);
  console.log("Telegram webhook registered");

  const familyToken = process.env.FAMILY_TELEGRAM_BOT_TOKEN;
  const familySecret =
    process.env.FAMILY_WEBHOOK_SECRET || webhookSecret;
  const familyGroupChatId = process.env.FAMILY_TELEGRAM_GROUP_CHAT_ID;
  const familyUserIdsRaw = process.env.FAMILY_TELEGRAM_USER_IDS || "";
  const familyUserIds = new Set(
    familyUserIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  let familyBot = undefined;
  if (familyToken) {
    if (!familyGroupChatId) {
      throw new Error(
        "FAMILY_TELEGRAM_GROUP_CHAT_ID is required when FAMILY_TELEGRAM_BOT_TOKEN is set"
      );
    }
    familyBot = createFamilyBot(familyToken, {
      groupChatId: familyGroupChatId,
      familyUserIds,
    });
    await familyBot.init();
    const familyWebhookUrl = `${webhookUrl}/family-webhook/${familySecret}`;
    await familyBot.api.setWebhook(familyWebhookUrl);
    console.log(
      `Family bot registered (@${familyBot.botInfo?.username}, group ${familyGroupChatId}, ${familyUserIds.size} DM user(s))`
    );
  }

  startWebhook(bot, port, webhookSecret, {
    familyBot,
    familyWebhookSecret: familySecret,
  });
  startWorker();
  startScheduler();
  startGoogleSync();
  startArchiveWorker();

  if (familyBot) {
    startFamilyDraftSweeper();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

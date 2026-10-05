// Telegram webhook registration.
//
// The webhook used to be authenticated only by WEBHOOK_SECRET in its URL
// path, so anything that logged the URL (a failed setWebhook's payload, the
// platform's request logs) exposed the credential. Telegram's secret_token
// moves it into the X-Telegram-Bot-Api-Secret-Token header instead: the path
// is fixed and carries no secret, and grammY's webhookCallback rejects
// requests without the right header.

import { createHash } from "node:crypto";
import { GrammyError, type Api } from "grammy";
import { describeError } from "./errors";

export const WEBHOOK_PATH = "/webhook/telegram";

/**
 * The secret_token sent with setWebhook, derived from WEBHOOK_SECRET.
 * Telegram allows only A-Z, a-z, 0-9, _ and - (1-256 chars); a hex digest
 * always fits, whatever WEBHOOK_SECRET contains.
 */
export function webhookSecretToken(webhookSecret: string): string {
  return createHash("sha256").update(`telegram-webhook|${webhookSecret}`, "utf8").digest("hex");
}

const MAX_RETRY_AFTER_S = 30;

/**
 * setWebhook, retrying when Telegram rate-limits it (429), which happens
 * when several deployments boot within seconds of each other. Other errors
 * are thrown after logging a line that holds no secret.
 */
export async function registerWebhook(
  api: Pick<Api, "setWebhook">,
  url: string,
  secretToken: string,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await api.setWebhook(url, { secret_token: secretToken });
      return;
    } catch (err) {
      const retryable = err instanceof GrammyError && err.error_code === 429 && attempt < attempts;
      console.error(`[bot] setWebhook attempt ${attempt}/${attempts} failed: ${describeError(err)}`);
      if (!retryable) throw err;
      const wait = Math.min(Math.max(Number(err.parameters?.retry_after) || 1, 1), MAX_RETRY_AFTER_S);
      await sleep(wait * 1000);
    }
  }
}

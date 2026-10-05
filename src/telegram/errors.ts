// Turn an error into a line that is safe to log.
//
// grammY's errors carry secrets in nested properties that console.error
// prints in full: an HttpError keeps the underlying fetch error, whose
// message is the request URL `https://api.telegram.org/bot<TOKEN>/<method>`;
// a GrammyError keeps the call's `payload` (setWebhook's carries the webhook
// URL and secret token); a BotError keeps the whole update context, including
// `ctx.api.token`. Only the method, Telegram's error code and description,
// and the network error code are kept here. Google API errors go through
// describeGoogleError for the same reason (their config holds the refresh
// token).

import { BotError, GrammyError, HttpError } from "grammy";
import { describeGoogleError } from "../google/errors";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 300) : undefined;

export function describeTelegramError(err: GrammyError | HttpError): string {
  if (err instanceof GrammyError) {
    return `Telegram ${err.method} failed (${err.error_code}: ${str(err.description) ?? "no description"})`;
  }
  // HttpError's own message ("Network request for 'sendMessage' failed!")
  // never contains the URL; its nested error's message does.
  const inner = err.error as { code?: unknown; errno?: unknown; name?: unknown } | undefined;
  const code = str(inner?.code) ?? (typeof inner?.errno === "number" ? String(inner.errno) : undefined) ?? str(inner?.name);
  return `${err.message}${code ? ` (${code})` : ""}`;
}

export function describeError(err: unknown): string {
  if (err instanceof BotError) {
    const updateId = (err.ctx as { update?: { update_id?: unknown } } | undefined)?.update?.update_id;
    return `while handling update ${typeof updateId === "number" ? updateId : "?"}: ${describeError(err.error)}`;
  }
  if (err instanceof GrammyError || err instanceof HttpError) return describeTelegramError(err);
  return describeGoogleError(err);
}

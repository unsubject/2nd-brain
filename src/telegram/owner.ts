// The personal bot serves its owner only. Anyone can find a Telegram bot and
// message it, and everything it receives is written to the owner's journal
// (and /task writes to his Google Tasks), so updates from any other account
// are dropped before a handler sees them. The allow-list fails closed: with
// OWNER_TELEGRAM_USER_IDS unset, every update is ignored.

import type { Context, NextFunction } from "grammy";

/** Numeric Telegram user ids from a comma- or space-separated list. */
export function parseOwnerIds(raw: string | undefined): Set<string> {
  const ids = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    if (/^\d{1,20}$/.test(part)) ids.add(part);
  }
  return ids;
}

const MAX_REPORTED = 100;

export function ownerOnly(owners: Set<string>) {
  // Log each unknown sender once (bounded), not every update they send.
  const reported = new Set<string>();
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const from = ctx.from?.id;
    if (from !== undefined && owners.has(String(from))) return next();
    const who = from === undefined ? "no sender" : `user ${from}`;
    if (!reported.has(who) && reported.size < MAX_REPORTED) {
      reported.add(who);
      console.warn(
        owners.size === 0
          ? `[bot] ignoring update from ${who}: OWNER_TELEGRAM_USER_IDS is not set`
          : `[bot] ignoring update from ${who}: not in OWNER_TELEGRAM_USER_IDS`
      );
    }
  };
}

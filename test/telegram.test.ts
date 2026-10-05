// Telegram plumbing: error lines that never carry the bot token or the
// webhook secret, the owner-only filter, and webhook registration that
// survives Telegram's rate limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BotError, GrammyError, HttpError } from "grammy";
import { describeError, describeTelegramError } from "../src/telegram/errors";
import { ownerOnly, parseOwnerIds } from "../src/telegram/owner";
import { WEBHOOK_PATH, registerWebhook, webhookSecretToken } from "../src/telegram/webhook";

const FAKE_TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklm";
const FAKE_SECRET = "f".repeat(64);

function httpError(): HttpError {
  // What grammY builds when fetch fails: the inner error's message is the
  // request URL, token included.
  const inner = Object.assign(new Error(`request to https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage failed, reason: connect ECONNRESET`), {
    code: "ECONNRESET",
    errno: "ECONNRESET",
  });
  return new HttpError("Network request for 'sendMessage' failed!", inner);
}

function grammyError(): GrammyError {
  return new GrammyError(
    "Call to 'setWebhook' failed!",
    { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } },
    "setWebhook",
    { url: `https://example.invalid/webhook/${FAKE_SECRET}`, secret_token: FAKE_SECRET }
  );
}

test("describeTelegramError keeps the method and code, never the URL or payload", () => {
  const net = describeTelegramError(httpError());
  assert.equal(net, "Network request for 'sendMessage' failed! (ECONNRESET)");
  const api = describeTelegramError(grammyError());
  assert.equal(api, "Telegram setWebhook failed (429: Too Many Requests: retry after 1)");
  for (const line of [net, api]) {
    assert.ok(!line.includes(FAKE_TOKEN));
    assert.ok(!line.includes(FAKE_SECRET));
  }
});

test("describeError unwraps a BotError without printing its context", () => {
  const ctx = { update: { update_id: 42, message: { text: "private journal text" } }, api: { token: FAKE_TOKEN } };
  const err = new BotError(httpError(), ctx as never);
  const line = describeError(err);
  assert.equal(line, "while handling update 42: Network request for 'sendMessage' failed! (ECONNRESET)");
  assert.ok(!line.includes(FAKE_TOKEN));
  assert.ok(!line.includes("private journal text"));
});

test("describeError hands Google errors to describeGoogleError", () => {
  const err = new Error("invalid_grant") as Error & Record<string, unknown>;
  err.config = { data: { refresh_token: "1//must-not-appear" } };
  err.response = { status: 400, data: { error: "invalid_grant" } };
  assert.equal(describeError(err), "invalid_grant (HTTP 400: invalid_grant)");
  assert.equal(describeError("boom"), "boom");
});

test("parseOwnerIds", () => {
  assert.deepEqual([...parseOwnerIds("123, 456 789")], ["123", "456", "789"]);
  assert.deepEqual([...parseOwnerIds(" 123 ,,")], ["123"]);
  assert.deepEqual([...parseOwnerIds("abc,12x,-5")], []);
  assert.deepEqual([...parseOwnerIds("")], []);
  assert.deepEqual([...parseOwnerIds(undefined)], []);
});

test("ownerOnly passes the owner through and drops everyone else", async (t) => {
  const warned: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => void warned.push(args.map(String).join(" ")));
  const mw = ownerOnly(new Set(["111"]));
  let calls = 0;
  const next = async () => void calls++;
  await mw({ from: { id: 111 } } as never, next);
  assert.equal(calls, 1);
  await mw({ from: { id: 222 } } as never, next);
  await mw({ from: { id: 222 } } as never, next);
  await mw({ from: undefined } as never, next);
  assert.equal(calls, 1, "strangers and sender-less updates never reach the handlers");
  assert.deepEqual(warned, [
    "[bot] ignoring update from user 222: not in OWNER_TELEGRAM_USER_IDS",
    "[bot] ignoring update from no sender: not in OWNER_TELEGRAM_USER_IDS",
  ]);
});

test("ownerOnly with no owners configured ignores every update", async (t) => {
  const warned: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => void warned.push(args.map(String).join(" ")));
  let calls = 0;
  await ownerOnly(new Set())({ from: { id: 111 } } as never, async () => void calls++);
  assert.equal(calls, 0);
  assert.match(warned[0], /OWNER_TELEGRAM_USER_IDS is not set/);
});

test("webhookSecretToken is a fixed-length token Telegram accepts, and the path holds no secret", () => {
  const token = webhookSecretToken("any secret, with spaces & symbols!");
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(token, webhookSecretToken("any secret, with spaces & symbols!"));
  assert.notEqual(token, webhookSecretToken("another secret"));
  assert.equal(WEBHOOK_PATH, "/webhook/telegram");
});

test("registerWebhook retries a 429 after retry_after and sends the secret token", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  const calls: Array<{ url: string; opts: unknown }> = [];
  const slept: number[] = [];
  let failures = 2;
  const api = {
    setWebhook: async (url: string, opts: unknown) => {
      calls.push({ url, opts });
      if (failures-- > 0) throw grammyError();
      return true as const;
    },
  };
  await registerWebhook(api as never, "https://example.invalid/webhook/telegram", "tok", {
    sleep: async (ms) => void slept.push(ms),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], { url: "https://example.invalid/webhook/telegram", opts: { secret_token: "tok" } });
  assert.deepEqual(slept, [1000, 1000]);
  assert.equal(logged.length, 2);
  for (const line of logged) assert.ok(!line.includes(FAKE_SECRET), "the payload is never logged");
});

test("registerWebhook gives up on other errors, and after the last attempt", async (t) => {
  t.mock.method(console, "error", () => {});
  const api401 = {
    setWebhook: async () => {
      throw new GrammyError("Call to 'setWebhook' failed!", { ok: false, error_code: 401, description: "Unauthorized" }, "setWebhook", {});
    },
  };
  await assert.rejects(registerWebhook(api401 as never, "u", "t", { sleep: async () => {} }), GrammyError);

  let calls = 0;
  const always429 = {
    setWebhook: async () => {
      calls++;
      throw grammyError();
    },
  };
  await assert.rejects(registerWebhook(always429 as never, "u", "t", { attempts: 3, sleep: async () => {} }), GrammyError);
  assert.equal(calls, 3);
});

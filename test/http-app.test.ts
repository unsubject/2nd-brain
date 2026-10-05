// The monolith's HTTP surface: the Telegram webhook needs Telegram's secret
// header and survives a failing handler; the archive routes need the API key
// whatever the path's case; /feed no longer exists.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// No database in these tests: point the pool at a closed port before the
// app's modules load, so any handler that reaches the database fails fast.
process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none_test";
// The OpenAI client is built at import time and needs a key; nothing here calls it.
process.env.OPENAI_API_KEY ||= "sk-test-unused";

const FAKE_TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklm";
const SECRET_TOKEN = "a".repeat(64);
const ARCHIVE_KEY = "archive-key-for-tests";
const OWNER = 111;
const STRANGER = 222;

type ApiCall = { method: string; payload: Record<string, unknown> };

let server: Server;
let base: string;
const apiCalls: ApiCall[] = [];

before(async () => {
  const { createBot, createApp } = await import("../src/bot");
  const bot = createBot(FAKE_TOKEN, new Set([String(OWNER)]));
  // Answer every Bot API call locally; nothing goes to Telegram.
  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "getMe"
        ? { id: 1, is_bot: true, first_name: "test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false }
        : method === "sendMessage"
          ? { message_id: 1, date: 0, chat: { id: OWNER, type: "private" }, text: "" }
          : true;
    return { ok: true, result } as never;
  });
  const app = createApp(bot, { secretToken: SECRET_TOKEN, archiveApiKey: ARCHIVE_KEY, ownerSecret: undefined });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const { pool } = await import("../src/db/client");
  await pool.end().catch(() => {});
});

let updateId = 1000;
function textUpdate(fromId: number, text: string) {
  updateId++;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: "private", first_name: "T" },
      from: { id: fromId, is_bot: false, first_name: "T" },
      text,
    },
  };
}

const postUpdate = (update: unknown, secret: string | null = SECRET_TOKEN) =>
  fetch(`${base}/webhook/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }) },
    body: JSON.stringify(update),
  });

test("the webhook refuses requests without Telegram's secret header", async () => {
  const start = apiCalls.length;
  assert.equal((await postUpdate(textUpdate(OWNER, "hello"), null)).status, 401);
  assert.equal((await postUpdate(textUpdate(OWNER, "hello"), "b".repeat(64))).status, 401);
  assert.deepEqual(apiCalls.slice(start).filter((c) => c.method === "sendMessage"), [], "the update never reached the bot");
});

test("the old secret-in-path webhook route is gone", async () => {
  const res = await fetch(`${base}/webhook/${SECRET_TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 404);
});

test("a stranger's message is dropped before any handler runs", async (t) => {
  t.mock.method(console, "warn", () => {});
  const start = apiCalls.length;
  const res = await postUpdate(textUpdate(STRANGER, "/task Pay invoice to X"));
  assert.equal(res.status, 200);
  assert.deepEqual(apiCalls.slice(start).map((c) => c.method).filter((m) => m !== "getMe"), [], "no reply, no task, no capture");
});

test("a failing handler answers 200, tells the owner, and logs no secret", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  const start = apiCalls.length;
  // Capture needs the database, which is unreachable here: the handler throws.
  const res = await postUpdate(textUpdate(OWNER, "a private thought"));
  assert.equal(res.status, 200);
  const replies = apiCalls.slice(start).filter((c) => c.method === "sendMessage");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].payload.chat_id, OWNER);
  assert.match(String(replies[0].payload.text), /something went wrong/);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[bot\] update \d+ failed: /);
  assert.ok(!logged[0].includes(FAKE_TOKEN));
  assert.ok(!logged[0].includes("a private thought"));
});

test("the archive routes require the key, whatever the path's case", async () => {
  const paths = ["/archive/stats", "/Archive/stats", "/ARCHIVE/stats", "/archive/stats/", "/Archive/Stats", "/archive/consolidation/status"];
  for (const p of paths) {
    const none = await fetch(`${base}${p}`);
    assert.equal(none.status, 401, `${p} without a key`);
    const wrong = await fetch(`${base}${p}`, { headers: { authorization: "Bearer not-the-key" } });
    assert.equal(wrong.status, 401, `${p} with a wrong key`);
  }
  const posts = ["/Archive/import/youtube", "/ARCHIVE/consolidation/collect", "/Archive/retry-errors", "/aRcHiVe/search"];
  for (const p of posts) {
    const res = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401, `${p} without a key`);
  }
});

test("the right key reaches the archive handlers", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const p of ["/archive/stats", "/Archive/stats"]) {
    const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${ARCHIVE_KEY}` } });
    assert.notEqual(res.status, 401, p);
    assert.notEqual(res.status, 404, p);
  }
});

test("with no archive key configured, every archive request is refused", async () => {
  const { createBot, createApp } = await import("../src/bot");
  const app = createApp(createBot(FAKE_TOKEN, new Set()), { secretToken: SECRET_TOKEN, archiveApiKey: undefined, ownerSecret: undefined });
  const s = await new Promise<Server>((resolve) => {
    const x = app.listen(0, "127.0.0.1", () => resolve(x));
  });
  try {
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/archive/stats`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer " } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer undefined" } })).status, 401);
  } finally {
    s.close();
  }
});

test("/feed is gone", async () => {
  assert.equal((await fetch(`${base}/feed`)).status, 404);
});

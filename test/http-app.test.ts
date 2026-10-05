// The monolith's HTTP surface: the archive routes need the API key whatever
// the path's case; the retired Telegram webhook and /feed are gone.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// No database in these tests: point the pool at a closed port before the
// app's modules load, so any handler that reaches the database fails fast.
process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none_test";
// Clients built at import time may need a key; nothing here calls them.
process.env.OPENAI_API_KEY ||= "sk-test-unused";

const ARCHIVE_KEY = "archive-key-for-tests";

let server: Server;
let base: string;

async function listen(app: import("express").Express): Promise<{ server: Server; base: string }> {
  const s = await new Promise<Server>((resolve) => {
    const x = app.listen(0, "127.0.0.1", () => resolve(x));
  });
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

before(async () => {
  const { createApp } = await import("../src/server");
  ({ server, base } = await listen(createApp({ archiveApiKey: ARCHIVE_KEY, ownerSecret: undefined })));
});

after(async () => {
  server?.close();
  const { pool } = await import("../src/db/client");
  await pool.end().catch(() => {});
});

test("health answers", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("no source file reads a Telegram setting or imports grammY", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  await walk(join(__dirname, "..", "src"));
  assert.ok(files.length > 10);
  for (const f of files) {
    const text = await readFile(f, "utf8");
    assert.ok(!/TELEGRAM_BOT_TOKEN|WEBHOOK_SECRET|WEBHOOK_URL|OWNER_TELEGRAM_USER_IDS|from "grammy"/.test(text), f);
  }
});

test("the Telegram webhook routes and /feed are gone", async () => {
  for (const path of ["/webhook/telegram", "/webhook/some-old-secret", "/family-webhook/x"]) {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 404, path);
  }
  assert.equal((await fetch(`${base}/feed`)).status, 404);
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
  const { createApp } = await import("../src/server");
  const other = await listen(createApp({ archiveApiKey: undefined, ownerSecret: undefined }));
  try {
    const url = `${other.base}/archive/stats`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer " } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer undefined" } })).status, 401);
  } finally {
    other.server.close();
  }
});

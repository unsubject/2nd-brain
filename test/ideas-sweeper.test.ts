// DB-backed test for the idea embedding sweeper. Gated on TEST_DATABASE_URL:
// a local *_test database with all migrations applied — either run
// `DATABASE_URL=$TEST_DATABASE_URL npm run migrate`, or run the mcp-worker
// vitest suite once against it (its setup resets and migrates the DB).
// The embedding call is injected — no OpenAI traffic.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;

let db: Pool;
let worker: typeof import("../src/ideas/worker");

const vec = (x: number) => {
  const v = new Array(1536).fill(0);
  v[0] = x;
  v[1] = Math.sqrt(1 - x * x);
  return v;
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

before(async () => {
  if (!url) return;
  // src/archive/embeddings constructs an OpenAI client at import time.
  process.env.OPENAI_API_KEY ??= "test-dummy";
  worker = await import("../src/ideas/worker");
  db = new Pool({ connectionString: url, max: 2 });
  // Check where we actually connected, not just what the URL says.
  const { rows } = await db.query("SELECT current_database() AS db, inet_server_addr()::text AS addr");
  const addr: string | null = rows[0].addr;
  if (!String(rows[0].db).endsWith("_test") || (addr !== null && !/^(127\.|::1)/.test(addr))) {
    await db.end();
    throw new Error(`Refusing to run against ${rows[0].db}@${addr}: needs a local *_test database`);
  }
});

after(async () => {
  await db?.end();
});

beforeEach(async () => {
  if (!url) return;
  await db.query("TRUNCATE idea, idea_source, idea_link CASCADE");
});

async function insertIdea(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO idea (user_id, title, thoughts, notes) VALUES ('u', $1, $2, $3) RETURNING id`,
    [title, extra.thoughts ?? null, JSON.stringify(extra.notes ?? [])]
  );
  return rows[0].id;
}

const ok = async (texts: string[]) => texts.map(() => vec(0.5));

async function state(id: string) {
  const { rows } = await db.query(
    `SELECT embedding IS NOT NULL AS has, embed_attempts, embed_error,
            embed_retry_at IS NOT NULL AND embed_retry_at > now() AS backing_off
       FROM idea WHERE id = $1`,
    [id]
  );
  return rows[0];
}

test("embeds pending ideas with the recipe text", { skip }, async () => {
  const id = await insertIdea("First", { thoughts: "mine", notes: [{ by: "simon", text: "note" }] });
  const seen: string[][] = [];
  const r = await worker.embedPendingIdeas({
    db,
    model: "test-model",
    embed: async (texts) => {
      seen.push(texts);
      return texts.map(() => vec(0.5));
    },
  });
  assert.deepEqual(r, { embedded: 1, skipped: 0, failed: 0, outage: false });
  assert.deepEqual(seen, [["First\n\nmine\n\nnote"]]);
  const { rows } = await db.query("SELECT embedding_model, embedded_at IS NOT NULL AS stamped FROM idea WHERE id = $1", [id]);
  assert.deepEqual(rows[0], { embedding_model: "test-model", stamped: true });
  assert.equal((await state(id)).has, true);
  const again = await worker.embedPendingIdeas({ db, embed: async () => assert.fail("nothing left to embed") });
  assert.deepEqual(again, { embedded: 0, skipped: 0, failed: 0, outage: false });
});

test("does not overwrite an idea edited while its embedding was in flight", { skip }, async () => {
  const id = await insertIdea("Before edit");
  const r = await worker.embedPendingIdeas({
    db,
    embed: async (texts) => {
      await db.query("UPDATE idea SET title = 'After edit', updated_at = now() WHERE id = $1", [id]);
      return texts.map(() => vec(0.5));
    },
  });
  assert.deepEqual(r, { embedded: 0, skipped: 1, failed: 0, outage: false });
  assert.equal((await state(id)).has, false);
});

test("an outage charges no attempts and leaves rows eligible", { skip }, async () => {
  const id = await insertIdea("During outage");
  for (const err of [new HttpError(503, "Service Unavailable"), new HttpError(429, "rate limited"), new Error("ECONNRESET")]) {
    const r = await worker.embedPendingIdeas({
      db,
      embed: async () => {
        throw err;
      },
    });
    assert.deepEqual(r, { embedded: 0, skipped: 0, failed: 0, outage: true });
  }
  assert.deepEqual(await state(id), { has: false, embed_attempts: 0, embed_error: null, backing_off: false });
  const r = await worker.embedPendingIdeas({ db, embed: ok });
  assert.equal(r.embedded, 1);
});

test("isolates a bad row, backs it off, and tick() terminates", { skip }, async () => {
  const good = await insertIdea("Good");
  const bad = await insertIdea("BAD");
  const embed = async (texts: string[]) => {
    if (texts.some((t) => t.startsWith("BAD"))) throw new HttpError(400, "invalid input");
    return texts.map(() => vec(0.5));
  };
  const r = await worker.tick({ db, embed });
  assert.deepEqual(r, { embedded: 1, skipped: 0, failed: 1, outage: false });
  assert.equal((await state(good)).has, true);
  assert.deepEqual(await state(bad), { has: false, embed_attempts: 1, embed_error: "invalid input", backing_off: true });

  // Not retried while backing off …
  const again = await worker.embedPendingIdeas({ db, embed: async () => assert.fail("should be backing off") });
  assert.equal(again.embedded + again.failed, 0);
  // … but retried once the backoff has elapsed.
  await db.query("UPDATE idea SET embed_retry_at = now() - interval '1 second' WHERE id = $1", [bad]);
  assert.equal((await worker.embedPendingIdeas({ db, embed: ok })).embedded, 1);
});

test("a failure on an idea edited mid-flight is not recorded", { skip }, async () => {
  const id = await insertIdea("BAD then edited");
  const r = await worker.embedPendingIdeas({
    db,
    embed: async () => {
      await db.query("UPDATE idea SET title = 'fixed', updated_at = now() WHERE id = $1", [id]);
      throw new HttpError(400, "invalid input");
    },
  });
  assert.equal(r.skipped, 1);
  assert.deepEqual(await state(id), { has: false, embed_attempts: 0, embed_error: null, backing_off: false });
});

test("retries over-long input with a shorter text", { skip }, async () => {
  const id = await insertIdea("Long", { thoughts: "粵".repeat(3000) });
  const r = await worker.embedPendingIdeas({
    db,
    embed: async (texts) => {
      if (texts.some((t) => Array.from(t).length > 2500)) {
        throw new HttpError(400, "This model's maximum context length is 8192 tokens");
      }
      return texts.map(() => vec(0.5));
    },
  });
  assert.equal(r.embedded, 1);
  assert.equal((await state(id)).has, true);
});

test("the trigger re-queues an idea when the user's words change", { skip }, async () => {
  const id = await insertIdea("Trigger");
  await worker.embedPendingIdeas({ db, embed: ok });
  await db.query(
    `UPDATE idea SET notes = notes || '[{"by":"agent","text":"x"}]'::jsonb, updated_at = now() WHERE id = $1`,
    [id]
  );
  assert.equal((await state(id)).has, true);
  await db.query(
    "UPDATE idea SET embed_attempts = 3, embed_retry_at = now() + interval '1 day' WHERE id = $1",
    [id]
  );
  await db.query("UPDATE idea SET thoughts = 'new words', updated_at = now() WHERE id = $1", [id]);
  assert.deepEqual(await state(id), { has: false, embed_attempts: 0, embed_error: null, backing_off: false });
});

// DB-backed test for the idea embedding sweeper. Gated on TEST_DATABASE_URL
// (a local *_test database with migrations applied, e.g. via
// `DATABASE_URL=$TEST_DATABASE_URL npm run migrate`). The embedding call
// is injected — no OpenAI traffic.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;

let db: Pool;
let embedPendingIdeas: typeof import("../src/ideas/worker").embedPendingIdeas;

const vec = (x: number) => {
  const v = new Array(1536).fill(0);
  v[0] = x;
  v[1] = Math.sqrt(1 - x * x);
  return v;
};

before(async () => {
  if (!url) return;
  const u = new URL(url);
  if (!["localhost", "127.0.0.1", "::1", "postgres"].includes(u.hostname) || !u.pathname.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must point at a local *_test database");
  }
  // src/archive/embeddings constructs an OpenAI client at import time.
  process.env.OPENAI_API_KEY ??= "test-dummy";
  ({ embedPendingIdeas } = await import("../src/ideas/worker"));
  db = new Pool({ connectionString: url, max: 2 });
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

test("embeds pending ideas with the recipe text", { skip }, async () => {
  const id = await insertIdea("First", { thoughts: "mine", notes: [{ by: "simon", text: "note" }] });
  const seen: string[][] = [];
  const r = await embedPendingIdeas({
    db,
    model: "test-model",
    embed: async (texts) => {
      seen.push(texts);
      return texts.map(() => vec(0.5));
    },
  });
  assert.deepEqual(r, { embedded: 1, skipped: 0, failed: 0 });
  assert.deepEqual(seen, [["First\n\nmine\n\nnote"]]);
  const { rows } = await db.query(
    "SELECT embedding IS NOT NULL AS has, embedding_model, embedded_at IS NOT NULL AS stamped FROM idea WHERE id = $1",
    [id]
  );
  assert.deepEqual(rows[0], { has: true, embedding_model: "test-model", stamped: true });
  const again = await embedPendingIdeas({ db, embed: async () => assert.fail("nothing left to embed") });
  assert.deepEqual(again, { embedded: 0, skipped: 0, failed: 0 });
});

test("does not overwrite an idea edited while its embedding was in flight", { skip }, async () => {
  const id = await insertIdea("Before edit");
  const r = await embedPendingIdeas({
    db,
    embed: async (texts) => {
      await db.query("UPDATE idea SET title = 'After edit', updated_at = now() WHERE id = $1", [id]);
      return texts.map(() => vec(0.5));
    },
  });
  assert.deepEqual(r, { embedded: 0, skipped: 1, failed: 0 });
  const { rows } = await db.query("SELECT embedding IS NULL AS pending FROM idea WHERE id = $1", [id]);
  assert.equal(rows[0].pending, true);
});

test("isolates a failing row and counts attempts", { skip }, async () => {
  const good = await insertIdea("Good");
  const bad = await insertIdea("BAD");
  const embed = async (texts: string[]) => {
    if (texts.some((t) => t.startsWith("BAD"))) throw new Error("rejected input");
    return texts.map(() => vec(0.5));
  };
  const r = await embedPendingIdeas({ db, embed });
  assert.deepEqual(r, { embedded: 1, skipped: 0, failed: 1 });
  const { rows } = await db.query(
    "SELECT id, embedding IS NOT NULL AS has, embed_attempts, embed_error FROM idea ORDER BY title"
  );
  const byId = new Map(rows.map((x) => [x.id, x]));
  assert.equal(byId.get(good).has, true);
  assert.equal(byId.get(bad).has, false);
  assert.equal(byId.get(bad).embed_attempts, 1);
  assert.match(byId.get(bad).embed_error, /rejected input/);

  // Gives up after maxAttempts.
  for (let i = 0; i < 3; i++) await embedPendingIdeas({ db, embed, maxAttempts: 3 });
  const last = await embedPendingIdeas({ db, embed: async () => assert.fail("should not retry"), maxAttempts: 3 });
  assert.deepEqual(last, { embedded: 0, skipped: 0, failed: 0 });
});

test("the trigger re-queues an idea when the user's words change", { skip }, async () => {
  const id = await insertIdea("Trigger");
  await embedPendingIdeas({ db, embed: async (t) => t.map(() => vec(0.5)) });
  await db.query(
    `UPDATE idea SET notes = notes || '[{"by":"agent","text":"x"}]'::jsonb, updated_at = now() WHERE id = $1`,
    [id]
  );
  let { rows } = await db.query("SELECT embedding IS NOT NULL AS has FROM idea WHERE id = $1", [id]);
  assert.equal(rows[0].has, true);
  await db.query("UPDATE idea SET thoughts = 'new words', updated_at = now() WHERE id = $1", [id]);
  ({ rows } = await db.query("SELECT embedding IS NOT NULL AS has FROM idea WHERE id = $1", [id]));
  assert.equal(rows[0].has, false);
});

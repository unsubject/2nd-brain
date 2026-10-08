// DB-backed test for journal link generation. Gated on TEST_DATABASE_URL: a
// local *_test database with all migrations applied (run the mcp-worker
// vitest suite once against it, or `npm run migrate`). Entity extraction is
// injected, and the OpenAI client is pointed at a closed local port, so no
// request leaves the machine.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;

let db: Pool;
let linker: typeof import("../src/google/linker");
let appPool: Pool | undefined;

before(async () => {
  if (!url) return;
  db = new Pool({ connectionString: url, max: 2 });
  const { rows } = await db.query("SELECT current_database() AS db, host(inet_server_addr()) AS addr");
  const addr: string | null = rows[0].addr;
  const local =
    addr === null ||
    /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr) ||
    addr === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(addr);
  if (!String(rows[0].db).endsWith("_test") || !local) {
    await db.end();
    throw new Error(`Refusing to run against ${rows[0].db}@${addr}: needs a local *_test database`);
  }
  // The linker writes through the app's shared pool, which reads
  // DATABASE_URL when first imported: point it at the checked database.
  process.env.DATABASE_URL = url;
  process.env.OPENAI_API_KEY ||= "sk-test-unused";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
  linker = await import("../src/google/linker");
  appPool = (await import("../src/db/client")).pool;
});

after(async () => {
  await appPool?.end();
  await db?.end();
});

const TASK_ID = "linker-test-task";
const ORG = "Linker Test Foundation";

beforeEach(async () => {
  if (!url) return;
  await db.query("DELETE FROM task_ref WHERE external_task_id = $1", [TASK_ID]);
  await db.query("DELETE FROM entity_ref WHERE user_id = 'default' AND normalized_name = $1", [ORG.toLowerCase()]);
});

test("one failing matcher keeps the other matchers' links, then reports the failure", { skip }, async () => {
  await db.query(
    `INSERT INTO task_ref (user_id, external_task_id, external_list_id, title, status)
     VALUES ('default', $1, 'list-1', 'Draft quarterly budget review', 'needsAction')`,
    [TASK_ID]
  );
  const entry = {
    id: randomUUID(),
    full_text: "Spent the morning on the quarterly budget with the foundation.",
    tags: [],
    created_at: new Date("2026-01-15T10:00:00Z"),
    // pgvector refuses NaN, so the artifact matcher's query fails.
    embedding: [Number.NaN],
  };
  const entities = async () => [
    { entity_type: "organization" as const, display_name: ORG, aliases: [], salience: 0.8 },
  ];

  try {
    const err: unknown = await linker.generateLinksStrict(entry, entities).then(
      () => null,
      (e: unknown) => e
    );
    // The entity and task matchers' links are written...
    const { rows } = await db.query(
      "SELECT link_type FROM link_edge WHERE source_type = 'journal_entry' AND source_id = $1 ORDER BY link_type",
      [entry.id]
    );
    assert.deepEqual(rows.map((r) => r.link_type), ["mentions_entity", "relates_to_task"]);
    // ...and the failure is still reported, naming the matcher.
    assert.ok(err instanceof AggregateError, `expected an AggregateError, got ${String(err)}`);
    assert.match(err.message, /artifacts matcher\(s\) failed/);
    assert.equal(err.errors.length, 1);
    assert.match(String(err.errors[0]), /NaN not allowed in vector/);

    // Re-running the entry (what the relink backfill does) adds no duplicates.
    await assert.rejects(linker.generateLinksStrict(entry, entities), AggregateError);
    const again = await db.query("SELECT count(*)::int AS n FROM link_edge WHERE source_id = $1", [entry.id]);
    assert.equal(again.rows[0].n, 2);
  } finally {
    await db.query("DELETE FROM link_edge WHERE source_id = $1", [entry.id]);
  }
});

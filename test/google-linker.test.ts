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
// Synthetic contact and calendar event, as the retired syncs stored them.
const PERSON = "Avery Quillfeather";
const PLACE = "Quillfeather Hall";
const PERSON_ID = "people/linker-test-person";
const EVENT_ID = "linker-test-event";

beforeEach(async () => {
  if (!url) return;
  await db.query("DELETE FROM task_ref WHERE external_task_id = $1", [TASK_ID]);
  await db.query("DELETE FROM entity_ref WHERE user_id = 'default' AND normalized_name = ANY($1::text[])", [
    [ORG, PERSON, PLACE].map((n) => n.toLowerCase()),
  ]);
});

test("people and calendar events are not linked, and people are not stored as entities", { skip }, async (t) => {
  // The rows the Contacts and Calendar syncs left behind stay in their
  // tables until a migration drops them; the linker no longer reads them.
  // Only this test touches those tables, so the drop leaves the others be.
  const { rows: tables } = await db.query(
    "SELECT to_regclass('public.person_ref') IS NOT NULL AND to_regclass('public.calendar_event_ref') IS NOT NULL AS present"
  );
  if (!tables[0].present) return t.skip("person_ref and calendar_event_ref are dropped");
  await db.query("DELETE FROM person_ref WHERE external_person_id = $1", [PERSON_ID]);
  await db.query("DELETE FROM calendar_event_ref WHERE external_event_id = $1", [EVENT_ID]);
  await db.query(
    `INSERT INTO person_ref (user_id, external_system, external_person_id, full_name)
     VALUES ('default', 'google_contacts', $1, $2)`,
    [PERSON_ID, PERSON]
  );
  await db.query(
    `INSERT INTO calendar_event_ref (user_id, external_system, external_event_id, title, start_at, end_at, scope)
     VALUES ('default', 'google_calendar', $1, $2, '2026-01-15T14:00:00Z', '2026-01-15T15:00:00Z', 'personal')`,
    [EVENT_ID, "Quillfeather Avery planning session"]
  );
  const entry = {
    id: randomUUID(),
    full_text: `Planning session with ${PERSON} about the foundation.`,
    tags: [],
    // The entry's day: the retired calendar matcher linked the events on it.
    created_at: new Date("2026-01-15T10:00:00Z"),
    embedding: [],
  };
  const entities = async () => [
    { entity_type: "person" as const, display_name: PERSON, aliases: ["Avery"], salience: 0.9 },
    { entity_type: "place" as const, display_name: PLACE, aliases: [], salience: 0.9 },
    { entity_type: "organization" as const, display_name: ORG, aliases: [], salience: 0.8 },
  ];

  try {
    await linker.generateLinksStrict(entry, entities);
    // Only the organization is linked: nothing points at the contact or the
    // event...
    const { rows } = await db.query(
      "SELECT target_type, link_type FROM link_edge WHERE source_type = 'journal_entry' AND source_id = $1",
      [entry.id]
    );
    assert.deepEqual(rows, [{ target_type: "entity_ref", link_type: "mentions_entity" }]);
    // ...and the person and the place are dropped, not kept as entities.
    const stored = await db.query(
      "SELECT entity_type FROM entity_ref WHERE user_id = 'default' AND normalized_name = ANY($1::text[]) ORDER BY 1",
      [[ORG, PERSON, PLACE].map((n) => n.toLowerCase())]
    );
    assert.deepEqual(stored.rows.map((r) => r.entity_type), ["organization"]);
    // The synced rows themselves are untouched.
    const kept = await db.query(
      `SELECT (SELECT count(*) FROM person_ref WHERE external_person_id = $1)::int AS people,
              (SELECT count(*) FROM calendar_event_ref WHERE external_event_id = $2)::int AS events`,
      [PERSON_ID, EVENT_ID]
    );
    assert.deepEqual(kept.rows[0], { people: 1, events: 1 });
  } finally {
    await db.query("DELETE FROM link_edge WHERE source_id = $1", [entry.id]);
  }
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
    assert.match(err.message, /artifacts matcher failed/);
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

test("a failed entity extraction keeps the other links, then is reported like a failed matcher", { skip }, async () => {
  await db.query(
    `INSERT INTO task_ref (user_id, external_task_id, external_list_id, title, status)
     VALUES ('default', $1, 'list-1', 'Draft quarterly budget review', 'needsAction')`,
    [TASK_ID]
  );
  const entry = {
    id: randomUUID(),
    full_text: "Spent the morning on the quarterly budget with the foundation.",
    tags: [],
    embedding: [],
  };
  const extractionDown = async (): Promise<never> => {
    throw new Error("synthetic extraction outage");
  };

  try {
    const err: unknown = await linker.generateLinksStrict(entry, extractionDown).then(
      () => null,
      (e: unknown) => e
    );
    // The task matcher does not need entities, so its link is written...
    const { rows } = await db.query(
      "SELECT link_type FROM link_edge WHERE source_type = 'journal_entry' AND source_id = $1",
      [entry.id]
    );
    assert.deepEqual(rows.map((r) => r.link_type), ["relates_to_task"]);
    // ...but the entry is not reported as fully linked: the relink backfill
    // has to count it as failed.
    assert.ok(err instanceof AggregateError, `expected an AggregateError, got ${String(err)}`);
    assert.match(err.message, /entity extraction failed/);
    assert.equal(err.errors.length, 1);
    assert.match(String(err.errors[0]), /synthetic extraction outage/);
  } finally {
    await db.query("DELETE FROM link_edge WHERE source_id = $1", [entry.id]);
  }
});

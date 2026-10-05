// DB-backed test for archive staging (upsert semantics + run tracking).
// Gated on TEST_DATABASE_URL: a local *_test database with migrations
// applied (CI's mcp-worker setup migrates it). No Google traffic.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;

let db: Pool;
let staging: typeof import("../src/archive/consolidation/staging");

before(async () => {
  if (!url) return;
  staging = await import("../src/archive/consolidation/staging");
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
});

after(async () => {
  await db?.end();
});

beforeEach(async () => {
  if (!url) return;
  await db.query("TRUNCATE archive_source_item, archive_collect_run");
});

const item = (over: Record<string, unknown> = {}) => ({
  source: "gmail" as const,
  sourceRef: "msg-1",
  containerRef: "thread-1",
  title: "利字當頭：科目三",
  authoredAt: new Date("2024-02-19T18:37:39Z"),
  rawText: "幾個星期前，港聲你聽的例會上……",
  rawHtml: null,
  metadata: { isSent: true },
  ...over,
});

test("upsert inserts, then reports unchanged, then updated on a content change", { skip }, async () => {
  assert.equal(await staging.upsertSourceItem(item(), db), "inserted");
  const before = await db.query("SELECT fetched_at FROM archive_source_item");
  assert.equal(await staging.upsertSourceItem(item(), db), "unchanged");
  const same = await db.query("SELECT fetched_at FROM archive_source_item");
  assert.deepEqual(same.rows[0].fetched_at, before.rows[0].fetched_at);

  assert.equal(await staging.upsertSourceItem(item({ rawText: "稍為修正了內容" }), db), "updated");
  assert.equal(await staging.upsertSourceItem(item({ rawText: "稍為修正了內容", metadata: { isSent: false } }), db), "updated");
  const { rows } = await db.query("SELECT raw_text, metadata, content_hash FROM archive_source_item");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_text, "稍為修正了內容");
  assert.deepEqual(rows[0].metadata, { isSent: false });
  assert.equal(rows[0].content_hash, staging.contentHash("稍為修正了內容", null));
});

test("upsert strips NUL bytes and rejects items with no body", { skip }, async () => {
  assert.equal(await staging.upsertSourceItem(item({ rawText: "a\u0000b", title: "t\u0000" }), db), "inserted");
  const { rows } = await db.query("SELECT raw_text, title FROM archive_source_item");
  assert.deepEqual(rows[0], { raw_text: "ab", title: "t" });
  await assert.rejects(staging.upsertSourceItem(item({ sourceRef: "x", rawText: null, rawHtml: null }), db), /no body/);
});

test("existingSourceRefs only reports refs of the given source", { skip }, async () => {
  await staging.upsertSourceItem(item(), db);
  await staging.upsertSourceItem(item({ source: "gdrive", sourceRef: "msg-2" }), db);
  const got = await staging.existingSourceRefs("gmail", ["msg-1", "msg-2", "msg-3"], db);
  assert.deepEqual([...got], ["msg-1"]);
});

test("auditPublicArtifacts flags email-contaminated, truncated and duplicate rows", { skip }, async () => {
  const { auditPublicArtifacts } = await import("../src/archive/consolidation/audit");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Seed inside a transaction that is rolled back: leaves no rows behind.
    await client.query(
      `INSERT INTO public_artifact (user_id, type, title, raw_source, source_system, processing_status) VALUES
         ('default', 'essay', '利字當頭 A', repeat('字', 2000), 'audit-test', 'processed'),
         ('default', 'essay', '利字當頭 a ', E'Hello Simon,\\n收到\\nKhaki 於 2024年2月19日 寫道：\\n正文', 'audit-test', 'error')`
    );
    const audit = (await auditPublicArtifacts(client)) as Record<string, any>;
    const buckets = (audit.length_buckets as any[]).find((b) => b.source_system === "audit-test");
    assert.equal(buckets.eq2000, 1);
    assert.ok(Number(audit.email_marker_rows) >= 1);
    assert.ok(Number(audit.dup_titles.groups) >= 1);
    assert.ok((audit.errors as any[]).some((e) => e.processing_status === "error"));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("one running run per source; stale runs are reclaimed", { skip }, async () => {
  const a = await staging.startRun("gmail", { label: "Writing" }, db);
  await assert.rejects(staging.startRun("gmail", {}, db), staging.RunAlreadyActiveError);
  // A different source can run alongside.
  const d = await staging.startRun("gdrive", { folderIds: ["x"] }, db);

  await staging.heartbeatRun(a, { listed: 10 }, db);
  await db.query(`UPDATE archive_collect_run SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [a]);
  const b = await staging.startRun("gmail", {}, db);
  assert.notEqual(a, b);
  const { rows } = await db.query("SELECT status, error, stats FROM archive_collect_run WHERE id = $1", [a]);
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error, /abandoned/);
  assert.deepEqual(rows[0].stats, { listed: 10 });

  await staging.finishRun(b, "succeeded", { inserted: 3 }, null, db);
  await staging.finishRun(d, "failed", {}, "boom", db);
  const status = await staging.getStagingStatus(db);
  assert.equal(status.runs.length, 3);
  // Finished runs free the slot.
  await staging.startRun("gmail", {}, db);
});

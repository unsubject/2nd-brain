// DB-backed test for members-only pieces (migration 033, D10): the column,
// and the YouTube import that sets it, through the HTTP route. Gated on
// TEST_DATABASE_URL: a local *_test database with all migrations applied.
// Synthetic videos only; the migration's own run goes to a scratch schema.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Pool } from "pg";
import { holdTestDatabase } from "./support/database-lock";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;
const SCHEMA = `members_only_test_${process.pid}`;
const MIGRATION = join(__dirname, "../migrations/033_published_access.sql");
const ARCHIVE_KEY = "archive-key-for-tests";
const VIDEOS = ["mo-test-joined", "mo-test-public", "mo-test-explicit"];

let db: Pool;
let appPool: Pool | undefined;
let server: Server | undefined;
let base: string;
let releaseDatabase: (() => Promise<void>) | undefined;

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
  releaseDatabase = await holdTestDatabase(url);
  // The import writes through the app's shared pool, which reads
  // DATABASE_URL when first imported: point it at the checked database.
  process.env.DATABASE_URL = url;
  process.env.OPENAI_API_KEY ||= "sk-test-unused";
  const { createApp } = await import("../src/server");
  appPool = (await import("../src/db/client")).pool;
  server = await new Promise<Server>((resolve) => {
    const s = createApp({ archiveApiKey: ARCHIVE_KEY, ownerSecret: undefined }).listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.query("DELETE FROM public_artifact WHERE source_system = 'youtube' AND source_external_id = ANY($1)", [VIDEOS]);
});

after(async () => {
  server?.close();
  if (url) {
    await db.query("DELETE FROM public_artifact WHERE source_system = 'youtube' AND source_external_id = ANY($1)", [VIDEOS]);
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  }
  await appPool?.end();
  await db?.end();
  await releaseDatabase?.();
});

test("033: members_only is a boolean, never null, false unless set", { skip }, async () => {
  const { rows } = await db.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'public_artifact' AND column_name = 'members_only'`
  );
  assert.deepEqual(rows, [{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
});

test("033 applies through the runner over existing rows, which read false, and again as a no-op", { skip }, async () => {
  // A stand-in public_artifact in a schema of its own, so the real table
  // and _migrations are never touched.
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.query(`CREATE SCHEMA ${SCHEMA}`);
  const scratch = new Pool({ connectionString: url, max: 1, options: `-c search_path=${SCHEMA}` });
  const dir = mkdtempSync(join(tmpdir(), "members-only-test-"));
  try {
    writeFileSync(
      join(dir, "032_stand_in.sql"),
      "CREATE TABLE public_artifact (n int);\nINSERT INTO public_artifact VALUES (1), (2);\n"
    );
    copyFileSync(MIGRATION, join(dir, "033_published_access.sql"));
    const { migrate } = await import("../src/db/migrate");
    await migrate(scratch, dir);

    const applied = await scratch.query("SELECT name FROM _migrations ORDER BY name");
    assert.deepEqual(applied.rows.map((r) => r.name), ["032_stand_in.sql", "033_published_access.sql"]);
    const read = async () => (await scratch.query("SELECT n, members_only FROM public_artifact ORDER BY n")).rows;
    assert.deepEqual(await read(), [
      { n: 1, members_only: false },
      { n: 2, members_only: false },
    ]);

    // Run again by hand (the runner skips it): a no-op, values kept.
    await scratch.query("UPDATE public_artifact SET members_only = true WHERE n = 2");
    await scratch.query(readFileSync(MIGRATION, "utf-8"));
    assert.deepEqual(await read(), [
      { n: 1, members_only: false },
      { n: 2, members_only: true },
    ]);
  } finally {
    await scratch.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

const video = (id: string, over: Record<string, unknown> = {}) => ({
  video_id: id,
  title: "會員測試影片",
  transcript: "這是一段合成的逐字稿，只用於測試。",
  published_at: "2026-09-01T12:00:00Z",
  keywords: "測試, synthetic",
  ...over,
});

async function post(body: unknown): Promise<Response> {
  return fetch(`${base}/archive/import/youtube`, {
    method: "POST",
    headers: { authorization: `Bearer ${ARCHIVE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function stored(id: string): Promise<{ members_only: boolean; processing_status: string }> {
  const { rows } = await db.query(
    "SELECT members_only, processing_status FROM public_artifact WHERE source_system = 'youtube' AND source_external_id = $1",
    [id]
  );
  assert.equal(rows.length, 1, id);
  return rows[0];
}

test("the YouTube import sets members_only; a sync that leaves it out keeps it; false clears it", { skip }, async () => {
  const [joined, open, explicit] = VIDEOS;

  // A new video: members-only when the sync says so, else public.
  assert.equal((await post(video(joined, { members_only: true }))).status, 200);
  assert.equal((await stored(joined)).members_only, true);
  assert.equal((await post(video(open))).status, 200);
  assert.equal((await stored(open)).members_only, false);
  assert.equal((await post(video(explicit, { members_only: false }))).status, 200);
  assert.equal((await stored(explicit)).members_only, false);

  // A re-sync that doesn't send the field (an older sync script) keeps the
  // row members-only, and the same text is not processed again.
  await db.query("UPDATE public_artifact SET processing_status = 'processed' WHERE source_external_id = ANY($1)", [VIDEOS]);
  assert.equal((await post(video(joined))).status, 200);
  assert.deepEqual(await stored(joined), { members_only: true, processing_status: "processed" });

  // A value that is not a boolean is refused, and the row keeps its value.
  for (const members_only of ["false", "no", 0, null]) {
    const res = await post(video(joined, { members_only }));
    assert.equal(res.status, 400, JSON.stringify(members_only));
    assert.deepEqual(await res.json(), { error: "members_only must be true or false" });
  }
  assert.equal((await stored(joined)).members_only, true);

  // Explicit values switch it either way.
  assert.equal((await post(video(joined, { members_only: false }))).status, 200);
  assert.deepEqual(await stored(joined), { members_only: false, processing_status: "processed" });
  assert.equal((await post(video(open, { members_only: true }))).status, 200);
  assert.equal((await stored(open)).members_only, true);
  assert.equal((await post(video(open))).status, 200);
  assert.equal((await stored(open)).members_only, true);
});

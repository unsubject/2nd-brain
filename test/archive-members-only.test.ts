// DB-backed test for members-only pieces (migration 033, D10). Gated on
// TEST_DATABASE_URL: a local *_test database with all migrations applied.
// The migration's own run goes to a scratch schema.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Pool } from "pg";
import { holdTestDatabase } from "./support/database-lock";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;
const SCHEMA = `members_only_test_${process.pid}`;
const MIGRATION = join(__dirname, "../migrations/033_published_access.sql");

let db: Pool;
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
});

after(async () => {
  if (url) await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
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

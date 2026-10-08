// DB-backed test for the migration runner. Gated on TEST_DATABASE_URL (a
// local *_test database). It runs synthetic migrations in a scratch schema
// of its own, so the database's real _migrations table is never touched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;
const SCHEMA = `migrate_test_${process.pid}`;

let admin: Pool;
let migrate: typeof import("../src/db/migrate").migrate;
let dir: string;

before(async () => {
  if (!url) return;
  admin = new Pool({ connectionString: url, max: 1 });
  const { rows } = await admin.query("SELECT current_database() AS db, host(inet_server_addr()) AS addr");
  const addr: string | null = rows[0].addr;
  const local =
    addr === null ||
    /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr) ||
    addr === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(addr);
  if (!String(rows[0].db).endsWith("_test") || !local) {
    await admin.end();
    throw new Error(`Refusing to run against ${rows[0].db}@${addr}: needs a local *_test database`);
  }
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  migrate = (await import("../src/db/migrate")).migrate;
  dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
});

after(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin?.end();
});

test("a migration may outlast the pool's statement_timeout, which still holds for the pool afterwards", { skip }, async () => {
  // Like the app's pool, but with a 300 ms limit, so a migration that
  // sleeps for one second is over it.
  const db = new Pool({
    connectionString: url,
    max: 1,
    statement_timeout: 300,
    options: `-c search_path=${SCHEMA}`,
  });
  try {
    writeFileSync(join(dir, "001_slow.sql"), "CREATE TABLE marker (n int);\nSELECT pg_sleep(1);\n");
    writeFileSync(join(dir, "002_after.sql"), "INSERT INTO marker VALUES (2);\n");

    await migrate(db, dir);

    const applied = await admin.query(`SELECT name FROM ${SCHEMA}._migrations ORDER BY name`);
    assert.deepEqual(applied.rows.map((r) => r.name), ["001_slow.sql", "002_after.sql"]);
    const marker = await admin.query(`SELECT n FROM ${SCHEMA}.marker`);
    assert.deepEqual(marker.rows, [{ n: 2 }]);

    // The lifted limit stayed on the migration's own connection.
    const { rows } = await db.query("SHOW statement_timeout");
    assert.equal(rows[0].statement_timeout, "300ms");
    await assert.rejects(db.query("SELECT pg_sleep(1)"), /statement timeout/);

    // A second run skips what is applied.
    await migrate(db, dir);
    const again = await admin.query(`SELECT count(*)::int AS n FROM ${SCHEMA}._migrations`);
    assert.equal(again.rows[0].n, 2);
  } finally {
    await db.end();
  }
});

test("a migration blocked on a lock gives up after the pool's statement_timeout instead of waiting without limit", { skip }, async () => {
  // While a migration waits for its lock, every later query on that table
  // queues behind it. So the wait keeps the pool's limit (300 ms here),
  // even though the migration's run time does not.
  const db = new Pool({
    connectionString: url,
    max: 1,
    statement_timeout: 300,
    options: `-c search_path=${SCHEMA}`,
  });
  const lockDir = mkdtempSync(join(tmpdir(), "migrate-lock-test-"));
  const holder = await admin.connect();
  let timer: NodeJS.Timeout | undefined;
  try {
    await holder.query(`CREATE TABLE ${SCHEMA}.locked (n int)`);
    // An open transaction that has read the table, as a live query would.
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${SCHEMA}.locked IN ACCESS SHARE MODE`);
    writeFileSync(join(lockDir, "001_alter.sql"), "ALTER TABLE locked ADD COLUMN extra int;\n");

    const started = Date.now();
    const run = migrate(db, lockDir).then(() => "applied", (err: unknown) => err);
    const outcome = await Promise.race([
      run,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("still waiting after 5 s"), 5000);
      }),
    ]);
    const elapsed = Date.now() - started;
    await holder.query("ROLLBACK");
    await run; // without a lock limit, the migration applies once the lock is free

    assert.ok(outcome instanceof Error, `expected the migration to fail, got: ${String(outcome)}`);
    assert.match(outcome.message, /lock timeout/);
    assert.ok(elapsed < 3000, `gave up after ${elapsed} ms`);
    const applied = await db.query("SELECT count(*)::int AS n FROM _migrations WHERE name = '001_alter.sql'");
    assert.equal(applied.rows[0].n, 0);

    // The lock limit, like the lifted statement limit, stayed on the
    // migration's own connection.
    const { rows } = await db.query("SHOW lock_timeout");
    assert.equal(rows[0].lock_timeout, "0");
  } finally {
    clearTimeout(timer);
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    await db.end();
    rmSync(lockDir, { recursive: true, force: true });
  }
});

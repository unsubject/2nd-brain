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

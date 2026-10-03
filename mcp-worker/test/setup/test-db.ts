// Vitest global setup for the DB-backed handler tests (test/db/*).
//
// Gated on TEST_DATABASE_URL: without it this is a no-op and the DB
// suites skip themselves. With it, the database is RESET and every
// migration in ../migrations is applied in order (and recorded in
// _migrations exactly like src/db/migrate.ts, so `npm run migrate` on the
// same database afterwards is a no-op) — which also proves the newest
// migration applies cleanly on top of the others.
//
// Safety: refuses anything but a local database whose name ends in _test,
// checked both on the URL and on the server we actually connected to.

import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

export function assertSafeTestUrl(raw: string): void {
  const url = new URL(raw);
  const db = url.pathname.replace(/^\//, '');
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  // Query parameters (e.g. ?database= / ?host=) and multi-host or
  // multi-@ authorities are parsed differently by the drivers than by
  // URL — refuse them outright.
  if (url.search || authority.includes(',') || (authority.match(/@/g) ?? []).length > 1) {
    throw new Error('Refusing TEST_DATABASE_URL with query parameters or multiple hosts');
  }
  if (!LOCAL_HOSTS.has(url.hostname) || !db.endsWith('_test')) {
    throw new Error(
      `Refusing to reset ${url.hostname}/${db}: TEST_DATABASE_URL must point at a local database whose name ends in _test`,
    );
  }
}

export async function assertSafeConnection(sql: postgres.Sql): Promise<void> {
  const [row] = await sql<Array<{ db: string; addr: string | null }>>`
    SELECT current_database() AS db, inet_server_addr()::text AS addr
  `;
  const loopback = row.addr === null || /^(127\.|::1)/.test(row.addr);
  if (!row.db.endsWith('_test') || !loopback) {
    throw new Error(`Refusing to reset ${row.db} on ${row.addr}: not a local *_test database`);
  }
}

export default async function setup(): Promise<void> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return;
  assertSafeTestUrl(raw);

  const sql = postgres(raw, { max: 1, onnotice: () => {} });
  try {
    await assertSafeConnection(sql);
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;').simple();
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const dir = fileURLToPath(new URL('../../../migrations/', import.meta.url).href);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      await sql.unsafe(readFileSync(join(dir, f), 'utf8')).simple();
      await sql`INSERT INTO _migrations (name) VALUES (${f}) ON CONFLICT (name) DO NOTHING`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

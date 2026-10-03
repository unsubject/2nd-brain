// Vitest global setup for the DB-backed handler tests (test/db/*).
//
// Gated on TEST_DATABASE_URL: without it this is a no-op and the DB
// suites skip themselves, so CI (which has no Postgres) still runs the
// dispatcher + pure unit tests. With it, the database is RESET and every
// migration in ../migrations is applied in order — which also proves the
// newest migration applies cleanly on top of the others.
//
// Safety: refuses anything but a local database whose name ends in _test.

import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

export function assertSafeTestUrl(raw: string): void {
  const url = new URL(raw);
  const db = url.pathname.replace(/^\//, '');
  if (!LOCAL_HOSTS.has(url.hostname) || !db.endsWith('_test')) {
    throw new Error(
      `Refusing to reset ${url.hostname}/${db}: TEST_DATABASE_URL must point at a local database whose name ends in _test`,
    );
  }
}

export default async function setup(): Promise<void> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return;
  assertSafeTestUrl(raw);

  const sql = postgres(raw, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;').simple();
    const dir = fileURLToPath(new URL('../../../migrations/', import.meta.url).href);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      await sql.unsafe(readFileSync(join(dir, f), 'utf8')).simple();
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

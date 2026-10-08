// The DB-backed test files share one database, and `node --test` runs test
// files in parallel: one file's TRUNCATEs and rows would land in another's
// assertions, or deadlock with its transactions (the idea sweeper truncates
// the idea tables that a consolidation load updates). Each such file holds
// this lock from its setup to its teardown, so they run one at a time while
// the other files still run alongside. Not a test file itself (no
// .test.ts), so the test glob leaves it alone.

import { Client } from "pg";

// Returns the release: ending the session drops the lock, as does the test
// process exiting.
export async function holdTestDatabase(url: string): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('2nd-brain test database'))");
  return () => client.end();
}

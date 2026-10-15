import { syncTasks } from "./tasks";
import { pool } from "../db/client";
import { describeGoogleError } from "./errors";

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function isAuthenticated(): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM google_tokens WHERE user_id = 'default'`
  );
  return rows.length > 0;
}

// Only Google Tasks is synced, until the Subjects import is done. The
// Calendar and Contacts syncs are retired; the rows they stored stay until
// the migration that drops their tables.
async function runSync(): Promise<void> {
  if (!(await isAuthenticated())) {
    return;
  }

  console.log("Starting Google sync...");
  const start = Date.now();

  try {
    await syncTasks();
    console.log("  Tasks synced");
  } catch (err) {
    console.error("  Tasks sync error:", describeGoogleError(err));
  }

  console.log(`Google sync complete (${Math.round((Date.now() - start) / 1000)}s)`);
}

export function startGoogleSync(): void {
  console.log("Google sync scheduled (every 30 min)");
  // Run first sync after 10s to let the server start
  setTimeout(() => {
    runSync().catch((err) => console.error("Google sync error:", describeGoogleError(err)));
  }, 10_000);
  setInterval(() => {
    runSync().catch((err) => console.error("Google sync error:", describeGoogleError(err)));
  }, SYNC_INTERVAL_MS);
}

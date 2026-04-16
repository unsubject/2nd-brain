import { syncTasks } from "./tasks";
import { syncContacts } from "./contacts";
import { syncCalendar } from "./calendar";
import { syncGmail } from "./gmail";
import { pool } from "../db/client";

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function isAuthenticated(): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM google_tokens WHERE user_id = 'default'`
  );
  return rows.length > 0;
}

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
    console.error("  Tasks sync error:", err);
  }

  try {
    await syncContacts();
    console.log("  Contacts synced");
  } catch (err) {
    console.error("  Contacts sync error:", err);
  }

  try {
    await syncCalendar();
    console.log("  Calendar synced");
  } catch (err) {
    console.error("  Calendar sync error:", err);
  }

  try {
    await syncGmail();
    console.log("  Gmail synced");
  } catch (err) {
    console.error("  Gmail sync error:", err);
  }

  console.log(`Google sync complete (${Math.round((Date.now() - start) / 1000)}s)`);
}

export function startGoogleSync(): void {
  console.log("Google sync scheduled (every 30 min)");
  // Run first sync after 10s to let the server start
  setTimeout(() => {
    runSync().catch((err) => console.error("Google sync error:", err));
  }, 10_000);
  setInterval(() => {
    runSync().catch((err) => console.error("Google sync error:", err));
  }, SYNC_INTERVAL_MS);
}

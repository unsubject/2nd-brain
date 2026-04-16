import * as queries from "./db/queries";
import { processEntry } from "./processor";

const POLL_INTERVAL_MS = 30_000;
const STITCH_WINDOW_MS = 10 * 60 * 1000;

async function tick(): Promise<void> {
  while (true) {
    const entry = await queries.findPendingEntry(STITCH_WINDOW_MS);
    if (!entry) break;

    console.log(`Processing entry ${entry.id}...`);
    try {
      const result = await processEntry(entry.full_text);
      await queries.saveProcessingResult(entry.id, result);
      console.log(`Processed entry ${entry.id}`);
    } catch (err) {
      console.error(`Error processing entry ${entry.id}:`, err);
      await queries.markProcessingError(entry.id);
    }
  }
}

export function startWorker(): void {
  console.log("Background processor started (polling every 30s)");
  const run = () => {
    tick().catch((err) => console.error("Worker tick error:", err));
  };
  run();
  setInterval(run, POLL_INTERVAL_MS);
}

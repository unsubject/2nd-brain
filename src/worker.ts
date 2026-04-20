import * as queries from "./db/queries";
import { processEntry } from "./processor";
import { generateEmbedding } from "./embeddings";
import { generateLinks } from "./google/linker";
import { maybeCreateTaskSuggestion } from "./taskSuggest";

const POLL_INTERVAL_MS = 30_000;
const STITCH_WINDOW_MS = 10 * 60 * 1000;

async function tick(): Promise<void> {
  while (true) {
    const entry = await queries.findPendingEntry(STITCH_WINDOW_MS);
    if (!entry) break;

    console.log(`Processing entry ${entry.id}...`);
    try {
      const result = await processEntry(entry.full_text);
      const embedding = await generateEmbedding(result.clean_text);
      await queries.saveProcessingResult(entry.id, result, embedding);
      console.log(`Processed entry ${entry.id}`);

      try {
        await maybeCreateTaskSuggestion(entry.id, result);
      } catch (err) {
        console.error(
          `[worker] task suggestion failed for entry ${entry.id}:`,
          err
        );
      }

      await generateLinks({
        id: entry.id,
        full_text: entry.full_text,
        tags: result.tags,
        created_at: new Date(),
        embedding,
      });
      console.log(`Links generated for entry ${entry.id}`);
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

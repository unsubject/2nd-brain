import * as queries from "./db/queries";
import { embeddingInput, processEntry } from "./processor";
import { generateEmbedding } from "./embeddings";
import { generateLinks } from "./google/linker";
import { isAiFeedbackText, parseFirstLineHashtags } from "./utils";

const POLL_INTERVAL_MS = 30_000;
const STITCH_WINDOW_MS = 10 * 60 * 1000;

async function tick(): Promise<void> {
  while (true) {
    const entry = await queries.findPendingEntry(STITCH_WINDOW_MS);
    if (!entry) break;

    console.log(`Processing entry ${entry.id}...`);
    try {
      if (isAiFeedbackText(entry.full_text)) {
        const tags = parseFirstLineHashtags(entry.full_text);
        const embedding = await generateEmbedding(
          embeddingInput({ summary: "", clean_text: entry.full_text })
        );
        await queries.saveAiFeedbackResult(
          entry.id,
          entry.full_text,
          tags,
          embedding
        );
        console.log(`Processed ai_feedback entry ${entry.id}`);
        continue;
      }

      const result = await processEntry(entry.full_text);
      const embedding = await generateEmbedding(embeddingInput(result));
      await queries.saveProcessingResult(entry.id, result, embedding);
      console.log(`Processed entry ${entry.id}`);

      // Downstream concerns are isolated: each runs in its own
      // try/catch so a failure does NOT flip the row back to 'error'
      // via the outer markProcessingError. Primary processing has
      // already succeeded by this point; downstream failures should
      // log and move on, not corrupt the row state.
      try {
        await generateLinks({
          id: entry.id,
          full_text: entry.full_text,
          tags: result.tags,
          // The entry's own date: an entry processed late (re-queued after
          // an error) links to the events of the day it was written.
          created_at: entry.created_at,
          embedding,
        });
        console.log(`Links generated for entry ${entry.id}`);
      } catch (err) {
        console.error(
          `[worker] link generation failed for entry ${entry.id}:`,
          err
        );
      }
    } catch (err) {
      console.error(`Error processing entry ${entry.id}:`, err);
      const message = err instanceof Error ? err.message : String(err);
      await queries.markProcessingError(entry.id, message);
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

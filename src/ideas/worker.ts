import { pool, type DB } from "../db/client";
import { batchEmbed, EMBEDDING_MODEL } from "../archive/embeddings";
import { buildIdeaEmbeddingText, type IdeaNote } from "./embeddingText";

// Embeds Idea Parking Lot ideas. The MCP Worker inserts ideas with
// embedding NULL (it never processes rows itself); the idea_before_update
// trigger clears the embedding when an embedded field changes. This
// sweeper fills both cases.

const POLL_INTERVAL_MS = 30_000;

type PendingIdea = {
  id: string;
  title: string;
  framing: string | null;
  why_interesting: string | null;
  thoughts: string | null;
  notes: IdeaNote[] | null;
  source_title: string | null;
  source_excerpt: string | null;
  tags: string[] | null;
  // Text form keeps microsecond precision for the optimistic write guard
  // (a JS Date would truncate to milliseconds and never match).
  updated_at_text: string;
};

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export type SweepOptions = {
  db?: DB;
  embed?: EmbedFn;
  model?: string;
  batchSize?: number;
  maxAttempts?: number;
};

export async function embedPendingIdeas(
  opts: SweepOptions = {}
): Promise<{ embedded: number; skipped: number; failed: number }> {
  const db = opts.db ?? pool;
  const embed = opts.embed ?? batchEmbed;
  const model = opts.model ?? EMBEDDING_MODEL;
  const batchSize = opts.batchSize ?? 50;
  const maxAttempts = opts.maxAttempts ?? 5;

  const { rows } = await db.query<PendingIdea>(
    `SELECT id, title, framing, why_interesting, thoughts, notes,
            source_title, source_excerpt, tags, updated_at::text AS updated_at_text
       FROM idea
      WHERE embedding IS NULL AND embed_attempts < $1
      ORDER BY updated_at
      LIMIT $2`,
    [maxAttempts, batchSize]
  );
  const result = { embedded: 0, skipped: 0, failed: 0 };
  if (rows.length === 0) return result;

  const texts = rows.map((r) => buildIdeaEmbeddingText(r));
  let vectors: Array<number[] | Error>;
  try {
    vectors = await embed(texts);
  } catch {
    // Isolate the bad row(s): retry one at a time.
    vectors = [];
    for (const t of texts) {
      try {
        vectors.push((await embed([t]))[0]);
      } catch (err) {
        vectors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const v = vectors[i];
    if (v instanceof Error || !Array.isArray(v)) {
      const message = v instanceof Error ? v.message : "no embedding returned";
      await db.query(
        `UPDATE idea SET embed_attempts = embed_attempts + 1, embed_error = $2 WHERE id = $1`,
        [row.id, message.slice(0, 1000)]
      );
      result.failed++;
      continue;
    }
    const updated = await db.query(
      `UPDATE idea
          SET embedding = $2::vector, embedding_model = $3,
              embedded_at = now(), embed_error = NULL
        WHERE id = $1 AND updated_at = $4::timestamptz AND embedding IS NULL`,
      [row.id, `[${v.join(",")}]`, model, row.updated_at_text]
    );
    // Edited mid-flight: the next tick embeds the new text.
    if (updated.rowCount === 0) result.skipped++;
    else result.embedded++;
  }
  return result;
}

async function tick(): Promise<void> {
  for (;;) {
    const r = await embedPendingIdeas();
    if (r.embedded + r.failed > 0) {
      console.log(`[ideas] embedded ${r.embedded}, failed ${r.failed}, skipped ${r.skipped}`);
    }
    if (r.embedded + r.skipped + r.failed === 0) return;
    // Only failures left in this batch: stop until the next poll.
    if (r.embedded === 0 && r.skipped === 0) return;
  }
}

export function startIdeaEmbeddingWorker(): void {
  console.log("Idea embedding sweeper started (polling every 30s)");
  const scheduleNext = () => {
    setTimeout(() => {
      tick()
        .catch((err) => console.error("[ideas] Sweeper tick error:", err))
        .finally(scheduleNext);
    }, POLL_INTERVAL_MS);
  };
  tick()
    .catch((err) => console.error("[ideas] Sweeper tick error:", err))
    .finally(scheduleNext);
}

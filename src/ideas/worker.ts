import { pool, type DB } from "../db/client";
import { batchEmbed, EMBEDDING_MODEL } from "../archive/embeddings";
import { buildIdeaEmbeddingText, estimateTokens, truncateToTokenBudget, type IdeaNote } from "./embeddingText";

// Embeds Idea Parking Lot ideas. The MCP Worker inserts ideas with
// embedding NULL (it never processes rows itself); the idea_before_update
// trigger clears the embedding when an embedded field changes. This
// sweeper fills both cases.
//
// Failure handling:
//   - systemic errors (auth, quota/rate limit, 5xx, network) charge no
//     attempts — the tick just ends and the next poll tries again;
//   - row-specific errors (HTTP 400, e.g. over-long input) increment
//     embed_attempts and back off exponentially via embed_retry_at
//     (1 min · 2^attempts, capped at a day), so a bad row never blocks
//     the queue and is still retried occasionally.

const POLL_INTERVAL_MS = 30_000;
// OpenAI caps one embeddings request at 300k tokens; stay well below.
const REQUEST_TOKEN_BUDGET = 200_000;

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
};

export type SweepResult = { embedded: number; skipped: number; failed: number; outage: boolean };

// Row-specific = the request itself was rejected (bad input). Anything
// else — 401/403/429/5xx, timeouts, connection errors — is systemic.
export function isRowSpecificError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 400 || status === 413 || status === 422;
}

function isContextLengthError(err: unknown): boolean {
  return err instanceof Error && /maximum context length|too many tokens/i.test(err.message);
}

// Split texts into requests that stay under the per-request token cap.
function chunkByTokens(texts: string[]): number[][] {
  const groups: number[][] = [];
  let cur: number[] = [];
  let tokens = 0;
  texts.forEach((t, i) => {
    const n = estimateTokens(t);
    if (cur.length > 0 && tokens + n > REQUEST_TOKEN_BUDGET) {
      groups.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(i);
    tokens += n;
  });
  if (cur.length > 0) groups.push(cur);
  return groups;
}

export async function embedPendingIdeas(opts: SweepOptions = {}): Promise<SweepResult> {
  const db = opts.db ?? pool;
  const embed = opts.embed ?? batchEmbed;
  const model = opts.model ?? EMBEDDING_MODEL;
  const batchSize = opts.batchSize ?? 50;

  const { rows } = await db.query<PendingIdea>(
    `SELECT id, title, framing, why_interesting, thoughts, notes,
            source_title, source_excerpt, tags, updated_at::text AS updated_at_text
       FROM idea
      WHERE embedding IS NULL
        AND (embed_retry_at IS NULL OR embed_retry_at <= now())
      ORDER BY updated_at
      LIMIT $1`,
    [batchSize]
  );
  const result: SweepResult = { embedded: 0, skipped: 0, failed: 0, outage: false };
  if (rows.length === 0) return result;

  const texts = rows.map((r) => buildIdeaEmbeddingText(r));
  const vectors: Array<number[] | Error | undefined> = new Array(rows.length);

  for (const group of chunkByTokens(texts)) {
    try {
      const out = await embed(group.map((i) => texts[i]));
      group.forEach((i, j) => (vectors[i] = out[j]));
    } catch (err) {
      if (!isRowSpecificError(err)) {
        // Service-level problem: charge nothing, try again next poll.
        console.error("[ideas] embeddings unavailable:", err instanceof Error ? err.message : err);
        result.outage = true;
        break;
      }
      // Isolate the bad row(s): retry one at a time.
      for (const i of group) {
        try {
          vectors[i] = (await embed([texts[i]]))[0];
        } catch (rowErr) {
          if (isContextLengthError(rowErr)) {
            try {
              vectors[i] = (await embed([truncateToTokenBudget(texts[i], 3500)]))[0];
              continue;
            } catch (retryErr) {
              rowErr = retryErr;
            }
          }
          if (!isRowSpecificError(rowErr)) {
            result.outage = true;
            break;
          }
          vectors[i] = rowErr instanceof Error ? rowErr : new Error(String(rowErr));
        }
      }
      if (result.outage) break;
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const v = vectors[i];
    if (v === undefined) continue; // not attempted (outage)
    if (v instanceof Error || !Array.isArray(v)) {
      const message = v instanceof Error ? v.message : "no embedding returned";
      const failed = await db.query(
        `UPDATE idea
            SET embed_attempts = embed_attempts + 1,
                embed_error = $2,
                embed_retry_at = now() + LEAST(interval '1 minute' * power(2, embed_attempts), interval '1 day')
          WHERE id = $1 AND updated_at = $3::timestamptz AND embedding IS NULL`,
        [row.id, message.slice(0, 1000), row.updated_at_text]
      );
      if (failed.rowCount === 0) result.skipped++;
      else result.failed++;
      continue;
    }
    const updated = await db.query(
      `UPDATE idea
          SET embedding = $2::vector, embedding_model = $3,
              embedded_at = now(), embed_error = NULL, embed_retry_at = NULL
        WHERE id = $1 AND updated_at = $4::timestamptz AND embedding IS NULL`,
      [row.id, `[${v.join(",")}]`, model, row.updated_at_text]
    );
    // Edited mid-flight: the next tick embeds the new text.
    if (updated.rowCount === 0) result.skipped++;
    else result.embedded++;
  }
  return result;
}

// Drain the queue. Failed rows are pushed into the future by
// embed_retry_at, so a re-select in the same tick never sees them again.
export async function tick(opts: SweepOptions = {}): Promise<SweepResult> {
  const total: SweepResult = { embedded: 0, skipped: 0, failed: 0, outage: false };
  for (;;) {
    const r = await embedPendingIdeas(opts);
    total.embedded += r.embedded;
    total.skipped += r.skipped;
    total.failed += r.failed;
    if (r.outage) {
      total.outage = true;
      break;
    }
    if (r.embedded + r.skipped === 0) break;
  }
  if (total.embedded + total.failed > 0) {
    console.log(`[ideas] embedded ${total.embedded}, failed ${total.failed}, skipped ${total.skipped}`);
  }
  return total;
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

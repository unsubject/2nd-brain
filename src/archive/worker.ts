import * as archiveQueries from "./queries";
import { analyzeArtifact, extractEntities } from "./processor";
import { chunkArtifact } from "./chunker";
import { batchEmbed, EMBEDDING_MODEL } from "./embeddings";
import { normalizeMarkdown } from "./ingest/markdown";
import { retireReplacedRows } from "./consolidation/load/run";

const POLL_INTERVAL_MS = 60_000;
// How often to put back rows whose lease has run out: their worker
// stopped mid-row (a restart or deploy), or spent that long in one model
// call.
const RECLAIM_INTERVAL_MS = 5 * 60_000;
let lastReclaim = 0;

async function reclaimStale(): Promise<void> {
  if (Date.now() - lastReclaim < RECLAIM_INTERVAL_MS) return;
  lastReclaim = Date.now();
  const n = await archiveQueries.reclaimStaleProcessing();
  if (n > 0) console.log(`[archive] Requeued ${n} row(s) whose worker's claim expired`);
}

async function processOne(): Promise<boolean> {
  await reclaimStale();
  const artifact = await archiveQueries.findPendingArtifact();
  if (!artifact) return false;
  // Every write this pass makes requires its claim. A claim lost meanwhile
  // (taken back once its lease ran out, the text changed by a load or an
  // import, or the row reset) leaves the row to the pass that holds it now,
  // or the next.
  const claim = { token: artifact.claim_token, rawSource: artifact.raw_source };
  const dropped = (outcome = "left for the next pass"): true => {
    console.log(`[archive] "${artifact.title}" lost its claim while processing (requeued, reset or taken back); ${outcome}`);
    return true;
  };

  console.log(`[archive] Processing "${artifact.title}" (${artifact.id})...`);

  try {
    // 1. Normalize text programmatically (avoids re-asking Claude to copy it)
    const cleanText = normalizeMarkdown(artifact.raw_source);

    // 2. Analyze: summarize, tag (on cleaned text)
    const analysis = await analyzeArtifact(
      artifact.title,
      cleanText,
      artifact.tags
    );
    // Renew the lease between model steps, or stop if it is lost.
    if (!(await archiveQueries.renewClaim(artifact.id, claim))) return dropped();

    // Prefer a source-provided summary over the LLM's when one is present
    const existingSummary = artifact.summary?.trim();
    const finalSummary =
      existingSummary && existingSummary.length > 0
        ? artifact.summary!
        : analysis.summary;
    if (existingSummary && existingSummary.length > 0) {
      console.log(
        `[archive] Using source summary for "${artifact.title}" (${existingSummary.length} chars)`
      );
    }

    // 3. Chunk
    const chunks = chunkArtifact(cleanText);

    // 3. Embed chunks + summary
    const textsToEmbed = [
      finalSummary,
      ...chunks.map((c) => c.chunkText),
    ];
    const embeddings = await batchEmbed(textsToEmbed);
    const summaryEmbedding = embeddings[0];
    const chunkEmbeddings = embeddings.slice(1);

    // Again before the entity calls (the save below checks once more).
    if (!(await archiveQueries.renewClaim(artifact.id, claim))) return dropped();

    // 4. Extract entities. Their shared names are written with the rest
    // below, under the claim.
    const entities = await extractEntities(artifact.title, cleanText);

    // 5. Save it all at once: the result, chunks, entities, and the links
    // to artifacts sharing entities (rebuilt, so nothing from an earlier
    // pass stays). Then the row can be found, and the rows it replaces
    // (archive consolidation, step 4) leave search.
    const saved = await archiveQueries.completeArtifactProcessing(artifact.id, claim, {
      cleanText,
      summary: finalSummary,
      excerpt: analysis.excerpt,
      tags: analysis.tags,
      language: analysis.language,
      embedding: summaryEmbedding,
      embeddingModel: EMBEDDING_MODEL,
      chunks: chunks.map((c, i) => ({
        chunkIndex: c.chunkIndex,
        chunkText: c.chunkText,
        chunkTokens: c.chunkTokens,
        headingPath: c.headingPath,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
        embedding: chunkEmbeddings[i],
      })),
      entities: entities.map((e) => ({
        entityType: e.entity_type,
        displayName: e.display_name,
        aliases: e.aliases,
        salience: e.salience,
      })),
    });
    // The claim was lost after the last renewal.
    if (!saved) return dropped();
    // A failure here is not this row's: it is complete. The rows it
    // replaces stay searchable, and the next load retires them.
    let retired = 0;
    try {
      retired = await retireReplacedRows(artifact.id);
    } catch (err) {
      console.error(`[archive] Could not retire the rows "${artifact.title}" replaces:`, err);
    }

    console.log(
      `[archive] Processed "${artifact.title}": ${chunks.length} chunks, ${entities.length} entities` +
        (retired > 0 ? `, replaces ${retired} older row(s)` : "")
    );
    return true;
  } catch (err) {
    console.error(`[archive] Error processing "${artifact.title}":`, err);
    const message = err instanceof Error ? err.message : String(err);
    if (!(await archiveQueries.markArtifactError(artifact.id, message, claim))) return dropped("its error is not recorded");
    return true;
  }
}

async function tick(): Promise<void> {
  while (await processOne()) {
    // keep processing until no more pending
  }
}

export function startArchiveWorker(): void {
  console.log("Archive processor started (polling every 60s)");
  const scheduleNext = () => {
    setTimeout(() => {
      tick()
        .catch((err) => console.error("[archive] Worker tick error:", err))
        .finally(scheduleNext);
    }, POLL_INTERVAL_MS);
  };
  tick()
    .catch((err) => console.error("[archive] Worker tick error:", err))
    .finally(scheduleNext);
}

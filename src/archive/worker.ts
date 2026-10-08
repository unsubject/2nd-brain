import * as archiveQueries from "./queries";
import { analyzeArtifact, extractEntities } from "./processor";
import { chunkArtifact } from "./chunker";
import { batchEmbed, EMBEDDING_MODEL } from "./embeddings";
import { normalizeMarkdown } from "./ingest/markdown";
import { retireReplacedRows } from "./consolidation/load/run";

const POLL_INTERVAL_MS = 60_000;
// How often to put back rows a stopped worker left half done.
const RECLAIM_INTERVAL_MS = 5 * 60_000;
let lastReclaim = 0;

async function reclaimStale(): Promise<void> {
  if (Date.now() - lastReclaim < RECLAIM_INTERVAL_MS) return;
  lastReclaim = Date.now();
  const n = await archiveQueries.reclaimStaleProcessing();
  if (n > 0) console.log(`[archive] Requeued ${n} row(s) a stopped worker left in processing`);
}

async function processOne(): Promise<boolean> {
  await reclaimStale();
  const artifact = await archiveQueries.findPendingArtifact();
  if (!artifact) return false;

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

    // 4. Save artifact processing result
    const saved = await archiveQueries.saveArtifactProcessingResult(artifact.id, artifact.raw_source, {
      cleanText,
      summary: finalSummary,
      excerpt: analysis.excerpt,
      tags: analysis.tags,
      language: analysis.language,
      embedding: summaryEmbedding,
      embeddingModel: EMBEDDING_MODEL,
    });

    if (!saved) {
      // The text changed while it was processed; the row is queued again
      // and the next pass processes the new text.
      console.log(`[archive] "${artifact.title}" changed while processing; left for the next pass`);
      return true;
    }

    // 5. Save chunks with embeddings
    const chunksWithEmbeddings = chunks.map((c, i) => ({
      chunkIndex: c.chunkIndex,
      chunkText: c.chunkText,
      chunkTokens: c.chunkTokens,
      headingPath: c.headingPath,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      embedding: chunkEmbeddings[i],
    }));
    await archiveQueries.insertChunks(artifact.id, chunksWithEmbeddings);

    // 6. Extract entities
    const entities = await extractEntities(artifact.title, cleanText);
    await archiveQueries.clearArtifactEntities(artifact.id);

    for (const entity of entities) {
      const entityRefId = await archiveQueries.upsertEntity(
        "default",
        entity.entity_type,
        entity.display_name,
        entity.aliases
      );
      await archiveQueries.insertArtifactEntity(
        artifact.id,
        entityRefId,
        entity.display_name,
        entity.salience
      );
    }

    // 7. Cross-link artifacts sharing entities (rebuilt, so nothing from an
    // earlier pass or an abandoned attempt stays)
    await archiveQueries.replaceSharedEntityLinks(artifact.id, 2);

    // 8. Done: the row can be found, and the rows it replaces (archive
    // consolidation, step 4) leave search.
    if (!(await archiveQueries.finishArtifactProcessing(artifact.id, artifact.raw_source))) {
      console.log(`[archive] "${artifact.title}" changed while processing; left for the next pass`);
      return true;
    }
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
    await archiveQueries.markArtifactError(artifact.id, message, artifact.raw_source);
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

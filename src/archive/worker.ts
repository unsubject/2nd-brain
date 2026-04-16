import * as archiveQueries from "./queries";
import { analyzeArtifact, extractEntities } from "./processor";
import { chunkArtifact } from "./chunker";
import { batchEmbed, EMBEDDING_MODEL } from "./embeddings";
import { normalizeMarkdown } from "./ingest/markdown";

const POLL_INTERVAL_MS = 60_000;

async function processOne(): Promise<boolean> {
  const artifact = await archiveQueries.findPendingArtifact();
  if (!artifact) return false;

  console.log(`[archive] Processing "${artifact.title}" (${artifact.id})...`);

  try {
    // 1. Analyze: clean, summarize, tag
    const analysis = await analyzeArtifact(
      artifact.title,
      artifact.raw_source,
      artifact.tags
    );

    // 2. Chunk
    const cleanText = analysis.clean_text || normalizeMarkdown(artifact.raw_source);
    const chunks = chunkArtifact(cleanText);

    // 3. Embed chunks + summary
    const textsToEmbed = [
      analysis.summary,
      ...chunks.map((c) => c.chunkText),
    ];
    const embeddings = await batchEmbed(textsToEmbed);
    const summaryEmbedding = embeddings[0];
    const chunkEmbeddings = embeddings.slice(1);

    // 4. Save artifact processing result
    await archiveQueries.saveArtifactProcessingResult(artifact.id, {
      cleanText,
      summary: analysis.summary,
      excerpt: analysis.excerpt,
      tags: analysis.tags,
      language: analysis.language,
      embedding: summaryEmbedding,
      embeddingModel: EMBEDDING_MODEL,
    });

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

    // 7. Cross-link artifacts sharing entities
    const related = await archiveQueries.findArtifactsSharingEntities(
      artifact.id,
      2
    );
    for (const rel of related) {
      await archiveQueries.insertLinkEdge(
        "public_artifact",
        artifact.id,
        "public_artifact",
        rel.other_artifact_id,
        "shared_entities",
        null,
        `${rel.shared_count} shared entities`
      );
    }

    console.log(
      `[archive] Processed "${artifact.title}": ${chunks.length} chunks, ${entities.length} entities`
    );
    return true;
  } catch (err) {
    console.error(`[archive] Error processing "${artifact.title}":`, err);
    await archiveQueries.markArtifactError(artifact.id);
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
  const run = () => {
    tick().catch((err) => console.error("[archive] Worker tick error:", err));
  };
  run();
  setInterval(run, POLL_INTERVAL_MS);
}

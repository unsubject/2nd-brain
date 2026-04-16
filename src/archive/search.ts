import * as archiveQueries from "./queries";
import { batchEmbed } from "./embeddings";

export interface SearchRequest {
  query: string;
  types?: string[];
  dateFrom?: string;
  dateTo?: string;
  tags?: string[];
  entityIds?: string[];
  limit?: number;
}

export interface SearchResult {
  artifactId: string;
  chunkId: string | null;
  chunkText: string | null;
  headingPath: string[] | null;
  title: string;
  type: string;
  publishedAt: Date | null;
  tags: string[] | null;
  summary: string | null;
  score: number;
  sources: string[];
}

const RRF_K = 60;

function rrfScore(ranks: number[]): number {
  return ranks.reduce((sum, rank) => sum + 1 / (RRF_K + rank), 0);
}

export async function hybridSearch(
  req: SearchRequest
): Promise<SearchResult[]> {
  const limit = req.limit || 10;
  const retrievalLimit = 30;
  const filters = {
    types: req.types,
    dateFrom: req.dateFrom,
    dateTo: req.dateTo,
    tags: req.tags,
  };

  // Generate query embedding
  const [queryEmbedding] = await batchEmbed([req.query]);

  // Run retrievers in parallel
  const [vectorResults, bm25Results, graphResults, queryEntities] =
    await Promise.all([
      archiveQueries.vectorSearchChunks(
        queryEmbedding,
        retrievalLimit,
        filters
      ),
      archiveQueries.bm25SearchChunks(req.query, retrievalLimit, filters),
      req.entityIds?.length
        ? archiveQueries.graphSearchArtifacts(req.entityIds, retrievalLimit)
        : Promise.resolve([]),
      // Also try to find entities matching the query text
      archiveQueries.findEntitiesByName(req.query),
    ]);

  // If we found matching entities from the query, do a graph search too
  let additionalGraphResults: typeof graphResults = [];
  if (queryEntities.length > 0 && !req.entityIds?.length) {
    const entityIds = queryEntities.map((e) => e.id);
    additionalGraphResults = await archiveQueries.graphSearchArtifacts(
      entityIds,
      retrievalLimit
    );
  }
  const allGraphResults = [...graphResults, ...additionalGraphResults];

  // Build rank maps: key = "artifactId:chunkId" or "artifactId:null"
  type CandidateInfo = {
    artifactId: string;
    chunkId: string | null;
    chunkText: string | null;
    headingPath: string[] | null;
    title: string;
    type: string;
    publishedAt: Date | null;
    tags: string[] | null;
    summary: string | null;
  };

  const candidates = new Map<string, CandidateInfo>();
  const vectorRanks = new Map<string, number>();
  const bm25Ranks = new Map<string, number>();
  const graphRanks = new Map<string, number>();

  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const key = `${r.artifact_id}:${r.chunk_id}`;
    vectorRanks.set(key, i + 1);
    if (!candidates.has(key)) {
      candidates.set(key, {
        artifactId: r.artifact_id,
        chunkId: r.chunk_id,
        chunkText: r.chunk_text,
        headingPath: r.heading_path,
        title: r.title,
        type: r.type,
        publishedAt: r.published_at,
        tags: r.tags,
        summary: r.summary,
      });
    }
  }

  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    const key = `${r.artifact_id}:${r.chunk_id}`;
    bm25Ranks.set(key, i + 1);
    if (!candidates.has(key)) {
      candidates.set(key, {
        artifactId: r.artifact_id,
        chunkId: r.chunk_id,
        chunkText: r.chunk_text,
        headingPath: r.heading_path,
        title: r.title,
        type: r.type,
        publishedAt: r.published_at,
        tags: r.tags,
        summary: r.summary,
      });
    }
  }

  for (let i = 0; i < allGraphResults.length; i++) {
    const r = allGraphResults[i];
    const key = `${r.artifact_id}:null`;
    graphRanks.set(key, i + 1);
    if (!candidates.has(key)) {
      candidates.set(key, {
        artifactId: r.artifact_id,
        chunkId: null,
        chunkText: null,
        headingPath: null,
        title: r.title,
        type: r.type,
        publishedAt: r.published_at,
        tags: r.tags,
        summary: r.summary,
      });
    }
  }

  // Compute RRF scores
  const scored: (SearchResult & { _key: string })[] = [];
  for (const [key, info] of candidates) {
    const ranks: number[] = [];
    const sources: string[] = [];

    const vr = vectorRanks.get(key);
    if (vr !== undefined) {
      ranks.push(vr);
      sources.push("vector");
    }

    const br = bm25Ranks.get(key);
    if (br !== undefined) {
      ranks.push(br);
      sources.push("bm25");
    }

    // For graph results, match on artifact ID (graph doesn't return chunks)
    const artifactGraphKey = `${info.artifactId}:null`;
    const gr = graphRanks.get(artifactGraphKey) || graphRanks.get(key);
    if (gr !== undefined) {
      ranks.push(gr);
      sources.push("graph");
    }

    scored.push({
      _key: key,
      artifactId: info.artifactId,
      chunkId: info.chunkId,
      chunkText: info.chunkText,
      headingPath: info.headingPath,
      title: info.title,
      type: info.type,
      publishedAt: info.publishedAt,
      tags: info.tags,
      summary: info.summary,
      score: rrfScore(ranks),
      sources,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ _key, ...rest }) => rest);
}

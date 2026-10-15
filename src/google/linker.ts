// Journal-entry link generation: finds candidate matches among the entities
// an entry mentions, Google Tasks (until the Subjects import is done) and the
// public artifact archive, and writes one row per match to link_edge.
//
// The contacts and calendar matchers are retired. The people (and places)
// the entity extraction finds are discarded: they link to nothing and are
// not stored as entities. Links those matchers wrote earlier stay in
// link_edge until the migration that drops their target tables.
//
// Scope-aware visibility invariant:
//   Generation here is intentionally scope-agnostic. For a family-scope
//   source entry we still look at personal-scope candidates, and vice
//   versa. The link_edge row is written regardless of target scope.
//
//   Reader-side visibility is enforced in the MCP worker's get_entry tool
//   (mcp-worker/src/tools/get_entry.ts): a family-scope entry never shows
//   a link whose target is in personal scope — the title would leak.
//   Personal readers see everything via spillover.

import { pool } from "../db/client";
import {
  extractEntitiesFromJournal,
  type ExtractedEntity,
} from "../archive/processor";
import { upsertEntity } from "../archive/queries";

interface LinkableEntry {
  id: string;
  full_text: string;
  tags: string[];
  embedding: number[];
}

interface LinkRow {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  linkType: string;
  confidence: number;
  explanation: string;
}

async function insertLinks(links: LinkRow[]): Promise<void> {
  if (links.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  for (const link of links) {
    const base = params.length;
    values.push(
      `('default', $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
    );
    params.push(
      link.sourceType,
      link.sourceId,
      link.targetType,
      link.targetId,
      link.linkType,
      link.confidence,
      link.explanation
    );
  }

  await pool.query(
    `INSERT INTO link_edge
       (user_id, source_type, source_id, target_type, target_id, link_type, confidence, explanation)
     VALUES ${values.join(", ")}
     ON CONFLICT DO NOTHING`,
    params
  );
}

async function linkMentionedEntities(
  entry: LinkableEntry,
  entities: ExtractedEntity[]
): Promise<LinkRow[]> {
  // People and places the entry mentions are dropped: not stored, not linked.
  const linkableEntities = entities.filter(
    (e) =>
      e.entity_type === "organization" ||
      e.entity_type === "concept" ||
      e.entity_type === "work"
  );
  if (linkableEntities.length === 0) return [];

  const links: LinkRow[] = [];
  for (const entity of linkableEntities) {
    const entityRefId = await upsertEntity(
      "default",
      entity.entity_type,
      entity.display_name,
      entity.aliases ?? []
    );
    const confidence = 0.5 + 0.4 * Math.max(0, Math.min(1, entity.salience));
    links.push({
      sourceType: "journal_entry",
      sourceId: entry.id,
      targetType: "entity_ref",
      targetId: entityRefId,
      linkType: "mentions_entity",
      confidence,
      explanation: `Entry mentions ${entity.entity_type} "${entity.display_name}" (salience ${entity.salience.toFixed(2)})`,
    });
  }

  return links;
}

async function linkRelatedTasks(entry: LinkableEntry): Promise<LinkRow[]> {
  const { rows: tasks } = await pool.query(
    `SELECT id, title FROM task_ref
     WHERE user_id = 'default'
       AND status = 'needsAction'`
  );

  const textLower = entry.full_text.toLowerCase();
  const entryTags = new Set(entry.tags.map((t) => t.toLowerCase()));
  const links: LinkRow[] = [];

  for (const task of tasks) {
    const titleLower = (task.title as string).toLowerCase();
    const titleWords = titleLower
      .split(/\s+/)
      .filter((w: string) => w.length >= 4);

    // Check text overlap
    const matchingWords = titleWords.filter((w: string) =>
      textLower.includes(w)
    );

    // Check tag overlap
    const tagMatch = titleWords.some((w: string) => entryTags.has(w));

    if (matchingWords.length >= 2 || (matchingWords.length >= 1 && tagMatch)) {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "task_ref",
        targetId: task.id,
        linkType: "relates_to_task",
        confidence: 0.6,
        explanation: `Entry mentions keywords from task "${task.title}"`,
      });
    }
  }

  return links;
}

async function linkRelatedArtifacts(entry: LinkableEntry): Promise<LinkRow[]> {
  if (!entry.embedding || entry.embedding.length === 0) return [];

  const vectorStr = `[${entry.embedding.join(",")}]`;

  // ANN-first over chunks (HNSW index on embedding), then dedupe to best-per-artifact in JS.
  // Pulling 30 nearest chunks reliably covers 5-10 distinct top artifacts.
  const { rows } = await pool.query(
    `SELECT c.public_artifact_id AS artifact_id,
            a.title,
            a.published_at,
            1 - (c.embedding <=> $1::vector) AS similarity
     FROM public_artifact_chunk c
     JOIN public_artifact a ON a.id = c.public_artifact_id
     WHERE c.embedding IS NOT NULL
       AND a.processing_status = 'processed'
       AND a.status = 'published'
     ORDER BY c.embedding <=> $1::vector
     LIMIT 30`,
    [vectorStr]
  );

  const bestByArtifact = new Map<
    string,
    { title: string; publishedAt: Date | null; similarity: number }
  >();
  for (const r of rows) {
    const sim = parseFloat(r.similarity);
    const existing = bestByArtifact.get(r.artifact_id);
    if (!existing || sim > existing.similarity) {
      bestByArtifact.set(r.artifact_id, {
        title: r.title,
        publishedAt: r.published_at,
        similarity: sim,
      });
    }
  }

  const topMatches = Array.from(bestByArtifact.entries())
    .map(([artifactId, info]) => ({ artifactId, ...info }))
    .filter((m) => m.similarity >= 0.45)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);

  return topMatches.map((match) => {
    const dateStr = match.publishedAt
      ? new Date(match.publishedAt).toISOString().slice(0, 10)
      : "undated";
    return {
      sourceType: "journal_entry",
      sourceId: entry.id,
      targetType: "public_artifact",
      targetId: match.artifactId,
      linkType: "echoes_artifact",
      confidence: match.similarity,
      explanation: `Entry echoes past article "${match.title}" (${dateStr})`,
    };
  });
}

// Core link-generation. The matchers run side by side and the links of
// every one that succeeded are written; if any failed (a DB error, say), or
// entity extraction failed (so the entity matcher found nothing),
// this then throws, naming them. Callers in the live worker path use
// generateLinks() which catches and logs; the backfill script uses this
// directly so it can count failures and exit non-zero. insertLinks skips
// links that already exist, so re-running an entry is safe.
export async function generateLinksStrict(
  entry: LinkableEntry,
  extractEntities: typeof extractEntitiesFromJournal = extractEntitiesFromJournal
): Promise<void> {
  // One LLM call up front, for the entity matcher.
  let entities: ExtractedEntity[] = [];
  const failed: string[] = [];
  const reasons: unknown[] = [];
  try {
    entities = await extractEntities(entry.full_text, entry.tags);
  } catch (err) {
    // Entity extraction failure shouldn't kill embedding-based linkers —
    // log and proceed with an empty entity list. It is still reported at
    // the end: the entry is missing its entity-driven links.
    failed.push("entity extraction");
    reasons.push(err);
    console.error(
      `[linker] entity extraction failed for entry ${entry.id}, continuing without entity-driven links:`,
      err
    );
  }

  const matchers: Array<[string, Promise<LinkRow[]>]> = [
    ["entities", linkMentionedEntities(entry, entities)],
    ["tasks", linkRelatedTasks(entry)],
    ["artifacts", linkRelatedArtifacts(entry)],
  ];
  // allSettled, not all: one failing matcher must not discard the links
  // the others found.
  const settled = await Promise.allSettled(matchers.map(([, run]) => run));
  const links: LinkRow[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") links.push(...result.value);
    else {
      failed.push(`${matchers[i][0]} matcher`);
      reasons.push(result.reason);
    }
  });
  await insertLinks(links);
  if (links.length > 0) {
    const byType: Record<string, number> = {};
    for (const l of links) {
      byType[l.linkType] = (byType[l.linkType] || 0) + 1;
    }
    const breakdown = Object.entries(byType)
      .map(([t, n]) => `${t}=${n}`)
      .join(", ");
    console.log(
      `[linker] entry ${entry.id}: ${links.length} link(s) written (${breakdown})`
    );
  }
  if (failed.length > 0) {
    throw new AggregateError(
      reasons,
      `[linker] entry ${entry.id}: ${failed.join(", ")} failed; the links found were written`
    );
  }
}

// Wrapper used by the live worker path: link generation is non-critical
// for journal processing, so swallow failures here. For backfills that
// need failure counts and a non-zero exit, call generateLinksStrict
// directly.
export async function generateLinks(entry: LinkableEntry): Promise<void> {
  try {
    await generateLinksStrict(entry);
  } catch (err) {
    console.error(`Link generation error for entry ${entry.id}:`, err);
  }
}

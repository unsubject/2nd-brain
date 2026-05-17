// Journal-entry link generation: finds candidate matches across Google
// integrations (contacts, calendar, tasks, email) and the public artifact
// archive, writes one row per match to link_edge.
//
// Scope-aware visibility invariant:
//   Generation here is intentionally scope-agnostic. For a family-scope
//   source entry we still look at personal-scope candidates, and vice
//   versa. The link_edge row is written regardless of target scope.
//
//   Reader-side visibility is enforced in src/db/queries.ts →
//   getLinksForRecentEntries, which filters both source scope (via
//   journal_entry.scope) and target scope (resolved per target_type).
//   Family readers never see a link whose target is in personal scope —
//   the title would leak. Personal readers see everything via spillover.

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
  created_at: Date;
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

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0)
  );
}

interface ContactMatch {
  contactId: string;
  contactName: string;
  jaccard: number;
}

// Match an extracted person name against a contact list using token-set Jaccard
// with a min-overlap guard. Returns the best contact if unambiguous; null if
// no match or if multiple contacts tied at the top score (ambiguous → skip).
//
// Algorithm:
//   - tokenize both names (strip punctuation, lowercase, split on whitespace)
//   - require at least min(2, |extracted|) overlapping tokens (so single-token
//     "Frances" can still match "Frances Li", but "France" can't match "Lee Pak Hong")
//   - score remaining candidates by Jaccard
//   - on a tie at the top, return null (don't guess)
function matchPersonByTokens(
  extractedName: string,
  contacts: Array<{ id: string; full_name: string }>
): ContactMatch | null {
  const extracted = tokenize(extractedName);
  if (extracted.size === 0) return null;
  const minOverlap = Math.min(2, extracted.size);

  let best: ContactMatch | null = null;
  let tiedCount = 0;

  for (const c of contacts) {
    const contactSet = tokenize(c.full_name);
    if (contactSet.size === 0) continue;

    let intersection = 0;
    for (const t of extracted) if (contactSet.has(t)) intersection++;
    if (intersection < minOverlap) continue;

    const union = extracted.size + contactSet.size - intersection;
    const jaccard = union === 0 ? 0 : intersection / union;

    if (!best || jaccard > best.jaccard) {
      best = { contactId: c.id, contactName: c.full_name, jaccard };
      tiedCount = 1;
    } else if (jaccard === best.jaccard) {
      tiedCount++;
    }
  }

  return tiedCount > 1 ? null : best;
}

async function linkMentionedContacts(
  entry: LinkableEntry,
  entities: ExtractedEntity[]
): Promise<LinkRow[]> {
  const personEntities = entities.filter((e) => e.entity_type === "person");
  if (personEntities.length === 0) return [];

  const { rows: contacts } = await pool.query(
    `SELECT id, full_name FROM person_ref WHERE user_id = 'default'`
  );

  const links: LinkRow[] = [];
  const linkedContactIds = new Set<string>();

  for (const entity of personEntities) {
    // Try the canonical display_name first, then each alias.
    const candidates = [entity.display_name, ...(entity.aliases ?? [])];
    let match: ContactMatch | null = null;
    let matchedVia = "";
    for (const cand of candidates) {
      const m = matchPersonByTokens(cand, contacts);
      if (m) {
        match = m;
        matchedVia = cand;
        break;
      }
    }
    if (!match) continue;
    if (linkedContactIds.has(match.contactId)) continue;
    linkedContactIds.add(match.contactId);

    // Confidence floor 0.5 (the get_entry default filter), scaled by LLM salience.
    const confidence = 0.5 + 0.4 * Math.max(0, Math.min(1, entity.salience));

    links.push({
      sourceType: "journal_entry",
      sourceId: entry.id,
      targetType: "person_ref",
      targetId: match.contactId,
      linkType: "mentions_person",
      confidence,
      explanation: `Entity "${matchedVia}" (salience ${entity.salience.toFixed(2)}) matched contact "${match.contactName}" (jaccard ${match.jaccard.toFixed(2)})`,
    });
  }

  return links;
}

async function linkNearbyCalendarEvents(
  entry: LinkableEntry,
  entities: ExtractedEntity[]
): Promise<LinkRow[]> {
  // Date-window query is unchanged — the gating principle is "same-day events
  // are a candidate set." But the matcher is now entity-driven, not substring:
  // only emit relates_to_event when an extracted entity's tokens overlap the
  // event title. The old confidence-0.3 same_day_as_event floor is gone —
  // calendar-only coincidence is noise.
  const entryDate = entry.created_at;
  const dayStart = new Date(entryDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(entryDate);
  dayEnd.setHours(23, 59, 59, 999);

  const { rows: events } = await pool.query(
    `SELECT id, title FROM calendar_event_ref
     WHERE user_id = 'default'
       AND start_at >= $1 AND start_at <= $2`,
    [dayStart, dayEnd]
  );
  if (events.length === 0) return [];

  // Union of tokens across all extracted entity names (skip 'place' — too
  // background-y; "Hong Kong" shouldn't match every HK event).
  const entityTokens = new Set<string>();
  for (const e of entities) {
    if (e.entity_type === "place") continue;
    for (const t of tokenize(e.display_name)) entityTokens.add(t);
    for (const alias of e.aliases ?? []) {
      for (const t of tokenize(alias)) entityTokens.add(t);
    }
  }
  if (entityTokens.size === 0) return [];

  const links: LinkRow[] = [];
  for (const event of events) {
    const titleTokens = new Set(
      Array.from(tokenize(event.title as string)).filter((t) => t.length >= 4)
    );
    if (titleTokens.size === 0) continue;

    let overlap = 0;
    for (const t of titleTokens) if (entityTokens.has(t)) overlap++;
    if (overlap === 0) continue;

    // Confidence = fraction of title tokens covered, floored at 0.6 (above the
    // get_entry default filter so any match makes it through).
    const confidence = Math.max(0.6, overlap / titleTokens.size);
    links.push({
      sourceType: "journal_entry",
      sourceId: entry.id,
      targetType: "calendar_event_ref",
      targetId: event.id,
      linkType: "relates_to_event",
      confidence,
      explanation: `Extracted entities overlap event title "${event.title}" by ${overlap}/${titleTokens.size} token(s)`,
    });
  }

  return links;
}

async function linkMentionedEntities(
  entry: LinkableEntry,
  entities: ExtractedEntity[]
): Promise<LinkRow[]> {
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

async function linkRelatedEmails(entry: LinkableEntry): Promise<LinkRow[]> {
  if (!entry.embedding || entry.embedding.length === 0) return [];

  const vectorStr = `[${entry.embedding.join(",")}]`;

  // Find emails with embeddings that are similar to this entry
  const { rows: emails } = await pool.query(
    `SELECT id, subject, 1 - (embedding <=> $1::vector) AS similarity
     FROM email_ref
     WHERE user_id = 'default'
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 3`,
    [vectorStr]
  );

  const links: LinkRow[] = [];
  for (const email of emails) {
    const similarity = parseFloat(email.similarity);
    if (similarity >= 0.5) {
      links.push({
        sourceType: "journal_entry",
        sourceId: entry.id,
        targetType: "email_ref",
        targetId: email.id,
        linkType: "relates_to_email",
        confidence: similarity,
        explanation: `Entry is semantically similar to email "${email.subject || "(no subject)"}"`,
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

// Core link-generation: throws on any failure (DB error, OpenAI failure
// outside the entity-extraction branch, etc). Callers in the live worker
// path use generateLinks() which catches and logs; the backfill script
// uses this directly so it can count failures and exit non-zero.
export async function generateLinksStrict(entry: LinkableEntry): Promise<void> {
  // One LLM call up front; reused by every entity-driven matcher.
  let entities: ExtractedEntity[] = [];
  try {
    entities = await extractEntitiesFromJournal(entry.full_text, entry.tags);
  } catch (err) {
    // Entity extraction failure shouldn't kill embedding-based linkers —
    // log and proceed with an empty entity list.
    console.error(
      `[linker] entity extraction failed for entry ${entry.id}, continuing without entity-driven links:`,
      err
    );
  }

  const results = await Promise.all([
    linkMentionedContacts(entry, entities),
    linkNearbyCalendarEvents(entry, entities),
    linkMentionedEntities(entry, entities),
    linkRelatedTasks(entry),
    linkRelatedEmails(entry),
    linkRelatedArtifacts(entry),
  ]);
  const links = results.flat();
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

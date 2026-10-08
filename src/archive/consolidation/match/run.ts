// Run step 3 over every candidate that extraction kept or sent to review,
// and rebuild the works in one transaction, so readers see the old set or
// the new one, never half of each.

import { Pool } from "pg";
import { pool, type DB } from "../../../db/client";
import { textLength } from "../extract/text";
import type { CollectStats } from "../gmail";
import { matchCandidates, type MatchCandidate, type Work } from "./cluster";

// Bump with every change to how candidates are grouped or a canonical is
// picked: works made by an older version are rebuilt on boot.
export const MATCHER_VERSION = 2;

export interface MatchStats extends CollectStats {
  candidates: number;
  pairsChecked: number;
  links: number;
  works: number;
  byStatus: Record<string, number>;
  // How many works have 1, 2, 3–5, 6–10 or more members: a few very large
  // works would mean different pieces were merged.
  bySize: Record<string, number>;
  largest: { members: number; title: string | null }[];
}

export function emptyMatchStats(): MatchStats {
  return {
    listed: 0,
    skippedExisting: 0,
    retriedIncomplete: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    attachmentsExtracted: 0,
    rateLimitPauses: 0,
    failed: 0,
    errors: [],
    candidates: 0,
    pairsChecked: 0,
    links: 0,
    works: 0,
    byStatus: {},
    bySize: {},
    largest: [],
  };
}

interface Row {
  id: string;
  source: string;
  kind: string;
  status: "keep" | "review";
  title: string | null;
  outlet: string | null;
  column_name: string | null;
  published_at: Date | null;
  is_published: boolean | null;
  authored_at: Date | null;
  body_text: string | null;
}

export async function loadMatchCandidates(db: DB = pool): Promise<MatchCandidate[]> {
  const { rows } = await db.query<Row>(
    `SELECT c.id, c.source, c.kind, c.status, c.title, c.outlet, c.column_name, c.published_at,
            c.is_published, s.authored_at, c.body_text
       FROM archive_candidate c JOIN archive_source_item s ON s.id = c.source_item_id
      WHERE c.status IN ('keep', 'review') AND c.body_text IS NOT NULL
      ORDER BY c.id`
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    kind: r.kind,
    status: r.status,
    title: r.title,
    outlet: r.outlet,
    column: r.column_name,
    publishedAt: r.published_at,
    isPublished: r.is_published,
    authoredAt: r.authored_at,
    bodyText: r.body_text ?? "",
  }));
}

function sizeBucket(n: number): string {
  return n === 1 ? "1" : n === 2 ? "2" : n <= 5 ? "3-5" : n <= 10 ? "6-10" : "11+";
}

async function writeWorks(works: Work[], charCounts: Map<string, number>, db: DB): Promise<void> {
  // One connection for the transaction: a pool would spread it over several.
  const client = db instanceof Pool ? await db.connect() : null;
  const q = client ?? db;
  try {
    await q.query("BEGIN");
    await q.query("DELETE FROM archive_work");
    for (const w of works) {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO archive_work
           (canonical_candidate_id, title, published_at, outlet, column_name, outlets, is_published,
            status, reasons, member_count, char_count, matcher_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          w.canonicalId,
          w.title,
          w.publishedAt,
          w.outlet,
          w.column,
          w.outlets,
          w.isPublished,
          w.status,
          w.reasons,
          w.members.length,
          charCounts.get(w.canonicalId) ?? 0,
          MATCHER_VERSION,
        ]
      );
      await q.query(
        `INSERT INTO archive_work_member (work_id, candidate_id, role, similarity)
         SELECT $1, m.candidate_id, m.role, m.similarity
           FROM unnest($2::uuid[], $3::text[], $4::real[]) AS m(candidate_id, role, similarity)`,
        [rows[0].id, w.members.map((m) => m.candidateId), w.members.map((m) => m.role), w.members.map((m) => m.similarity)]
      );
    }
    await q.query("COMMIT");
  } catch (err) {
    await q.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client?.release();
  }
}

export async function runMatch(
  stats: MatchStats,
  onProgress: () => Promise<void>,
  shouldStop: () => boolean = () => false,
  db: DB = pool
): Promise<void> {
  const candidates = await loadMatchCandidates(db);
  stats.listed = stats.candidates = candidates.length;
  await onProgress();
  if (shouldStop()) return;
  const result = matchCandidates(candidates);
  stats.pairsChecked = result.pairsChecked;
  stats.links = result.links;
  if (shouldStop()) return;
  const charCounts = new Map(candidates.map((c) => [c.id, textLength(c.bodyText)]));
  await writeWorks(result.works, charCounts, db);
  stats.works = stats.inserted = result.works.length;
  for (const w of result.works) {
    stats.byStatus[w.status] = (stats.byStatus[w.status] ?? 0) + 1;
    const b = sizeBucket(w.members.length);
    stats.bySize[b] = (stats.bySize[b] ?? 0) + 1;
  }
  stats.largest = [...result.works]
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 5)
    .map((w) => ({ members: w.members.length, title: w.title }));
}

export async function workSummary(db: DB = pool): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `SELECT status, is_published, count(*)::int AS works, sum(member_count)::int AS members,
            min(published_at) AS earliest, max(published_at) AS latest
       FROM archive_work GROUP BY status, is_published ORDER BY status, is_published`
  );
  return rows;
}

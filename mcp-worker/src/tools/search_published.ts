import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { embed, vectorLiteral } from '../embeddings';
import { escapeLike, searchTerms, termPattern, truncateChars } from '../ideas/text';
import {
  dbError,
  errorResult,
  isoDateTimeSchema,
  ok,
  parseJsonb,
  toIso,
  toIsoOrNull,
  uuidArrayLiteral,
  type Q,
} from './idea_shared';

// The user's own published work (refocus Phase 5): essays and columns from
// the consolidated archive, and YouTube episode transcripts. Hybrid search
// over the pieces' chunks: vector similarity, plus a text leg that finds
// Chinese phrases and names the embedding misses (search_brain's terms and
// patterns; no index yet). One hit per piece, with its best passages.
// Superseded copies are never returned. Members-only pieces are (D11),
// marked members_only. Every read carries `now() AS as_of`, like the idea
// tools (Hyperdrive cache bypass; test/ideas.fixes.test.ts scans this file).

const inputSchema = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(15).optional(),
    passages: z.number().int().min(1).max(3).optional(),
    type: z.enum(['essay', 'episode']).optional(),
    since: isoDateTimeSchema.optional(),
    until: isoDateTimeSchema.optional(),
    outlet: z.string().trim().min(1).max(100).optional(),
    confirmed_only: z.boolean().optional(),
    members_only: z.enum(['include', 'exclude', 'only']).optional(),
  })
  .strict();

// Chunk rows each leg brings back at least; a leg takes more when the
// request needs them (limit pieces at the leg's per-piece cap), so a full
// leg always holds `limit` whole pieces. A chunk is about 2,000-3,200
// characters (src/archive/chunker.ts), so only a window of it becomes a
// passage.
const CANDIDATES = 40;
// Nearest chunks the semantic leg reads from the vector index before keeping
// at most SEMANTIC_PER_PIECE of each piece (the most passages a hit shows),
// so one long transcript cannot fill the leg. When that leaves the leg
// short, it ranks every searchable chunk exactly instead. At least the
// largest leg (15 pieces x 3).
const SEMANTIC_POOL = 200;
const SEMANTIC_PER_PIECE = 3;
const PASSAGE_CHARS = 500;
// Context kept before the first text match in a passage.
const PASSAGE_LEAD = 150;
const SUMMARY_CHARS = 300;
// Passage and summary characters in one result. Chinese costs about one to
// one and a half tokens a character, and clients cut tool results off (Claude
// Code near 25k tokens), so extra passages give way first.
const TEXT_BUDGET = 12_000;

type Leg = 'semantic' | 'text';

type ChunkRow = {
  artifact_id: string;
  chunk_index: number;
  heading_path: unknown;
  chunk_text: string;
  published_at: Date | null;
  // A text-leg row past the piece's `passages`, used only if another repeats.
  spare?: boolean;
};

type SemanticRow = ChunkRow & { similarity: number };

type Chunk = ChunkRow & { legs: Leg[]; rank: number; similarity: number | null };

type Piece = {
  id: string;
  match: Leg[];
  score: number;
  similarity: number | null;
  published_at: Date | null;
  chunks: Map<number, Chunk>;
};

type MetaRow = {
  id: string;
  title: string;
  source_system: string;
  published_at: Date | null;
  series: string | null;
  outlets: unknown;
  canonical_url: string | null;
  flag: string | null;
  members_only: boolean;
  language: string | null;
  summary_src: string | null;
  as_of: Date;
};

export async function searchPublishedHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const limit = args.limit ?? 8;
  const perPiece = args.passages ?? 2;
  const semanticRows = Math.max(CANDIDATES, limit * SEMANTIC_PER_PIECE);
  // Room for one spare row for each of the first `limit` pieces (below).
  const textRows = Math.max(CANDIDATES, limit * perPiece) + limit;
  const membersOnly = args.members_only ?? 'include';
  const terms = searchTerms(args.query);
  const patterns = terms.map(termPattern);
  const warnings: string[] = [];

  let vector: number[] | null = null;
  try {
    vector = await embed(args.query, env.OPENAI_API_KEY);
  } catch (e) {
    warnings.push(`Semantic search unavailable (${e instanceof Error ? e.message : String(e)}); text matches only.`);
  }

  // The searchable pieces: processed, still published (a superseded copy
  // has left search), and inside every filter given. Archive rows belong to
  // user 'default', so there is no user filter (as in explore_topic).
  const outletPattern = args.outlet ? `%${escapeLike(args.outlet)}%` : null;
  const searchable = (q: Q) => q`
    pa.processing_status = 'processed'
    AND pa.status = 'published'
    AND ${
      args.type === 'episode'
        ? q`(pa.source_system = 'youtube' OR pa.flag = 'video')`
        : args.type === 'essay'
          ? q`(pa.source_system <> 'youtube' AND pa.flag IS DISTINCT FROM 'video')`
          : q`TRUE`
    }
    AND ${args.since ? q`pa.published_at >= ${args.since}::timestamptz` : q`TRUE`}
    AND ${args.until ? q`pa.published_at <= ${args.until}::timestamptz` : q`TRUE`}
    AND ${
      outletPattern
        ? q`(pa.series ILIKE ${outletPattern}
             OR EXISTS (SELECT 1 FROM unnest(pa.outlets) o WHERE o ILIKE ${outletPattern}))`
        : q`TRUE`
    }
    AND ${args.confirmed_only ? q`pa.flag IS NULL` : q`TRUE`}
    AND ${membersOnly === 'exclude' ? q`NOT pa.members_only` : membersOnly === 'only' ? q`pa.members_only` : q`TRUE`}
  `;
  const allTerms = (q: Q, col: ReturnType<Q>) => patterns.reduce((acc, p) => q`${acc} AND ${col} ~* ${p}`, q`TRUE`);

  const sql = getDb(env);
  try {
    const v = vector ? vectorLiteral(vector) : null;
    const [semantic, textual] = await Promise.all([
      v
        ? (sql.begin(async (tx) => {
            // An HNSW scan hands back ef_search rows (pgvector's default is
            // 40) before the filters run, and superseded copies' chunks take
            // some of them; widen it so a filtered search still fills the pool.
            await tx`SET LOCAL hnsw.ef_search = 400`;
            const pooled = await tx<SemanticRow[]>`
              SELECT x.artifact_id, x.chunk_index, x.heading_path, x.chunk_text, x.published_at,
                     1 - x.d AS similarity,
                     now() AS as_of
                FROM (
                  SELECT y.*, row_number() OVER (PARTITION BY y.artifact_id ORDER BY y.d, y.chunk_index) AS n
                    FROM (
                      SELECT c.public_artifact_id AS artifact_id, c.chunk_index,
                             to_jsonb(c.heading_path) AS heading_path, c.chunk_text, pa.published_at,
                             c.embedding <=> ${v}::vector AS d
                        FROM public_artifact_chunk c
                        JOIN public_artifact pa ON pa.id = c.public_artifact_id
                       WHERE c.embedding IS NOT NULL
                         AND ${searchable(tx)}
                       ORDER BY d
                       LIMIT ${SEMANTIC_POOL}
                    ) y
                ) x
               WHERE x.n <= ${SEMANTIC_PER_PIECE}
               ORDER BY x.d
               LIMIT ${semanticRows}
            `;
            // A full leg needs nothing more: every chunk past the pool is at
            // least as far as the farthest pooled one (up to the index's
            // approximation), so none could displace a row kept here. A
            // short one may miss pieces: a few long pieces can own
            // the whole pool, or the filters drop most of it, and the pieces
            // just past it are left out. Rank every searchable chunk instead,
            // each piece's nearest SEMANTIC_PER_PIECE first, then read the
            // text of the rows kept. The archive is a few thousand pieces,
            // so the scan stays quick.
            if (pooled.length >= semanticRows) return pooled;
            return tx<SemanticRow[]>`
              SELECT c.public_artifact_id AS artifact_id, c.chunk_index,
                     to_jsonb(c.heading_path) AS heading_path, c.chunk_text, pa.published_at,
                     1 - k.d AS similarity,
                     now() AS as_of
                FROM (
                  SELECT r.id, r.d
                    FROM (
                      SELECT z.id, z.d,
                             row_number() OVER (PARTITION BY z.artifact_id ORDER BY z.d, z.chunk_index) AS n
                        FROM (
                          SELECT c.id, c.public_artifact_id AS artifact_id, c.chunk_index,
                                 c.embedding <=> ${v}::vector AS d
                            FROM public_artifact_chunk c
                            JOIN public_artifact pa ON pa.id = c.public_artifact_id
                           WHERE c.embedding IS NOT NULL
                             AND ${searchable(tx)}
                        ) z
                    ) r
                   WHERE r.n <= ${SEMANTIC_PER_PIECE}
                   ORDER BY r.d, r.id
                   LIMIT ${semanticRows}
                ) k
                JOIN public_artifact_chunk c ON c.id = k.id
                JOIN public_artifact pa ON pa.id = c.public_artifact_id
               ORDER BY k.d, k.id
            `;
          }) as Promise<SemanticRow[]>)
        : Promise.resolve([]),
      // Every term in the chunk or the piece's title. A piece whose title
      // matches ranks first, then newer pieces; each piece brings at most
      // `passages` chunks, those holding every term first, so one long
      // transcript cannot fill the leg. Each piece may also bring one spare
      // chunk, listed after every other row, for when a passage repeats
      // another (see `repeats`).
      terms.length > 0
        ? sql<Array<ChunkRow>>`
            SELECT x.artifact_id, x.chunk_index, x.heading_path, x.chunk_text, x.published_at,
                   x.n > ${perPiece} AS spare,
                   now() AS as_of
              FROM (
                SELECT c.public_artifact_id AS artifact_id, c.chunk_index,
                       to_jsonb(c.heading_path) AS heading_path, c.chunk_text, pa.published_at,
                       (${allTerms(sql, sql`pa.title`)}) AS in_title,
                       row_number() OVER (
                         PARTITION BY c.public_artifact_id
                         ORDER BY (${allTerms(sql, sql`c.chunk_text`)}) DESC, c.chunk_index
                       ) AS n
                  FROM public_artifact_chunk c
                  JOIN public_artifact pa ON pa.id = c.public_artifact_id
                 WHERE ${searchable(sql)}
                   AND ${allTerms(sql, sql`concat_ws(' ', pa.title, c.chunk_text)`)}
              ) x
             WHERE x.n <= ${perPiece} + 1
             ORDER BY x.n > ${perPiece}, x.in_title DESC, x.published_at DESC NULLS LAST, x.artifact_id, x.n
             LIMIT ${textRows}
          `
        : Promise.resolve([]),
    ]);

    // Reciprocal-rank fusion over pieces: each leg ranks the pieces in the
    // order they first appear in it, and a piece found by both legs ranks
    // first. Ties go to the higher similarity, then the newer piece.
    const pieces = new Map<string, Piece>();
    const addLeg = (rows: Array<ChunkRow & { similarity?: number }>, leg: Leg) => {
      let rank = 0;
      rows.forEach((r, i) => {
        let p = pieces.get(r.artifact_id);
        if (!p) {
          p = { id: r.artifact_id, match: [], score: 0, similarity: null, published_at: r.published_at, chunks: new Map() };
          pieces.set(r.artifact_id, p);
        }
        if (!p.match.includes(leg)) {
          p.match.push(leg);
          p.score += rrf(rank++);
        }
        const sim = r.similarity === undefined ? null : roundTo(Number(r.similarity), 4);
        if (sim !== null && (p.similarity === null || sim > p.similarity)) p.similarity = sim;
        const c = p.chunks.get(r.chunk_index);
        if (c) {
          c.legs.push(leg);
          c.rank = Math.min(c.rank, i);
          if (sim !== null) c.similarity = sim;
        } else {
          p.chunks.set(r.chunk_index, { ...r, legs: [leg], rank: i, similarity: sim });
        }
      });
    };
    addLeg(semantic, 'semantic');
    addLeg(textual, 'text');

    const ranked = [...pieces.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.similarity ?? -1) - (a.similarity ?? -1) ||
          time(b.published_at) - time(a.published_at),
      )
      .slice(0, limit);

    // The same predicate again: a sync that commits between the legs and
    // this read can requeue, replace, hide or mark members-only a piece the
    // legs found. That piece is dropped rather than shown with new metadata.
    const meta =
      ranked.length > 0
        ? await sql<Array<MetaRow>>`
            SELECT pa.id, pa.title, pa.source_system, pa.published_at, pa.series,
                   to_jsonb(pa.outlets) AS outlets, pa.canonical_url, pa.flag, pa.members_only,
                   pa.language, COALESCE(pa.summary, pa.excerpt) AS summary_src,
                   now() AS as_of
              FROM public_artifact pa
             WHERE pa.id = ANY(${uuidArrayLiteral(ranked.map((p) => p.id))}::uuid[])
               AND ${searchable(sql)}
          `
        : [];
    const metaById = new Map(meta.map((m) => [m.id, m]));
    const regexes = patterns.map((p) => new RegExp(p, 'iu'));

    const hits = ranked
      .filter((p) => metaById.has(p.id))
      .map((p) => {
        const m = metaById.get(p.id)!;
        // Chunks found by both legs first, then the best rank in either, and
        // spares last. A passage that repeats one already kept is skipped.
        const chosen: Array<Chunk & { text: string }> = [];
        const ordered = [...p.chunks.values()].sort(
          (a, b) => Number(!!a.spare) - Number(!!b.spare) || b.legs.length - a.legs.length || a.rank - b.rank,
        );
        for (const c of ordered) {
          if (chosen.length >= perPiece) break;
          const text = passage(c.chunk_text, c.legs.includes('text') ? regexes : []);
          if (!chosen.some((k) => repeats(k, k.text, c, text))) chosen.push({ ...c, text });
        }
        return {
          artifact_id: p.id,
          title: m.title,
          type: pieceType(m.source_system, m.flag),
          published_at: toIsoOrNull(m.published_at),
          series: m.series,
          outlets: parseJsonb<string[] | null>(m.outlets, null) ?? [],
          url: m.canonical_url,
          // null: confirmed (or an old row kept as the only copy);
          // 'review': still to check; 'video': an old copy of a video's
          // transcript; 'unmatched' (older loads): an old row no piece
          // replaced.
          flag: m.flag ?? null,
          members_only: m.members_only,
          language: m.language,
          match: p.match,
          similarity: p.similarity,
          summary: m.summary_src ? truncateChars(flatten(m.summary_src), SUMMARY_CHARS) : null,
          passages: chosen.map((c) => ({
            chunk_index: c.chunk_index,
            heading_path: parseJsonb<string[] | null>(c.heading_path, null) ?? [],
            match: c.legs,
            similarity: c.similarity,
            text: c.text,
          })),
        };
      });

    // Keep the result inside the budget: drop the extra passages of the
    // lowest-ranked pieces first. One passage and a summary per piece
    // always fit (15 × (500 + 300)).
    const size = () =>
      hits.reduce(
        (n, h) => n + chars(h.summary ?? '') + h.passages.reduce((k, x) => k + chars(x.text), 0),
        0,
      );
    let truncated = false;
    let total = size();
    while (total > TEXT_BUDGET) {
      const last = [...hits].reverse().find((h) => h.passages.length > 1);
      if (!last) break;
      total -= chars(last.passages.pop()!.text);
      truncated = true;
    }

    const asOf = meta[0]?.as_of ? toIso(meta[0].as_of) : new Date().toISOString();
    return ok({
      query: args.query,
      as_of: asOf,
      count: hits.length,
      truncated,
      ...(warnings.length ? { warnings } : {}),
      hits,
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

const RRF_K = 60;
function rrf(rank: number): number {
  return 1 / (RRF_K + rank + 1);
}

function roundTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function time(d: Date | null): number {
  return d ? new Date(d).getTime() : 0;
}

function chars(s: string): number {
  return Array.from(s).length;
}

function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// A long section's next chunk starts with the last ~400 characters of the
// one before (src/archive/chunker.ts), so a match there is in both chunks
// and their passages would show the same text. Two passages repeat when
// their chunks are next to each other, the later one starts with the end
// of the earlier one, and the passages share a run of about 150 characters
// (some 100-character slice of one, taken every 50, appears in the other).
const MIN_CARRY = 50;
const MAX_CARRY = 1_000;
const REPEAT_PROBE = 100;
const REPEAT_STEP = 50;
function repeats(a: ChunkRow, aText: string, b: ChunkRow, bText: string): boolean {
  if (Math.abs(a.chunk_index - b.chunk_index) !== 1) return false;
  const [prev, next] = a.chunk_index < b.chunk_index ? [a, b] : [b, a];
  if (!carriesOver(flatten(prev.chunk_text), flatten(next.chunk_text))) return false;
  for (let i = 0; i + REPEAT_PROBE <= bText.length; i += REPEAT_STEP) {
    if (aText.includes(bText.slice(i, i + REPEAT_PROBE))) return true;
  }
  return false;
}

function carriesOver(prev: string, next: string): boolean {
  for (let n = Math.min(prev.length, next.length, MAX_CARRY); n >= MIN_CARRY; n--) {
    if (prev.endsWith(next.slice(0, n))) return true;
  }
  return false;
}

// An old imported copy of a video's transcript (flag 'video') is an episode,
// whatever system it came from.
export function pieceType(sourceSystem: string, flag: string | null): 'episode' | 'essay' {
  return sourceSystem === 'youtube' || flag === 'video' ? 'episode' : 'essay';
}

// At most PASSAGE_CHARS code points of a chunk (a surrogate pair is never
// split): around the first match of any term for a text hit, else from the
// start. An ellipsis marks each cut.
function passage(text: string, regexes: readonly RegExp[]): string {
  const flat = flatten(text);
  const cps = Array.from(flat);
  if (cps.length <= PASSAGE_CHARS) return flat;
  let at = Infinity;
  for (const re of regexes) {
    const m = re.exec(flat);
    if (m) at = Math.min(at, Array.from(flat.slice(0, m.index)).length);
  }
  const start = at === Infinity ? 0 : Math.max(0, Math.min(at - PASSAGE_LEAD, cps.length - PASSAGE_CHARS + 1));
  if (start === 0) return truncateChars(flat, PASSAGE_CHARS);
  const room = PASSAGE_CHARS - 1;
  const end = start + room;
  return end >= cps.length ? `…${cps.slice(start).join('')}` : `…${cps.slice(start, end - 1).join('')}…`;
}

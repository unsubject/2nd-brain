import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { isSymmetric, linkLabel, type LinkType } from '../ideas/linkTypes';
import { snippet } from '../ideas/text';
import {
  dbError,
  errorResult,
  ideaStatusSchema,
  inboxCondition,
  ok,
  parseJsonb,
  textArray,
  toIso,
  toIsoOrNull,
  uuidArrayLiteral,
  uuidSchema,
  type Q,
} from './idea_shared';

// Gardening step 1 (docs/idea-parking-lot-protocol.md §2): pull CANDIDATE
// pairs for the agent to judge. Read-only — candidates are not links.
// Pairs already proposed / accepted / rejected / retracted are excluded;
// withdrawn ones may resurface.
//
// Cost control: `near` uses a per-idea HNSW nearest-neighbour lookup;
// `band` (low similarity, where an index can't help) scans pairs among
// the most recently updated ideas only, or all pairs of one focus idea.
// Every query runs under a statement timeout.
//
// `inbox` is the weekly garden review's queue (refocus Phase 4): ideas no
// review has handled yet, oldest first, each with its nearest neighbours
// and the proposals still waiting on it (capture proposals included).

const inputSchema = z
  .object({
    mode: z.enum(['near', 'band', 'orphans', 'outputs', 'inbox']),
    focus_idea_id: uuidSchema.optional(),
    min_similarity: z.number().min(-1).max(1).optional(),
    max_similarity: z.number().min(-1).max(1).optional(),
    limit: z.number().int().min(1).max(30).optional(),
    per_idea_cap: z.number().int().min(1).max(10).optional(),
    cross_domain: z.boolean().optional(),
    include_statuses: z.array(ideaStatusSchema).min(1).optional(),
    order: z.enum(['newest', 'oldest']).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

const DEFAULTS = {
  near: { min: 0.5, max: 1 },
  band: { min: 0.3, max: 0.45 },
  orphans: { min: 0.3, max: 1 },
  outputs: { min: 0.45, max: 1 },
  inbox: { min: 0.3, max: 1 },
} as const;

// How many ideas a global near/band pass looks at.
const NEAR_SCOPE = 1000;
const BAND_SCOPE = 600;
const NEAR_K = 15;
const OUTPUTS_PAGE = 40;

type IdeaBrief = { id: string; title: string; kind: string; status: string; snippet: string | null; tags: string[] };
type Row = Record<string, unknown>;

export async function gardenIdeasHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const minSim = args.min_similarity ?? DEFAULTS[args.mode].min;
  const maxSim = args.max_similarity ?? DEFAULTS[args.mode].max;
  if (minSim > maxSim) return errorResult('Invalid arguments: min_similarity > max_similarity');
  const limit = args.limit ?? (args.mode === 'orphans' || args.mode === 'inbox' ? 8 : 12);
  const perIdeaCap = args.per_idea_cap ?? 2;
  const statuses = args.include_statuses ?? ['parked', 'exploring', 'used'];
  const offset = args.offset ?? 0;
  const newestFirst = (args.order ?? (args.mode === 'inbox' ? 'oldest' : 'newest')) === 'newest';
  const uid = env.BRAIN_USER_ID;
  const focus = args.focus_idea_id;

  const toBrief = (r: Row, p: 'a' | 'b'): IdeaBrief => ({
    id: r[`${p}_id`] as string,
    title: r[`${p}_title`] as string,
    kind: r[`${p}_kind`] as string,
    status: r[`${p}_status`] as string,
    snippet: snippet(r[`${p}_snip`] as string | null, 400),
    tags: parseJsonb<string[]>(r[`${p}_tags`], []),
  });
  const overlap = (a: string[], b: string[]) => {
    const s = new Set(a.map((t) => t.toLowerCase()));
    return b.some((t) => s.has(t.toLowerCase()));
  };

  const sql = getDb(env);
  try {
    const stats = await sql<Array<{ embedded: string | number; unembedded: string | number; as_of: Date }>>`
      SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
             count(*) FILTER (WHERE embedding IS NULL) AS unembedded,
             now() AS as_of
        FROM idea WHERE user_id = ${uid}
    `;
    const statsOut = { embedded: Number(stats[0].embedded), unembedded: Number(stats[0].unembedded) };
    const asOf = toIso(stats[0].as_of);

    if (focus) {
      const f = await sql`
        SELECT 1 AS found, now() AS as_of FROM idea WHERE id = ${focus} AND user_id = ${uid}
      `;
      if (f.length === 0) return errorResult(`Idea not found: ${focus}`);
    }

    // All candidate queries run in one transaction with a statement timeout
    // (SET LOCAL: Hyperdrive pools connections in transaction mode).
    const run = <T>(fn: (tx: Q) => Promise<T>) =>
      sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '8s'`;
        return fn(tx);
      }) as Promise<T>;

    const unconsidered = (tx: Q, a: string, b: string) => tx`
      NOT EXISTS (
        SELECT 1 FROM idea_link l
         WHERE LEAST(l.source_idea_id, l.target_idea_id) = LEAST(${tx(a)}, ${tx(b)})
           AND GREATEST(l.source_idea_id, l.target_idea_id) = GREATEST(${tx(a)}, ${tx(b)})
           AND l.status IN ('proposed', 'accepted', 'rejected', 'retracted'))
    `;
    const cols = (tx: Q, alias: string, p: 'a' | 'b') => tx`
      ${tx(alias)}.id AS ${tx(`${p}_id`)}, ${tx(alias)}.title AS ${tx(`${p}_title`)},
      ${tx(alias)}.kind AS ${tx(`${p}_kind`)}, ${tx(alias)}.status AS ${tx(`${p}_status`)},
      left(COALESCE(${tx(alias)}.framing, ${tx(alias)}.why_interesting, ${tx(alias)}.thoughts, ${tx(alias)}.source_excerpt), 600) AS ${tx(`${p}_snip`)},
      to_jsonb(${tx(alias)}.tags) AS ${tx(`${p}_tags`)}
    `;

    if (args.mode === 'outputs') {
      // Ideas without an accepted `became`, a page at a time, each with its
      // nearest own published outputs (public_artifact rows are user 'default').
      const rows = await run((tx) => tx<Row[]>`
        SELECT ${cols(tx, 'i', 'a')}, i.captured_at AS a_captured_at, i.total,
               art.id AS art_id, art.title AS art_title, art.canonical_url AS art_url,
               art.published_at AS art_published_at, art.type AS art_type, art.similarity,
               now() AS as_of
          FROM (
            SELECT x.*, count(*) OVER () AS total FROM idea x
             WHERE x.user_id = ${uid}
               AND x.embedding IS NOT NULL
               AND x.status = ANY(${textArray(tx, statuses)})
               AND ${focus ? tx`x.id = ${focus}` : tx`TRUE`}
               AND NOT EXISTS (SELECT 1 FROM idea_link l
                                WHERE l.source_idea_id = x.id AND l.status = 'accepted'
                                  AND l.link_type = 'became')
             ORDER BY ${newestFirst ? tx`x.captured_at DESC` : tx`x.captured_at ASC`}, x.id
             LIMIT ${OUTPUTS_PAGE} OFFSET ${offset}
          ) i
          CROSS JOIN LATERAL (
            SELECT a.id, a.title, a.canonical_url, a.published_at, a.type,
                   1 - (a.embedding <=> i.embedding) AS similarity
              FROM public_artifact a
             WHERE a.processing_status = 'processed'
               AND a.status = 'published'
               AND a.embedding IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM idea_link l
                                WHERE l.source_idea_id = i.id AND l.target_artifact_id = a.id
                                  AND l.status IN ('proposed', 'accepted', 'rejected', 'retracted'))
             ORDER BY a.embedding <=> i.embedding
             LIMIT 3
          ) art
         WHERE art.similarity >= ${minSim} AND art.similarity <= ${maxSim}
         ORDER BY art.similarity DESC
      `);
      const total = rows.length > 0 ? Number(rows[0].total) : null;
      const perIdea = new Map<string, number>();
      const candidates = [];
      for (const r of rows) {
        const n = perIdea.get(r.a_id as string) ?? 0;
        if (n >= perIdeaCap) continue;
        perIdea.set(r.a_id as string, n + 1);
        const published = r.art_published_at ? new Date(r.art_published_at as string | Date) : null;
        const captured = new Date(r.a_captured_at as string | Date);
        candidates.push({
          a: toBrief(r, 'a'),
          artifact: {
            id: r.art_id,
            title: r.art_title,
            url: r.art_url,
            published_at: toIsoOrNull(r.art_published_at as Date | null),
            type: r.art_type,
          },
          similarity: round4(r.similarity),
          hint: published && published >= captured ? 'became?' : 'revisits?',
        });
        if (candidates.length >= limit) break;
      }
      return ok({
        as_of: asOf,
        mode: args.mode,
        stats: statsOut,
        paging: {
          ideas_per_page: OUTPUTS_PAGE,
          offset,
          next_offset: total !== null && offset + OUTPUTS_PAGE < total ? offset + OUTPUTS_PAGE : null,
          note: 'Each call scans one page of ideas without a `became` link; pass next_offset (or focus_idea_id) to reach the rest.',
        },
        ...footer(),
        candidates,
      });
    }

    // Up to 3 nearest unconsidered neighbours of one idea (none until it is
    // embedded). The inbox offers live ones only, even when include_statuses
    // lets composted ideas in: propose_idea_links refuses a composted end.
    const neighbourStatuses = args.mode === 'inbox' ? statuses.filter((s) => s !== 'composted') : statuses;
    const neighboursOf = async (tx: Q, o: Row) => {
      const neighbours = o.embedded
        ? await tx<Row[]>`
            SELECT ${cols(tx, 'b', 'b')}, nb.similarity, now() AS as_of
              FROM idea a
              CROSS JOIN LATERAL (
                SELECT c.id, 1 - (c.embedding <=> a.embedding) AS similarity
                  FROM idea c
                 WHERE c.user_id = a.user_id AND c.id <> a.id AND c.embedding IS NOT NULL
                   AND c.status = ANY(${textArray(tx, neighbourStatuses)})
                 ORDER BY c.embedding <=> a.embedding
                 LIMIT ${NEAR_K}
              ) nb
              JOIN idea b ON b.id = nb.id
             WHERE a.id = ${o.a_id as string}
               AND nb.similarity BETWEEN ${minSim} AND ${maxSim}
               AND ${unconsidered(tx, 'a.id', 'b.id')}
             ORDER BY nb.similarity DESC
          `
        : [];
      const aTags = parseJsonb<string[]>(o.a_tags, []);
      return neighbours
        .map((n) => ({ b: toBrief(n, 'b'), similarity: round4(n.similarity) }))
        .filter((n) => !args.cross_domain || !overlap(aTags, n.b.tags))
        .slice(0, 3);
    };

    if (args.mode === 'orphans' || args.mode === 'inbox') {
      const inbox = args.mode === 'inbox';
      const out = await run(async (tx) => {
        const ideas = await tx<Row[]>`
          SELECT ${cols(tx, 'i', 'a')}, (i.embedding IS NOT NULL) AS embedded, i.captured_at AS a_captured_at,
                 count(*) OVER () AS total, now() AS as_of
            FROM idea i
           WHERE i.user_id = ${uid}
             AND i.status = ANY(${textArray(tx, statuses)})
             AND ${focus ? tx`i.id = ${focus}` : tx`TRUE`}
             AND ${
               inbox
                 ? inboxCondition(tx)
                 : tx`NOT EXISTS (SELECT 1 FROM idea_link l
                                   WHERE l.status = 'accepted'
                                     AND (l.source_idea_id = i.id OR l.target_idea_id = i.id))`
             }
           ORDER BY ${newestFirst ? tx`i.captured_at DESC` : tx`i.captured_at ASC`}, i.id
           LIMIT ${limit} OFFSET ${offset}
        `;
        const pending = inbox && ideas.length > 0 ? await pendingFor(tx, uid, ideas.map((o) => o.a_id as string)) : [];
        const list = [];
        for (const o of ideas) {
          const neighbours = await neighboursOf(tx, o);
          if (!inbox) {
            list.push({ idea: toBrief(o, 'a'), embedded: o.embedded, neighbours });
            continue;
          }
          const id = o.a_id as string;
          list.push({
            idea: { ...toBrief(o, 'a'), captured_at: toIso(o.a_captured_at as Date) },
            embedded: o.embedded,
            neighbours,
            pending: pending.filter((p) => p.source_idea_id === id || p.target_idea_id === id).map((p) => pendingView(p, id)),
          });
        }
        const total = ideas.length > 0 ? Number(ideas[0].total) : 0;
        return { list, total };
      });
      const nextOffset = offset + limit < out.total ? offset + limit : null;
      return inbox
        ? ok({
            as_of: asOf,
            mode: args.mode,
            stats: statsOut,
            paging: { offset, total_inbox: out.total, next_offset: nextOffset },
            reminder: INBOX_REMINDER,
            inbox: out.list,
          })
        : ok({
            as_of: asOf,
            mode: args.mode,
            stats: statsOut,
            paging: { offset, total_orphans: out.total, next_offset: nextOffset },
            ...footer(),
            orphans: out.list,
          });
    }

    // near / band: idea pairs within the similarity range.
    const rows = await run((tx) =>
      args.mode === 'near'
        ? tx<Row[]>`
            WITH a AS (
              SELECT * FROM idea
               WHERE user_id = ${uid} AND embedding IS NOT NULL
                 AND status = ANY(${textArray(tx, statuses)})
                 AND ${focus ? tx`id = ${focus}` : tx`TRUE`}
               ORDER BY updated_at DESC
               LIMIT ${NEAR_SCOPE}
            )
            SELECT ${cols(tx, 'a', 'a')}, ${cols(tx, 'b', 'b')}, nb.similarity, now() AS as_of
              FROM a
              CROSS JOIN LATERAL (
                SELECT c.id, 1 - (c.embedding <=> a.embedding) AS similarity
                  FROM idea c
                 WHERE c.user_id = a.user_id AND c.id <> a.id AND c.embedding IS NOT NULL
                   AND c.status = ANY(${textArray(tx, statuses)})
                 ORDER BY c.embedding <=> a.embedding
                 LIMIT ${NEAR_K}
              ) nb
              JOIN idea b ON b.id = nb.id
             WHERE nb.similarity BETWEEN ${minSim} AND ${maxSim}
               AND ${unconsidered(tx, 'a.id', 'b.id')}
             ORDER BY nb.similarity DESC
          `
        : focus
          ? tx<Row[]>`
              SELECT ${cols(tx, 'a', 'a')}, ${cols(tx, 'b', 'b')},
                     1 - (a.embedding <=> b.embedding) AS similarity, now() AS as_of
                FROM idea a
                JOIN idea b ON b.user_id = a.user_id AND b.id <> a.id AND b.embedding IS NOT NULL
               WHERE a.id = ${focus} AND a.embedding IS NOT NULL
                 AND b.status = ANY(${textArray(tx, statuses)})
                 AND 1 - (a.embedding <=> b.embedding) BETWEEN ${minSim} AND ${maxSim}
                 AND ${unconsidered(tx, 'a.id', 'b.id')}
               ORDER BY similarity DESC
               LIMIT ${limit * 5}
            `
          : tx<Row[]>`
              WITH c AS (
                SELECT * FROM idea
                 WHERE user_id = ${uid} AND embedding IS NOT NULL
                   AND status = ANY(${textArray(tx, statuses)})
                 ORDER BY updated_at DESC
                 LIMIT ${BAND_SCOPE}
              )
              SELECT ${cols(tx, 'a', 'a')}, ${cols(tx, 'b', 'b')},
                     1 - (a.embedding <=> b.embedding) AS similarity, now() AS as_of
                FROM c a
                JOIN c b ON a.id < b.id
               WHERE 1 - (a.embedding <=> b.embedding) BETWEEN ${minSim} AND ${maxSim}
                 AND ${unconsidered(tx, 'a.id', 'b.id')}
               ORDER BY similarity DESC, a.id, b.id
               LIMIT ${limit * 5}
            `,
    );

    const seenPairs = new Set<string>();
    const perIdea = new Map<string, number>();
    const candidates = [];
    for (const r of rows) {
      let a = toBrief(r, 'a');
      let b = toBrief(r, 'b');
      if (a.id > b.id) [a, b] = [b, a];
      const key = `${a.id}|${b.id}`;
      if (seenPairs.has(key)) continue; // kNN finds each pair from both ends
      seenPairs.add(key);
      if (args.cross_domain && overlap(a.tags, b.tags)) continue;
      const na = perIdea.get(a.id) ?? 0;
      const nb = perIdea.get(b.id) ?? 0;
      if (na >= perIdeaCap || nb >= perIdeaCap) continue;
      perIdea.set(a.id, na + 1);
      perIdea.set(b.id, nb + 1);
      const sim = round4(r.similarity);
      candidates.push({ a, b, similarity: sim, hint: sim >= 0.9 ? 'possible_duplicate' : null });
      if (candidates.length >= limit) break;
    }
    const scope = focus ? null : args.mode === 'near' ? NEAR_SCOPE : BAND_SCOPE;
    return ok({
      as_of: asOf,
      mode: args.mode,
      range: { min_similarity: minSim, max_similarity: maxSim },
      stats: statsOut,
      ...(scope !== null && statsOut.embedded > scope
        ? {
            scope_note: `Global ${args.mode} passes look at the ${scope} most recently updated ideas; use focus_idea_id to reach any idea.`,
          }
        : {}),
      ...footer(),
      candidates,
    });
  } catch (e) {
    if ((e as { code?: string }).code === '57014') {
      return errorResult(
        'garden_ideas timed out scanning pairs. Narrow it with focus_idea_id, a tighter similarity range, or include_statuses.',
      );
    }
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

type PendingRow = {
  id: string;
  link_type: LinkType;
  rationale: string;
  similarity: number | null;
  proposed_by: string;
  proposed_at: Date;
  source_idea_id: string;
  target_idea_id: string | null;
  target_artifact_id: string | null;
  s_title: string;
  s_status: string;
  t_title: string | null;
  t_status: string | null;
  art_title: string | null;
  art_url: string | null;
};

// Proposals still waiting on any of these ideas, oldest first. None with
// a composted end: a review never asks about ideas the user set aside.
async function pendingFor(tx: Q, uid: string, ids: string[]): Promise<PendingRow[]> {
  return tx<PendingRow[]>`
    SELECT l.id, l.link_type, l.rationale, l.similarity, l.proposed_by, l.proposed_at,
           l.source_idea_id, l.target_idea_id, l.target_artifact_id,
           s.title AS s_title, s.status AS s_status, t.title AS t_title, t.status AS t_status,
           art.title AS art_title, art.canonical_url AS art_url,
           now() AS as_of
      FROM idea_link l
      JOIN idea s ON s.id = l.source_idea_id
      LEFT JOIN idea t ON t.id = l.target_idea_id
      LEFT JOIN public_artifact art ON art.id = l.target_artifact_id
     WHERE l.user_id = ${uid}
       AND l.status = 'proposed'
       AND s.status <> 'composted'
       AND t.status IS DISTINCT FROM 'composted'
       AND (l.source_idea_id = ANY(${uuidArrayLiteral(ids)}::uuid[])
            OR l.target_idea_id = ANY(${uuidArrayLiteral(ids)}::uuid[]))
     ORDER BY l.proposed_at, l.id
  `;
}

// One pending proposal as seen from idea `id`.
function pendingView(p: PendingRow, id: string) {
  const out = p.source_idea_id === id;
  return {
    link_id: p.id,
    link_type: p.link_type,
    label: linkLabel(p.link_type),
    direction: isSymmetric(p.link_type) ? 'both' : out ? 'out' : 'in',
    rationale: p.rationale,
    similarity: p.similarity,
    proposed_by: p.proposed_by,
    proposed_at: toIso(p.proposed_at),
    ...(p.target_artifact_id
      ? { artifact: { id: p.target_artifact_id, title: p.art_title, url: p.art_url } }
      : out
        ? { other: { id: p.target_idea_id, title: p.t_title, status: p.t_status } }
        : { other: { id: p.source_idea_id, title: p.s_title, status: p.s_status } }),
  };
}

const INBOX_REMINDER =
  "Walk these with the user. Neighbours are NOT links: propose only defensible typed links (propose_idea_links). Pending proposals wait for the user's verdict: record exactly what they say (decide_idea_links) and leave the rest pending. Mark an idea reviewed (decide_idea_links mark_reviewed) only once the user has been through it. Next page: offset = paging.next_offset minus the ideas on this page that left the inbox (marked reviewed, composted or promoted).";

function round4(v: unknown): number {
  return Math.round(Number(v) * 10000) / 10000;
}

function footer() {
  return {
    reminder:
      'Candidates are NOT links. Judge each pair, propose only defensible typed links with propose_idea_links, and let the user accept or reject them (decide_idea_links). Proposing nothing is fine.',
  };
}

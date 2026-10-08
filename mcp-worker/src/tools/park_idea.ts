import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import type { Principal } from '../auth/principal';
import { getDb } from '../db';
import { embed, vectorLiteral } from '../embeddings';
import { buildIdeaEmbeddingText } from '../ideas/embeddingText';
import { LINK_TYPES, LINK_TYPE_INFO, targetsArtifact } from '../ideas/linkTypes';
import { snippet } from '../ideas/text';
import {
  capturedViaSchema,
  cleanTags,
  dbError,
  errorResult,
  credentialLabel,
  isoDateTimeSchema,
  jsonParam,
  LIMITS,
  ok,
  tagsSchema,
  textArray,
  toIso,
  type Q,
} from './idea_shared';

const inputSchema = z
  .object({
    title: z.string().min(1).max(LIMITS.title),
    thoughts: z.string().max(LIMITS.thoughts).optional(),
    why_interesting: z.string().max(LIMITS.why_interesting).optional(),
    encountered_where: z.string().max(LIMITS.encountered_where).optional(),
    source: z
      .object({
        url: z.string().url().max(LIMITS.source_url).optional(),
        title: z.string().max(LIMITS.source_title).optional(),
        excerpt: z.string().max(LIMITS.source_excerpt).optional(),
      })
      .strict()
      .optional(),
    framing: z.string().max(LIMITS.framing).optional(),
    tags: tagsSchema.optional(),
    captured_at: isoDateTimeSchema.optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
    captured_via: capturedViaSchema.optional(),
  })
  .strict();

// Link proposals at capture (refocus D3, D12): park_idea returns the
// nearest existing ideas; the assistant drafts the typed proposals and
// glosses, saves them with propose_idea_links(origin 'capture'), and the
// user decides. Below this cosine similarity a neighbour is noise (the
// protocol's similarity guide).
export const CANDIDATE_MIN_SIMILARITY = 0.3;
const MAX_CANDIDATES = 5;
// A slow embedding call must not hold up the capture: it just means no candidates.
export const CANDIDATE_EMBED_TIMEOUT_MS = 5000;

// Idea-to-idea types with the label the user sees, e.g. "tension_with
// (contradicts)"; part_of also says it needs a synthesis candidate.
const CAPTURE_TYPE_LABELS = LINK_TYPES.filter((t) => !targetsArtifact(t))
  .map((t) => {
    const { label, target } = LINK_TYPE_INFO[t];
    const notes = [
      ...(label === t ? [] : [label]),
      ...(target === 'synthesis' ? ["only to a candidate of kind 'synthesis'"] : []),
    ];
    return notes.length > 0 ? `${t} (${notes.join('; ')})` : t;
  })
  .join(', ');

const RECEIPT_NOTE =
  'Filed. In your reply this receipt comes first. Where a link_candidate genuinely connects with this idea, draft ' +
  'up to 3 typed link proposals between this idea and those candidates, each with a one-line gloss naming the ' +
  "specific connection; save them with propose_idea_links (origin 'capture') and list them after the receipt in " +
  `the same reply, with their display labels. Types (label): ${CAPTURE_TYPE_LABELS}; directed types read ` +
  'source → target. Nothing is linked until the user says yes: record exactly their verdicts with ' +
  'decide_idea_links. Proposals they ignore stay pending for the weekly garden review. Propose nothing if no ' +
  'candidate truly connects, and do not suggest tags. Embedding runs async (~30–60s).';

const NO_CANDIDATES_NOTE =
  'Filed. Reply with this receipt only: there are no link candidates to propose from (see warnings, if any). ' +
  'The weekly garden review links it later. Embedding runs async (~30–60s).';

const DEDUP_NOTE =
  'Already filed (same idempotency key, or within the last 10 minutes the same title and the same content in ' +
  "every other field; captured_via is not compared, the first capture's is kept). " +
  'Nothing new was written. A retry returns no link_candidates: proposals saved after the first capture are ' +
  'still pending (list_idea_links with idea_id).';

export async function parkIdeaHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const title = args.title.trim();
  if (!title) return errorResult('Invalid arguments: title is blank');

  if (args.captured_at && Date.parse(args.captured_at) > Date.now() + 60 * 60 * 1000) {
    return errorResult('Invalid arguments: captured_at is in the future');
  }

  const tags = cleanTags(args.tags);
  const nonBlank = (s: string | undefined) => (s !== undefined && s.trim() !== '' ? s : null);
  // thoughts are stored byte-for-byte as given (verbatim rule) — only an
  // all-whitespace value is treated as absent.
  const thoughts = nonBlank(args.thoughts);
  const fields = {
    why_interesting: nonBlank(args.why_interesting),
    encountered_where: nonBlank(args.encountered_where),
    source_url: nonBlank(args.source?.url),
    source_title: nonBlank(args.source?.title),
    source_excerpt: nonBlank(args.source?.excerpt),
    framing: nonBlank(args.framing),
  };
  const fieldsFiled = [
    'title',
    ...(thoughts !== null ? ['thoughts'] : []),
    ...Object.entries(fields)
      .filter(([, v]) => v !== null)
      .map(([k]) => k),
    ...(tags.length > 0 ? ['tags'] : []),
    ...(args.captured_at ? ['captured_at'] : []),
  ];
  // The credential label is stamped server-side (the strict schema rejects a client-sent one).
  const capturedVia = { ...(args.captured_via ?? {}), role: 'librarian', credential: credentialLabel(principal) };
  const key = args.idempotency_key ?? null;

  const sql = getDb(env);
  try {
    type Existing = { id: string; title: string; captured_at: Date; status: string };
    const byKey = async (): Promise<Existing | null> => {
      if (!key) return null;
      const rows = await sql<Existing[]>`
        SELECT i.id, i.title, i.captured_at, i.status, now() AS as_of
          FROM idea_source s JOIN idea i ON i.id = s.idea_id
         WHERE s.user_id = ${env.BRAIN_USER_ID}
           AND s.source_system = 'librarian'
           AND s.source_external_id = ${key}
      `;
      return rows[0] ?? null;
    };
    // Retry guard for clients that resend without (or with a fresh) key:
    // the same title AND every captured content field identical, filed in
    // the last 10 minutes. Any difference (another thought, framing, tag,
    // source or capture time) is a new idea, so no content the caller sent
    // is dropped. Title and tags compare case-insensitively, tags as a set
    // (a regenerated call may reorder them). captured_via is provenance and
    // not compared: a match keeps the first capture's. An omitted
    // captured_at defaults to the insert's now(), i.e. created_at.
    const tagSet = (arr: ReturnType<typeof textArray>) =>
      sql`(SELECT coalesce(array_agg(lower(t) ORDER BY lower(t)), '{}') FROM unnest(${arr}) t)`;
    const sameContentRecently = async (): Promise<Existing | null> => {
      const rows = await sql<Existing[]>`
        SELECT id, title, captured_at, status, now() AS as_of
          FROM idea
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND kind = 'unit'
           AND lower(btrim(title)) = lower(${title})
           AND thoughts IS NOT DISTINCT FROM ${thoughts}
           AND why_interesting IS NOT DISTINCT FROM ${fields.why_interesting}
           AND encountered_where IS NOT DISTINCT FROM ${fields.encountered_where}
           AND source_url IS NOT DISTINCT FROM ${fields.source_url}
           AND source_title IS NOT DISTINCT FROM ${fields.source_title}
           AND source_excerpt IS NOT DISTINCT FROM ${fields.source_excerpt}
           AND framing IS NOT DISTINCT FROM ${fields.framing}
           AND ${tagSet(sql`tags`)} = ${tagSet(textArray(sql, tags))}
           AND captured_at = COALESCE(${args.captured_at ?? null}::timestamptz, created_at)
           AND created_at > now() - interval '10 minutes'
         ORDER BY created_at DESC
         LIMIT 1
      `;
      return rows[0] ?? null;
    };
    const lookupExisting = async (): Promise<Existing | null> => {
      const k = await byKey();
      if (k) return k;
      const recent = await sameContentRecently();
      if (recent && key) {
        // Remember the new key too, so later retries with it stay consistent.
        await sql`
          INSERT INTO idea_source (idea_id, user_id, source_system, source_external_id)
          VALUES (${recent.id}, ${env.BRAIN_USER_ID}, 'librarian', ${key})
          ON CONFLICT DO NOTHING
        `;
      }
      return recent;
    };

    const existing = await lookupExisting();
    if (existing) {
      return ok(receipt(existing.id, existing.title, existing.captured_at, existing.status, [], true, [], []));
    }

    let created: { id: string; title: string; captured_at: Date; status: string };
    try {
      created = await sql.begin(async (tx) => {
        const rows = await tx<Array<{ id: string; title: string; captured_at: Date; status: string }>>`
          INSERT INTO idea (
            user_id, title, thoughts, why_interesting, encountered_where,
            source_url, source_title, source_excerpt, framing, tags,
            captured_at, captured_via
          ) VALUES (
            ${env.BRAIN_USER_ID}, ${title}, ${thoughts}, ${fields.why_interesting},
            ${fields.encountered_where}, ${fields.source_url}, ${fields.source_title},
            ${fields.source_excerpt}, ${fields.framing}, ${textArray(tx, tags)},
            COALESCE(${args.captured_at ?? null}::timestamptz, now()),
            ${jsonParam(tx, capturedVia)}
          )
          RETURNING id, title, captured_at, status
        `;
        await tx`
          INSERT INTO idea_source (idea_id, user_id, source_system, source_external_id)
          VALUES (${rows[0].id}, ${env.BRAIN_USER_ID}, 'librarian', ${key})
        `;
        return rows[0];
      });
    } catch (e) {
      // Concurrent retry with the same idempotency key lost the race.
      if ((e as { code?: string }).code === '23505' && key) {
        const again = await lookupExisting();
        if (again) {
          return ok(receipt(again.id, again.title, again.captured_at, again.status, [], true, [], []));
        }
      }
      throw e;
    }

    // The idea is filed; finding candidates is best effort and never fails the capture.
    const warnings: string[] = [];
    let candidates: LinkCandidate[] = [];
    try {
      const text = buildIdeaEmbeddingText({
        title,
        framing: fields.framing,
        why_interesting: fields.why_interesting,
        thoughts,
        notes: null,
        source_title: fields.source_title,
        source_excerpt: fields.source_excerpt,
        tags,
      });
      candidates = await findLinkCandidates(sql, env, created.id, text);
    } catch (e) {
      warnings.push(`Link candidates unavailable (${e instanceof Error ? e.message : String(e)}); the idea is filed.`);
    }

    return ok(
      receipt(created.id, created.title, created.captured_at, created.status, fieldsFiled, false, candidates, warnings),
    );
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

type LinkCandidate = {
  id: string;
  title: string;
  kind: string;
  status: string;
  similarity: number;
  snippet: string | null;
};

// The nearest live ideas to a new one, nearest first. The new idea's text
// is embedded here only as a query vector: the vector is not stored, since
// the Node sweeper embeds rows and the Worker never processes them.
async function findLinkCandidates(sql: Q, env: Env, ideaId: string, text: string): Promise<LinkCandidate[]> {
  // Nothing to compare with (no other embedded idea that is not composted):
  // skip the OpenAI call.
  const others = await sql<Array<{ found: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM idea
       WHERE user_id = ${env.BRAIN_USER_ID} AND id <> ${ideaId}
         AND status <> 'composted' AND embedding IS NOT NULL
    ) AS found, now() AS as_of
  `;
  if (!others[0]?.found) return [];

  const q = vectorLiteral(await withTimeout(embed(text, env.OPENAI_API_KEY), CANDIDATE_EMBED_TIMEOUT_MS));
  const rows = await sql<
    Array<{ id: string; title: string; kind: string; status: string; snippet_src: string | null; similarity: number }>
  >`
    SELECT i.id, i.title, i.kind, i.status,
           left(COALESCE(i.framing, i.why_interesting, i.thoughts, i.source_excerpt), 600) AS snippet_src,
           1 - (i.embedding <=> ${q}::vector) AS similarity,
           now() AS as_of
      FROM idea i
     WHERE i.user_id = ${env.BRAIN_USER_ID} AND i.id <> ${ideaId}
       AND i.status <> 'composted' AND i.embedding IS NOT NULL
       AND 1 - (i.embedding <=> ${q}::vector) >= ${CANDIDATE_MIN_SIMILARITY}
     ORDER BY i.embedding <=> ${q}::vector
     LIMIT ${MAX_CANDIDATES}
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    status: r.status,
    similarity: Math.round(Number(r.similarity) * 10000) / 10000,
    snippet: snippet(r.snippet_src, 240),
  }));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`embedding timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// The receipt fields come first and keep their shape; link_candidates
// (and warnings, when there are any) follow them.
function receipt(
  id: string,
  title: string,
  capturedAt: Date | string,
  status: string,
  fieldsFiled: string[],
  deduplicated: boolean,
  candidates: LinkCandidate[],
  warnings: string[],
) {
  return {
    idea_id: id,
    title,
    captured_at: toIso(capturedAt),
    status,
    fields_filed: fieldsFiled,
    embedding: deduplicated ? 'unchanged' : 'pending',
    deduplicated,
    note: deduplicated ? DEDUP_NOTE : candidates.length > 0 ? RECEIPT_NOTE : NO_CANDIDATES_NOTE,
    link_candidates: candidates,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

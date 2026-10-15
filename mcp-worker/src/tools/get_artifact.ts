import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';
import { dbError, errorResult, ok, parseJsonb, toIso, toIsoOrNull, uuidSchema } from './idea_shared';

// One published piece (refocus Phase 5) with its text, a bounded part at a
// time. An id whose row was replaced (status 'superseded', as the archive
// load does) resolves to the row that replaced it, so a link found in an
// old journal entry or idea still reads the current text. Only a published
// row is returned: a draft, a fragment kept out of search (status
// 'hidden') or a chain that ends anywhere else reads as not found, even by
// id. Members-only pieces are returned (D11), marked members_only. Every read carries
// `now() AS as_of` (test/ideas.fixes.test.ts scans this file).

// Characters (Unicode code points: Postgres substr and char_length count
// those, so a surrogate pair is never split) per part.
const PART_CHARS = 12_000;
// Replacements followed at most; a longer chain stops at the last row read.
const MAX_HOPS = 5;
// Past any text Postgres can hold (1 GB), and offset + 1 still fits the
// int the SQL substr takes.
const MAX_OFFSET = 2_000_000_000;

const inputSchema = z
  .object({
    artifact_id: uuidSchema,
    offset: z.number().int().min(0).max(MAX_OFFSET).optional(),
    limit: z.number().int().min(1).max(PART_CHARS).optional(),
    include_text: z.boolean().optional(),
  })
  .strict();

type Row = {
  id: string;
  title: string;
  source_system: string;
  status: string;
  flag: string | null;
  members_only: boolean;
  published_at: Date | null;
  series: string | null;
  series_position: number | null;
  outlets: unknown;
  canonical_url: string | null;
  tags: unknown;
  summary: string | null;
  excerpt: string | null;
  language: string | null;
  word_count: number | null;
  processing_status: string;
  text_chars: number | string;
  text: string | null;
  resolved_from: unknown;
  as_of: Date;
};

export async function getArtifactHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { artifact_id: id } = parsed.data;
  const offset = parsed.data.offset ?? 0;
  const limit = parsed.data.limit ?? PART_CHARS;
  const includeText = parsed.data.include_text ?? true;

  const sql = getDb(env);
  try {
    // A sync that changes a row's text sets it back to 'pending' and keeps
    // the old clean_text and summary until the worker runs again (or for
    // good, if it fails). So only a processed row reads clean_text; any
    // other reads raw_source, and its summary and excerpt are left out.
    const processed = () => sql`pa.processing_status = 'processed'`;
    const textSrc = () => sql`CASE WHEN ${processed()} THEN COALESCE(pa.clean_text, pa.raw_source) ELSE pa.raw_source END`;
    // Follow superseded_by only from a row that has left search: a row
    // whose replacement still waits to be processed is the live one.
    const rows = await sql<Array<Row>>`
      WITH RECURSIVE chain AS (
        SELECT id, superseded_by, status, 0 AS hop
          FROM public_artifact
         WHERE id = ${id}
        UNION ALL
        SELECT n.id, n.superseded_by, n.status, c.hop + 1
          FROM chain c
          JOIN public_artifact n ON n.id = c.superseded_by
         WHERE c.status = 'superseded' AND c.hop < ${MAX_HOPS}
      )
      SELECT pa.id, pa.title, pa.source_system, pa.status, pa.flag, pa.members_only,
             pa.published_at, pa.series, pa.series_position, to_jsonb(pa.outlets) AS outlets,
             pa.canonical_url, to_jsonb(pa.tags) AS tags,
             CASE WHEN ${processed()} THEN pa.summary END AS summary,
             CASE WHEN ${processed()} THEN pa.excerpt END AS excerpt,
             pa.language, pa.word_count, pa.processing_status,
             char_length(${textSrc()}) AS text_chars,
             ${includeText ? sql`substr(${textSrc()}, ${offset + 1}::int, ${limit}::int)` : sql`NULL::text`} AS text,
             (SELECT jsonb_agg(c.id ORDER BY c.hop) FROM chain c WHERE c.hop < (SELECT max(hop) FROM chain))
               AS resolved_from,
             now() AS as_of
        FROM public_artifact pa
       WHERE pa.id = (SELECT id FROM chain ORDER BY hop DESC LIMIT 1)
         AND pa.status = 'published'
    `;
    if (rows.length === 0) return errorResult(`Published piece not found: ${id}`);
    const r = rows[0];

    const followed = [...new Set(parseJsonb<string[] | null>(r.resolved_from, null) ?? [])];
    const textChars = Number(r.text_chars);
    const end = offset + limit;
    return ok({
      as_of: toIso(r.as_of),
      ...(followed.length > 0
        ? {
            resolved_from: followed,
            note: `${id} was replaced; this is the piece that replaced it. Cite this one.`,
          }
        : { resolved_from: null }),
      artifact: {
        id: r.id,
        title: r.title,
        type: r.source_system === 'youtube' ? 'episode' : 'essay',
        source_system: r.source_system,
        status: r.status,
        // null: confirmed (or an old row kept as the only copy); 'review':
        // still to check (it may never have been published, or its text is
        // uncertain); 'video': an old copy of a video's transcript;
        // 'unmatched' (older loads): an old row no piece replaced.
        flag: r.flag ?? null,
        members_only: r.members_only,
        published_at: toIsoOrNull(r.published_at),
        series: r.series,
        series_position: r.series_position,
        outlets: parseJsonb<string[] | null>(r.outlets, null) ?? [],
        url: r.canonical_url,
        tags: parseJsonb<string[] | null>(r.tags, null) ?? [],
        language: r.language,
        word_count: r.word_count,
        processing_status: r.processing_status,
        summary: r.summary,
        excerpt: r.excerpt,
      },
      ...(r.members_only
        ? { members_only_notice: 'Members-only: read and discuss it with the user, but never quote, link or use it in anything public.' }
        : {}),
      text_chars: textChars,
      ...(includeText
        ? { offset, next_offset: end < textChars ? end : null, text: r.text ?? '' }
        : {}),
    });
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { embed, vectorLiteral } from '../embeddings';
import { getDb } from '../db';
import { textArray } from './idea_shared';
import { searchTerms } from '../ideas/text';

// primary_type is no longer a filter (the classification was retired with
// the Chief-of-Staff role); a client that still sends it gets it ignored.
const inputSchema = z.object({
  query: z.string().min(1).max(8000),
  limit: z.number().int().min(1).max(50).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
  scope: z.enum(['personal', 'family', 'all']).optional(),
});

type Row = {
  id: string;
  summary: string | null;
  preview_src: string | null;
  tags: string[] | null;
  processing_status: string;
  created_at: Date | string;
};

// Hybrid search: vector similarity over processed entries, plus a text leg
// over every entry's summary, text and tags. The text leg finds
// Chinese phrases and names the embedding misses, and entries that are not
// processed yet (or failed processing), which have no embedding.
export async function searchBrainHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const args = parsed.data;
  const limit = args.limit ?? 10;
  const scope = args.scope ?? 'personal';
  const terms = searchTerms(args.query);
  const warnings: string[] = [];

  let vector: number[] | null = null;
  try {
    vector = await embed(args.query, env.OPENAI_API_KEY);
  } catch (e) {
    warnings.push(`Semantic search unavailable (${e instanceof Error ? e.message : String(e)}); text matches only.`);
  }

  const sql = getDb(env);
  try {
    const common = sql`
      ${scope === 'all' ? sql`TRUE` : sql`je.scope = ${scope}`}
      AND ${args.since ? sql`je.created_at >= ${args.since}` : sql`TRUE`}
      AND ${args.until ? sql`je.created_at <= ${args.until}` : sql`TRUE`}
      AND ${args.tags && args.tags.length > 0 ? sql`je.tags @> ${textArray(sql, args.tags)}` : sql`TRUE`}
    `;

    const semantic = vector
      ? await sql<Array<Row & { similarity: number }>>`
          SELECT je.id, je.summary, left(je.clean_text, 400) AS preview_src,
                 to_jsonb(je.tags) AS tags, je.processing_status, je.created_at,
                 1 - (je.embedding <=> ${vectorLiteral(vector)}::vector) AS similarity,
                 now() AS as_of
            FROM journal_entry je
           WHERE je.processing_status = 'processed'
             AND je.embedding IS NOT NULL
             AND ${common}
           ORDER BY je.embedding <=> ${vectorLiteral(vector)}::vector
           LIMIT ${limit}
        `
      : [];

    // A text hit whose summary matches every term ranks above one that
    // matches only in the body; newer entries first after that.
    const patterns = terms.map(termPattern);
    const matchAll = (col: typeof common) =>
      patterns.reduce((acc, p) => sql`${acc} AND ${col} ~* ${p}`, sql`TRUE`);
    const textual =
      terms.length > 0
        ? await sql<Array<Row>>`
            SELECT x.id, x.summary, x.preview_src, x.tags, x.processing_status, x.created_at,
                   now() AS as_of
              FROM (
                SELECT je.id, je.summary,
                       left(COALESCE(je.clean_text, je.full_text), 400) AS preview_src,
                       to_jsonb(je.tags) AS tags, je.processing_status, je.created_at,
                       concat_ws(' ', je.summary, COALESCE(je.clean_text, je.full_text),
                                 array_to_string(je.tags, ' ')) AS hay
                  FROM journal_entry je
                 WHERE je.processing_status <> 'cancelled'
                   AND ${common}
              ) x
             WHERE ${matchAll(sql`x.hay`)}
             ORDER BY (${matchAll(sql`COALESCE(x.summary, '')`)}) DESC, x.created_at DESC
             LIMIT ${limit}
          `
        : [];

    // Reciprocal-rank fusion: each leg contributes by rank, not by score,
    // so neither leg can crowd the other out, and an entry both legs found
    // ranks first. Ties go to the higher similarity.
    type Hit = Row & { similarity: number | null; match: string[]; score: number };
    const byId = new Map<string, Hit>();
    semantic.forEach((r, i) => {
      const sim = roundTo(Number(r.similarity), 4);
      byId.set(r.id, { ...r, similarity: sim, match: ['semantic'], score: rrf(i) });
    });
    textual.forEach((r, i) => {
      const prev = byId.get(r.id);
      if (prev) {
        prev.match.push('text');
        prev.score += rrf(i);
      } else {
        byId.set(r.id, { ...r, similarity: null, match: ['text'], score: rrf(i) });
      }
    });

    const hits = [...byId.values()]
      .sort((a, b) => b.score - a.score || (b.similarity ?? -1) - (a.similarity ?? -1))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        similarity: r.similarity,
        match: r.match,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        tags: Array.isArray(r.tags) ? r.tags : [],
        summary: r.summary,
        preview: r.preview_src,
        ...(r.processing_status === 'processed' ? {} : { processing_status: r.processing_status }),
      }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: hits.length, hits, ...(warnings.length ? { warnings } : {}) }, null, 2),
        },
      ],
    };
  } catch (e) {
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

const RRF_K = 60;
function rrf(rank: number): number {
  return 1 / (RRF_K + rank + 1);
}

// A case-insensitive regex for one search term. Latin terms match at the
// start of a word, and terms of up to three characters only as whole words,
// so 'AI' finds "AI-driven" and "我覺得AI會" but not "said", "again" or
// "aim". A word boundary here is any character that is not an ASCII letter
// or digit, so Latin words run into Chinese text still match. Other terms
// (Chinese has no spaces) match anywhere.
export function termPattern(term: string): string {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!/^[A-Za-z0-9]/.test(term)) return escaped;
  const start = '(^|[^A-Za-z0-9])';
  const end = /^[A-Za-z0-9]{1,3}$/.test(term) ? '($|[^A-Za-z0-9])' : '';
  return `${start}${escaped}${end}`;
}

function roundTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

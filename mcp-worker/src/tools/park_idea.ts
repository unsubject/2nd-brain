import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import type { Principal } from '../auth/principal';
import { getDb } from '../db';
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

const RECEIPT_NOTE =
  'Filed. Capture is one-way: do not suggest related ideas, links or tags now — associations are made only in gardening sessions the user starts. Embedding runs async (~30–60s).';

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
    // the same title AND the same content filed in the last 10 minutes.
    // A different thought under the same title is a new idea.
    const sameContentRecently = async (): Promise<Existing | null> => {
      const rows = await sql<Existing[]>`
        SELECT id, title, captured_at, status, now() AS as_of
          FROM idea
         WHERE user_id = ${env.BRAIN_USER_ID}
           AND kind = 'unit'
           AND lower(btrim(title)) = lower(${title})
           AND thoughts IS NOT DISTINCT FROM ${thoughts}
           AND why_interesting IS NOT DISTINCT FROM ${fields.why_interesting}
           AND source_url IS NOT DISTINCT FROM ${fields.source_url}
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
      return ok(receipt(existing.id, existing.title, existing.captured_at, existing.status, [], true));
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
          return ok(receipt(again.id, again.title, again.captured_at, again.status, [], true));
        }
      }
      throw e;
    }

    return ok(receipt(created.id, created.title, created.captured_at, created.status, fieldsFiled, false));
  } catch (e) {
    return dbError(e);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function receipt(
  id: string,
  title: string,
  capturedAt: Date | string,
  status: string,
  fieldsFiled: string[],
  deduplicated: boolean,
) {
  return {
    idea_id: id,
    title,
    captured_at: toIso(capturedAt),
    status,
    fields_filed: fieldsFiled,
    embedding: deduplicated ? 'unchanged' : 'pending',
    deduplicated,
    note: deduplicated
      ? 'Already filed (same idempotency key, or the same title and content within the last 10 minutes). Nothing new was written.'
      : RECEIPT_NOTE,
  };
}

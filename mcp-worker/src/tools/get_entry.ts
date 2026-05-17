import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  entry_id: z.string().uuid(),
  min_confidence: z.number().min(0).max(1).optional(),
});

export async function getEntryHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { entry_id } = parsed.data;
  const minConfidence = parsed.data.min_confidence ?? 0.5;

  const sql = getDb(env);
  try {
    const entries = await sql<
      Array<{
        id: string;
        channel: string;
        full_text: string | null;
        clean_text: string | null;
        summary: string | null;
        tags: string[] | null;
        primary_type: string | null;
        primary_type_confidence: number | null;
        suggested_actions: unknown;
        processing_status: string;
        scope: string;
        created_at: Date | string;
        updated_at: Date | string;
      }>
    >`
      SELECT id, channel, full_text, clean_text, summary,
             to_jsonb(tags) AS tags,
             primary_type, primary_type_confidence,
             suggested_actions, processing_status, scope,
             created_at, updated_at
      FROM journal_entry
      WHERE id = ${entry_id}
    `;
    if (entries.length === 0) {
      return errorResult(`Entry not found: ${entry_id}`);
    }
    const e = entries[0];

    // Scope filter mirrors src/db/queries.ts → getLinksForRecentEntries.
    // link_edge rows are written scope-agnostic by the linker (see file
    // header of src/google/linker.ts); reader-side enforcement lives here.
    // For a family-scope entry, only family-scope targets may be returned —
    // otherwise personal contact/task/email/calendar titles leak through.
    // Personal-scope entries see both scopes (spillover convention).
    const allowedTargetScopes =
      e.scope === 'family' ? ['family'] : ['personal', 'family'];

    const linkRows = await sql<
      Array<{
        target_id: string;
        target_type: string;
        target_title: string | null;
        link_type: string;
        confidence: number | null;
        explanation: string | null;
      }>
    >`
      SELECT le.target_id, le.target_type, le.link_type, le.confidence, le.explanation,
             COALESCE(p.full_name, c.title, t.title, em.subject, a.title, er.display_name) AS target_title
        FROM link_edge le
        LEFT JOIN person_ref         p  ON le.target_type='person_ref'         AND p.id  = le.target_id
        LEFT JOIN calendar_event_ref c  ON le.target_type='calendar_event_ref' AND c.id  = le.target_id
        LEFT JOIN task_ref           t  ON le.target_type='task_ref'           AND t.id  = le.target_id
        LEFT JOIN email_ref          em ON le.target_type='email_ref'          AND em.id = le.target_id
        LEFT JOIN public_artifact    a  ON le.target_type='public_artifact'    AND a.id  = le.target_id
        LEFT JOIN entity_ref         er ON le.target_type='entity_ref'         AND er.id = le.target_id
       WHERE le.source_id = ${entry_id} AND le.source_type='journal_entry'
         AND le.confidence >= ${minConfidence}
         AND (
           CASE le.target_type
             WHEN 'calendar_event_ref' THEN c.scope
             WHEN 'task_ref'           THEN t.scope
             WHEN 'email_ref'          THEN em.scope
             WHEN 'entity_ref'         THEN ${e.scope}::text
             ELSE 'personal'
           END = ANY(${allowedTargetScopes}::text[])
         )
       ORDER BY le.confidence DESC NULLS LAST, le.link_type
    `;

    const seen = new Set<string>();
    const links = linkRows.filter((row) => {
      if (seen.has(row.target_id)) return false;
      seen.add(row.target_id);
      return true;
    });

    const result = {
      id: e.id,
      channel: e.channel,
      scope: e.scope,
      processing_status: e.processing_status,
      primary_type: e.primary_type,
      primary_type_confidence: e.primary_type_confidence,
      created_at: toIso(e.created_at),
      updated_at: toIso(e.updated_at),
      tags: Array.isArray(e.tags) ? e.tags : [],
      summary: e.summary,
      clean_text: e.clean_text,
      full_text: e.full_text,
      suggested_actions: e.suggested_actions,
      links,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return errorResult(`DB error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

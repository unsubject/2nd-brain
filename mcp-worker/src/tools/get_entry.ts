import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  entry_id: z.string().uuid(),
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

    const links = await sql<
      Array<{
        target_id: string;
        target_type: string;
        link_type: string;
        confidence: number | null;
        explanation: string | null;
      }>
    >`
      SELECT target_id, target_type, link_type, confidence, explanation
      FROM link_edge
      WHERE source_id = ${entry_id} AND source_type = 'journal_entry'
      ORDER BY created_at DESC
    `;

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

import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(32000),
  scope: z.enum(['personal', 'family']).optional(),
  source: z
    .object({
      client: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
});

export async function saveSessionHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { title, summary, source } = parsed.data;
  const scope = parsed.data.scope ?? 'personal';

  const sourceLabel =
    source && (source.client || source.model)
      ? [source.client, source.model].filter(Boolean).join(' · ')
      : null;
  const fullText = sourceLabel
    ? `[${title}]\n\n${summary}\n\n(via ${sourceLabel})`
    : `[${title}]\n\n${summary}`;

  const messageId = crypto.randomUUID();

  const sql = getDb(env);
  try {
    const entryId = await sql.begin(async (tx) => {
      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO journal_entry (
          user_id, channel, chat_id, full_text, scope,
          created_at, updated_at,
          stitch_window_start, stitch_window_end, processing_status
        )
        VALUES (
          ${env.BRAIN_USER_ID}, 'ai_chat', null, ${fullText}, ${scope},
          now(), now(),
          now() - interval '15 minutes',
          now() - interval '15 minutes',
          'pending'
        )
        RETURNING id
      `;
      const newId = rows[0].id;

      await tx`
        INSERT INTO capture_event (
          user_id, channel, chat_id, channel_message_id, raw_text, received_at,
          journal_entry_id, is_system_command, system_command_type
        )
        VALUES (
          ${env.BRAIN_USER_ID}, 'ai_chat', null, ${messageId}, ${fullText}, now(),
          ${newId}, false, null
        )
      `;

      return newId;
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              entry_id: entryId,
              status: 'queued_for_processing',
              channel: 'ai_chat',
              scope,
              note: 'Tags, classification, and embedding run async (~30–60s). The entry will be searchable via search_brain shortly.',
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return errorResult(`DB error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

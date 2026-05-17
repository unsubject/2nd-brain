import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const inputSchema = z.object({
  candidate_id: z.string().uuid(),
  episode_url: z.string().url().max(2048),
});

export async function recordEpisodeLinkHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { candidate_id, episode_url } = parsed.data;

  const sql = getDb(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      UPDATE editorial_pick
         SET episode_url = ${episode_url},
             episode_linked_at = now()
       WHERE id = ${candidate_id}
      RETURNING id
    `;
    if (rows.length === 0) {
      return errorResult(`No editorial_pick row with id=${candidate_id}`);
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, pick_id: rows[0].id }, null, 2),
        },
      ],
    };
  } catch (e) {
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

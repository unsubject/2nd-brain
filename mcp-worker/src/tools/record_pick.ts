import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { getDb } from '../db';

const candidateSchema = z.object({
  headline: z.string().min(1).max(500),
  context: z.string().max(8000).optional(),
  domain: z.string().max(255).optional(),
  keywords: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  urls: z.array(z.string()).optional(),
});

const inputSchema = z.object({
  candidate: candidateSchema,
  decision: z.enum(['pick', 'pass', 'defer']),
  reason: z.string().max(2000).optional(),
});

export async function recordPickHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const { candidate, decision, reason } = parsed.data;

  const sql = getDb(env);
  try {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO editorial_pick (
        decision, reason, headline, context, domain, keywords, tags, urls
      )
      VALUES (
        ${decision},
        ${reason ?? null},
        ${candidate.headline},
        ${candidate.context ?? null},
        ${candidate.domain ?? null},
        ${candidate.keywords ? JSON.stringify(candidate.keywords) : null}::jsonb,
        ${candidate.tags ? JSON.stringify(candidate.tags) : null}::jsonb,
        ${candidate.urls ? JSON.stringify(candidate.urls) : null}::jsonb
      )
      RETURNING id
    `;
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

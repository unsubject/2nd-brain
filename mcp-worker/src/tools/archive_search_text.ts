import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { embed } from '../embeddings';
import { runArchiveVectorSearch } from './archive_search';

const inputSchema = z.object({
  query: z.string().min(1).max(8000),
  top_k: z.number().int().min(1).max(50).optional(),
});

export async function archiveSearchTextHandler(
  rawArgs: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`);
  }
  const topK = parsed.data.top_k ?? 10;

  let vector: number[];
  try {
    vector = await embed(parsed.data.query, env.OPENAI_API_KEY);
  } catch (e) {
    return errorResult(`Embedding failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const hits = await runArchiveVectorSearch(env, ctx, vector, topK);
    return {
      content: [{ type: 'text', text: JSON.stringify({ count: hits.length, hits }, null, 2) }],
    };
  } catch (e) {
    return errorResult(`DB error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

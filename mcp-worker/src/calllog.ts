// Attribution: which credential called which tool, and whether it worked.
// Never stores arguments. Written in ctx.waitUntil after the response; any
// failure is logged and swallowed (it must never break a tool call).

import type { AuthDb } from './auth/middleware';
import type { Principal } from './auth/principal';

export type CallEntry = {
  method: string;
  tool: string | null;
  isWrite: boolean;
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
  resultIds: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Top-level `*_id` uuids plus `results[*].*_id` from a tool's JSON result.
export function extractResultIds(resultText: string | undefined): string[] {
  if (!resultText) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(resultText);
  } catch {
    return [];
  }
  const out: string[] = [];
  const take = (o: unknown) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k.endsWith('_id') && typeof v === 'string' && UUID.test(v)) out.push(v.toLowerCase());
    }
  };
  take(obj);
  const results = (obj as { results?: unknown })?.results;
  if (Array.isArray(results)) results.forEach(take);
  return [...new Set(out)].slice(0, 50);
}

export async function recordActivity(
  db: AuthDb,
  principal: Principal,
  entries: CallEntry[],
  clientInfo: Record<string, unknown> | null,
  opts: { clientInfoOnlyIfChanged?: boolean } = {},
): Promise<void> {
  // Each step on its own: one failure must not drop the rest.
  const step = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      console.error(`[calllog] ${what} failed:`, err instanceof Error ? err.message : err);
    }
  };
  try {
    const id = principal.credentialId;
    if (id) {
      await step('last_used_at', () => db`
        UPDATE mcp_credential SET last_used_at = now()
         WHERE id = ${id}
           AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')
      `);
      if (clientInfo) {
        const unchanged = opts.clientInfoOnlyIfChanged
          ? db`AND (last_client_info IS NULL
                    OR last_client_info->'clientInfo' IS DISTINCT FROM ${db.json((clientInfo.clientInfo ?? null) as never)}
                    OR last_client_info->>'protocolVersion' IS DISTINCT FROM ${String(clientInfo.protocolVersion ?? '')})`
          : db``;
        await step('last_client_info', () => db`
          UPDATE mcp_credential SET last_client_info = ${db.json(clientInfo as never)}
           WHERE id = ${id} ${unchanged}
        `);
      }
    }
    for (const e of entries) {
      await step('insert', () => db`
        INSERT INTO mcp_call_log (credential_id, label, method, tool, is_write, ok, error_code, duration_ms, result_ids)
        VALUES (
          ${id}, ${principal.label}, ${e.method}, ${e.tool}, ${e.isWrite},
          ${e.ok}, ${e.errorCode}, ${e.durationMs}, ${db.json(e.resultIds)}
        )
      `);
    }
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }
}

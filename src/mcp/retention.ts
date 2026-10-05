// Daily housekeeping for the MCP Worker's auth tables (migration 020).
//
// The Worker logs every tool call per credential (mcp_call_log) and only
// sweeps expired tokens, codes and unapproved registrations after a
// successful OAuth request. This prunes them on a schedule instead:
//   - call-log rows older than MCP_CALL_LOG_RETENTION_DAYS (default 90,
//     never below 7: the owner console shows 7-day counts), in batches so
//     each statement stays well under the pool's 10 s statement_timeout;
//   - tokens expired, or rotated, more than a day ago;
//   - tokens of credentials revoked more than a day ago (the credential
//     rows themselves are kept for the console's "Recently revoked" list);
//   - authorization codes expired more than a day ago;
//   - client registrations never approved within 7 days.
// Every delete is idempotent, so a second instance only repeats work.

import { pool, type DB } from "../db/client";

export const DEFAULT_CALL_LOG_DAYS = 90;
export const MIN_CALL_LOG_DAYS = 7;
const BATCH_SIZE = 5000;
const MAX_BATCHES = 200;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

export function callLogRetentionDays(raw: string | undefined = process.env.MCP_CALL_LOG_RETENTION_DAYS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CALL_LOG_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[mcp-retention] ignoring MCP_CALL_LOG_RETENTION_DAYS=${JSON.stringify(raw)}; using ${DEFAULT_CALL_LOG_DAYS}`);
    return DEFAULT_CALL_LOG_DAYS;
  }
  return Math.max(MIN_CALL_LOG_DAYS, Math.floor(n));
}

export type PruneResult = {
  callLog: number;
  expiredTokens: number;
  rotatedTokens: number;
  revokedTokens: number;
  authCodes: number;
  clients: number;
};

export type PruneOptions = {
  db?: DB;
  callLogDays?: number;
  batchSize?: number;
  maxBatches?: number;
};

export async function pruneMcpAuthData(opts: PruneOptions = {}): Promise<PruneResult> {
  const db = opts.db ?? pool;
  const days = Math.max(MIN_CALL_LOG_DAYS, Math.floor(opts.callLogDays ?? callLogRetentionDays()));
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES;
  const result: PruneResult = { callLog: 0, expiredTokens: 0, rotatedTokens: 0, revokedTokens: 0, authCodes: 0, clients: 0 };

  // One failing step must not stop the others.
  const step = async (what: keyof PruneResult, run: () => Promise<number>) => {
    try {
      result[what] = await run();
    } catch (err) {
      console.error(`[mcp-retention] ${what} failed:`, err);
    }
  };
  const del = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rowCount ?? 0;

  await step("callLog", async () => {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const n = await del(
        `DELETE FROM mcp_call_log WHERE id IN (
           SELECT id FROM mcp_call_log
            WHERE at < now() - make_interval(days => $1::int)
            ORDER BY at LIMIT $2::int)`,
        [days, batchSize],
      );
      total += n;
      if (n < batchSize) break;
    }
    return total;
  });
  await step("expiredTokens", () => del(`DELETE FROM mcp_token WHERE expires_at < now() - interval '1 day'`));
  await step("rotatedTokens", () => del(`DELETE FROM mcp_token WHERE rotated_at < now() - interval '1 day'`));
  await step("revokedTokens", () =>
    del(
      `DELETE FROM mcp_token t USING mcp_credential c
        WHERE t.credential_id = c.id AND c.revoked_at < now() - interval '1 day'`,
    ),
  );
  await step("authCodes", () => del(`DELETE FROM mcp_auth_code WHERE expires_at < now() - interval '1 day'`));
  await step("clients", () =>
    del(`DELETE FROM mcp_client WHERE last_authorized_at IS NULL AND created_at < now() - interval '7 days'`),
  );
  return result;
}

export function startMcpRetention(): void {
  const days = callLogRetentionDays();
  console.log(`[mcp-retention] call log kept ${days} days; first prune in 5 min, then daily`);
  const run = () => {
    pruneMcpAuthData({ callLogDays: days })
      .then((r) => {
        const total = Object.values(r).reduce((a, b) => a + b, 0);
        if (total > 0) console.log("[mcp-retention] pruned", r);
      })
      .catch((err) => console.error("[mcp-retention] error:", err))
      .finally(() => setTimeout(run, INTERVAL_MS));
  };
  setTimeout(run, FIRST_RUN_DELAY_MS);
}

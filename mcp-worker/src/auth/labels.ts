// Credential labels: the human name an agent is known by in /tokens and in
// attribution (captured_via.credential, mcp_call_log.label). Unique among
// live credentials, case-insensitively.

import type postgres from 'postgres';

export const LABEL_MAX = 80;

// Collapse whitespace, drop control characters; null if empty or too long.
export function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 1 && s.length <= LABEL_MAX ? s : null;
}

// Pure part of uniqueLabel: "Claude" → "Claude (2)" → "Claude (3)" …
export function pickUniqueLabel(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, LABEL_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// Must run inside a transaction: the advisory lock serialises label
// allocation per user until commit, so two concurrent grants can't both
// pick "Claude (2)".
export async function uniqueLabel(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  userId: string,
  base: string,
): Promise<string> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`mcp_credential_label|${userId}`})), now() AS as_of`;
  const rows = await tx<Array<{ l: string }>>`
    SELECT lower(btrim(label)) AS l, now() AS as_of
      FROM mcp_credential
     WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
  return pickUniqueLabel(base, new Set(rows.map((r) => r.l)));
}

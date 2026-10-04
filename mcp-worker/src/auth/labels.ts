// Credential labels: the human name an agent is known by in /tokens and in
// attribution (captured_via.credential, mcp_call_log.label). Unique among
// live credentials, case-insensitively — as Postgres lower() sees it.

import type postgres from 'postgres';

export const LABEL_MAX = 80;
// Attribution values the server itself uses.
const RESERVED = new Set(['master', 'unknown']);

// Collapse whitespace; drop control and invisible format characters
// (zero-width, bidi overrides) so "Claude​" can't pose as "Claude".
// null if empty or too long.
export function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = cleanDisplayText(raw);
  if (RESERVED.has(s.toLowerCase())) return null;
  return s.length >= 1 && s.length <= LABEL_MAX ? s : null;
}

export function cleanDisplayText(raw: string): string {
  return raw
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Claude" → "Claude (2)" → "Claude (3)" … truncated to fit LABEL_MAX.
export function labelCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = ` (${n})`;
  return `${base.slice(0, LABEL_MAX - suffix.length).trimEnd()}${suffix}`;
}

// Pure variant (JS case folding) — tests and previews only.
export function pickUniqueLabel(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const candidate = labelCandidate(base, n);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// Must run inside a transaction: the advisory lock serialises label
// allocation per user until commit, so two concurrent grants can't both
// pick "Claude (2)". Each candidate is checked with the same lower(btrim())
// the unique index uses (JS and Postgres case folding differ, e.g. Greek
// final sigma).
// With replaceOAuth, live OAuth credentials named exactly `base` are
// revoked first ("replaced"), so a reconnect keeps its name.
export async function uniqueLabel(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  userId: string,
  base: string,
  opts: { replaceOAuth?: boolean } = {},
): Promise<string> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`mcp_credential_label|${userId}`})), now() AS as_of`;
  if (opts.replaceOAuth) {
    await tx`
      UPDATE mcp_credential SET revoked_at = now(), revoked_reason = 'replaced'
       WHERE user_id = ${userId} AND revoked_at IS NULL AND kind = 'oauth'
         AND lower(btrim(label)) = lower(btrim(${base}::text))
    `;
  }
  for (let n = 1; n <= 200; n++) {
    const candidate = labelCandidate(base, n);
    const [row] = await tx<Array<{ taken: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM mcp_credential
         WHERE user_id = ${userId} AND revoked_at IS NULL
           AND lower(btrim(label)) = lower(btrim(${candidate}::text))
      ) AS taken, now() AS as_of
    `;
    if (!row.taken) return candidate;
  }
  return labelCandidate(base, Math.floor(1000 + Math.random() * 9000));
}

// Opaque bearer tokens. Only SHA-256 hashes are stored (mcp_token). The
// recognisable prefixes make leaked tokens easy to grep for.

import { randomBase64url, sha256Hex } from './crypto';

export type TokenKind = 'access' | 'refresh' | 'pat';

const PREFIX: Record<TokenKind, string> = {
  access: 'brain_at_',
  refresh: 'brain_rt_',
  pat: 'brain_pat_',
};

const TOKEN_RE = /^brain_(at|rt|pat)_[A-Za-z0-9_-]{43}$/;
const KIND_OF: Record<string, TokenKind> = { at: 'access', rt: 'refresh', pat: 'pat' };

export const ACCESS_TTL_SECONDS = 60 * 60;
// Sliding idle expiry: each refresh issues a new refresh token valid this long.
export const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60;
export const CODE_TTL_SECONDS = 5 * 60;
// A rotated refresh token presented again within this window still gets a
// new pair: parallel requests from one client, or several processes sharing
// one token store (Claude Code, Gemini CLI), all refresh with the same
// token. Bounded per token. Later reuse is refused but revokes nothing — a
// stale copy in an idle process must not log out the live ones.
export const REFRESH_REUSE_GRACE_SECONDS = 5 * 60;
export const REFRESH_MAX_REUSES = 10;

export function newToken(kind: TokenKind): string {
  return `${PREFIX[kind]}${randomBase64url(32)}`;
}

export function tokenKind(raw: string): TokenKind | null {
  const m = TOKEN_RE.exec(raw);
  return m ? KIND_OF[m[1]] : null;
}

export function hashToken(raw: string): Promise<string> {
  return sha256Hex(raw);
}

// "Authorization: Bearer <token>" — scheme is case-insensitive (RFC 7235).
export function bearerFrom(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

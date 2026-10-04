// Helpers shared by the OAuth endpoints.

import type postgres from 'postgres';
import { CORS_HEADERS, jsonNoStore } from '../http';
import { ACCESS_TTL_SECONDS, hashToken, newToken, REFRESH_TTL_SECONDS } from '../auth/tokens';

// RFC 6749 §5.2 error body. invalid_client is the only 401.
export function oauthError(error: string, description: string, status = 400, extra: Record<string, string> = {}): Response {
  return jsonNoStore({ error, error_description: description }, status, { ...CORS_HEADERS, ...extra });
}

export function methodNotAllowed(allow: string): Response {
  return new Response('method not allowed', { status: 405, headers: { ...CORS_HEADERS, Allow: allow } });
}

const MAX_BODY_BYTES = 16 * 1024;

// Token and revocation requests are form-encoded per RFC 6749; JSON is
// accepted leniently. null = unreadable body (bad content type or JSON).
export async function readBodyParams(request: Request): Promise<URLSearchParams | null> {
  const ct = (request.headers.get('Content-Type') ?? '').toLowerCase();
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if (ct.includes('application/json')) {
    try {
      const body = JSON.parse(text) as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const out = new URLSearchParams();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (typeof v === 'string') out.set(k, v);
      }
      return out;
    } catch {
      return null;
    }
  }
  if (ct === '' || ct.includes('application/x-www-form-urlencoded')) return new URLSearchParams(text);
  return null;
}

// client_id from the body, or from HTTP Basic (public clients that send
// an empty secret). Returns a conflict marker when both are present and differ.
export function clientIdFrom(request: Request, params: URLSearchParams): string | null | 'conflict' {
  const fromBody = params.get('client_id');
  let fromBasic: string | null = null;
  const header = request.headers.get('Authorization');
  const m = header ? /^\s*basic\s+(\S+)\s*$/i.exec(header) : null;
  if (m) {
    try {
      const decoded = atob(m[1]);
      const i = decoded.indexOf(':');
      fromBasic = decodeURIComponent(i >= 0 ? decoded.slice(0, i) : decoded);
    } catch {
      fromBasic = null;
    }
  }
  if (fromBody && fromBasic && fromBody !== fromBasic) return 'conflict';
  return fromBody || fromBasic || null;
}

export type TokenPair = { accessToken: string; refreshToken: string };

// Issue a fresh access + refresh token for a credential (inside a transaction).
export async function issueTokenPair(
  tx: postgres.TransactionSql<Record<string, unknown>>,
  credentialId: string,
): Promise<TokenPair> {
  const accessToken = newToken('access');
  const refreshToken = newToken('refresh');
  const accessHash = await hashToken(accessToken);
  const refreshHash = await hashToken(refreshToken);
  await tx`
    INSERT INTO mcp_token (token_hash, credential_id, kind, expires_at) VALUES
      (${accessHash}, ${credentialId}, 'access', now() + make_interval(secs => ${ACCESS_TTL_SECONDS})),
      (${refreshHash}, ${credentialId}, 'refresh', now() + make_interval(secs => ${REFRESH_TTL_SECONDS}))
  `;
  return { accessToken, refreshToken };
}

export function tokenResponse(pair: TokenPair, scope: string | null): Response {
  return jsonNoStore(
    {
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: pair.refreshToken,
      ...(scope ? { scope } : {}),
    },
    200,
    CORS_HEADERS,
  );
}

export const LEGACY_CLIENT_ID = /^mcp-client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

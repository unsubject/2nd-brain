// Bearer authentication for /mcp.
//
// Order: the legacy master token (while ALLOW_MASTER_BEARER isn't "false"),
// then a per-client opaque token looked up by hash. Anything else is a 401
// without touching the database. Revocation is immediate: the lookup runs on
// every request and carries now() so Hyperdrive never answers it from cache.

import postgres from 'postgres';
import type { Env } from '../env';
import { baseUrl, CORS_HEADERS } from '../http';
import { constantTimeEqual } from './crypto';
import { MASTER_PRINCIPAL, type Principal } from './principal';
import { bearerFrom, hashToken, tokenKind } from './tokens';

export type AuthDb = ReturnType<typeof postgres>;

export function authDb(env: Env): AuthDb {
  return postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false });
}

// The secret that approves OAuth connections and signs in to /tokens.
export function ownerSecret(env: Env): string | null {
  return env.OWNER_SECRET?.trim() || env.BRAIN_MCP_TOKEN || null;
}

export function ownerSecretIsSeparate(env: Env): boolean {
  return !!env.OWNER_SECRET?.trim();
}

export function masterBearerAllowed(env: Env): boolean {
  return (env.ALLOW_MASTER_BEARER ?? 'true').trim().toLowerCase() !== 'false';
}

export type AuthResult =
  | { ok: true; principal: Principal; db: AuthDb | null }
  | { ok: false; response: Response };

export function protectedResourceMetadataUrl(request: Request): string {
  return `${baseUrl(request)}/.well-known/oauth-protected-resource/mcp`;
}

// Same response whatever was wrong with a presented token (never reveal why).
export function unauthorized(request: Request, tokenPresented: boolean): Response {
  const params = [
    'realm="2nd-brain"',
    ...(tokenPresented ? ['error="invalid_token"'] : []),
    'scope="mcp"',
    `resource_metadata="${protectedResourceMetadataUrl(request)}"`,
  ];
  return new Response(null, {
    status: 401,
    headers: { ...CORS_HEADERS, 'WWW-Authenticate': `Bearer ${params.join(', ')}` },
  });
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const token = bearerFrom(request);
  if (!token) return { ok: false, response: unauthorized(request, false) };

  if (masterBearerAllowed(env) && env.BRAIN_MCP_TOKEN && constantTimeEqual(token, env.BRAIN_MCP_TOKEN)) {
    return { ok: true, principal: MASTER_PRINCIPAL, db: null };
  }

  const kind = tokenKind(token);
  if (kind !== 'access' && kind !== 'pat') return { ok: false, response: unauthorized(request, true) };

  const db = authDb(env);
  try {
    const hash = await hashToken(token);
    const rows = await db<Array<{ id: string; label: string; scope: string; ckind: 'pat' | 'oauth' }>>`
      SELECT c.id, c.label, c.scope, c.kind AS ckind, now() AS as_of
        FROM mcp_token t
        JOIN mcp_credential c ON c.id = t.credential_id
       WHERE t.token_hash = ${hash}
         AND t.kind IN ('access', 'pat')
         AND c.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > now())
    `;
    if (rows.length === 0) {
      await db.end({ timeout: 5 }).catch(() => {});
      return { ok: false, response: unauthorized(request, true) };
    }
    const r = rows[0];
    return {
      ok: true,
      principal: { credentialId: r.id, label: r.label, scope: r.scope, via: r.ckind === 'pat' ? 'pat' : 'oauth' },
      db,
    };
  } catch (e) {
    await db.end({ timeout: 5 }).catch(() => {});
    console.error('[auth] credential lookup failed:', e instanceof Error ? e.message : e);
    // Not a 401: that would make clients throw away good tokens and re-auth.
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
        status: 503,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Retry-After': '5' },
      }),
    };
  }
}

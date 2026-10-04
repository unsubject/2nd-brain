// Token endpoint: authorization_code (PKCE) and rotating refresh_token.
//
// - Codes are consumed atomically; presenting a used code again revokes
//   the credential it minted (RFC 6749 §4.1.2, OAuth 2.1 §4.1.3).
// - Each refresh rotates the pair. A rotated refresh token presented again
//   within REFRESH_REUSE_GRACE_SECONDS is a client retry race and is just
//   rejected; later, it is treated as a stolen token and the whole
//   credential is revoked.

import type { Env } from '../env';
import { authDb, type AuthDb } from '../auth/middleware';
import { constantTimeEqual, isValidCodeVerifier, pkceS256 } from '../auth/crypto';
import { uniqueLabel } from '../auth/labels';
import { hashToken, REFRESH_REUSE_GRACE_SECONDS, tokenKind } from '../auth/tokens';
import { clientIdFrom, issueTokenPair, methodNotAllowed, oauthError, readBodyParams, tokenResponse } from './common';
import { isOurResource } from './metadata';

type CodeRow = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  scope: string;
  label: string;
};

export async function tokenEndpoint(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
  const params = await readBodyParams(request);
  if (!params) return oauthError('invalid_request', 'send application/x-www-form-urlencoded parameters');
  const clientId = clientIdFrom(request, params);
  if (clientId === 'conflict') return oauthError('invalid_client', 'client_id mismatch', 401);

  const grant = params.get('grant_type');
  if (grant !== 'authorization_code' && grant !== 'refresh_token') {
    return oauthError('unsupported_grant_type', `grant_type ${String(grant).slice(0, 50)} is not supported`);
  }

  const db = authDb(env);
  try {
    return grant === 'authorization_code'
      ? await exchangeCode(request, env, db, params, clientId)
      : await refresh(db, params, clientId);
  } catch (e) {
    console.error('[token] failed:', e instanceof Error ? e.message : e);
    return oauthError('temporarily_unavailable', 'try again shortly', 503, { 'Retry-After': '5' });
  } finally {
    ctx.waitUntil(sweepAndEnd(db));
  }
}

async function exchangeCode(
  request: Request,
  env: Env,
  db: AuthDb,
  params: URLSearchParams,
  clientId: string | null,
): Promise<Response> {
  const code = params.get('code');
  const verifier = params.get('code_verifier');
  if (!code || !verifier) return oauthError('invalid_request', 'code and code_verifier are required');
  if (!clientId) return oauthError('invalid_request', 'client_id is required');
  const codeHash = await hashToken(code);

  const consumed = await db<CodeRow[]>`
    UPDATE mcp_auth_code SET used_at = now()
     WHERE code_hash = ${codeHash} AND used_at IS NULL AND expires_at > now()
     RETURNING client_id, redirect_uri, code_challenge, resource, scope, label
  `;
  if (consumed.length === 0) {
    const prior = await db<Array<{ credential_id: string | null; used: boolean }>>`
      SELECT credential_id, used_at IS NOT NULL AS used, now() AS as_of
        FROM mcp_auth_code WHERE code_hash = ${codeHash}
    `;
    if (prior.length > 0 && prior[0].used && prior[0].credential_id) {
      await db`
        UPDATE mcp_credential SET revoked_at = now(), revoked_reason = 'code_reuse'
         WHERE id = ${prior[0].credential_id} AND revoked_at IS NULL
      `;
    }
    return oauthError('invalid_grant', 'authorization code is invalid, expired or already used');
  }
  const c = consumed[0];
  if (c.client_id !== clientId) return oauthError('invalid_grant', 'code was issued to another client');
  const redirectUri = params.get('redirect_uri');
  if (redirectUri !== null && redirectUri !== c.redirect_uri) {
    return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
  }
  if (!isValidCodeVerifier(verifier) || !constantTimeEqual(await pkceS256(verifier), c.code_challenge)) {
    return oauthError('invalid_grant', 'PKCE verification failed');
  }
  const resource = params.get('resource');
  if (resource !== null && resource !== '' && !isOurResource(resource, request)) {
    return oauthError('invalid_target', 'unknown resource');
  }

  const pair = await db.begin(async (tx) => {
    const label = await uniqueLabel(tx, env.BRAIN_USER_ID, c.label);
    const [cred] = await tx<Array<{ id: string }>>`
      INSERT INTO mcp_credential (user_id, label, kind, client_id, redirect_uri)
      VALUES (${env.BRAIN_USER_ID}, ${label}, 'oauth', ${c.client_id}, ${c.redirect_uri})
      RETURNING id
    `;
    await tx`UPDATE mcp_auth_code SET credential_id = ${cred.id} WHERE code_hash = ${codeHash}`;
    return issueTokenPair(tx, cred.id);
  });
  return tokenResponse(pair, c.scope);
}

type RefreshRow = {
  credential_id: string;
  client_id: string | null;
  revoked: boolean;
  rotated: boolean;
  in_grace: boolean;
  live: boolean;
};

type RefreshOutcome = { pair: Awaited<ReturnType<typeof issueTokenPair>> } | { error: string };

async function refresh(db: AuthDb, params: URLSearchParams, clientId: string | null): Promise<Response> {
  const raw = params.get('refresh_token');
  if (!raw) return oauthError('invalid_request', 'refresh_token is required');
  if (tokenKind(raw) !== 'refresh') return oauthError('invalid_grant', 'refresh token is invalid');
  const hash = await hashToken(raw);

  // Never throw out of this transaction for a grant error: a reuse
  // revocation must commit.
  const outcome = await db.begin(async (tx): Promise<RefreshOutcome> => {
    const rows = await tx<RefreshRow[]>`
      SELECT t.credential_id, c.client_id,
             c.revoked_at IS NOT NULL AS revoked,
             t.rotated_at IS NOT NULL AS rotated,
             (t.rotated_at > now() - make_interval(secs => ${REFRESH_REUSE_GRACE_SECONDS})) IS TRUE AS in_grace,
             t.expires_at > now() AS live,
             now() AS as_of
        FROM mcp_token t
        JOIN mcp_credential c ON c.id = t.credential_id
       WHERE t.token_hash = ${hash} AND t.kind = 'refresh'
       FOR UPDATE OF t, c
    `;
    if (rows.length === 0) return { error: 'refresh token is invalid' };
    const r = rows[0];
    if (r.revoked) return { error: 'refresh token has been revoked' };
    if (clientId && r.client_id && clientId !== r.client_id) return { error: 'refresh token was issued to another client' };
    if (r.rotated) {
      if (!r.in_grace) {
        await tx`
          UPDATE mcp_credential SET revoked_at = now(), revoked_reason = 'refresh_reuse'
           WHERE id = ${r.credential_id} AND revoked_at IS NULL
        `;
        return { error: 'refresh token was already used; the connection has been revoked — reconnect' };
      }
      return { error: 'refresh token was already used' };
    }
    if (!r.live) return { error: 'refresh token has expired' };
    await tx`UPDATE mcp_token SET rotated_at = now() WHERE token_hash = ${hash}`;
    return { pair: await issueTokenPair(tx, r.credential_id) };
  });

  if ('error' in outcome) return oauthError('invalid_grant', outcome.error);
  return tokenResponse(outcome.pair, null);
}

// Housekeeping after the response: expired tokens and codes go after a
// day. Rotated refresh tokens stay until they expire (reuse detection).
async function sweepAndEnd(db: AuthDb): Promise<void> {
  try {
    await db`DELETE FROM mcp_token WHERE expires_at < now() - interval '1 day'`;
    await db`DELETE FROM mcp_auth_code WHERE expires_at < now() - interval '1 day'`;
  } catch (e) {
    console.error('[token] sweep failed:', e instanceof Error ? e.message : e);
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }
}

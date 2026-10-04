// Token endpoint: authorization_code (PKCE) and rotating refresh_token.
//
// - Codes are locked, checked against client, redirect URI and PKCE, then
//   consumed. Presenting a used code again (with the right verifier)
//   revokes the credential it minted (RFC 6749 §4.1.2).
// - Each refresh rotates the pair. A rotated refresh token presented again
//   within REFRESH_REUSE_GRACE_SECONDS (up to REFRESH_MAX_REUSES times) gets
//   its own new pair; later it is refused. Nothing is revoked on reuse:
//   theft is the owner's call in /tokens, where every call is visible.

import type { Env } from '../env';
import { authDb, type AuthDb } from '../auth/middleware';
import { constantTimeEqual, isValidCodeVerifier, pkceS256 } from '../auth/crypto';
import { uniqueLabel } from '../auth/labels';
import { hashToken, REFRESH_MAX_REUSES, REFRESH_REUSE_GRACE_SECONDS, tokenKind } from '../auth/tokens';
import {
  clientIdFrom,
  issueTokenPair,
  methodNotAllowed,
  oauthError,
  readBodyParams,
  tokenResponse,
  type TokenPair,
} from './common';
import { isOurResource } from './metadata';

type CodeRow = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  scope: string;
  label: string;
  replace_label: boolean;
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
  let issued = false;
  try {
    const res =
      grant === 'authorization_code'
        ? await exchangeCode(request, env, db, params, clientId)
        : await refresh(db, params, clientId);
    issued = res.status === 200;
    return res;
  } catch (e) {
    console.error('[token] failed:', e instanceof Error ? e.message : e);
    return oauthError('temporarily_unavailable', 'try again shortly', 503, { 'Retry-After': '5' });
  } finally {
    // Housekeeping only on successful issues, so junk requests cost no writes.
    ctx.waitUntil(issued ? sweepAndEnd(db) : db.end({ timeout: 5 }).catch(() => {}));
  }
}

type Grant = { pair: TokenPair; scope: string | null } | { error: string; description: string };

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
  const resource = params.get('resource');
  if (resource !== null && resource !== '' && !isOurResource(resource, request)) {
    return oauthError('invalid_target', 'unknown resource');
  }
  const redirectUri = params.get('redirect_uri');
  const codeHash = await hashToken(code);
  const challenge = isValidCodeVerifier(verifier) ? await pkceS256(verifier) : null;

  // Lock the code, check everything it is bound to, and only then consume
  // it: someone who merely saw the code (history, logs) can neither burn it
  // nor trigger the replay revocation below.
  const out = await db.begin(async (tx): Promise<Grant> => {
    const rows = await tx<Array<CodeRow & { credential_id: string | null; used: boolean; live: boolean }>>`
      SELECT client_id, redirect_uri, code_challenge, resource, scope, label, replace_label, credential_id,
             used_at IS NOT NULL AS used, expires_at > now() AS live, now() AS as_of
        FROM mcp_auth_code WHERE code_hash = ${codeHash}
       FOR UPDATE
    `;
    const bad = (description: string): Grant => ({ error: 'invalid_grant', description });
    if (rows.length === 0) return bad('authorization code is invalid');
    const c = rows[0];
    if (c.client_id !== clientId) return bad('code was issued to another client');
    if (redirectUri !== null && redirectUri !== c.redirect_uri) return bad('redirect_uri does not match the authorization request');
    if (!challenge || !constantTimeEqual(challenge, c.code_challenge)) return bad('PKCE verification failed');
    if (c.used) {
      // RFC 6749 §4.1.2: a code used twice revokes what it issued.
      if (c.credential_id) {
        await tx`
          UPDATE mcp_credential SET revoked_at = now(), revoked_reason = 'code_reuse'
           WHERE id = ${c.credential_id} AND revoked_at IS NULL
        `;
      }
      return bad('authorization code was already used; the connection it created has been revoked');
    }
    if (!c.live) return bad('authorization code has expired');

    const label = await uniqueLabel(tx, env.BRAIN_USER_ID, c.label, { replaceOAuth: c.replace_label });
    const [cred] = await tx<Array<{ id: string }>>`
      INSERT INTO mcp_credential (user_id, label, kind, client_id, redirect_uri)
      VALUES (${env.BRAIN_USER_ID}, ${label}, 'oauth', ${c.client_id}, ${c.redirect_uri})
      RETURNING id
    `;
    await tx`UPDATE mcp_auth_code SET used_at = now(), credential_id = ${cred.id} WHERE code_hash = ${codeHash}`;
    return { pair: await issueTokenPair(tx, cred.id), scope: c.scope };
  });
  if ('error' in out) return oauthError(out.error, out.description);
  return tokenResponse(out.pair, out.scope);
}

type RefreshRow = {
  credential_id: string;
  client_id: string | null;
  revoked: boolean;
  rotated: boolean;
  in_grace: boolean;
  reuse_count: number;
  live: boolean;
};

type RefreshOutcome = { pair: TokenPair } | { error: string };

async function refresh(db: AuthDb, params: URLSearchParams, clientId: string | null): Promise<Response> {
  const raw = params.get('refresh_token');
  if (!raw) return oauthError('invalid_request', 'refresh_token is required');
  if (tokenKind(raw) !== 'refresh') return oauthError('invalid_grant', 'refresh token is invalid');
  const hash = await hashToken(raw);

  const outcome = await db.begin(async (tx): Promise<RefreshOutcome> => {
    const rows = await tx<RefreshRow[]>`
      SELECT t.credential_id, c.client_id,
             c.revoked_at IS NOT NULL AS revoked,
             t.rotated_at IS NOT NULL AS rotated,
             (t.rotated_at > now() - make_interval(secs => ${REFRESH_REUSE_GRACE_SECONDS})) IS TRUE AS in_grace,
             t.reuse_count,
             t.expires_at > now() AS live,
             now() AS as_of
        FROM mcp_token t
        JOIN mcp_credential c ON c.id = t.credential_id
       WHERE t.token_hash = ${hash} AND t.kind = 'refresh'
       FOR UPDATE OF t
    `;
    if (rows.length === 0) return { error: 'refresh token is invalid' };
    const r = rows[0];
    if (r.revoked) return { error: 'refresh token has been revoked' };
    if (clientId && r.client_id && clientId !== r.client_id) return { error: 'refresh token was issued to another client' };
    if (!r.live) return { error: 'refresh token has expired' };
    if (r.rotated) {
      if (!r.in_grace || r.reuse_count >= REFRESH_MAX_REUSES) return { error: 'refresh token was already used' };
      // A sibling pair; the window stays anchored to the first rotation.
      await tx`UPDATE mcp_token SET reuse_count = reuse_count + 1 WHERE token_hash = ${hash}`;
    } else {
      await tx`UPDATE mcp_token SET rotated_at = now() WHERE token_hash = ${hash}`;
    }
    return { pair: await issueTokenPair(tx, r.credential_id) };
  });

  if ('error' in outcome) return oauthError('invalid_grant', outcome.error);
  return tokenResponse(outcome.pair, null);
}

// Housekeeping after a successful issue: expired tokens and codes go after
// a day, as do refresh tokens rotated more than a day ago (past any grace).
async function sweepAndEnd(db: AuthDb): Promise<void> {
  try {
    await db`DELETE FROM mcp_token WHERE expires_at < now() - interval '1 day'`;
    await db`DELETE FROM mcp_token WHERE rotated_at < now() - interval '1 day'`;
    await db`DELETE FROM mcp_auth_code WHERE expires_at < now() - interval '1 day'`;
  } catch (e) {
    console.error('[token] sweep failed:', e instanceof Error ? e.message : e);
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }
}

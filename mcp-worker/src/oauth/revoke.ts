// RFC 7009 token revocation. Presenting any of our tokens (access,
// refresh or PAT) revokes the whole credential behind it — the holder can
// only disconnect itself. Unknown tokens get the same 200 (§2.2).

import type { Env } from '../env';
import { authDb } from '../auth/middleware';
import { hashToken, tokenKind } from '../auth/tokens';
import { CORS_HEADERS, jsonNoStore } from '../http';
import { methodNotAllowed, oauthError, readBodyParams } from './common';

export async function revokeEndpoint(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
  const params = await readBodyParams(request);
  if (!params) return oauthError('invalid_request', 'send application/x-www-form-urlencoded parameters');
  const token = params.get('token');
  if (!token) return oauthError('invalid_request', 'token is required');

  if (tokenKind(token)) {
    const db = authDb(env);
    try {
      const hash = await hashToken(token);
      await db`
        UPDATE mcp_credential SET revoked_at = now(), revoked_reason = 'client'
         WHERE revoked_at IS NULL
           AND id = (SELECT credential_id FROM mcp_token WHERE token_hash = ${hash})
      `;
    } catch (e) {
      console.error('[revoke] failed:', e instanceof Error ? e.message : e);
      return oauthError('temporarily_unavailable', 'try again shortly', 503, { 'Retry-After': '5' });
    } finally {
      ctx.waitUntil(db.end({ timeout: 5 }).catch(() => {}));
    }
  }
  return jsonNoStore({}, 200, CORS_HEADERS);
}

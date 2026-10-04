// RFC 7591 dynamic client registration. Public clients only (PKCE, no
// secret). Every redirect URI must pass the allow-list in
// auth/redirects.ts; registrations that never get authorized are capped
// per hour and swept after a week.

import type { Env } from '../env';
import { authDb } from '../auth/middleware';
import { classifyRedirect, parseExtraPrefixes, type ClientFamily } from '../auth/redirects';
import { CORS_HEADERS, jsonNoStore } from '../http';
import { methodNotAllowed, oauthError } from './common';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_UNAUTHORIZED_PER_HOUR = 50;

export async function registerClient(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return oauthError('invalid_client_metadata', 'registration body too large');
  let body: Record<string, unknown>;
  try {
    const parsed = text.trim() === '' ? {} : (JSON.parse(text) as unknown);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return oauthError('invalid_client_metadata', 'body must be a JSON object');
  }

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every((u) => typeof u === 'string')) {
    return oauthError('invalid_redirect_uri', `redirect_uris must be 1-${MAX_REDIRECT_URIS} strings`);
  }
  const extra = parseExtraPrefixes(env.OAUTH_EXTRA_REDIRECT_PREFIXES);
  const families: ClientFamily[] = [];
  for (const uri of uris as string[]) {
    const family = classifyRedirect(uri, extra);
    if (!family) {
      return oauthError(
        'invalid_redirect_uri',
        `redirect_uri not allowed by this server: ${uri.slice(0, 300)}. See docs/mcp-client-setup.md (OAUTH_EXTRA_REDIRECT_PREFIXES).`,
      );
    }
    families.push(family);
  }

  let clientName: string | null = null;
  if (typeof body.client_name === 'string') {
    clientName = body.client_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || null;
  }

  const db = authDb(env);
  try {
    const [recent] = await db<Array<{ n: number }>>`
      SELECT count(*)::int AS n, now() AS as_of
        FROM mcp_client
       WHERE last_authorized_at IS NULL AND created_at > now() - interval '1 hour'
    `;
    if (recent.n >= MAX_UNAUTHORIZED_PER_HOUR) {
      await db.end({ timeout: 5 }).catch(() => {});
      return oauthError('temporarily_unavailable', 'too many registrations; try again later', 429, { 'Retry-After': '600' });
    }

    const clientId = `mcp-client-${crypto.randomUUID()}`;
    const [row] = await db<Array<{ issued: number }>>`
      INSERT INTO mcp_client (client_id, client_name, redirect_uris, client_family, registration)
      VALUES (${clientId}, ${clientName}, ${db.json(uris as string[])}, ${families[0]}, ${db.json(body as never)})
      RETURNING extract(epoch FROM created_at)::bigint AS issued
    `;

    ctx.waitUntil(
      (async () => {
        try {
          await db`
            DELETE FROM mcp_client
             WHERE last_authorized_at IS NULL AND created_at < now() - interval '7 days'
          `;
        } catch (e) {
          console.error('[register] sweep failed:', e instanceof Error ? e.message : e);
        } finally {
          await db.end({ timeout: 5 }).catch(() => {});
        }
      })(),
    );

    return jsonNoStore(
      {
        client_id: clientId,
        client_id_issued_at: Number(row.issued),
        ...(clientName ? { client_name: clientName } : {}),
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp offline_access',
      },
      201,
      CORS_HEADERS,
    );
  } catch (e) {
    await db.end({ timeout: 5 }).catch(() => {});
    console.error('[register] failed:', e instanceof Error ? e.message : e);
    return oauthError('temporarily_unavailable', 'registration failed; try again', 503, { 'Retry-After': '5' });
  }
}

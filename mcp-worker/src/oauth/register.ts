// RFC 7591 dynamic client registration. Public clients only (PKCE, no
// secret). Every redirect URI must pass the allow-list in
// auth/redirects.ts. Registrations that never get authorized are capped
// per source IP and globally per hour, and swept after a week.

import type { Env } from '../env';
import { authDb } from '../auth/middleware';
import { sha256Hex } from '../auth/crypto';
import { cleanDisplayText } from '../auth/labels';
import { classifyRedirect, parseExtraPrefixes, type ClientFamily } from '../auth/redirects';
import { CORS_HEADERS, jsonNoStore, readLimitedText } from '../http';
import { methodNotAllowed, oauthError } from './common';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
// Unapproved registrations in the last hour. The per-source cap keeps one
// noisy caller from locking everyone else out; the global cap bounds writes.
const MAX_UNAUTHORIZED_PER_SOURCE_HOUR = 10;
const MAX_UNAUTHORIZED_PER_HOUR = 200;

export async function registerClient(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');

  const text = await readLimitedText(request, MAX_BODY_BYTES);
  if (text === null) return oauthError('invalid_client_metadata', 'registration body too large');
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
  // Clients often register several callbacks (Cursor: app + cloud agents).
  // Keep the allowed ones (RFC 7591 §3.2.1 lets the server trim metadata);
  // /authorize refuses the rest. Fail only if none is allowed.
  const extra = parseExtraPrefixes(env.OAUTH_EXTRA_REDIRECT_PREFIXES);
  const allowed: string[] = [];
  const families: ClientFamily[] = [];
  for (const uri of uris as string[]) {
    const family = classifyRedirect(uri, extra);
    if (family) {
      allowed.push(uri);
      families.push(family);
    }
  }
  if (allowed.length === 0) {
    // Redirect URIs aren't secrets; logging them is how an unknown client's
    // callback gets found (Workers Logs) and added to the allow-list.
    console.warn(
      '[register] refused: no allowed redirect_uri',
      JSON.stringify({ redirect_uris: (uris as string[]).map((u) => u.slice(0, 300)), client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : null }),
    );
    return oauthError(
      'invalid_redirect_uri',
      `no redirect_uri is allowed by this server (first: ${String(uris[0]).slice(0, 300)}). See docs/mcp-client-setup.md (OAUTH_EXTRA_REDIRECT_PREFIXES).`,
    );
  }

  let clientName: string | null = null;
  if (typeof body.client_name === 'string') {
    clientName = cleanDisplayText(body.client_name).slice(0, 200) || null;
  }
  const source = (await sha256Hex(`register-source|${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`)).slice(0, 32);

  const db = authDb(env);
  try {
    const clientId = `mcp-client-${crypto.randomUUID()}`;
    // Count and insert under one lock so concurrent bursts can't exceed the caps.
    const outcome = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('mcp_client_register')), now() AS as_of`;
      const [recent] = await tx<Array<{ total: number; mine: number }>>`
        SELECT count(*)::int AS total,
               (count(*) FILTER (WHERE registered_from = ${source}))::int AS mine,
               now() AS as_of
          FROM mcp_client
         WHERE last_authorized_at IS NULL AND created_at > now() - interval '1 hour'
      `;
      if (recent.mine >= MAX_UNAUTHORIZED_PER_SOURCE_HOUR || recent.total >= MAX_UNAUTHORIZED_PER_HOUR) {
        return { limited: true as const };
      }
      const [row] = await tx<Array<{ issued: number }>>`
        INSERT INTO mcp_client (client_id, client_name, redirect_uris, client_family, registration, registered_from)
        VALUES (${clientId}, ${clientName}, ${tx.json(allowed)}, ${families[0]}, ${tx.json(body as never)}, ${source})
        RETURNING extract(epoch FROM created_at)::bigint AS issued
      `;
      return { limited: false as const, issued: Number(row.issued) };
    });
    if (outcome.limited) {
      ctx.waitUntil(db.end({ timeout: 5 }).catch(() => {}));
      return oauthError('temporarily_unavailable', 'too many registrations; try again later', 429, { 'Retry-After': '600' });
    }

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
        client_id_issued_at: outcome.issued,
        ...(clientName ? { client_name: clientName } : {}),
        redirect_uris: allowed,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp offline_access',
      },
      201,
      CORS_HEADERS,
    );
  } catch (e) {
    ctx.waitUntil(db.end({ timeout: 5 }).catch(() => {}));
    console.error('[register] failed:', e instanceof Error ? e.message : e);
    return oauthError('temporarily_unavailable', 'registration failed; try again', 503, { 'Retry-After': '5' });
  }
}

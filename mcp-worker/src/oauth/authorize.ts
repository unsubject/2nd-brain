// Authorization endpoint: owner consent, then a single-use code.
//
// Errors about the client or its redirect URI are shown as a page and
// never redirected (RFC 6749 §4.1.2.1) — we can't trust where we'd be
// sending the user. Anything after that goes back to the client with
// `state` and `iss` (RFC 9207).

import type { Env } from '../env';
import { authDb, type AuthDb } from '../auth/middleware';
import { constantTimeEqual, randomBase64url } from '../auth/crypto';
import { normalizeLabel, pickUniqueLabel } from '../auth/labels';
import {
  classifyRedirect,
  FAMILY_NAMES,
  parseExtraPrefixes,
  redirectDisplayHost,
  redirectMatchesRegistered,
  type ClientFamily,
} from '../auth/redirects';
import { CODE_TTL_SECONDS, hashToken } from '../auth/tokens';
import { baseUrl, redirect } from '../http';
import { LEGACY_CLIENT_ID, methodNotAllowed } from './common';
import { isOurResource, normalizeScope } from './metadata';
import { consentPage, oauthErrorPage, type AuthorizeParams } from './pages';

type ClientRow = { client_id: string; client_name: string | null; redirect_uris: string[]; legacy: boolean };

const DEFAULT_LABEL: Record<ClientFamily, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  google: 'Gemini Spark',
  loopback: 'Local app',
  custom: 'Custom client',
};

function readParams(source: URLSearchParams | FormData): AuthorizeParams {
  const get = (k: string) => {
    const v = source.get(k);
    return typeof v === 'string' ? v : '';
  };
  return {
    response_type: get('response_type'),
    client_id: get('client_id'),
    redirect_uri: get('redirect_uri'),
    state: get('state'),
    code_challenge: get('code_challenge'),
    code_challenge_method: get('code_challenge_method'),
    scope: get('scope'),
    resource: get('resource'),
  };
}

async function loadClient(db: AuthDb, p: AuthorizeParams, family: ClientFamily | null): Promise<ClientRow | null> {
  const rows = await db<Array<{ client_id: string; client_name: string | null; redirect_uris: unknown }>>`
    SELECT client_id, client_name, redirect_uris, now() AS as_of
      FROM mcp_client WHERE client_id = ${p.client_id}
  `;
  if (rows.length > 0) {
    const r = rows[0];
    const uris = typeof r.redirect_uris === 'string' ? JSON.parse(r.redirect_uris) : r.redirect_uris;
    return { client_id: r.client_id, client_name: r.client_name, redirect_uris: Array.isArray(uris) ? uris : [], legacy: false };
  }
  // Clients registered before registrations were stored (stateless ids).
  // Adopted on approval, bound to the redirect URI they present now —
  // which must still pass the allow-list.
  if (LEGACY_CLIENT_ID.test(p.client_id) && family) {
    return { client_id: p.client_id, client_name: null, redirect_uris: [p.redirect_uri], legacy: true };
  }
  return null;
}

function errorRedirect(request: Request, p: AuthorizeParams, error: string, description: string): Response {
  const url = new URL(p.redirect_uri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (p.state) url.searchParams.set('state', p.state);
  url.searchParams.set('iss', baseUrl(request));
  return redirect(url.toString());
}

type Checked =
  | { ok: true; client: ClientRow; family: ClientFamily; scope: string; resource: string | null }
  | { ok: false; response: Response };

async function check(request: Request, env: Env, db: AuthDb, p: AuthorizeParams, resources: string[]): Promise<Checked> {
  if (!p.client_id || !p.redirect_uri) {
    return { ok: false, response: oauthErrorPage('Invalid request', 'client_id and redirect_uri are required.') };
  }
  const family = classifyRedirect(p.redirect_uri, parseExtraPrefixes(env.OAUTH_EXTRA_REDIRECT_PREFIXES));
  const client = await loadClient(db, p, family);
  if (!client) {
    return {
      ok: false,
      response: oauthErrorPage(
        'Unknown client',
        'This client is not registered with 2nd-brain. Remove the connector in your AI app and add it again.',
      ),
    };
  }
  if (!family || !redirectMatchesRegistered(p.redirect_uri, client.redirect_uris)) {
    return {
      ok: false,
      response: oauthErrorPage(
        'Redirect not allowed',
        `The redirect address ${p.redirect_uri.slice(0, 300)} is not registered for this client or not on the allow-list.`,
      ),
    };
  }

  if (p.response_type !== 'code') {
    return { ok: false, response: errorRedirect(request, p, 'unsupported_response_type', 'only response_type=code is supported') };
  }
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) {
    return { ok: false, response: errorRedirect(request, p, 'invalid_request', 'PKCE with code_challenge_method=S256 is required') };
  }
  const distinct = [...new Set(resources.filter((r) => r !== ''))];
  if (distinct.length > 1 || (distinct.length === 1 && !isOurResource(distinct[0], request))) {
    return { ok: false, response: errorRedirect(request, p, 'invalid_target', 'unknown resource') };
  }
  return { ok: true, client, family, scope: normalizeScope(p.scope), resource: distinct[0] ?? null };
}

async function takenLabels(db: AuthDb, userId: string): Promise<Set<string>> {
  const rows = await db<Array<{ l: string }>>`
    SELECT lower(btrim(label)) AS l, now() AS as_of
      FROM mcp_credential WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
  return new Set(rows.map((r) => r.l));
}

function renderConsent(
  c: Extract<Checked, { ok: true }>,
  p: AuthorizeParams,
  label: string,
  extra: { error?: string; status?: number } = {},
): Response {
  return consentPage({
    params: { ...p, scope: c.scope, resource: c.resource ?? '' },
    familyName: FAMILY_NAMES[c.family],
    redirectHost: redirectDisplayHost(p.redirect_uri),
    clientName: c.client.client_name,
    label,
    ...extra,
  });
}

export async function authorize(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return methodNotAllowed('GET, POST');

  let p: AuthorizeParams;
  let resources: string[];
  let form: FormData | null = null;
  if (request.method === 'GET') {
    const q = new URL(request.url).searchParams;
    p = readParams(q);
    resources = q.getAll('resource');
  } else {
    try {
      form = await request.formData();
    } catch {
      return oauthErrorPage('Invalid request', 'Expected a form submission.');
    }
    p = readParams(form);
    resources = form.getAll('resource').filter((v): v is string => typeof v === 'string');
  }

  const db = authDb(env);
  const end = () => ctx.waitUntil(db.end({ timeout: 5 }).catch(() => {}));
  try {
    const c = await check(request, env, db, p, resources);
    if (!c.ok) return c.response;

    if (!form) {
      const base = c.family === 'loopback' || c.family === 'custom'
        ? normalizeLabel(c.client.client_name) ?? DEFAULT_LABEL[c.family]
        : DEFAULT_LABEL[c.family];
      return renderConsent(c, p, pickUniqueLabel(base, await takenLabels(db, env.BRAIN_USER_ID)));
    }

    if (form.get('decision') !== 'approve') {
      return errorRedirect(request, p, 'access_denied', 'the owner denied the request');
    }
    const rawLabel = form.get('label');
    const secret = form.get('owner_secret');
    if (typeof secret !== 'string' || !env.BRAIN_MCP_TOKEN || !constantTimeEqual(secret, env.BRAIN_MCP_TOKEN)) {
      return renderConsent(c, p, typeof rawLabel === 'string' ? rawLabel.slice(0, 80) : '', {
        error: 'Wrong owner secret. Try again.',
        status: 401,
      });
    }
    const label = normalizeLabel(rawLabel);
    if (!label) {
      return renderConsent(c, p, '', { error: 'Give this connection a name (1–80 characters).', status: 400 });
    }

    const code = randomBase64url(32);
    const codeHash = await hashToken(code);
    await db.begin(async (tx) => {
      if (c.client.legacy) {
        await tx`
          INSERT INTO mcp_client (client_id, redirect_uris, client_family, registration)
          VALUES (${c.client.client_id}, ${tx.json([p.redirect_uri])}, ${c.family}, ${tx.json({ adopted_legacy_client: true })})
          ON CONFLICT (client_id) DO NOTHING
        `;
      }
      await tx`
        INSERT INTO mcp_auth_code (code_hash, client_id, redirect_uri, code_challenge, resource, scope, label, expires_at)
        VALUES (
          ${codeHash}, ${c.client.client_id}, ${p.redirect_uri}, ${p.code_challenge},
          ${c.resource}, ${c.scope}, ${label}, now() + make_interval(secs => ${CODE_TTL_SECONDS})
        )
      `;
      await tx`UPDATE mcp_client SET last_authorized_at = now() WHERE client_id = ${c.client.client_id}`;
    });

    const url = new URL(p.redirect_uri);
    url.searchParams.set('code', code);
    if (p.state) url.searchParams.set('state', p.state);
    url.searchParams.set('iss', baseUrl(request));
    return redirect(url.toString());
  } catch (e) {
    console.error('[authorize] failed:', e instanceof Error ? e.message : e);
    return oauthErrorPage('Temporarily unavailable', 'The 2nd-brain database could not be reached. Try again shortly.', 503);
  } finally {
    end();
  }
}

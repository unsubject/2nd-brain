// Owner console at /tokens: see every connected agent, when it last
// called, what it did; mint personal access tokens (PATs) for clients
// that take a static bearer (scripts, config-file clients); revoke anything.
//
// Login is the owner secret (OWNER_SECRET, else BRAIN_MCP_TOKEN) → a signed, HttpOnly,
// SameSite=Strict __Host- cookie (30 min). Every POST also needs a
// same-origin Origin/Sec-Fetch-Site and, once logged in, a CSRF token.

import type { Env } from './env';
import { authDb, ownerSecret, ownerSecretIsSeparate, type AuthDb } from './auth/middleware';
import { constantTimeEqual } from './auth/crypto';
import { normalizeLabel, uniqueLabel } from './auth/labels';
import {
  clearSessionCookieHeader,
  createSession,
  csrfToken,
  readCookie,
  SESSION_COOKIE,
  sessionCookieHeader,
  verifyCsrf,
  verifySession,
} from './auth/session';
import { hashToken, newToken } from './auth/tokens';
import { classifyRedirect, FAMILY_NAMES, parseExtraPrefixes } from './auth/redirects';
import { baseUrl, escapeHtml as e, htmlPage, PAGE_STYLE, readForm, redirect } from './http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function page(title: string, body: string, status = 200, extra: Record<string, string> = {}): Response {
  return htmlPage(
    `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>2nd-brain — ${e(title)}</title><style>${PAGE_STYLE}</style></head><body>
${body}
</body></html>`,
    status,
    { formActionSelf: true },
    extra,
  );
}

// Same-origin POSTs only. Browsers send Origin on every POST; non-browser
// callers with neither header are let through to the CSRF/session checks.
// `Origin: null` is what a sandboxed or opaque context sends, but also what
// a browser sends from our own page under a no-referrer policy (or a cached
// copy of one), so it passes only when Sec-Fetch-Site vouches for it.
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if (origin === 'null') return site === 'same-origin';
  if (origin !== null) return origin === baseUrl(request);
  return site === null || site === 'same-origin' || site === 'none';
}

function ago(d: Date | string | null): string {
  if (!d) return 'never';
  const t = typeof d === 'string' ? new Date(d) : d;
  const s = Math.max(0, Math.round((Date.now() - t.getTime()) / 1000));
  if (s < 90) return 'just now';
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function when(d: Date | string | null): string {
  if (!d) return '<span class="muted">never</span>';
  const iso = (typeof d === 'string' ? new Date(d) : d).toISOString();
  return `<span title="${e(iso)}">${e(ago(d))}</span>`;
}

function loginPage(error?: string, status = 200): Response {
  return page(
    'Owner console',
    `<h1>2nd-brain — connected agents</h1>
<p>Sign in with the owner secret.</p>
${error ? `<div class="error">${e(error)}</div>` : ''}
<form method="post" action="/tokens/login">
  <label for="owner_secret">Owner secret</label>
  <input id="owner_secret" type="password" name="owner_secret" autofocus required autocomplete="off">
  <button type="submit">Sign in</button>
</form>`,
    status,
  );
}

type Session = { sid: string; csrf: string };

async function session(request: Request, secret: string): Promise<Session | null> {
  const sid = await verifySession(secret, readCookie(request, SESSION_COOKIE), nowSeconds());
  return sid ? { sid, csrf: await csrfToken(secret, sid) } : null;
}

export async function handleConsole(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = ownerSecret(env);
  if (!secret) {
    return page('Not configured', '<div class="error">No owner secret is set on this Worker (OWNER_SECRET).</div>', 500);
  }
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/tokens';
  const method = request.method;

  if (method === 'POST' && !sameOrigin(request)) {
    return page('Forbidden', '<div class="error">Cross-site request refused.</div>', 403);
  }

  if (path === '/tokens/login' && method === 'POST') {
    const given = (await readForm(request))?.get('owner_secret') ?? null;
    if (given === null || !constantTimeEqual(given, secret)) {
      return loginPage('Wrong owner secret.', 401);
    }
    const value = await createSession(secret, nowSeconds());
    return redirect('/tokens', 303, { 'Set-Cookie': sessionCookieHeader(value) });
  }
  if (path === '/tokens/logout' && method === 'POST') {
    return redirect('/tokens', 303, { 'Set-Cookie': clearSessionCookieHeader() });
  }

  const s = await session(request, secret);
  if (!s) {
    if (method === 'GET' && path === '/tokens') return loginPage();
    if (method === 'GET') return redirect('/tokens', 303);
    return loginPage('Your session expired. Sign in again.', 401);
  }

  const db = authDb(env);
  try {
    if (method === 'GET' && path === '/tokens') return await dashboard(request, env, db, s);
    if (method === 'GET' && path === '/tokens/activity') return await activity(request, db, s);

    if (method === 'POST' && (path === '/tokens/create' || path === '/tokens/revoke')) {
      const form = await readForm(request);
      if (!form) return page('Bad request', '<div class="error">Expected a form submission.</div>', 400);
      if (!(await verifyCsrf(secret, s.sid, form.get('csrf')))) {
        return page('Forbidden', '<div class="error">Invalid form token. Reload /tokens and try again.</div>', 403);
      }
      if (path === '/tokens/create') return await createPat(request, env, db, s, form);
      const id = form.get('id');
      if (id === null || !UUID.test(id)) {
        return page('Bad request', '<div class="error">Unknown credential.</div>', 400);
      }
      await db`
        UPDATE mcp_credential SET revoked_at = now(), revoked_reason = 'owner'
         WHERE id = ${id} AND user_id = ${env.BRAIN_USER_ID} AND revoked_at IS NULL
      `;
      return redirect('/tokens', 303);
    }
    return page('Not found', '<div class="error">Not found.</div>', 404);
  } catch (err) {
    console.error('[console] failed:', err instanceof Error ? err.message : err);
    return page('Unavailable', '<div class="error">The database could not be reached. Try again shortly.</div>', 503);
  } finally {
    ctx.waitUntil(db.end({ timeout: 5 }).catch(() => {}));
  }
}

type CredRow = {
  id: string;
  label: string;
  kind: 'pat' | 'oauth';
  token_hint: string | null;
  last_client_info: unknown;
  created_at: Date;
  last_used_at: Date | null;
  redirect_uri: string | null;
  client_name: string | null;
  calls_7d: number;
};

function clientInfoText(info: unknown): string {
  const parsed = typeof info === 'string' ? safeJson(info) : info;
  const ci = (parsed as { clientInfo?: { name?: unknown; version?: unknown } } | null)?.clientInfo;
  if (!ci || typeof ci.name !== 'string') return '';
  return `${ci.name}${typeof ci.version === 'string' ? ` ${ci.version}` : ''}`;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function header(s: Session, title: string): string {
  return `<h1>${e(title)}</h1>
<p class="muted"><a href="/tokens">Agents</a> · <a href="/tokens/activity">Activity</a> ·
<form class="inline" method="post" action="/tokens/logout"><input type="hidden" name="csrf" value="${e(s.csrf)}"><button class="secondary" style="margin:0;padding:2px 8px">Sign out</button></form></p>`;
}

async function dashboard(request: Request, env: Env, db: AuthDb, s: Session, notice = ''): Promise<Response> {
  const active = await db<CredRow[]>`
    SELECT c.id, c.label, c.kind, c.token_hint, c.last_client_info, c.created_at, c.last_used_at,
           c.redirect_uri, cl.client_name,
           (SELECT count(*)::int FROM mcp_call_log l
             WHERE l.credential_id = c.id AND l.at > now() - interval '7 days') AS calls_7d,
           now() AS as_of
      FROM mcp_credential c
      LEFT JOIN mcp_client cl ON cl.client_id = c.client_id
     WHERE c.user_id = ${env.BRAIN_USER_ID} AND c.revoked_at IS NULL
     ORDER BY c.last_used_at DESC NULLS LAST, c.created_at DESC
  `;
  const revoked = await db<Array<{ label: string; kind: string; revoked_at: Date; revoked_reason: string }>>`
    SELECT label, kind, revoked_at, revoked_reason, now() AS as_of
      FROM mcp_credential
     WHERE user_id = ${env.BRAIN_USER_ID} AND revoked_at IS NOT NULL
     ORDER BY revoked_at DESC LIMIT 20
  `;
  const [master] = await db<Array<{ n: number; last_at: Date | null }>>`
    SELECT count(*)::int AS n, max(at) AS last_at, now() AS as_of
      FROM mcp_call_log WHERE credential_id IS NULL AND label = 'master' AND at > now() - interval '7 days'
  `;

  const mcpUrl = `${baseUrl(request)}/mcp`;
  const extra = parseExtraPrefixes(env.OAUTH_EXTRA_REDIRECT_PREFIXES);
  const rows = active
    .map((c) => {
      // The family of the redirect URI this grant was actually issued to.
      const fam = c.redirect_uri ? classifyRedirect(c.redirect_uri, extra) : null;
      const family = fam ? FAMILY_NAMES[fam] : '';
      const via = c.kind === 'pat' ? `PAT …${e(c.token_hint ?? '')}` : `OAuth${family ? ` · ${e(family)}` : ''}`;
      const ci = clientInfoText(c.last_client_info);
      return `<tr>
  <td><strong>${e(c.label)}</strong><br><span class="muted">${via}${c.client_name ? ` · “${e(c.client_name)}”` : ''}</span></td>
  <td>${when(c.last_used_at)}<br><span class="muted">${c.calls_7d} calls / 7 days</span></td>
  <td>${ci ? e(ci) : '<span class="muted">—</span>'}</td>
  <td>${when(c.created_at)}</td>
  <td><a href="/tokens/activity?credential=${e(c.id)}">activity</a><br>
    <form class="inline" method="post" action="/tokens/revoke">
      <input type="hidden" name="csrf" value="${e(s.csrf)}"><input type="hidden" name="id" value="${e(c.id)}">
      <button class="danger" type="submit">Revoke</button>
    </form></td>
</tr>`;
    })
    .join('\n');

  const ownerBanner = ownerSecretIsSeparate(env)
    ? ''
    : `<div class="warn">The owner secret is still <code>BRAIN_MCP_TOKEN</code>, which OAuth clients connected before this console existed received as their access token.
Set a separate <code>OWNER_SECRET</code> Worker secret (<code>openssl rand -hex 32</code>), then review this list and revoke anything you don't recognise.</div>`;
  const masterBanner =
    master.n > 0
      ? `<div class="warn">The master token (<code>BRAIN_MCP_TOKEN</code>) made ${master.n} call(s) in the last 7 days,
last ${when(master.last_at)}. Move those clients to their own token, then set <code>ALLOW_MASTER_BEARER</code> to "false".
<a href="/tokens/activity?credential=master">See calls</a></div>`
      : '';

  const body = `${header(s, '2nd-brain — connected agents')}
${notice}
${ownerBanner}
${masterBanner}
<p>MCP endpoint: <code>${e(mcpUrl)}</code></p>
<h2>Active (${active.length})</h2>
${
  active.length
    ? `<table><thead><tr><th>Agent</th><th>Last used</th><th>Client</th><th>Connected</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">No agents connected yet.</p>'
}
<h2>New personal access token</h2>
<p class="muted">For clients that take a static bearer token (scripts, Cursor/Gemini CLI without OAuth, or Meta Muse if it asks for a header instead of signing in). OAuth clients (Claude, ChatGPT, Gemini Spark, Meta Muse) connect themselves and show up above.</p>
<form method="post" action="/tokens/create">
  <input type="hidden" name="csrf" value="${e(s.csrf)}">
  <label for="label">Name (shown here and recorded on everything it writes)</label>
  <input id="label" type="text" name="label" maxlength="80" required placeholder="e.g. Cursor (laptop)">
  <button type="submit">Create token</button>
</form>
${
  revoked.length
    ? `<h2>Recently revoked</h2><table><tbody>${revoked
        .map((r) => `<tr><td>${e(r.label)}</td><td>${e(r.kind)}</td><td>${e(r.revoked_reason)}</td><td>${when(r.revoked_at)}</td></tr>`)
        .join('')}</tbody></table>`
    : ''
}`;
  return page('Connected agents', body);
}

async function createPat(request: Request, env: Env, db: AuthDb, s: Session, form: URLSearchParams): Promise<Response> {
  const base = normalizeLabel(form.get('label'));
  if (!base) {
    return dashboard(request, env, db, s, '<div class="error">Give the token a name (1–80 characters; "master" and "unknown" are reserved).</div>');
  }
  const token = newToken('pat');
  const hash = await hashToken(token);
  const label = await db.begin(async (tx) => {
    const unique = await uniqueLabel(tx, env.BRAIN_USER_ID, base);
    const [cred] = await tx<Array<{ id: string }>>`
      INSERT INTO mcp_credential (user_id, label, kind, token_hint)
      VALUES (${env.BRAIN_USER_ID}, ${unique}, 'pat', ${token.slice(-4)})
      RETURNING id
    `;
    await tx`INSERT INTO mcp_token (token_hash, credential_id, kind) VALUES (${hash}, ${cred.id}, 'pat')`;
    return unique;
  });

  const url = `${baseUrl(request)}/mcp`;
  const bearer = `Bearer ${token}`;
  const json = (o: unknown) => e(JSON.stringify(o, null, 2));
  const body = `${header(s, 'Token created')}
<div class="ok">Created <strong>${e(label)}</strong>. Copy the token now — it is shown only once and stored only as a hash.</div>
<pre>${e(token)}</pre>
<h2>Meta Muse (only if it asks for a header instead of signing in)</h2>
<p>Store the token in Muse's Secure Credentials Store (never paste it into the chat), then ask Muse to create a custom connector:
MCP server URL <code>${e(url)}</code>, header <code>Authorization: Bearer &lt;the stored credential&gt;</code>. Full prompt: docs/mcp-client-setup.md.</p>
<h2>Claude Code</h2>
<pre>claude mcp add --transport http 2nd-brain ${e(url)} --header "Authorization: ${e(bearer)}"</pre>
<h2>Cursor (~/.cursor/mcp.json)</h2>
<pre>${json({ mcpServers: { '2nd-brain': { url, headers: { Authorization: bearer } } } })}</pre>
<h2>Gemini CLI (~/.gemini/settings.json)</h2>
<pre>${json({ mcpServers: { '2nd-brain': { httpUrl: url, headers: { Authorization: bearer } } } })}</pre>
<h2>Smoke test</h2>
<pre>cd mcp-worker &amp;&amp; BRAIN_MCP_URL=${e(url)} BRAIN_TOKEN=${e(token)} npm run smoke</pre>
<p><a href="/tokens">Back to agents</a></p>`;
  return page('Token created', body);
}

type LogRow = {
  at: Date;
  label: string;
  method: string;
  tool: string | null;
  is_write: boolean;
  ok: boolean;
  error_code: string | null;
  duration_ms: number | null;
  result_ids: unknown;
};

async function activity(request: Request, db: AuthDb, s: Session): Promise<Response> {
  const which = new URL(request.url).searchParams.get('credential');
  const filter =
    which === 'master'
      ? db`credential_id IS NULL AND label = 'master'`
      : which && UUID.test(which)
        ? db`credential_id = ${which}`
        : db`true`;
  const rows = await db<LogRow[]>`
    SELECT at, label, method, tool, is_write, ok, error_code, duration_ms, result_ids, now() AS as_of
      FROM mcp_call_log WHERE ${filter}
     ORDER BY at DESC LIMIT 200
  `;
  const ids = (v: unknown): string[] => {
    const parsed = typeof v === 'string' ? safeJson(v) : v;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  };
  const body = `${header(s, 'Activity')}
<p class="muted">Latest 200 calls${which ? ' for this agent' : ''}. Arguments are never logged.</p>
<table><thead><tr><th>When</th><th>Agent</th><th>Tool</th><th>Result</th><th>ms</th><th>Ids</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr><td>${when(r.at)}</td><td>${e(r.label)}</td>
<td>${e(r.tool ?? r.method)}${r.is_write ? ' <span class="muted">(write)</span>' : ''}</td>
<td>${r.ok ? 'ok' : `<span style="color:#b91c1c">${e(r.error_code ?? 'error')}</span>`}</td>
<td>${r.duration_ms ?? ''}</td><td class="muted">${ids(r.result_ids).slice(0, 3).map((i) => e(i.slice(0, 8))).join(' ')}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`;
  return page('Activity', body);
}

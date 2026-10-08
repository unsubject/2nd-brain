// OAuth 2.1 end to end against a real database: registration → consent →
// code → tokens → /mcp → refresh rotation → reuse detection → revocation.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { admin, BASE, env, form, resetAuthData, rpcRaw, TEST_DB, TOKEN, workerFetch } from './helpers';
import { pkceS256 } from '../../src/auth/crypto';
import { hashToken } from '../../src/auth/tokens';
import { REFUSED_LOGS_PER_MINUTE } from '../../src/oauth/register';

afterAll(() => admin.end({ timeout: 5 }));

const REDIRECT = 'http://127.0.0.1:43210/callback';
const VERIFIER = 'v'.repeat(20) + 'erifier-0123456789-abcdefghijk'; // 50 chars

async function register(redirectUris: string[] = [REDIRECT], name = 'Test CLI'): Promise<Response> {
  return workerFetch('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: name, token_endpoint_auth_method: 'none' }),
  });
}

async function registeredClient(redirectUris: string[] = [REDIRECT], name = 'Test CLI'): Promise<string> {
  const res = await register(redirectUris, name);
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

type AuthzOpts = {
  clientId: string;
  redirectUri?: string;
  verifier?: string;
  state?: string;
  resource?: string;
  scope?: string;
  method?: string;
};

async function authParams(o: AuthzOpts): Promise<Record<string, string>> {
  return {
    response_type: 'code',
    client_id: o.clientId,
    redirect_uri: o.redirectUri ?? REDIRECT,
    state: o.state ?? 'st/+= ä',
    code_challenge: await pkceS256(o.verifier ?? VERIFIER),
    code_challenge_method: o.method ?? 'S256',
    scope: o.scope ?? 'mcp offline_access',
    resource: o.resource ?? `${BASE}/mcp`,
  };
}

async function approve(o: AuthzOpts & { label?: string; secret?: string }): Promise<Response> {
  return workerFetch(
    '/authorize',
    form({ ...(await authParams(o)), decision: 'approve', label: o.label ?? 'My CLI', owner_secret: o.secret ?? TOKEN }),
  );
}

async function getCode(o: AuthzOpts & { label?: string }): Promise<string> {
  const res = await approve(o);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('Location')!);
  expect(loc.searchParams.get('error')).toBeNull();
  return loc.searchParams.get('code')!;
}

async function token(fields: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await workerFetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function exchange(clientId: string, code: string, verifier = VERIFIER, redirectUri = REDIRECT) {
  return token({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: `${BASE}/mcp`,
  });
}

async function mcpStatus(accessToken: string): Promise<number> {
  return (await rpcRaw('tools/list', {}, { token: accessToken })).status;
}

async function credentialOf(accessToken: string) {
  const hash = await hashToken(accessToken);
  const rows = await admin<Array<{ id: string; label: string; kind: string; revoked_reason: string | null; client_id: string }>>`
    SELECT c.id, c.label, c.kind, c.revoked_reason, c.client_id
      FROM mcp_token t JOIN mcp_credential c ON c.id = t.credential_id WHERE t.token_hash = ${hash}
  `;
  return rows[0];
}

describe.skipIf(!TEST_DB)('OAuth: registration', () => {
  beforeEach(resetAuthData);

  it('registers allowed redirect URIs as a public client', async () => {
    const res = await register(['https://claude.ai/api/mcp/auth_callback'], 'claudeai');
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toMatch(/^mcp-client-/);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body).not.toHaveProperty('client_secret');
    const [row] = await admin`SELECT client_family, client_name FROM mcp_client WHERE client_id = ${body.client_id as string}`;
    expect(row).toEqual({ client_family: 'claude', client_name: 'claudeai' });
  });

  it('keeps only the allowed redirect URIs of a multi-callback registration', async () => {
    const cursor = ['cursor://anysphere.cursor-mcp/oauth/callback', 'https://www.cursor.com/agents/mcp/oauth/callback'];
    const a = await register(cursor, 'Cursor');
    expect(a.status).toBe(201);
    expect(((await a.json()) as { redirect_uris: string[] }).redirect_uris).toEqual(cursor);
    const b = await register([REDIRECT, 'https://evil.example/cb']);
    expect(b.status).toBe(201);
    const body = (await b.json()) as { client_id: string; redirect_uris: string[] };
    expect(body.redirect_uris).toEqual([REDIRECT]);
    // The dropped one is refused at /authorize.
    const q = new URLSearchParams(await authParams({ clientId: body.client_id, redirectUri: 'https://evil.example/cb' }));
    expect((await workerFetch(`/authorize?${q}`)).status).toBe(400);
  });

  it('echoes a known application_type', async () => {
    const reg = (application_type?: string) =>
      workerFetch('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT], ...(application_type ? { application_type } : {}) }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect((await reg('native')).application_type).toBe('native');
    expect((await reg('web')).application_type).toBe('web');
    expect(await reg('desktop')).not.toHaveProperty('application_type');
    expect(await reg()).not.toHaveProperty('application_type');
  });

  it('refuses registrations with no allowed redirect URI', async () => {
    for (const uris of [['https://evil.example/cb'], [], ['https://evil.example/a', 'https://evil.example/b']]) {
      const res = await register(uris);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    }
    const bad = await workerFetch('/register', { method: 'POST', body: 'not json' });
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_client_metadata');
    expect(await admin`SELECT 1 FROM mcp_client`).toHaveLength(0);
  });

  const registerFrom = (ip: string) =>
    workerFetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });

  it('caps unapproved registrations per source, atomically', async () => {
    const burst = await Promise.all(Array.from({ length: 15 }, () => registerFrom('203.0.113.5')));
    expect(burst.filter((r) => r.status === 201)).toHaveLength(10);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(5);
    // Another caller is not locked out by the noisy one.
    expect((await registerFrom('198.51.100.7')).status).toBe(201);
    // Approved registrations stop counting.
    await admin`UPDATE mcp_client SET last_authorized_at = now()`;
    expect((await registerFrom('203.0.113.5')).status).toBe(201);
  });

  it('caps unapproved registrations globally', async () => {
    await admin`
      INSERT INTO mcp_client (client_id, redirect_uris, registered_from)
      SELECT 'spam-' || g, '[]'::jsonb, 'source-' || (g % 40) FROM generate_series(1, 200) g
    `;
    expect((await registerFrom('192.0.2.1')).status).toBe(429);
  });

  it('refuses oversized bodies without buffering them', async () => {
    const big = JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(20000) });
    const res = await workerFetch('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    expect(res.status).toBe(400);
    const tok = await workerFetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${'a'.repeat(20000)}`,
    });
    expect(((await tok.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('sweeps registrations never authorized within a week', async () => {
    await admin`INSERT INTO mcp_client (client_id, created_at) VALUES ('stale', now() - interval '8 days')`;
    await admin`INSERT INTO mcp_client (client_id, created_at, last_authorized_at) VALUES ('kept', now() - interval '8 days', now())`;
    await registeredClient();
    const ids = (await admin<Array<{ client_id: string }>>`SELECT client_id FROM mcp_client`).map((r) => r.client_id);
    expect(ids).toContain('kept');
    expect(ids).not.toContain('stale');
  });
});

describe.skipIf(!TEST_DB)('OAuth: consent', () => {
  beforeEach(resetAuthData);

  it('shows the consent page with the trusted family, host and a default label', async () => {
    const clientId = await registeredClient();
    // Loopback clients may come back on another port.
    const q = new URLSearchParams(await authParams({ clientId, redirectUri: 'http://127.0.0.1:50000/callback' }));
    const res = await workerFetch(`/authorize?${q}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('127.0.0.1:50000');
    expect(html).toContain('value="Test CLI"');
    expect(html).toContain('(unverified)');
  });

  it('does not reveal existing labels before approval', async () => {
    await admin`INSERT INTO mcp_credential (user_id, label, kind) VALUES (${env.BRAIN_USER_ID}, 'Test CLI', 'pat')`;
    const clientId = await registeredClient();
    const q = new URLSearchParams(await authParams({ clientId }));
    const html = await (await workerFetch(`/authorize?${q}`)).text();
    expect(html).toContain('value="Test CLI"');
    expect(html).not.toContain('Test CLI (2)');
    // The duplicate is resolved when the grant is minted.
    const t = (await exchange(clientId, await getCode({ clientId, label: 'Test CLI' }))).body;
    expect((await credentialOf(t.access_token)).label).toBe('Test CLI (2)');
  });

  it('never redirects for an unknown client or unregistered redirect', async () => {
    const clientId = await registeredClient();
    const wrong = new URLSearchParams(await authParams({ clientId, redirectUri: 'http://127.0.0.1:1/other' }));
    const a = await workerFetch(`/authorize?${wrong}`);
    expect(a.status).toBe(400);
    expect(a.headers.get('Location')).toBeNull();
    const unknown = new URLSearchParams(await authParams({ clientId: 'nobody' }));
    const b = await workerFetch(`/authorize?${unknown}`);
    expect(b.status).toBe(400);
    expect(await b.text()).toContain('Unknown client');
  });

  it('redirects protocol errors back with state and iss', async () => {
    const clientId = await registeredClient();
    for (const [over, error] of [
      [{ method: 'plain' }, 'invalid_request'],
      [{ resource: 'https://evil.example/mcp' }, 'invalid_target'],
    ] as const) {
      const q = new URLSearchParams(await authParams({ clientId, ...over }));
      const res = await workerFetch(`/authorize?${q}`);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('Location')!);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get('error')).toBe(error);
      expect(loc.searchParams.get('state')).toBe('st/+= ä');
      expect(loc.searchParams.get('iss')).toBe(BASE);
    }
    const q = new URLSearchParams({ ...(await authParams({ clientId })), response_type: 'token' });
    const res = await workerFetch(`/authorize?${q}`);
    expect(new URL(res.headers.get('Location')!).searchParams.get('error')).toBe('unsupported_response_type');
  });

  it('requires the owner secret and honours Deny', async () => {
    const clientId = await registeredClient();
    const wrong = await approve({ clientId, secret: 'guess' });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Wrong owner secret');
    const deny = await workerFetch('/authorize', form({ ...(await authParams({ clientId })), decision: 'deny' }));
    expect(new URL(deny.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
    expect(await admin`SELECT 1 FROM mcp_auth_code`).toHaveLength(0);
  });

  it('redirects with a code, the exact state and iss on approval', async () => {
    const clientId = await registeredClient();
    const res = await approve({ clientId, state: 'a&b=c d' });
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.searchParams.get('state')).toBe('a&b=c d');
    expect(loc.searchParams.get('iss')).toBe(BASE);
    expect(loc.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [client] = await admin`SELECT last_authorized_at FROM mcp_client WHERE client_id = ${clientId}`;
    expect(client.last_authorized_at).not.toBeNull();
  });

  it('adopts a legacy stateless client id on a known redirect', async () => {
    const legacy = 'mcp-client-0b5c9a3e-1111-4222-8333-944445555666';
    const claude = 'https://claude.ai/api/mcp/auth_callback';
    const q = new URLSearchParams(await authParams({ clientId: legacy, redirectUri: claude }));
    const page = await workerFetch(`/authorize?${q}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('value="Claude"');
    expect(await admin`SELECT 1 FROM mcp_client`).toHaveLength(0); // nothing stored before approval
    const code = await getCode({ clientId: legacy, redirectUri: claude, label: 'Claude' });
    const t = await exchange(legacy, code, VERIFIER, claude);
    expect(t.status).toBe(200);
    const [row] = await admin`SELECT redirect_uris, registration FROM mcp_client WHERE client_id = ${legacy}`;
    expect(row.redirect_uris).toEqual([claude]);
    expect(row.registration).toEqual({ adopted_legacy_client: true });
    const evil = new URLSearchParams(
      await authParams({ clientId: 'mcp-client-0b5c9a3e-1111-4222-8333-944445555667', redirectUri: 'https://evil.example/cb' }),
    );
    expect((await workerFetch(`/authorize?${evil}`)).status).toBe(400);
  });

  it('never redirects errors or denials for a legacy id that is not yet adopted', async () => {
    const legacy = 'mcp-client-0b5c9a3e-1111-4222-8333-944445555668';
    const target = 'http://localhost:6379/anything';
    const q = new URLSearchParams({ ...(await authParams({ clientId: legacy, redirectUri: target })), response_type: 'token' });
    const err = await workerFetch(`/authorize?${q}`);
    expect(err.status).toBe(400);
    expect(err.headers.get('Location')).toBeNull();
    const deny = await workerFetch('/authorize', form({ ...(await authParams({ clientId: legacy, redirectUri: target })), decision: 'deny' }));
    expect(deny.status).toBe(400);
    expect(deny.headers.get('Location')).toBeNull();
  });
});

describe.skipIf(!TEST_DB)('OAuth: tokens', () => {
  beforeEach(resetAuthData);

  it('exchanges a code for working tokens bound to a labelled credential', async () => {
    const clientId = await registeredClient();
    const code = await getCode({ clientId, label: '  Gemini   CLI ' });
    const t = await exchange(clientId, code);
    expect(t.status).toBe(200);
    expect(t.headers.get('Cache-Control')).toContain('no-store');
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp offline_access' });
    expect(t.body.access_token).toMatch(/^brain_at_/);
    expect(t.body.refresh_token).toMatch(/^brain_rt_/);
    expect(await mcpStatus(t.body.access_token)).toBe(200);
    const cred = await credentialOf(t.body.access_token);
    expect(cred).toMatchObject({ label: 'Gemini CLI', kind: 'oauth', revoked_reason: null, client_id: clientId });
    // Stored as its SHA-256 hash.
    const stored = await admin`SELECT kind FROM mcp_token WHERE token_hash = ${await hashToken(t.body.access_token)}`;
    expect(stored).toEqual([{ kind: 'access' }]);
  });

  it('binds codes to client, redirect and verifier without letting a code holder burn them', async () => {
    const clientId = await registeredClient();
    const other = await registeredClient();
    const code = await getCode({ clientId });
    expect((await exchange(clientId, code, 'w'.repeat(50))).body.error).toBe('invalid_grant');
    expect((await exchange(clientId, code, 'short')).body.error).toBe('invalid_grant');
    expect((await exchange(other, code)).body.error).toBe('invalid_grant');
    expect((await exchange(clientId, code, VERIFIER, 'http://127.0.0.1:43210/elsewhere')).body.error).toBe('invalid_grant');
    expect(await admin`SELECT 1 FROM mcp_credential`).toHaveLength(0);
    // The rightful client can still redeem it.
    expect((await exchange(clientId, code)).status).toBe(200);
  });

  it('rejects expired codes', async () => {
    const clientId = await registeredClient();
    const code = await getCode({ clientId });
    await admin`UPDATE mcp_auth_code SET expires_at = now() - interval '1 second'`;
    expect((await exchange(clientId, code)).body.error).toBe('invalid_grant');
  });

  it('revokes the credential when a used code is replayed by its client', async () => {
    const clientId = await registeredClient();
    const code = await getCode({ clientId });
    const t = await exchange(clientId, code);
    expect(t.status).toBe(200);
    // Someone who only saw the code can't trigger the revocation.
    expect((await exchange(clientId, code, 'x'.repeat(50))).body.error).toBe('invalid_grant');
    expect((await credentialOf(t.body.access_token)).revoked_reason).toBeNull();
    const replay = await exchange(clientId, code);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await credentialOf(t.body.access_token)).revoked_reason).toBe('code_reuse');
    expect(await mcpStatus(t.body.access_token)).toBe(401);
  });

  it('rotates refresh tokens, tolerating parallel and shared-store reuse', async () => {
    const clientId = await registeredClient();
    const first = (await exchange(clientId, await getCode({ clientId }))).body;
    const refreshWith = (rt: string) => token({ grant_type: 'refresh_token', refresh_token: rt, client_id: clientId });

    // Three parallel refreshes with one token (SDK clients do this): all succeed.
    const parallel = await Promise.all([1, 2, 3].map(() => refreshWith(first.refresh_token)));
    expect(parallel.map((r) => r.status)).toEqual([200, 200, 200]);
    const pairs = parallel.map((r) => r.body);
    expect(new Set(pairs.map((p) => p.refresh_token)).size).toBe(3);
    for (const p of pairs) expect(await mcpStatus(p.access_token)).toBe(200);

    // Every sibling refresh token keeps working on its own.
    for (const p of pairs) expect((await refreshWith(p.refresh_token)).status).toBe(200);

    // Reuse is bounded within the window…
    const hash = await hashToken(first.refresh_token);
    await admin`UPDATE mcp_token SET reuse_count = 10 WHERE token_hash = ${hash}`;
    expect((await refreshWith(first.refresh_token)).body.error).toBe('invalid_grant');
    // …and refused after it, without revoking anything (a stale copy in an
    // idle process must not log out the live ones).
    await admin`UPDATE mcp_token SET reuse_count = 0, rotated_at = now() - interval '6 minutes' WHERE token_hash = ${hash}`;
    expect((await refreshWith(first.refresh_token)).body.error).toBe('invalid_grant');
    expect((await credentialOf(pairs[0].access_token)).revoked_reason).toBeNull();
    expect(await mcpStatus(pairs[0].access_token)).toBe(200);
  });

  it('registers Meta Muse by its callback and names it on the consent page', async () => {
    const muse = 'https://agent.meta.ai/api/hatch/oauth/callback';
    const res = await register([muse, 'https://unknown.example/cb'], 'Muse');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; redirect_uris: string[] };
    expect(body.redirect_uris).toEqual([muse]);
    const page = await workerFetch(`/authorize?${new URLSearchParams(await authParams({ clientId: body.client_id, redirectUri: muse }))}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Meta (Muse)');
    expect(html).toMatch(/name="label"[^>]*value="Meta Muse"/);
    expect(html).toMatch(/name="replace" value="on" checked/);
  });

  it('logs the redirect URIs of a refused registration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await register(['https://unknown-agent.example/oauth/cb'], 'Unknown Agent');
      expect(res.status).toBe(400);
      const line = warn.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('[register] refused'));
      expect(line).toContain('https://unknown-agent.example/oauth/cb');
      expect(line).toContain('Unknown Agent');
    } finally {
      warn.mockRestore();
    }
  });

  it('throttles the refusal log, so a flood of bad registrations cannot bury it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const flood = 3 * REFUSED_LOGS_PER_MINUTE;
      for (let i = 0; i < flood; i++) {
        expect((await register([`https://junk-${i}.example/cb`], 'Junk')).status).toBe(400);
      }
      const lines = warn.mock.calls.filter((c) => String(c[0]).includes('[register] refused'));
      // One window, or two if the flood straddles a minute boundary.
      expect(lines.length).toBeLessThanOrEqual(2 * REFUSED_LOGS_PER_MINUTE);
      expect(await admin`SELECT 1 FROM mcp_client`).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a reconnect under its name when the owner chooses replace', async () => {
    const clientId = await registeredClient(['https://claude.ai/api/mcp/auth_callback']);
    const claude = 'https://claude.ai/api/mcp/auth_callback';
    // Default on for server-side vendors, off for local apps.
    const page = await workerFetch(`/authorize?${new URLSearchParams(await authParams({ clientId, redirectUri: claude }))}`);
    expect(await page.text()).toMatch(/name="replace" value="on" checked/);
    const loop = await registeredClient();
    const loopPage = await workerFetch(`/authorize?${new URLSearchParams(await authParams({ clientId: loop }))}`);
    expect(await loopPage.text()).not.toMatch(/name="replace" value="on" checked/);

    await admin`INSERT INTO mcp_credential (user_id, label, kind) VALUES (${env.BRAIN_USER_ID}, 'Claude PAT', 'pat')`;
    const approveAs = async (replace: boolean) => {
      const fields: Record<string, string> = {
        ...(await authParams({ clientId, redirectUri: claude })),
        decision: 'approve',
        label: 'Claude',
        owner_secret: TOKEN,
      };
      if (replace) fields.replace = 'on';
      const res = await workerFetch('/authorize', form(fields));
      return new URL(res.headers.get('Location')!).searchParams.get('code')!;
    };
    const a = (await exchange(clientId, await approveAs(true), VERIFIER, claude)).body;
    const b = (await exchange(clientId, await approveAs(true), VERIFIER, claude)).body;
    expect((await credentialOf(b.access_token)).label).toBe('Claude');
    expect((await credentialOf(a.access_token)).revoked_reason).toBe('replaced');
    expect(await mcpStatus(a.access_token)).toBe(401);
    const c = (await exchange(clientId, await approveAs(false), VERIFIER, claude)).body;
    expect((await credentialOf(c.access_token)).label).toBe('Claude (2)');
    // PATs are never replaced by an OAuth reconnect.
    const [pat] = await admin`SELECT revoked_at FROM mcp_credential WHERE label = 'Claude PAT'`;
    expect(pat.revoked_at).toBeNull();
  });

  it('refuses reserved labels', async () => {
    const clientId = await registeredClient();
    const res = await approve({ clientId, label: 'Master' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('reserved');
  });

  it('checks the client on refresh and rejects expired refresh tokens', async () => {
    const clientId = await registeredClient();
    const other = await registeredClient();
    const t = (await exchange(clientId, await getCode({ clientId }))).body;
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: other })).body.error).toBe(
      'invalid_grant',
    );
    await admin`UPDATE mcp_token SET expires_at = now() - interval '1 second' WHERE kind = 'refresh'`;
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).body.error).toBe('invalid_grant');
  });

  it('rejects expired access tokens at /mcp', async () => {
    const clientId = await registeredClient();
    const t = (await exchange(clientId, await getCode({ clientId }))).body;
    await admin`UPDATE mcp_token SET expires_at = now() - interval '1 second' WHERE kind = 'access'`;
    const res = await rpcRaw('tools/list', {}, { token: t.access_token });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });

  it('gives each grant a unique label, folding case as Postgres does', async () => {
    const clientId = await registeredClient();
    const a = (await exchange(clientId, await getCode({ clientId, label: 'Twin' }))).body;
    const b = (await exchange(clientId, await getCode({ clientId, label: 'twin' }))).body;
    expect((await credentialOf(a.access_token)).label).toBe('Twin');
    expect((await credentialOf(b.access_token)).label).toBe('twin (2)');
    // JS and Postgres lower() disagree on final sigma; the index decides.
    const c = await exchange(clientId, await getCode({ clientId, label: 'ΟΔΟΣ' }));
    const d = await exchange(clientId, await getCode({ clientId, label: 'ΟΔΟΣ' }));
    expect(c.status).toBe(200);
    expect(d.status).toBe(200);
    expect((await credentialOf(d.body.access_token)).label).toBe('ΟΔΟΣ (2)');
    const e = await exchange(clientId, await getCode({ clientId, label: 'i' }));
    const f = await exchange(clientId, await getCode({ clientId, label: 'İ' }));
    expect([e.status, f.status]).toEqual([200, 200]);
  });

  it('answers grant and request errors per RFC 6749', async () => {
    expect((await token({ grant_type: 'password' })).body.error).toBe('unsupported_grant_type');
    expect((await token({ grant_type: 'authorization_code', code: 'x' })).body.error).toBe('invalid_request');
    expect((await token({ grant_type: 'refresh_token', refresh_token: 'nope' })).body.error).toBe('invalid_grant');
    const json = await workerFetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'nope' }),
    });
    expect(((await json.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('sweeps tokens and codes a day past expiry', async () => {
    const clientId = await registeredClient();
    const t = (await exchange(clientId, await getCode({ clientId }))).body;
    await admin`UPDATE mcp_token SET expires_at = now() - interval '2 days' WHERE kind = 'access'`;
    await admin`UPDATE mcp_auth_code SET expires_at = now() - interval '2 days'`;
    await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    expect(await admin`SELECT 1 FROM mcp_token WHERE token_hash = ${await hashToken(t.access_token)}`).toHaveLength(0);
    expect(await admin`SELECT 1 FROM mcp_auth_code`).toHaveLength(0);
  });
});

describe.skipIf(!TEST_DB)('OAuth: revocation', () => {
  beforeEach(resetAuthData);

  it('revokes the whole credential from any of its tokens', async () => {
    const clientId = await registeredClient();
    const t = (await exchange(clientId, await getCode({ clientId }))).body;
    const res = await workerFetch('/revoke', form({ token: t.refresh_token, token_type_hint: 'refresh_token' }));
    expect(res.status).toBe(200);
    expect(await mcpStatus(t.access_token)).toBe(401);
    expect((await credentialOf(t.access_token)).revoked_reason).toBe('client');
  });

  it('answers 200 for unknown tokens and ignores the master token', async () => {
    expect((await workerFetch('/revoke', form({ token: 'whatever' }))).status).toBe(200);
    expect((await workerFetch('/revoke', form({ token: TOKEN }))).status).toBe(200);
    expect(await mcpStatus(TOKEN)).toBe(200);
    expect((await workerFetch('/revoke', form({}))).status).toBe(400);
  });
});

describe.skipIf(!TEST_DB)('OAuth: environment switches', () => {
  beforeEach(resetAuthData);

  it('approves with OWNER_SECRET, not the legacy bearer, once it is set', async () => {
    const separate = { ...env, OWNER_SECRET: 'a-separate-owner-secret' };
    const clientId = await registeredClient();
    const params = await authParams({ clientId });
    const legacy = await workerFetch('/authorize', form({ ...params, decision: 'approve', label: 'X', owner_secret: TOKEN }), { env: separate });
    expect(legacy.status).toBe(401);
    const owner = await workerFetch(
      '/authorize',
      form({ ...params, decision: 'approve', label: 'X', owner_secret: 'a-separate-owner-secret' }),
      { env: separate },
    );
    expect(owner.status).toBe(302);
  });

  it('accepts extra redirect prefixes from OAUTH_EXTRA_REDIRECT_PREFIXES', async () => {
    const custom = { ...env, OAUTH_EXTRA_REDIRECT_PREFIXES: 'https://agent.example/oauth/' };
    const body = JSON.stringify({ redirect_uris: ['https://agent.example/oauth/cb'] });
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
    expect((await workerFetch('/register', init)).status).toBe(400);
    expect((await workerFetch('/register', init, { env: custom })).status).toBe(201);
  });
});

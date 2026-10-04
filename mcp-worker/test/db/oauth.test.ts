// OAuth 2.1 end to end against a real database: registration → consent →
// code → tokens → /mcp → refresh rotation → reuse detection → revocation.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, BASE, env, form, resetAuthData, rpcRaw, TEST_DB, TOKEN, workerFetch } from './helpers';
import { pkceS256 } from '../../src/auth/crypto';
import { hashToken } from '../../src/auth/tokens';

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

  it('refuses redirect URIs outside the allow-list', async () => {
    for (const uris of [['https://evil.example/cb'], [], [REDIRECT, 'https://evil.example/cb']]) {
      const res = await register(uris);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    }
    const bad = await workerFetch('/register', { method: 'POST', body: 'not json' });
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_client_metadata');
    expect(await admin`SELECT 1 FROM mcp_client`).toHaveLength(0);
  });

  it('caps unauthorized registrations per hour', async () => {
    await admin`
      INSERT INTO mcp_client (client_id, redirect_uris)
      SELECT 'spam-' || g, '[]'::jsonb FROM generate_series(1, 50) g
    `;
    const res = await register();
    expect(res.status).toBe(429);
    await admin`UPDATE mcp_client SET last_authorized_at = now()`;
    expect((await register()).status).toBe(201);
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
    // Only hashes are stored.
    const raw = await admin`SELECT 1 FROM mcp_token WHERE token_hash = ${t.body.access_token}`;
    expect(raw).toHaveLength(0);
  });

  it('burns a code on PKCE failure and binds it to the client', async () => {
    const clientId = await registeredClient();
    const other = await registeredClient();
    const code = await getCode({ clientId });
    expect((await exchange(clientId, code, 'w'.repeat(50))).body.error).toBe('invalid_grant');
    expect((await exchange(clientId, code)).body.error).toBe('invalid_grant');
    const code2 = await getCode({ clientId });
    expect((await exchange(other, code2)).body.error).toBe('invalid_grant');
    const code3 = await getCode({ clientId });
    expect((await exchange(clientId, code3, VERIFIER, 'http://127.0.0.1:43210/elsewhere')).body.error).toBe('invalid_grant');
    expect(await admin`SELECT 1 FROM mcp_credential`).toHaveLength(0);
  });

  it('rejects expired codes', async () => {
    const clientId = await registeredClient();
    const code = await getCode({ clientId });
    await admin`UPDATE mcp_auth_code SET expires_at = now() - interval '1 second'`;
    expect((await exchange(clientId, code)).body.error).toBe('invalid_grant');
  });

  it('revokes the credential when a used code is replayed', async () => {
    const clientId = await registeredClient();
    const code = await getCode({ clientId });
    const t = await exchange(clientId, code);
    expect(t.status).toBe(200);
    const replay = await exchange(clientId, code);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await credentialOf(t.body.access_token)).revoked_reason).toBe('code_reuse');
    expect(await mcpStatus(t.body.access_token)).toBe(401);
  });

  it('rotates refresh tokens and treats late reuse as theft', async () => {
    const clientId = await registeredClient();
    const first = (await exchange(clientId, await getCode({ clientId }))).body;
    const second = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect(await mcpStatus(second.body.access_token)).toBe(200);

    // A retry race within the grace window: rejected, nothing revoked.
    const race = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(race.body.error).toBe('invalid_grant');
    expect(await mcpStatus(second.body.access_token)).toBe(200);

    // Later reuse of a rotated token revokes the whole credential.
    await admin`UPDATE mcp_token SET rotated_at = now() - interval '5 minutes' WHERE token_hash = ${await hashToken(first.refresh_token)}`;
    const theft = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(theft.body.error).toBe('invalid_grant');
    expect((await credentialOf(second.body.access_token)).revoked_reason).toBe('refresh_reuse');
    expect(await mcpStatus(second.body.access_token)).toBe(401);
    const after = await token({ grant_type: 'refresh_token', refresh_token: second.body.refresh_token });
    expect(after.body.error).toBe('invalid_grant');
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

  it('gives each grant a unique label', async () => {
    const clientId = await registeredClient();
    const a = (await exchange(clientId, await getCode({ clientId, label: 'Twin' }))).body;
    const b = (await exchange(clientId, await getCode({ clientId, label: 'twin' }))).body;
    expect((await credentialOf(a.access_token)).label).toBe('Twin');
    expect((await credentialOf(b.access_token)).label).toBe('twin (2)');
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

  it('accepts extra redirect prefixes from OAUTH_EXTRA_REDIRECT_PREFIXES', async () => {
    const custom = { ...env, OAUTH_EXTRA_REDIRECT_PREFIXES: 'https://agent.example/oauth/' };
    const body = JSON.stringify({ redirect_uris: ['https://agent.example/oauth/cb'] });
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
    expect((await workerFetch('/register', init)).status).toBe(400);
    expect((await workerFetch('/register', init, { env: custom })).status).toBe(201);
  });
});

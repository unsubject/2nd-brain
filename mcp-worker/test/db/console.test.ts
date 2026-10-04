// Owner console (/tokens): login, CSRF, PAT lifecycle, activity.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, BASE, callTool, env, form, resetAuthData, resetIdeaData, rpcRaw, TEST_DB, TOKEN, USER, workerFetch } from './helpers';
import { createSession } from '../../src/auth/session';
import { hashToken } from '../../src/auth/tokens';

afterAll(() => admin.end({ timeout: 5 }));

async function login(): Promise<string> {
  const res = await workerFetch('/tokens/login', form({ owner_secret: TOKEN }));
  expect(res.status).toBe(303);
  const setCookie = res.headers.get('Set-Cookie')!;
  expect(setCookie).toMatch(/^__Host-brain_console=v1\./);
  for (const attr of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) expect(setCookie).toContain(attr);
  return setCookie.split(';')[0];
}

async function getPage(path: string, cookie: string): Promise<{ status: number; html: string; headers: Headers }> {
  const res = await workerFetch(path, { headers: { Cookie: cookie } });
  return { status: res.status, html: await res.text(), headers: res.headers };
}

function csrfFrom(html: string): string {
  return /name="csrf" value="([^"]+)"/.exec(html)![1];
}

async function postAs(cookie: string, path: string, fields: Record<string, string>, origin = BASE): Promise<Response> {
  const init = form(fields);
  return workerFetch(path, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie, Origin: origin } });
}

describe.skipIf(!TEST_DB)('owner console', () => {
  beforeEach(async () => {
    await resetAuthData();
    await resetIdeaData();
  });

  it('shows a hardened login page and refuses a wrong secret', async () => {
    const res = await workerFetch('/tokens');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(await res.text()).toContain('Sign in');
    expect((await workerFetch('/tokens/login', form({ owner_secret: 'nope' }))).status).toBe(401);
  });

  it('refuses cross-site posts before anything else', async () => {
    const init = form({ owner_secret: TOKEN });
    const res = await workerFetch('/tokens/login', {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('creates a PAT once, which then works, shows up, and can be revoked', async () => {
    const cookie = await login();
    const dash = await getPage('/tokens', cookie);
    expect(dash.status).toBe(200);
    expect(dash.html).toContain('No agents connected yet');
    const csrf = csrfFrom(dash.html);

    expect((await postAs(cookie, '/tokens/create', { label: 'Meta Muse' })).status).toBe(403);
    expect((await postAs(cookie, '/tokens/create', { label: 'Meta Muse', csrf: 'forged' })).status).toBe(403);
    expect((await postAs(cookie, '/tokens/create', { label: 'Meta Muse', csrf }, 'https://evil.example')).status).toBe(403);

    const created = await postAs(cookie, '/tokens/create', { label: ' Meta  Muse ', csrf });
    expect(created.status).toBe(200);
    const html = await created.text();
    const token = /(brain_pat_[A-Za-z0-9_-]{43})/.exec(html)![1];
    expect(html).toContain('claude mcp add --transport http 2nd-brain');
    expect(html).toContain('&quot;httpUrl&quot;');

    const [cred] = await admin`SELECT id, label, kind, token_hint FROM mcp_credential`;
    expect(cred).toMatchObject({ label: 'Meta Muse', kind: 'pat', token_hint: token.slice(-4) });
    expect(await admin`SELECT kind FROM mcp_token WHERE token_hash = ${await hashToken(token)}`).toEqual([{ kind: 'pat' }]);

    expect((await callTool('list_ideas', {}, { token })).isError).toBe(false);
    const after = await getPage('/tokens', cookie);
    expect(after.html).toContain('Meta Muse');
    expect(after.html).toContain('just now');
    expect(after.html).toContain('1 calls / 7 days');
    expect(after.html).toContain(`PAT …${token.slice(-4)}`);

    const activity = await getPage(`/tokens/activity?credential=${cred.id}`, cookie);
    expect(activity.html).toContain('list_ideas');

    const revoke = await postAs(cookie, '/tokens/revoke', { id: cred.id as string, csrf });
    expect(revoke.status).toBe(303);
    expect((await rpcRaw('tools/list', {}, { token })).status).toBe(401);
    const [gone] = await admin`SELECT revoked_reason FROM mcp_credential WHERE id = ${cred.id as string}`;
    expect(gone.revoked_reason).toBe('owner');
    expect((await getPage('/tokens', cookie)).html).toContain('Recently revoked');
  });

  it('suffixes duplicate labels and rejects empty ones', async () => {
    const cookie = await login();
    const csrf = csrfFrom((await getPage('/tokens', cookie)).html);
    await postAs(cookie, '/tokens/create', { label: 'Scripts', csrf });
    await postAs(cookie, '/tokens/create', { label: 'scripts', csrf });
    const labels = (await admin<Array<{ label: string }>>`SELECT label FROM mcp_credential ORDER BY created_at`).map((r) => r.label);
    expect(labels).toEqual(['Scripts', 'scripts (2)']);
    const empty = await postAs(cookie, '/tokens/create', { label: '   ', csrf });
    expect(await empty.text()).toContain('Give the token a name');
  });

  it('warns while the master token is still in use', async () => {
    const cookie = await login();
    expect((await getPage('/tokens', cookie)).html).not.toContain('master token');
    // Calls from deleted credentials (credential_id set NULL) are not master calls.
    await admin`INSERT INTO mcp_call_log (credential_id, label, method, ok) VALUES (NULL, 'Gone', 'tools/call', true)`;
    expect((await getPage('/tokens', cookie)).html).not.toContain('The master token');
    await callTool('list_ideas', {});
    const html = (await getPage('/tokens', cookie)).html;
    expect(html).toContain('The master token');
    expect(html).toContain('1 call(s)');
    expect((await getPage('/tokens/activity?credential=master', cookie)).html).toContain('list_ideas');
  });

  it('treats tampered, expired or foreign cookies as signed out', async () => {
    const cookie = await login();
    const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await getPage('/tokens', tampered)).html).toContain('Sign in');
    const old = await createSession(TOKEN, Math.floor(Date.now() / 1000) - 3600);
    expect((await getPage('/tokens', `__Host-brain_console=${old}`)).html).toContain('Sign in');
    const foreign = await createSession('another-secret', Math.floor(Date.now() / 1000));
    expect((await getPage('/tokens', `__Host-brain_console=${foreign}`)).html).toContain('Sign in');
    const res = await postAs(tampered, '/tokens/revoke', { id: '00000000-0000-4000-8000-000000000000', csrf: 'x' });
    expect(res.status).toBe(401);
  });

  it('uses OWNER_SECRET once set, and nags until it is', async () => {
    const cookie = await login();
    expect((await getPage('/tokens', cookie)).html).toContain('The owner secret is still');

    const separate = { ...env, OWNER_SECRET: 'console-owner-secret' };
    expect((await workerFetch('/tokens/login', form({ owner_secret: TOKEN }), { env: separate })).status).toBe(401);
    // Sessions signed with the old secret are void.
    expect((await (await workerFetch('/tokens', { headers: { Cookie: cookie } }, { env: separate })).text())).toContain('Sign in');
    const res = await workerFetch('/tokens/login', form({ owner_secret: 'console-owner-secret' }), { env: separate });
    expect(res.status).toBe(303);
    const fresh = res.headers.get('Set-Cookie')!.split(';')[0];
    const html = await (await workerFetch('/tokens', { headers: { Cookie: fresh } }, { env: separate })).text();
    expect(html).toContain('connected agents');
    expect(html).not.toContain('The owner secret is still');
  });

  it('labels OAuth grants by the redirect they were issued to', async () => {
    await admin`INSERT INTO mcp_client (client_id, client_name, redirect_uris, client_family)
                VALUES ('c1', 'Claude', '["https://claude.ai/api/mcp/auth_callback","http://127.0.0.1/cb"]'::jsonb, 'claude')`;
    await admin`INSERT INTO mcp_credential (user_id, label, kind, client_id, redirect_uri)
                VALUES (${USER}, 'Sneaky', 'oauth', 'c1', 'http://127.0.0.1/cb')`;
    const html = (await getPage('/tokens', await login())).html;
    expect(html).toContain('OAuth · Local app');
    expect(html).not.toContain('OAuth · Claude');
  });

  it('signs out by clearing the cookie', async () => {
    const cookie = await login();
    const res = await postAs(cookie, '/tokens/logout', {});
    expect(res.status).toBe(303);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

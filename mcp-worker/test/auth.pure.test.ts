import { describe, it, expect } from 'vitest';
import { constantTimeEqual, isValidCodeVerifier, pkceS256 } from '../src/auth/crypto';
import {
  classifyRedirect,
  parseExtraPrefixes,
  redirectDisplayHost,
  redirectMatchesRegistered,
} from '../src/auth/redirects';
import { createSession, csrfToken, readCookie, SESSION_TTL_SECONDS, verifyCsrf, verifySession } from '../src/auth/session';
import { bearerFrom, newToken, tokenKind } from '../src/auth/tokens';
import { normalizeLabel, pickUniqueLabel } from '../src/auth/labels';
import { authenticate, unauthorized } from '../src/auth/middleware';
import { authServerMetadata, isOurResource, normalizeScope, protectedResourceMetadata } from '../src/oauth/metadata';
import { clientIdFrom } from '../src/oauth/common';
import { sameOrigin } from '../src/console';
import worker from '../src/index';
import type { Env } from '../src/env';

const BASE = 'https://brain.example';

describe('PKCE', () => {
  it('matches the RFC 7636 Appendix B vector', async () => {
    expect(await pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('validates verifier length and alphabet', () => {
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${'a'.repeat(42)}+`)).toBe(false);
  });

  it('compares in constant time, including multi-byte strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('é', 'é')).toBe(false);
  });
});

describe('redirect allow-list', () => {
  const allowed: Array<[string, string]> = [
    ['https://claude.ai/api/mcp/auth_callback', 'claude'],
    ['https://claude.com/api/mcp/auth_callback', 'claude'],
    ['https://chatgpt.com/connector_platform_oauth_redirect', 'chatgpt'],
    ['https://chatgpt.com/connector/oauth/abc123', 'chatgpt'],
    ['cursor://anysphere.cursor-mcp/oauth/callback', 'cursor'],
    ['https://oauth-redirect.googleusercontent.com/r/my-project', 'google'],
    ['http://localhost:33418/callback', 'loopback'],
    ['http://127.0.0.1/cb', 'loopback'],
    ['http://[::1]:8080/cb', 'loopback'],
  ];
  for (const [uri, family] of allowed) {
    it(`allows ${uri}`, () => expect(classifyRedirect(uri)).toBe(family));
  }

  const refused = [
    'https://claude.ai/api/mcp/auth_callback?next=evil',
    'https://claude.ai.evil.com/api/mcp/auth_callback',
    'https://evil.com/api/mcp/auth_callback',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/../../steal',
    'https://chatgpt.com/other',
    'https://oauth-redirect.googleusercontent.com/other',
    'https://localhost/cb',
    'http://localhost.evil.com/cb',
    'http://evil.com/cb',
    'https://user:pw@claude.ai/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback#frag',
    'javascript:alert(1)',
    'not a url',
    `https://chatgpt.com/connector/oauth/${'a'.repeat(2100)}`,
  ];
  for (const uri of refused) {
    it(`refuses ${uri.slice(0, 60)}`, () => expect(classifyRedirect(uri)).toBeNull());
  }

  it('honours https-only extra prefixes', () => {
    const extra = parseExtraPrefixes(' https://agent.example/cb/ , http://insecure.example/, junk');
    expect(extra).toEqual(['https://agent.example/cb/']);
    expect(classifyRedirect('https://agent.example/cb/x', extra)).toBe('custom');
    expect(classifyRedirect('https://agent.example/other', extra)).toBeNull();
    expect(classifyRedirect('https://agent.example/cb/../other', extra)).toBeNull();
  });

  it('lets loopback redirects change port but nothing else', () => {
    const reg = ['http://127.0.0.1:1234/callback'];
    expect(redirectMatchesRegistered('http://127.0.0.1:5555/callback', reg)).toBe(true);
    expect(redirectMatchesRegistered('http://127.0.0.1:5555/other', reg)).toBe(false);
    expect(redirectMatchesRegistered('http://localhost:1234/callback', reg)).toBe(false);
    expect(redirectMatchesRegistered('https://claude.ai/api/mcp/auth_callback', ['https://claude.ai/api/mcp/auth_callback'])).toBe(true);
    expect(redirectMatchesRegistered('https://claude.com/api/mcp/auth_callback', ['https://claude.ai/api/mcp/auth_callback'])).toBe(false);
  });

  it('shows a trustworthy host', () => {
    expect(redirectDisplayHost('https://chatgpt.com/connector/oauth/x')).toBe('chatgpt.com');
    expect(redirectDisplayHost('cursor://anysphere.cursor-mcp/oauth/callback')).toBe('cursor://anysphere.cursor-mcp');
    expect(redirectDisplayHost('http://127.0.0.1:9/cb')).toBe('127.0.0.1:9');
  });
});

describe('console session cookie', () => {
  const secret = 'owner-secret';
  const now = 1_800_000_000;

  it('round-trips, and binds CSRF tokens to the session', async () => {
    const cookie = await createSession(secret, now);
    const sid = await verifySession(secret, cookie, now + 10);
    expect(sid).toBeTruthy();
    const csrf = await csrfToken(secret, sid!);
    expect(await verifyCsrf(secret, sid!, csrf)).toBe(true);
    expect(await verifyCsrf(secret, 'other-sid', csrf)).toBe(false);
    expect(await verifyCsrf(secret, sid!, null)).toBe(false);
  });

  it('rejects tampering, expiry and a rotated secret', async () => {
    const cookie = await createSession(secret, now);
    const [v, exp, sid, sig] = cookie.split('.');
    expect(await verifySession(secret, `${v}.${Number(exp) + 3600}.${sid}.${sig}`, now)).toBeNull();
    expect(await verifySession(secret, `${v}.${exp}.other.${sig}`, now)).toBeNull();
    expect(await verifySession(secret, `${v}.${exp}.${sid}.${sig.slice(0, -1)}A`, now)).toBeNull();
    expect(await verifySession(secret, cookie, now + SESSION_TTL_SECONDS + 1)).toBeNull();
    expect(await verifySession('rotated', cookie, now)).toBeNull();
    expect(await verifySession(secret, '', now)).toBeNull();
    expect(await verifySession(secret, 'v1.a.b', now)).toBeNull();
  });

  it('reads the cookie by exact name', () => {
    const req = new Request(BASE, { headers: { Cookie: 'x__Host-brain_console=bad; __Host-brain_console=good' } });
    expect(readCookie(req, '__Host-brain_console')).toBe('good');
  });
});

describe('tokens and labels', () => {
  it('mints recognisable opaque tokens', () => {
    expect(tokenKind(newToken('access'))).toBe('access');
    expect(tokenKind(newToken('refresh'))).toBe('refresh');
    expect(tokenKind(newToken('pat'))).toBe('pat');
    expect(tokenKind('brain_at_short')).toBeNull();
    expect(tokenKind(`brain_xx_${'a'.repeat(43)}`)).toBeNull();
    expect(newToken('pat')).not.toBe(newToken('pat'));
  });

  it('reads bearer tokens case-insensitively', () => {
    expect(bearerFrom(new Request(BASE, { headers: { Authorization: 'bearer abc' } }))).toBe('abc');
    expect(bearerFrom(new Request(BASE, { headers: { Authorization: 'Bearer  abc ' } }))).toBe('abc');
    expect(bearerFrom(new Request(BASE, { headers: { Authorization: 'Basic abc' } }))).toBeNull();
    expect(bearerFrom(new Request(BASE))).toBeNull();
  });

  it('normalises and de-duplicates labels', () => {
    expect(normalizeLabel('  Meta\n  Muse ')).toBe('Meta Muse');
    expect(normalizeLabel('   ')).toBeNull();
    expect(normalizeLabel('x'.repeat(81))).toBeNull();
    expect(normalizeLabel(42)).toBeNull();
    expect(pickUniqueLabel('Claude', new Set())).toBe('Claude');
    expect(pickUniqueLabel('Claude', new Set(['claude']))).toBe('Claude (2)');
    expect(pickUniqueLabel('Claude', new Set(['claude', 'claude (2)']))).toBe('Claude (3)');
    const long = pickUniqueLabel('y'.repeat(80), new Set(['y'.repeat(80)]));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith(' (2)')).toBe(true);
  });
});

describe('/mcp authentication without a database', () => {
  const env = {
    HYPERDRIVE: { connectionString: 'postgres://unused' },
    BRAIN_MCP_TOKEN: 'master-secret',
    BRAIN_USER_ID: 'u',
  } as unknown as Env;
  const req = (auth?: string) =>
    new Request(`${BASE}/mcp`, { method: 'POST', headers: auth ? { Authorization: auth } : {} });

  it('points 401s at the /mcp protected-resource metadata', () => {
    const none = unauthorized(req(), false).headers.get('WWW-Authenticate')!;
    expect(none).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(none).not.toContain('invalid_token');
    expect(unauthorized(req(), true).headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });

  it('accepts the master token unless ALLOW_MASTER_BEARER is "false"', async () => {
    const ok = await authenticate(req('Bearer master-secret'), env);
    expect(ok.ok && ok.principal.via).toBe('master');
    const off = await authenticate(req('Bearer master-secret'), { ...env, ALLOW_MASTER_BEARER: ' FALSE ' });
    expect(off.ok).toBe(false);
  });

  it('rejects unprefixed and refresh tokens without touching the database', async () => {
    for (const auth of [undefined, 'Bearer nope', `Bearer ${newToken('refresh')}`]) {
      const r = await authenticate(req(auth), env);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(401);
    }
  });
});

describe('OAuth discovery', () => {
  const request = new Request(`${BASE}/.well-known/oauth-authorization-server`);

  it('advertises refresh, iss and no CIMD', async () => {
    const m = (await authServerMetadata(request).json()) as Record<string, unknown>;
    expect(m.issuer).toBe(BASE);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.scopes_supported).toContain('offline_access');
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m.revocation_endpoint).toBe(`${BASE}/revoke`);
    expect(m).not.toHaveProperty('client_id_metadata_document_supported');
  });

  it('serves RFC 9728 metadata at the root and for /mcp', async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const env = {} as Env;
    const root = await worker.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`), env, ctx);
    const mcp = await worker.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`), env, ctx);
    expect(((await root.json()) as { resource: string }).resource).toBe(BASE);
    expect(((await mcp.json()) as { resource: string }).resource).toBe(`${BASE}/mcp`);
    expect(mcp.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(((await protectedResourceMetadata(request, '').json()) as { authorization_servers: string[] }).authorization_servers).toEqual([BASE]);
    const pre = await worker.fetch(new Request(`${BASE}/token`, { method: 'OPTIONS' }), env, ctx);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('recognises our resource indicators and scopes', () => {
    expect(isOurResource(`${BASE}/mcp`, request)).toBe(true);
    expect(isOurResource(BASE, request)).toBe(true);
    expect(isOurResource('https://evil.example/mcp', request)).toBe(false);
    expect(normalizeScope(undefined)).toBe('mcp');
    expect(normalizeScope('offline_access openid mcp')).toBe('mcp offline_access');
    expect(normalizeScope('profile')).toBe('mcp');
  });

  it('reads client_id from the body or HTTP Basic', () => {
    const p = new URLSearchParams('client_id=abc');
    expect(clientIdFrom(new Request(BASE), p)).toBe('abc');
    const basic = new Request(BASE, { headers: { Authorization: `Basic ${btoa('xyz:')}` } });
    expect(clientIdFrom(basic, new URLSearchParams())).toBe('xyz');
    expect(clientIdFrom(basic, p)).toBe('conflict');
  });
});

describe('console origin check', () => {
  const post = (headers: Record<string, string>) => new Request(`${BASE}/tokens/create`, { method: 'POST', headers });
  it('allows same-origin and refuses cross-site posts', () => {
    expect(sameOrigin(post({ Origin: BASE }))).toBe(true);
    expect(sameOrigin(post({ Origin: 'https://evil.example' }))).toBe(false);
    expect(sameOrigin(post({ Origin: 'null' }))).toBe(false);
    expect(sameOrigin(post({ 'Sec-Fetch-Site': 'cross-site' }))).toBe(false);
    expect(sameOrigin(post({ 'Sec-Fetch-Site': 'same-origin' }))).toBe(true);
    expect(sameOrigin(post({}))).toBe(true);
  });
});

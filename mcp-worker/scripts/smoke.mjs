#!/usr/bin/env node
// Smoke test for the 2nd-brain MCP Worker, as any client sees it.
// No dependencies; Node 20+.
//
//   BRAIN_TOKEN=brain_pat_… npm run smoke                 # discovery + read checks
//   BRAIN_TOKEN=brain_pat_… npm run smoke -- --write      # also park + compost a [smoke] idea
//   BRAIN_TOKEN=brain_pat_… npm run smoke -- --expect-401 # after revoking: must be refused
//   npm run smoke -- --oauth [--write] [--revoke]         # full OAuth flow via a loopback redirect
//   BRAIN_TOKEN=brain_pat_… npm run smoke -- --modern     # also check the MCP 2026-07-28 (stateless) path
//
// BRAIN_MCP_URL defaults to the production Worker's /mcp endpoint.
// Tokens are never printed.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const MCP_URL = process.env.BRAIN_MCP_URL ?? 'https://2nd-brain-mcp.simon-lee.workers.dev/mcp';
const BASE = new URL(MCP_URL).origin;
const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const EXPECT_401 = args.has('--expect-401');
const OAUTH = args.has('--oauth');
const REVOKE = args.has('--revoke');
const MODERN = args.has('--modern');
const MODERN_VERSION = '2026-07-28';

let failures = 0;
const pass = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const check = (cond, msg) => (cond ? pass(msg) : fail(msg));

let rpcId = 0;
async function rpc(token, method, params = {}) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

// MCP 2026-07-28: no initialize; version, capabilities and client info
// travel in _meta and are mirrored into headers.
async function rpcModern(token, method, params = {}, version = MODERN_VERSION) {
  const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : null;
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': version,
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': version,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: '2nd-brain-smoke', version: '1.0.0' },
        },
      },
    }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function modernChecks(token) {
  console.log(`MCP ${MODERN_VERSION} (stateless)`);
  const d = await rpcModern(token, 'server/discover');
  check(
    d.status === 200 && d.body?.result?.resultType === 'complete' && d.body.result.supportedVersions?.[0] === MODERN_VERSION,
    'server/discover',
  );
  check(d.body?.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name === '2nd-brain', 'serverInfo in _meta');
  const tl = await rpcModern(token, 'tools/list');
  check(tl.status === 200 && tl.body?.result?.ttlMs > 0 && tl.body.result.cacheScope === 'private', 'tools/list with cache hints');
  const rp = await rpcModern(token, 'tools/call', { name: 'read_protocol', arguments: { name: 'idea-parking-lot', section: '§1' } });
  check(rp.status === 200 && (rp.body?.result?.content?.[0]?.text ?? '').startsWith('## §1'), 'tools/call read_protocol');
  const bad = await rpcModern(token, 'tools/list', {}, '2099-01-01');
  check(bad.status === 400 && bad.body?.error?.code === -32022 && Array.isArray(bad.body.error.data?.supported), 'unsupported version → 400 / -32022');
}

async function callTool(token, name, toolArgs) {
  const r = await rpc(token, 'tools/call', { name, arguments: toolArgs });
  if (r.status !== 200 || !r.body?.result) throw new Error(`${name}: HTTP ${r.status} ${JSON.stringify(r.body?.error ?? '')}`);
  const text = r.body.result.content?.[0]?.text ?? '';
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: !!r.body.result.isError, text, json };
}

async function discovery() {
  console.log(`Discovery (${BASE})`);
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  const prmBody = prm.ok ? await prm.json() : null;
  check(prmBody?.resource === MCP_URL, `protected-resource metadata names ${MCP_URL}`);
  const as = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  const asBody = as.ok ? await as.json() : null;
  check(asBody?.issuer === BASE, 'authorization-server metadata issuer');
  check(asBody?.grant_types_supported?.includes('refresh_token'), 'refresh_token grant advertised');
  check(!asBody || !('client_id_metadata_document_supported' in asBody), 'no CIMD advertised (Gemini Spark)');
  const pre = await fetch(MCP_URL, { method: 'OPTIONS' });
  check(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'CORS preflight on /mcp');
  const anon = await fetch(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check(
    anon.status === 401 && (anon.headers.get('www-authenticate') ?? '').includes('oauth-protected-resource/mcp'),
    '401 without a token points at the resource metadata',
  );
  return asBody;
}

async function reads(token) {
  console.log('MCP session');
  const init = await rpc(token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: '2nd-brain-smoke', version: '1.0.0' },
  });
  if (init.status !== 200) {
    fail(`initialize: HTTP ${init.status}`);
    return false;
  }
  check(init.body?.result?.serverInfo?.name === '2nd-brain', `initialize (protocol ${init.body?.result?.protocolVersion})`);
  check((init.body?.result?.instructions ?? '').length <= 2048, 'instructions fit in 2,048 characters');
  await rpc(token, 'notifications/initialized');

  const list = await rpc(token, 'tools/list');
  const tools = list.body?.result?.tools ?? [];
  check(tools.length > 0 && tools.length <= 40, `tools/list: ${tools.length} tools (≤ 40 for Cursor)`);
  check(tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'), 'every tool has annotations');
  check(tools.some((t) => t.name === 'read_protocol'), 'read_protocol available');

  const proto = await callTool(token, 'read_protocol', { name: 'idea-parking-lot', section: '§1' });
  check(!proto.isError && proto.text.startsWith('## §1'), 'read_protocol idea-parking-lot §1');
  const ideas = await callTool(token, 'list_ideas', { limit: 1 });
  check(!ideas.isError, 'list_ideas (read)');
  return true;
}

async function writes(token) {
  console.log('Write round-trip');
  const stamp = new Date().toISOString();
  const parked = await callTool(token, 'park_idea', {
    title: `[smoke] ${stamp}`,
    thoughts: 'Synthetic smoke-test idea. Safe to delete.',
    tags: ['smoke'],
    idempotency_key: `smoke-${stamp}`,
    captured_via: { client: '2nd-brain-smoke' },
  });
  check(!parked.isError && parked.json?.idea_id, 'park_idea [smoke]');
  if (!parked.json?.idea_id) return;
  const got = await callTool(token, 'get_idea', { id: parked.json.idea_id });
  const via = got.json?.idea?.captured_via ?? got.json?.captured_via;
  check(typeof via?.credential === 'string' && via.credential.length > 0, `attributed to credential "${via?.credential}"`);
  const composted = await callTool(token, 'update_idea', { id: parked.json.idea_id, status: 'composted' });
  check(!composted.isError, 'update_idea → composted');
}

async function oauthFlow(asMeta) {
  console.log('OAuth (loopback)');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(12).toString('base64url');

  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const reg = await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: '2nd-brain smoke test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  });
  const client = await reg.json();
  check(reg.status === 201 && client.client_id, 'dynamic client registration');

  const auth = new URL(asMeta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp offline_access',
    resource: MCP_URL,
  })) {
    auth.searchParams.set(k, v);
  }
  console.log(`\n  Open this URL, approve with the owner secret (label it e.g. "smoke"):\n\n  ${auth}\n`);

  const params = await new Promise((resolve) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Done — return to the terminal.');
      resolve(u.searchParams);
    });
  });
  server.close();
  check(!params.get('error'), `authorization ${params.get('error') ?? 'approved'}`);
  check(params.get('state') === state, 'state echoed exactly');
  check(params.get('iss') === asMeta.issuer, 'iss matches the issuer (RFC 9207)');
  if (params.get('error')) return null;

  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code'),
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      resource: MCP_URL,
    }),
  });
  const tokens = await tokenRes.json();
  check(tokenRes.status === 200 && tokens.access_token && tokens.refresh_token, 'code exchanged for access + refresh tokens');

  const refreshed = await fetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
  });
  const pair = await refreshed.json();
  check(refreshed.status === 200 && pair.refresh_token && pair.refresh_token !== tokens.refresh_token, 'refresh token rotates');
  return { ...pair, clientId: client.client_id };
}

async function main() {
  console.log(`2nd-brain smoke test → ${MCP_URL}\n`);
  const asMeta = await discovery();

  let token = process.env.BRAIN_TOKEN;
  let oauth = null;
  if (OAUTH) {
    if (!asMeta) throw new Error('no authorization-server metadata');
    oauth = await oauthFlow(asMeta);
    token = oauth?.access_token;
  }
  if (!token) {
    console.log('\nSet BRAIN_TOKEN (a PAT from /tokens) or pass --oauth.');
    process.exit(failures ? 1 : 0);
  }

  if (EXPECT_401) {
    const r = await rpc(token, 'tools/list');
    check(r.status === 401, `token refused (HTTP ${r.status})`);
  } else if (await reads(token)) {
    if (WRITE) await writes(token);
    if (MODERN) await modernChecks(token);
  }

  if (oauth && REVOKE) {
    await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: oauth.refresh_token }),
    });
    const r = await rpc(token, 'tools/list');
    check(r.status === 401, 'revoked via /revoke; access token now refused');
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nsmoke test crashed: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});

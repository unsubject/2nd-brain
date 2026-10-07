import { describe, it, expect } from 'vitest';
import { handleMcpRequest } from '../src/mcp';
import type { Env } from '../src/env';

const TOKEN = 'test-token';

const IDEA_WRITE_TOOLS = [
  'park_idea',
  'import_ideas',
  'update_idea',
  'propose_idea_links',
  'decide_idea_links',
  'create_synthesis',
];
const IDEA_TOOLS = [
  ...IDEA_WRITE_TOOLS,
  'list_subjects_for_import',
  'get_idea',
  'list_ideas',
  'search_ideas',
  'garden_ideas',
  'list_idea_links',
  'export_idea_map',
  'explore_topic',
];

// Minimal Env stub. The dispatcher cases below never touch Hyperdrive
// (resources/* + tools/list don't hit DB), so the connectionString is
// just a placeholder.
const env: Env = {
  HYPERDRIVE: { connectionString: 'postgres://unused' },
  BRAIN_MCP_TOKEN: TOKEN,
  BRAIN_USER_ID: 'test-user',
  OPENAI_API_KEY: 'sk-test-not-used',
} as unknown as Env;

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function rpc(method: string, params: unknown = {}, id: number = 1) {
  const req = new Request('https://test.example/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const res = await handleMcpRequest(req, env, ctx);
  return (await res.json()) as {
    jsonrpc: '2.0';
    id: number | null;
    result?: any;
    error?: { code: number; message: string; data?: unknown };
  };
}

describe('mcp dispatcher', () => {
  it('rejects requests with a wrong bearer', async () => {
    const req = new Request('https://test.example/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const res = await handleMcpRequest(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('tools/list includes the core surface', async () => {
    const r = await rpc('tools/list');
    const names = (r.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('search_brain');
    expect(names).toContain('list_constitution_domains');
    expect(names).toContain('list_goals');
  });

  it('tools/list includes the Idea Parking Lot surface with guarded write tools', async () => {
    const r = await rpc('tools/list');
    const tools = r.result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of IDEA_TOOLS) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)!.inputSchema.type).toBe('object');
    }
    for (const name of IDEA_WRITE_TOOLS) {
      expect(byName.get(name)!.description, name).toContain('ONLY');
    }
    // Tool names stay unique across the whole registry.
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it('initialize instructions mention the idea protocol resource', async () => {
    const r = await rpc('initialize');
    expect(r.result.instructions).toContain('second-brain://protocol/idea-parking-lot');
  });

  it('initialize instructions describe the Idea Garden v2 flow, not one-way capture', async () => {
    const r = await rpc('initialize');
    const text = r.result.instructions as string;
    // Capture is no longer one-way (refocus D3, D12): receipt first, then proposals.
    expect(text).not.toContain('never suggesting links at capture');
    expect(text).not.toContain('receipt only');
    expect(text).toContain('receipt first');
    expect(text).toContain("propose_idea_links (origin 'capture')");
    expect(text).toContain('weekly garden review');
    // Free gardening ("let's garden") is not a review: it needs the protocol too.
    expect(text).toContain('Before capturing, gardening or reviewing, mapping or importing');
    // "What do I have on X?" goes to the cluster query; the map is the HTML file.
    expect(text).toContain('explore_topic');
    expect(text).toContain("export_idea_map(format:'html')");
    expect(text).toContain('search_brain');
  });

  it('resources/list returns the protocol resources', async () => {
    const r = await rpc('resources/list');
    const resources = r.result.resources as Array<{ uri: string; mimeType: string }>;
    expect(resources).toHaveLength(2);
    expect(resources.map((x) => x.uri)).toEqual([
      'second-brain://protocol/goal-amendment',
      'second-brain://protocol/idea-parking-lot',
    ]);
    for (const res of resources) expect(res.mimeType).toBe('text/markdown');
  });

  it('resources/read returns the idea protocol with its executable sections', async () => {
    const r = await rpc('resources/read', { uri: 'second-brain://protocol/idea-parking-lot' });
    const text = (r.result.contents as Array<{ text: string }>)[0].text;
    for (const heading of ['## §0', '## §1', '## §2', '## §3', '## §4', '## §5', '## §6']) {
      expect(text).toContain(heading);
    }
  });

  it('resources/read returns the doc text for a known uri', async () => {
    const r = await rpc('resources/read', { uri: 'second-brain://protocol/goal-amendment' });
    const contents = r.result.contents as Array<{ uri: string; text: string }>;
    expect(contents).toHaveLength(1);
    expect(contents[0].text.length).toBeGreaterThan(100);
  });

  it('resources/read on an unknown uri returns JSON-RPC -32602', async () => {
    const r = await rpc('resources/read', { uri: 'bogus://nothing' });
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(-32602);
  });

  it('resources/read without a uri argument returns -32602', async () => {
    const r = await rpc('resources/read', {});
    expect(r.error?.code).toBe(-32602);
  });

  it('unknown method returns -32601', async () => {
    const r = await rpc('this/does/not/exist');
    expect(r.error?.code).toBe(-32601);
  });
});

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request('https://test.example/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return handleMcpRequest(req, env, ctx);
}

describe('mcp transport compatibility', () => {
  it('answers CORS preflight without auth and refuses GET with 405', async () => {
    const pre = await handleMcpRequest(new Request('https://test.example/mcp', { method: 'OPTIONS' }), env, ctx);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    const get = await handleMcpRequest(new Request('https://test.example/mcp', { method: 'GET' }), env, ctx);
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toContain('POST');
  });

  it('answers a tokenless HEAD with the discovery challenge (Gemini Spark probe)', async () => {
    const head = await handleMcpRequest(new Request('https://test.example/mcp', { method: 'HEAD' }), env, ctx);
    expect(head.status).toBe(401);
    const challenge = head.headers.get('WWW-Authenticate')!;
    expect(challenge).toContain('resource_metadata="https://test.example/.well-known/oauth-protected-resource/mcp"');
    expect(challenge).not.toContain('error=');
    const withToken = await handleMcpRequest(
      new Request('https://test.example/mcp', { method: 'HEAD', headers: { Authorization: `Bearer ${TOKEN}` } }),
      env,
      ctx,
    );
    expect(withToken.status).toBe(405);
    expect(withToken.headers.get('Allow')).toContain('POST');
  });

  it('401s carry the protected-resource metadata pointer and CORS headers', async () => {
    const res = await handleMcpRequest(
      new Request('https://test.example/mcp', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="https://test.example/.well-known/oauth-protected-resource/mcp"',
    );
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');
  });

  it('negotiates the protocol version', async () => {
    for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
      const r = await rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } });
      expect(r.result.protocolVersion).toBe(v);
    }
    const r = await rpc('initialize', { protocolVersion: '1999-01-01' });
    expect(r.result.protocolVersion).toBe('2025-11-25');
    expect(r.result.serverInfo.name).toBe('2nd-brain');
    expect(r.result.instructions).toContain("read_protocol('idea-parking-lot')");
  });

  it('accepts notifications with 202 and no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('ignores JSON-RPC responses sent by the client', async () => {
    const res = await post({ jsonrpc: '2.0', id: 9, result: {} });
    expect(res.status).toBe(202);
  });

  it('handles bounded batches, dropping notification replies', async () => {
    const res = await post([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'nope' },
    ]);
    const body = (await res.json()) as Array<{ id: number; result?: unknown; error?: { code: number } }>;
    expect(body.map((b) => b.id)).toEqual([1, 2]);
    expect(body[0].result).toEqual({});
    expect(body[1].error?.code).toBe(-32601);
    const empty = (await (await post([])).json()) as { error: { code: number } };
    expect(empty.error.code).toBe(-32600);
    const tooMany = (await (await post(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })))).json()) as {
      error: { code: number };
    };
    expect(tooMany.error.code).toBe(-32600);
  });

  it('returns a parse error for malformed JSON', async () => {
    const body = (await (await post('{not json')).json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('serves tools/list without a prior initialize, with titles and annotations', async () => {
    const r = await rpc('tools/list');
    const t = (r.result.tools as Array<any>).find((x) => x.name === 'park_idea');
    expect(t.title).toBe(t.annotations.title);
    expect(t.annotations.readOnlyHint).toBe(false);
    const read = (r.result.tools as Array<any>).find((x) => x.name === 'get_idea');
    expect(read.annotations.readOnlyHint).toBe(true);
  });

  it('answers the optional list methods some clients probe', async () => {
    expect((await rpc('prompts/list')).result).toEqual({ prompts: [] });
    expect((await rpc('resources/templates/list')).result).toEqual({ resourceTemplates: [] });
    expect((await rpc('logging/setLevel', { level: 'info' })).result).toEqual({});
  });

  it('read_protocol serves whole docs and single sections', async () => {
    const whole = await rpc('tools/call', { name: 'read_protocol', arguments: { name: 'idea-parking-lot' } });
    expect(whole.result.content[0].text).toContain('## §1');
    const one = await rpc('tools/call', { name: 'read_protocol', arguments: { name: 'idea-parking-lot', section: '§2' } });
    const text = one.result.content[0].text as string;
    expect(text.startsWith('## §2')).toBe(true);
    expect(text).not.toContain('## §3');
    const loose = await rpc('tools/call', { name: 'read_protocol', arguments: { name: 'idea-parking-lot', section: '2' } });
    expect(loose.result.content[0].text).toBe(text);
    const missing = await rpc('tools/call', { name: 'read_protocol', arguments: { name: 'idea-parking-lot', section: '§99' } });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain('§1');
    const goal = await rpc('tools/call', { name: 'read_protocol', arguments: { name: 'goal-amendment', section: '1A' } });
    expect(goal.result.isError).toBeFalsy();
  });
});

const MODERN = '2026-07-28';

async function modern(
  method: string,
  params: Record<string, unknown> = {},
  o: { version?: string; headers?: Record<string, string>; meta?: Record<string, unknown> | null; id?: number } = {},
) {
  const version = o.version ?? MODERN;
  const _meta =
    o.meta === null
      ? undefined
      : {
          'io.modelcontextprotocol/protocolVersion': version,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'modern-client', version: '1.0.0' },
          ...(o.meta ?? {}),
        };
  const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined;
  const res = await post(
    { jsonrpc: '2.0', id: o.id ?? 7, method, params: { ...params, ...(_meta ? { _meta } : {}) } },
    {
      'MCP-Protocol-Version': version,
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
      ...(o.headers ?? {}),
    },
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}

describe('MCP 2026-07-28 (stateless) alongside 2025-era clients', () => {
  it('serves server/discover', async () => {
    const r = await modern('server/discover');
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({
      resultType: 'complete',
      capabilities: { tools: {}, resources: {} },
      ttlMs: 300000,
      cacheScope: 'private',
    });
    expect(r.body.result.supportedVersions[0]).toBe(MODERN);
    expect(r.body.result.supportedVersions).toContain('2025-11-25');
    expect(r.body.result.instructions).toContain('read_protocol');
    expect(r.body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('2nd-brain');
  });

  it('serves lists, reads and calls statelessly with cache hints', async () => {
    const tl = await modern('tools/list');
    expect(tl.status).toBe(200);
    const legacy = await rpc('tools/list');
    expect(tl.body.result.tools.map((t: any) => t.name)).toEqual(legacy.result.tools.map((t: any) => t.name));
    expect(tl.body.result).toMatchObject({ resultType: 'complete', ttlMs: 300000, cacheScope: 'private' });
    for (const m of ['resources/list', 'resources/templates/list', 'prompts/list']) {
      expect((await modern(m)).body.result).toMatchObject({ resultType: 'complete', cacheScope: 'private' });
    }
    const read = await modern('resources/read', { uri: 'second-brain://protocol/idea-parking-lot' });
    expect(read.body.result.contents[0].text).toContain('## §1');
    expect(read.body.result.ttlMs).toBe(300000);
    const call = await modern('tools/call', { name: 'read_protocol', arguments: { name: 'idea-parking-lot', section: '§1' } });
    expect(call.status).toBe(200);
    expect(call.body.result.resultType).toBe('complete');
    expect(call.body.result.content[0].text.startsWith('## §1')).toBe(true);
    expect(call.body.result).not.toHaveProperty('ttlMs');
  });

  it('answers 2026 errors with HTTP 400 and no version text in the message', async () => {
    const unsupported = await modern('tools/list', {}, { version: '2099-01-01' });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error).toMatchObject({ code: -32022, data: { requested: '2099-01-01' } });
    expect(unsupported.body.error.data.supported).toContain(MODERN);
    expect(unsupported.body.error.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    const noCaps = await modern('tools/list', {}, { meta: { 'io.modelcontextprotocol/clientCapabilities': undefined } });
    expect([noCaps.status, noCaps.body.error.code]).toEqual([400, -32602]);
    const bare = await modern('server/discover', {}, { meta: null });
    expect([bare.status, bare.body.error.code]).toEqual([400, -32602]);
    expect(bare.body.error.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    const wrongMethod = await modern('tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } });
    expect([wrongMethod.status, wrongMethod.body.error.code]).toEqual([400, -32020]);
    const wrongName = await modern('tools/call', { name: 'read_protocol', arguments: {} }, { headers: { 'Mcp-Name': 'get_idea' } });
    expect([wrongName.status, wrongName.body.error.code]).toEqual([400, -32020]);
    // A 2025 version in the 2026-only _meta key is a modern request with an
    // unsupported version (-32022 here, as the header matches it).
    const legacyInMeta = await modern('tools/list', {}, { version: '2025-11-25' });
    expect([legacyInMeta.status, legacyInMeta.body.error.code]).toEqual([400, -32022]);
    const proto = await modern('constructor');
    expect([proto.status, proto.body.error.code]).toEqual([404, -32601]);
    const wrongVersion = await modern('tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-11-25' } });
    expect([wrongVersion.status, wrongVersion.body.error.code]).toEqual([400, -32020]);
  });

  it('answers removed and unknown methods with 404 / -32601', async () => {
    for (const m of ['ping', 'logging/setLevel', 'no/such/method']) {
      const r = await modern(m);
      expect([r.status, r.body.error.code]).toEqual([404, -32601]);
    }
    const cursor = await modern('tools/list', { cursor: 'abc' });
    expect([cursor.status, cursor.body.error.code]).toEqual([200, -32602]);
  });

  it('refuses batches that contain a 2026 message, accepts 2026 notifications', async () => {
    const res = await post([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'server/discover', params: {} },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32600);
    const note = await post(
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } },
      { 'MCP-Protocol-Version': MODERN },
    );
    expect(note.status).toBe(202);
  });

  it('leaves 2025-era behaviour byte-for-byte unchanged', async () => {
    const list = await rpc('tools/list');
    expect(Object.keys(list.result)).toEqual(['tools']);
    const init = await rpc('initialize', { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(Object.keys(init.result).sort()).toEqual(['capabilities', 'instructions', 'protocolVersion', 'serverInfo']);
    expect(init.result.protocolVersion).toBe('2025-11-25');
    // An unknown version header on a legacy request is not a 2026 error.
    const res = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'MCP-Protocol-Version': '2099-01-01' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.tools.length).toBeGreaterThan(0);
    expect((await rpc('ping')).result).toEqual({});
    expect((await rpc('no/such/method')).error?.code).toBe(-32601);
  });

  it('lets browsers send the 2026 headers', async () => {
    const pre = await handleMcpRequest(new Request('https://test.example/mcp', { method: 'OPTIONS' }), env, ctx);
    const allowed = pre.headers.get('Access-Control-Allow-Headers')!;
    expect(allowed).toContain('Mcp-Method');
    expect(allowed).toContain('Mcp-Name');
  });
});

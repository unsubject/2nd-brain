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
    expect(r.result.instructions).toContain('2nd-brain://protocol/idea-parking-lot');
  });

  it('resources/list returns the protocol resources', async () => {
    const r = await rpc('resources/list');
    const resources = r.result.resources as Array<{ uri: string; mimeType: string }>;
    expect(resources).toHaveLength(2);
    expect(resources.map((x) => x.uri)).toEqual([
      '2nd-brain://protocol/goal-amendment',
      '2nd-brain://protocol/idea-parking-lot',
    ]);
    for (const res of resources) expect(res.mimeType).toBe('text/markdown');
  });

  it('resources/read returns the idea protocol with its executable sections', async () => {
    const r = await rpc('resources/read', { uri: '2nd-brain://protocol/idea-parking-lot' });
    const text = (r.result.contents as Array<{ text: string }>)[0].text;
    for (const heading of ['## §0', '## §1', '## §2', '## §3', '## §4', '## §5', '## §6']) {
      expect(text).toContain(heading);
    }
  });

  it('resources/read returns the doc text for a known uri', async () => {
    const r = await rpc('resources/read', { uri: '2nd-brain://protocol/goal-amendment' });
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

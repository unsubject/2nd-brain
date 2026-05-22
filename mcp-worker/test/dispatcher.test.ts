import { describe, it, expect } from 'vitest';
import { handleMcpRequest } from '../src/mcp';
import type { Env } from '../src/env';

const TOKEN = 'test-token';

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

  it('resources/list returns the goal-amendment protocol resource', async () => {
    const r = await rpc('resources/list');
    const resources = r.result.resources as Array<{ uri: string; mimeType: string }>;
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe('2nd-brain://protocol/goal-amendment');
    expect(resources[0].mimeType).toBe('text/markdown');
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

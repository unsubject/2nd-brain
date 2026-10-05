import { describe, it, expect } from 'vitest';
import { decodeHeaderValue, decorateModern, messageEra, readModernHeaders, validateModern, type ModernHeaders } from '../src/protocol';
import { RpcError } from '../src/rpc';

const ALL = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const meta = (v: unknown = '2026-07-28', extra: Record<string, unknown> = {}) => ({
  'io.modelcontextprotocol/protocolVersion': v,
  'io.modelcontextprotocol/clientCapabilities': {},
  ...extra,
});
const headers = (h: Partial<ModernHeaders> = {}): ModernHeaders => ({
  protocolVersion: '2026-07-28',
  method: 'tools/list',
  name: null,
  ...h,
});

describe('messageEra', () => {
  it('server/discover, the 2026-only _meta key or a 2026 header make a message modern', () => {
    expect(messageEra({ method: 'server/discover' }, null)).toBe('modern');
    expect(messageEra({ method: 'tools/list', params: { _meta: meta() } }, null)).toBe('modern');
    expect(messageEra({ method: 'tools/list', params: { _meta: meta('2099-01-01') } }, null)).toBe('modern');
    // The _meta key is 2026-only: naming a 2025 version there is a modern
    // request that gets -32022, not a legacy result without resultType.
    expect(messageEra({ method: 'tools/list', params: { _meta: meta('2025-11-25') } }, null)).toBe('modern');
    expect(messageEra({ method: 'tools/list' }, '2026-07-28')).toBe('modern');
  });

  it('keeps initialize, legacy headers and other _meta keys legacy', () => {
    expect(messageEra({ method: 'initialize', params: { _meta: meta() } }, '2026-07-28')).toBe('legacy');
    expect(messageEra({ method: 'tools/call', params: { _meta: { progressToken: 1 } } }, '2025-11-25')).toBe('legacy');
    expect(messageEra({ method: 'tools/list' }, '2025-06-18')).toBe('legacy');
    expect(messageEra({ method: 'tools/list' }, '2099-01-01')).toBe('legacy');
    expect(messageEra({ method: 'tools/list' }, null)).toBe('legacy');
  });

  it('never throws on malformed messages', () => {
    for (const m of [null, 42, 'x', [], { params: 'nope' }, { params: { _meta: [] } }, { method: 1 }]) {
      expect(messageEra(m, null)).toBe('legacy');
    }
  });
});

describe('readModernHeaders', () => {
  it('strips surrounding spaces and tabs the runtime left in', () => {
    // A stub: fetch Headers already normalise, the raw request path may not.
    const raw: Record<string, string> = { 'MCP-Protocol-Version': '2026-07-28 \t', 'Mcp-Method': ' tools/call', 'Mcp-Name': 'get_idea\t' };
    const req = { headers: { get: (n: string) => raw[n] ?? null } } as unknown as Request;
    expect(readModernHeaders(req)).toEqual({ protocolVersion: '2026-07-28', method: 'tools/call', name: 'get_idea' });
    const none = { headers: { get: () => null } } as unknown as Request;
    expect(readModernHeaders(none)).toEqual({ protocolVersion: null, method: null, name: null });
  });
});

describe('validateModern', () => {
  const fails = (method: string, params: Record<string, unknown>, h: ModernHeaders) => {
    try {
      validateModern(method, params, h, ALL);
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      const err = e as RpcError;
      expect(err.httpStatus).toBe(400);
      // Claude Code misreads error messages that mention a version.
      expect(err.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      return { code: err.code, data: err.data };
    }
    throw new Error('expected a validation error');
  };

  it('accepts a well-formed request', () => {
    expect(() => validateModern('tools/list', { _meta: meta() }, headers(), ALL)).not.toThrow();
    expect(() =>
      validateModern('tools/call', { name: 'get_idea', _meta: meta() }, headers({ method: 'tools/call', name: 'get_idea' }), ALL),
    ).not.toThrow();
  });

  it('rejects missing _meta fields with -32602', () => {
    expect(fails('tools/list', {}, headers()).code).toBe(-32602);
    expect(fails('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }, headers()).code).toBe(-32602);
  });

  it('rejects missing or mismatched headers with -32020', () => {
    expect(fails('tools/list', { _meta: meta() }, headers({ protocolVersion: null })).code).toBe(-32020);
    expect(fails('tools/list', { _meta: meta() }, headers({ protocolVersion: '2025-11-25' })).code).toBe(-32020);
    expect(fails('tools/list', { _meta: meta() }, headers({ method: null })).code).toBe(-32020);
    expect(fails('tools/list', { _meta: meta() }, headers({ method: 'tools/call' })).code).toBe(-32020);
    const call = (name: string | null) =>
      fails('tools/call', { name: 'get_idea', _meta: meta() }, headers({ method: 'tools/call', name }));
    expect(call(null).code).toBe(-32020);
    expect(call('other').code).toBe(-32020);
    expect(call('=?base64?not base64?=').code).toBe(-32020);
  });

  it('rejects raw non-ASCII header values and prototype-member method names correctly', () => {
    const uri = 'x://é';
    expect(fails('resources/read', { uri, _meta: meta() }, headers({ method: 'resources/read', name: uri })).code).toBe(-32020);
    // An inherited property name is just an unknown method, not a tools/call.
    for (const m of ['constructor', 'toString', '__proto__']) {
      expect(() => validateModern(m, { _meta: meta() }, headers({ method: m }), ALL)).not.toThrow();
    }
  });

  it('rejects an unsupported version with -32022 and the supported list', () => {
    const e = fails('tools/list', { _meta: meta('2099-01-01') }, headers({ protocolVersion: '2099-01-01' }));
    expect(e).toEqual({ code: -32022, data: { supported: ALL, requested: '2099-01-01' } });
  });

  it('decodes base64-sentinel Mcp-Name values', () => {
    const uri = 'second-brain://protocol/idea-parking-lot';
    const encoded = `=?base64?${btoa(uri)}?=`;
    expect(decodeHeaderValue(encoded)).toBe(uri);
    expect(() =>
      validateModern('resources/read', { uri, _meta: meta() }, headers({ method: 'resources/read', name: encoded }), ALL),
    ).not.toThrow();
    const cjk = '想法';
    const enc = `=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode(cjk)))}?=`;
    expect(decodeHeaderValue(enc)).toBe(cjk);
    expect(decodeHeaderValue('plain')).toBe('plain');
  });
});

describe('decorateModern', () => {
  const info = { name: '2nd-brain', version: '0.1.0' };
  it('adds resultType and serverInfo to every result, cache hints to cacheable ones', () => {
    const list = decorateModern('tools/list', { tools: [] }, info);
    expect(list).toMatchObject({ tools: [], resultType: 'complete', ttlMs: 300000, cacheScope: 'private' });
    expect((list._meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']).toEqual(info);
    const call = decorateModern('tools/call', { content: [], isError: true }, info);
    expect(call).toMatchObject({ resultType: 'complete', isError: true });
    expect(call).not.toHaveProperty('ttlMs');
  });
});

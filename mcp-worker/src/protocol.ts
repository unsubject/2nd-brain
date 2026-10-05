// MCP 2026-07-28 ("modern", stateless) alongside the 2025-era protocol
// ("legacy", initialize handshake). See docs/phase-mcp-multi-client-spec.md §6.
//
// A message is served the modern way only when it says so explicitly:
// method server/discover, the io.modelcontextprotocol/protocolVersion key in
// params._meta (any value), or a 2026 MCP-Protocol-Version header.
// `initialize` is always legacy, and a legacy message never sees a 2026-only
// error or field — 2026 clients probe with a modern request and fall back to
// initialize on anything they don't recognise as a modern error, so legacy
// behaviour must stay exactly as it was.
//
// Error messages never contain a version string: Claude Code misreads a
// message mentioning one as coming from a modern server. Versions go in
// `data` only.

import { RpcError } from './rpc';

export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

// How long a modern client may treat list/read/discover results as fresh.
export const MODERN_CACHE_TTL_MS = 5 * 60 * 1000;

// Results that MUST carry ttlMs/cacheScope (2026-07-28 server/utilities/caching).
const CACHEABLE = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

// Requests whose name/uri is mirrored into the Mcp-Name header.
const NAME_PARAM: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

export type Era = 'legacy' | 'modern';

export type ModernHeaders = {
  protocolVersion: string | null;
  method: string | null;
  name: string | null;
};

// Field values exclude surrounding spaces and tabs (RFC 9110 §5.5); not every
// runtime strips the trailing ones.
const header = (request: Request, name: string): string | null =>
  request.headers.get(name)?.replace(/^[ \t]+|[ \t]+$/g, '') ?? null;

export function readModernHeaders(request: Request): ModernHeaders {
  return {
    protocolVersion: header(request, 'MCP-Protocol-Version'),
    method: header(request, 'Mcp-Method'),
    name: header(request, 'Mcp-Name'),
  };
}

const isModernVersion = (v: unknown): boolean =>
  typeof v === 'string' && (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(v);

function metaOf(msg: unknown): Record<string, unknown> | null {
  const params = (msg as { params?: unknown } | null)?.params;
  const meta = params && typeof params === 'object' ? (params as { _meta?: unknown })._meta : undefined;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
}

// The protocolVersion _meta key only exists from 2026-07-28 on, so its
// presence alone marks a modern request, whatever it holds. A value that
// isn't 2026-07-28 is then rejected by validateModern: -32602 if it isn't a
// string, -32020 if the header is missing or differs, else -32022 (whose
// data.supported tells the client to retry with 2026-07-28).
export function messageEra(msg: unknown, headerVersion: string | null): Era {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'legacy';
  const method = (msg as { method?: unknown }).method;
  if (method === 'initialize') return 'legacy';
  if (method === 'server/discover') return 'modern';
  if (metaOf(msg)?.[META.protocolVersion] !== undefined) return 'modern';
  return isModernVersion(headerVersion) ? 'modern' : 'legacy';
}

// RFC 2047-style sentinel for header values that aren't plain ASCII.
export function decodeHeaderValue(v: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    const bin = atob(m[1]);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

const bad = (code: number, message: string, data?: unknown) => new RpcError(code, message, data, 400);

// RFC 9110 field values: visible ASCII, space and tab. Anything else must
// arrive base64-encoded (=?base64?…?=) and is a validation failure.
const INVALID_HEADER_CHARS = /[^\x20-\x7e\t]/;

// Throws an RpcError (HTTP 400) when a modern request is malformed:
// -32602 for missing _meta fields, -32020 for missing or mismatched
// headers, -32022 for an unsupported version.
export function validateModern(
  method: string,
  params: Record<string, unknown>,
  headers: ModernHeaders,
  allVersions: readonly string[],
): void {
  const meta = metaOf({ params });
  const version = meta?.[META.protocolVersion];
  if (typeof version !== 'string') {
    throw bad(-32602, `Invalid params: _meta["${META.protocolVersion}"] is required`);
  }
  if (headers.protocolVersion === null) {
    throw bad(-32020, 'Header mismatch: the MCP-Protocol-Version header is required');
  }
  if (headers.protocolVersion !== version) {
    throw bad(-32020, 'Header mismatch: MCP-Protocol-Version does not match the protocol version in _meta');
  }
  if (!isModernVersion(version)) {
    throw bad(-32022, 'Unsupported protocol version', { supported: [...allVersions], requested: version });
  }
  const caps = meta?.[META.clientCapabilities];
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    throw bad(-32602, `Invalid params: _meta["${META.clientCapabilities}"] is required`);
  }
  if (headers.method === null) throw bad(-32020, 'Header mismatch: the Mcp-Method header is required');
  if (INVALID_HEADER_CHARS.test(headers.method)) throw bad(-32020, 'Header mismatch: Mcp-Method contains invalid characters');
  if (headers.method !== method) throw bad(-32020, 'Header mismatch: Mcp-Method does not match the request method');
  const nameParam = Object.hasOwn(NAME_PARAM, method) ? NAME_PARAM[method] : undefined;
  if (nameParam) {
    if (headers.name === null) throw bad(-32020, 'Header mismatch: the Mcp-Name header is required');
    if (INVALID_HEADER_CHARS.test(headers.name)) throw bad(-32020, 'Header mismatch: Mcp-Name contains invalid characters');
    const decoded = decodeHeaderValue(headers.name);
    if (decoded === null || decoded !== params[nameParam]) {
      throw bad(-32020, `Header mismatch: Mcp-Name does not match params.${nameParam}`);
    }
  }
}

export function decorateModern(
  method: string,
  result: unknown,
  serverInfo: Record<string, unknown>,
): Record<string, unknown> {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const meta = r._meta && typeof r._meta === 'object' ? (r._meta as Record<string, unknown>) : {};
  return {
    ...r,
    resultType: 'complete',
    // Lists are filtered per credential; everything here is behind auth.
    ...(CACHEABLE.has(method) ? { ttlMs: MODERN_CACHE_TTL_MS, cacheScope: 'private' } : {}),
    _meta: { ...meta, [META.serverInfo]: serverInfo },
  };
}

export function modernClientInfo(params: Record<string, unknown>): Record<string, unknown> | null {
  const ci = metaOf({ params })?.[META.clientInfo];
  return ci && typeof ci === 'object' && !Array.isArray(ci) ? (ci as Record<string, unknown>) : null;
}

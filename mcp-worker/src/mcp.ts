import type { Env } from './env';
import { tools } from './tools/registry';
import { listResources, readResource, ResourceNotFoundError } from './resources';
import { authDb, authenticate, unauthorized } from './auth/middleware';
import { bearerFrom } from './auth/tokens';
import { scopeAllows, type Principal } from './auth/principal';
import { extractResultIds, recordActivity, type CallEntry } from './calllog';
import { CORS_HEADERS, corsPreflight, withCors } from './http';
import { RpcError } from './rpc';
import {
  decorateModern,
  messageEra,
  MODERN_PROTOCOL_VERSIONS,
  modernClientInfo,
  readModernHeaders,
  validateModern,
  type Era,
  type ModernHeaders,
} from './protocol';

// Newest first. The client's requested version is echoed when supported,
// otherwise we answer with the newest and let the client decide.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
// Every version this server speaks, newest first (server/discover, -32022).
export const ALL_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...SUPPORTED_PROTOCOL_VERSIONS];
const SERVER_INFO = { name: '2nd-brain', title: "Simon's 2nd-brain", version: '0.1.0' };
const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { listChanged: false, subscribe: false },
};
// JSON-RPC batching (2025-03-26) is accepted leniently, but bounded.
const MAX_BATCH = 20;

// Kept under ~2,000 characters: some clients (Claude Code) truncate server
// instructions at 2,048. Tool descriptions repeat the rules that matter.
export const INSTRUCTIONS = `You are connected to the user's personal 2nd-brain: their journal (Telegram and AI-chat sessions), their goal system, and their Idea Parking Lot.

Journal: use search_brain when the user brainstorms a topic they may have thought about before, or asks "have I thought about X?"; get_entry to follow a hit; list_recent for "what have I been thinking about lately". Use save_session ONLY when the user explicitly asks ("save this", "log this"): propose a title, confirm it, and write a narrative summary, not a transcript. Similarity below ~0.3 is noise; above ~0.5 is worth attention. The journal is private: treat it with discretion.

Goals and constitution: amendments are NEVER autonomous. Before any propose_*/commit_*_amendment call, read read_protocol('goal-amendment') (same text as resource second-brain://protocol/goal-amendment).

Idea Parking Lot: ideas are curated raw material, not tasks. Use park_idea ONLY when the user asks to park or file an idea: confirm the title, copy their own thoughts verbatim, and reply with the receipt only, never suggesting links at capture. "Save this session" still means save_session. Associations are made only in gardening sessions the user starts (garden_ideas, propose_idea_links, the user decides, decide_idea_links with exactly their verdicts). Idea tools are pull-only: never surface ideas unprompted. For a map, call export_idea_map and render it with your own tools. Before capturing, gardening, mapping or importing, read read_protocol('idea-parking-lot') (same text as resource second-brain://protocol/idea-parking-lot).

If a tool returns an error, report it and ask the user; don't retry silently.`;


type Reply = { body: Record<string, unknown> | null; status: number };

type RequestState = {
  principal: Principal;
  entries: CallEntry[];
  clientInfo: Record<string, unknown> | null;
  // Modern clients send clientInfo on every request: store it only when it changed.
  clientInfoOnlyIfChanged: boolean;
  headers: ModernHeaders;
};

export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

export async function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === 'OPTIONS') return corsPreflight('GET, POST, DELETE, OPTIONS');
  // Gemini Spark probes the MCP URL with a tokenless HEAD and reads the
  // Bearer challenge from the 401. Presence check only: no DB call.
  if (request.method === 'HEAD' && !bearerFrom(request)) return unauthorized(request, false);
  if (request.method !== 'POST') {
    // No server-initiated SSE stream and no sessions to delete.
    return new Response('Use POST with a JSON-RPC body', {
      status: 405,
      headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' },
    });
  }

  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const state: RequestState = {
    principal: auth.principal,
    entries: [],
    clientInfo: null,
    clientInfoOnlyIfChanged: false,
    headers: readModernHeaders(request),
  };

  let response: Response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
    response = rpcJson({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  if (body !== undefined) {
    if (Array.isArray(body)) {
      if (body.length === 0 || body.length > MAX_BATCH) {
        response = rpcJson({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
      } else if (body.some((m) => messageEra(m, state.headers.protocolVersion) === 'modern')) {
        // 2026-07-28: the body must be a single request.
        response = rpcJson(
          { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request: batching is not supported' } },
          400,
        );
      } else {
        const out: unknown[] = [];
        for (const msg of body) {
          const r = await handleMessage(msg, env, ctx, state);
          if (r.body) out.push(r.body);
        }
        response = out.length > 0 ? rpcJson(out) : new Response(null, { status: 202 });
      }
    } else {
      const r = await handleMessage(body, env, ctx, state);
      response = r.body ? rpcJson(r.body, r.status) : new Response(null, { status: 202 });
    }
  }

  // Attribution and last-used bookkeeping happen after the response.
  if (state.principal.credentialId || state.entries.length > 0) {
    const db = auth.db ?? authDb(env);
    ctx.waitUntil(
      recordActivity(db, state.principal, state.entries, state.clientInfo, {
        clientInfoOnlyIfChanged: state.clientInfoOnlyIfChanged,
      }),
    );
  } else if (auth.db) {
    const db = auth.db;
    ctx.waitUntil(db.end({ timeout: 5 }).catch(() => {}));
  }

  return withCors(response!);
}

async function handleMessage(
  msg: unknown,
  env: Env,
  ctx: ExecutionContext,
  state: RequestState,
): Promise<Reply> {
  const reply = (body: Record<string, unknown> | null, status = 200): Reply => ({ body, status });
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') {
    return reply({ jsonrpc: '2.0', id: (m as { id?: unknown } | null)?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
  }
  // A JSON-RPC response sent to us (e.g. to a server request) needs no reply.
  if (typeof m.method !== 'string') {
    if ('result' in m || 'error' in m) return reply(null);
    return reply({ jsonrpc: '2.0', id: m.id ?? null, error: { code: -32600, message: 'Invalid request' } });
  }
  const isNotification = m.id === undefined;
  const era = messageEra(m, state.headers.protocolVersion);
  try {
    const params = (m.params ?? {}) as Record<string, any>;
    if (era === 'modern') {
      // 2026-07-28 defines no client notifications over HTTP: accept and ignore.
      if (isNotification) return reply(null);
      validateModern(m.method, params, state.headers, ALL_PROTOCOL_VERSIONS);
      const ci = modernClientInfo(params);
      if (ci) {
        state.clientInfo = {
          clientInfo: cleanClientInfo(ci),
          requestedProtocolVersion: shortString(params._meta?.['io.modelcontextprotocol/protocolVersion']),
          protocolVersion: MODERN_PROTOCOL_VERSIONS[0],
          at: new Date().toISOString(),
        };
        state.clientInfoOnlyIfChanged = true;
      }
      const result = await dispatch(m.method, params, env, ctx, state, era);
      return reply({ jsonrpc: '2.0', id: m.id, result: decorateModern(m.method, result, SERVER_INFO) });
    }
    const result = await dispatch(m.method, params, env, ctx, state, era);
    return reply(isNotification ? null : { jsonrpc: '2.0', id: m.id, result });
  } catch (err) {
    if (isNotification) return reply(null);
    if (err instanceof RpcError) {
      return reply(
        { jsonrpc: '2.0', id: m.id, error: { code: err.code, message: err.message, data: err.data } },
        err.httpStatus ?? 200,
      );
    }
    if (err instanceof ResourceNotFoundError) {
      return reply({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: err.message } });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `Internal: ${message}` } });
  }
}

async function dispatch(
  method: string,
  params: Record<string, any>,
  env: Env,
  ctx: ExecutionContext,
  state: RequestState,
  era: Era,
): Promise<unknown> {
  // 2026-07-28 answers an unknown method with HTTP 404 (Streamable HTTP).
  const notFound = () => new RpcError(-32601, `Method not found: ${method}`, undefined, era === 'modern' ? 404 : undefined);
  // This server never issues cursors.
  if (era === 'modern' && typeof params?.cursor === 'string' && params.cursor !== '') {
    throw new RpcError(-32602, 'Invalid params: unknown cursor');
  }
  switch (method) {
    case 'server/discover':
      if (era !== 'modern') throw notFound();
      return { supportedVersions: ALL_PROTOCOL_VERSIONS, capabilities: CAPABILITIES, instructions: INSTRUCTIONS };
    case 'initialize': {
      const protocolVersion = negotiateVersion(params?.protocolVersion);
      if (params?.clientInfo && typeof params.clientInfo === 'object') {
        state.clientInfo = {
          clientInfo: cleanClientInfo(params.clientInfo),
          requestedProtocolVersion: shortString(params?.protocolVersion),
          protocolVersion,
          at: new Date().toISOString(),
        };
      }
      return {
        protocolVersion,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      // Removed in 2026-07-28.
      if (era === 'modern') throw notFound();
      return {};
    case 'tools/list':
      return {
        tools: tools
          .filter((t) => scopeAllows(state.principal.scope, t.name))
          .map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, ...t.annotations },
          })),
      };
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
      if (!scopeAllows(state.principal.scope, tool.name)) {
        throw new RpcError(-32602, `Tool not available for this credential: ${name}`);
      }
      const started = Date.now();
      const entry: CallEntry = {
        method: 'tools/call',
        tool: tool.name,
        isWrite: !tool.annotations.readOnlyHint,
        ok: false,
        errorCode: null,
        durationMs: 0,
        resultIds: [],
      };
      try {
        const result = await tool.handler(args, env, ctx, state.principal);
        entry.ok = !result.isError;
        entry.errorCode = result.isError ? 'tool_error' : null;
        entry.resultIds = result.isError ? [] : extractResultIds(result.content?.[0]?.text);
        return result;
      } catch (e) {
        entry.errorCode = 'exception';
        throw e;
      } finally {
        entry.durationMs = Date.now() - started;
        state.entries.push(entry);
      }
    }
    case 'resources/list':
      return { resources: listResources() };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read': {
      const uri = params?.uri;
      if (typeof uri !== 'string' || uri.length === 0) {
        throw new RpcError(-32602, 'resources/read: uri parameter required');
      }
      return readResource(uri);
    }
    case 'prompts/list':
      return { prompts: [] };
    case 'logging/setLevel':
      // Removed in 2026-07-28 (the level travels in _meta).
      if (era === 'modern') throw notFound();
      return {};
    default:
      throw notFound();
  }
}

// Only the identifying strings, bounded and free of NULs (jsonb rejects \u0000).
function shortString(v: unknown, max = 100): string | null {
  return typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, max) : null;
}

function cleanClientInfo(info: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['name', 'title', 'version']) {
    const v = shortString(info[k]);
    if (v) out[k] = v;
  }
  return out;
}

function rpcJson(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

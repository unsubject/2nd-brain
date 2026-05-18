import type { Env } from './env';
import { checkBearer } from './auth';
import { tools } from './tools/registry';
import { listResources, readResource, ResourceNotFoundError } from './resources';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: '2nd-brain', version: '0.0.1' };

const INSTRUCTIONS = `You are connected to the user's personal 2nd-brain — a journal of their thoughts, brainstorms, tasks, and ideas, ingested from Telegram and AI chat sessions.

Use search_brain proactively when the user starts a brainstorm on a topic they may have thought about before, or when they ask "have I thought about X?". Don't search every message; don't search factual questions unrelated to their life.

Use save_session ONLY when the user explicitly asks ("save this", "log this", "save to my brain"). Never autonomously. Propose a title and confirm before calling. Write a narrative summary (what we discussed, key insights, decisions, open questions) — not a transcript.

Use get_entry to follow up on a search hit. Use list_recent for "what have I been thinking about this week".

The journal is private — treat with discretion. Entries can include emotional venting and rough takes. Search is fuzzy: similarity below ~0.3 is probably noise, above ~0.5 is worth attention.

Reference material is exposed as MCP resources (call resources/list to discover). If the user asks about goals, the constitution, or amendments and your client supports resources, read \`2nd-brain://protocol/goal-amendment\` before calling any propose/commit_*_amendment tool — it contains the executable interview protocol. If resources aren't available, the registry descriptions of those tools point at the same protocol by section number.`;

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Use POST with JSON-RPC body', { status: 405 });
  }
  if (!checkBearer(request, env.BRAIN_MCP_TOKEN)) {
    const url = new URL(request.url);
    const resourceMetadata = `${url.protocol}//${url.host}/.well-known/oauth-protected-resource`;
    return new Response(null, {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer realm="2nd-brain", resource_metadata="${resourceMetadata}"`,
      },
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return rpcResponse(null, undefined, { code: -32700, message: 'Parse error' });
  }

  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcResponse(body?.id ?? null, undefined, { code: -32600, message: 'Invalid request' });
  }

  const isNotification = body.id === undefined;

  try {
    const result = await dispatch(body.method, body.params ?? {}, env, ctx);
    if (isNotification) return new Response(null, { status: 202 });
    return rpcResponse(body.id, result);
  } catch (err) {
    if (isNotification) return new Response(null, { status: 202 });
    if (err instanceof RpcError) {
      return rpcResponse(body.id, undefined, { code: err.code, message: err.message, data: err.data });
    }
    if (err instanceof ResourceNotFoundError) {
      return rpcResponse(body.id, undefined, { code: -32602, message: err.message });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return rpcResponse(body.id, undefined, { code: -32603, message: `Internal: ${msg}` });
  }
}

async function dispatch(
  method: string,
  params: any,
  env: Env,
  ctx: ExecutionContext,
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
      return await tool.handler(args, env, ctx);
    }
    case 'resources/list':
      return { resources: listResources() };
    case 'resources/read': {
      const uri = params?.uri;
      if (typeof uri !== 'string' || uri.length === 0) {
        throw new RpcError(-32602, 'resources/read: uri parameter required');
      }
      return readResource(uri);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

function rpcResponse(
  id: unknown,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): Response {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id: id ?? null };
  if (error) body.error = error;
  else body.result = result;
  return Response.json(body);
}

import postgres from 'postgres';
import type { Env } from './env';
import { handleMcpRequest } from './mcp';
import { handleConsole } from './console';
import { corsPreflight } from './http';
import { authServerMetadata, protectedResourceMetadata } from './oauth/metadata';
import { registerClient } from './oauth/register';
import { authorize } from './oauth/authorize';
import { tokenEndpoint } from './oauth/token';
import { revokeEndpoint } from './oauth/revoke';

export type { Env };

const CORS_PATHS = new Set([
  '/register',
  '/token',
  '/revoke',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'GET' && path === '/db-health') {
      const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false });
      try {
        const rows = await sql<{ version: string }[]>`SELECT version(), now() AS as_of`;
        return Response.json({ ok: true, version: rows[0]?.version ?? null });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      } finally {
        ctx.waitUntil(sql.end({ timeout: 5 }));
      }
    }

    if (request.method === 'OPTIONS' && CORS_PATHS.has(path)) {
      return corsPreflight(path.startsWith('/.well-known/') ? 'GET, OPTIONS' : 'POST, OPTIONS');
    }

    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return authServerMetadata(request);
    }
    // RFC 9728: the document for <base>/mcp lives at the /mcp-suffixed path;
    // the root one is kept for clients that look there.
    if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource/mcp') {
      return protectedResourceMetadata(request, '/mcp');
    }
    if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource') {
      return protectedResourceMetadata(request, '');
    }
    if (path === '/register') return registerClient(request, env, ctx);
    if (path === '/authorize') return authorize(request, env, ctx);
    if (path === '/token') return tokenEndpoint(request, env, ctx);
    if (path === '/revoke') return revokeEndpoint(request, env, ctx);
    if (path === '/tokens' || path.startsWith('/tokens/')) return handleConsole(request, env, ctx);

    if (path === '/mcp' || path === '/mcp/') {
      return handleMcpRequest(request, env, ctx);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

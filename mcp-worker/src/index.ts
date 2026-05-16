import postgres from 'postgres';
import type { Env } from './env';
import { handleMcpRequest } from './mcp';
import {
  authServerMetadata,
  protectedResourceMetadata,
  registerClient,
  authorize,
  token,
} from './oauth';

export type { Env };

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
        const rows = await sql<{ version: string }[]>`SELECT version()`;
        return Response.json({ ok: true, version: rows[0]?.version ?? null });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      } finally {
        ctx.waitUntil(sql.end({ timeout: 5 }));
      }
    }

    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return authServerMetadata(request);
    }
    if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource') {
      return protectedResourceMetadata(request);
    }
    if (path === '/register') {
      return registerClient(request);
    }
    if (path === '/authorize') {
      return authorize(request, env);
    }
    if (path === '/token') {
      return token(request, env);
    }

    if (path === '/mcp') {
      return handleMcpRequest(request, env, ctx);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

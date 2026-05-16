import postgres from 'postgres';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  BRAIN_MCP_TOKEN: string;
  OPENAI_API_KEY: string;
  BRAIN_USER_ID: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/db-health') {
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

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

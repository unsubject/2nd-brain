// HTTP helpers shared by /mcp, OAuth and the owner console.

export function baseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// /mcp, discovery metadata and the token endpoints are called cross-origin
// by browser-based MCP clients (e.g. MCP Inspector). No cookies are used
// there, so a wildcard origin is safe.
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version',
};

export function corsPreflight(methods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// Copy a response with extra headers (Response.redirect/json headers may be
// immutable, so always rebuild).
export function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function withCors(res: Response): Response {
  return withHeaders(res, CORS_HEADERS);
}

export const NO_STORE: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

export function jsonNoStore(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

export function redirect(location: string, status = 302, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { Location: location, ...NO_STORE, ...extra } });
}

// Read a request body without buffering more than `max` bytes (Workers
// accept bodies far larger than anything we parse). null = too large.
export async function readLimitedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

// Owner-facing forms are plain urlencoded posts. null = unreadable or too large.
export async function readForm(request: Request, max = 16 * 1024): Promise<URLSearchParams | null> {
  const ct = (request.headers.get('Content-Type') ?? '').toLowerCase();
  if (ct && !ct.includes('application/x-www-form-urlencoded')) return null;
  const text = await readLimitedText(request, max);
  return text === null ? null : new URLSearchParams(text);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Owner-facing HTML pages (consent, console). Never framed, never cached,
// no third-party resources. `formActionSelf` must stay off on the OAuth
// consent page: Chrome applies form-action to the post-submit redirect.
export function htmlPage(body: string, status = 200, opts: { formActionSelf?: boolean } = {}, extra: Record<string, string> = {}): Response {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    ...(opts.formActionSelf ? ["form-action 'self'"] : []),
  ].join('; ');
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...NO_STORE,
      ...extra,
    },
  });
}

export const PAGE_STYLE = `
  body { font: 16px system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; color: #1f2328; background: #fff; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin-top: 28px; }
  p, li { color: #444; }
  label { display: block; margin-top: 14px; font-weight: 600; font-size: 14px; }
  input[type=password], input[type=text] { width: 100%; padding: 9px; font-size: 14px; border: 1px solid #c8ccd0; border-radius: 6px; box-sizing: border-box; }
  button { margin-top: 16px; padding: 9px 16px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
  button.secondary { background: #e5e7eb; color: #111; }
  button.danger { background: #b91c1c; margin-top: 0; padding: 5px 10px; font-size: 13px; }
  .error { color: #b91c1c; margin-top: 12px; font-size: 14px; padding: 10px; background: #fef2f2; border-radius: 6px; }
  .warn { color: #92400e; margin-top: 12px; font-size: 14px; padding: 10px; background: #fffbeb; border-radius: 6px; }
  .ok { color: #065f46; margin-top: 12px; font-size: 14px; padding: 10px; background: #ecfdf5; border-radius: 6px; }
  .muted { color: #6b7280; font-size: 13px; }
  code, pre { background: #f3f4f6; border-radius: 4px; font-size: 13px; }
  code { padding: 2px 5px; }
  pre { padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  form.inline { display: inline; }
  label.check { font-weight: normal; display: flex; gap: 8px; align-items: baseline; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    p, li { color: #c9d1d9; }
    input[type=password], input[type=text] { background: #161b22; color: #e6edf3; border-color: #30363d; }
    code, pre { background: #161b22; }
    th, td { border-color: #30363d; }
    button.secondary { background: #30363d; color: #e6edf3; }
    .muted { color: #8b949e; }
  }
`;

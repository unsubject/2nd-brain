import type { Env } from './env';
import { constantTimeEqual } from './auth';

const CODE_TTL_SECONDS = 600;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function issuerOf(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function authServerMetadata(request: Request): Response {
  const base = issuerOf(request);
  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
}

export function protectedResourceMetadata(request: Request): Response {
  const base = issuerOf(request);
  return Response.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  });
}

export async function registerClient(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // empty body is ok for DCR
  }
  return Response.json(
    {
      client_id: 'mcp-client-' + crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
      client_name: body.client_name ?? null,
    },
    { status: 201 },
  );
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const redirect_uri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const code_challenge = url.searchParams.get('code_challenge') ?? '';
    const code_challenge_method = url.searchParams.get('code_challenge_method') ?? '';
    const client_id = url.searchParams.get('client_id') ?? '';

    if (code_challenge && code_challenge_method && code_challenge_method !== 'S256') {
      return new Response(`Unsupported code_challenge_method: ${code_challenge_method}`, { status: 400 });
    }

    const html = renderAuthForm({
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method: code_challenge_method || 'S256',
      client_id,
    });
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'POST') {
    const form = await request.formData();
    const token = String(form.get('token') ?? '');
    const redirect_uri = String(form.get('redirect_uri') ?? '');
    const state = String(form.get('state') ?? '');
    const code_challenge = String(form.get('code_challenge') ?? '');

    if (!redirect_uri) {
      return new Response('Missing redirect_uri', { status: 400 });
    }

    if (!constantTimeEqual(token, env.BRAIN_MCP_TOKEN)) {
      const html = renderAuthForm({
        redirect_uri,
        state,
        code_challenge,
        code_challenge_method: 'S256',
        client_id: '',
        error: 'Invalid token. Try again.',
      });
      return new Response(html, {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS;
    const code = await signCode({ challenge: code_challenge, exp: expiresAt }, env.BRAIN_MCP_TOKEN);

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    return Response.redirect(redirectUrl.toString(), 302);
  }

  return new Response('method not allowed', { status: 405 });
}

export async function token(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const ct = request.headers.get('content-type') ?? '';
  let params: URLSearchParams;
  if (ct.includes('application/x-www-form-urlencoded')) {
    params = new URLSearchParams(await request.text());
  } else if (ct.includes('application/json')) {
    const body = (await request.json()) as Record<string, string>;
    params = new URLSearchParams(body);
  } else {
    return jsonError('invalid_request', 'Unsupported content-type', 400);
  }

  const grant_type = params.get('grant_type');
  if (grant_type !== 'authorization_code') {
    return jsonError('unsupported_grant_type', `grant_type ${grant_type} not supported`, 400);
  }

  const code = params.get('code') ?? '';
  const code_verifier = params.get('code_verifier') ?? '';

  let payload: { challenge: string; exp: number };
  try {
    payload = await verifyCode(code, env.BRAIN_MCP_TOKEN);
  } catch (e) {
    return jsonError('invalid_grant', e instanceof Error ? e.message : String(e), 400);
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return jsonError('invalid_grant', 'authorization code expired', 400);
  }

  if (payload.challenge) {
    if (!code_verifier) {
      return jsonError('invalid_grant', 'PKCE required: missing code_verifier', 400);
    }
    const computed = await s256(code_verifier);
    if (!constantTimeEqual(computed, payload.challenge)) {
      return jsonError('invalid_grant', 'PKCE verification failed', 400);
    }
  }

  return Response.json({
    access_token: env.BRAIN_MCP_TOKEN,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: 'mcp',
  });
}

async function signCode(payload: { challenge: string; exp: number }, secret: string): Promise<string> {
  const data = `${payload.challenge}.${payload.exp}`;
  const sig = await hmacB64(data, secret);
  return base64url(data + '.' + sig);
}

async function verifyCode(code: string, secret: string): Promise<{ challenge: string; exp: number }> {
  const decoded = base64urlDecode(code);
  const parts = decoded.split('.');
  if (parts.length !== 3) throw new Error('malformed code');
  const [challenge, expStr, sig] = parts;
  const data = `${challenge}.${expStr}`;
  const expectedSig = await hmacB64(data, secret);
  if (!constantTimeEqual(sig, expectedSig)) throw new Error('signature mismatch');
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) throw new Error('invalid exp');
  return { challenge, exp };
}

async function hmacB64(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bufferToBase64url(sig);
}

async function s256(verifier: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return bufferToBase64url(hash);
}

function base64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return bufferToBase64url(bytes.buffer);
}

function base64urlDecode(input: string): string {
  let std = input.replace(/-/g, '+').replace(/_/g, '/');
  while (std.length % 4) std += '=';
  return atob(std);
}

function bufferToBase64url(buffer: ArrayBuffer | ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function jsonError(error: string, error_description: string, status: number): Response {
  return Response.json({ error, error_description }, { status });
}

function renderAuthForm(p: {
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  client_id: string;
  error?: string;
}): string {
  const e = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>2nd-brain MCP — Connect</title>
<style>
  body { font: 16px system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 20px; color: #222; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p { color: #555; }
  label { display: block; margin-top: 16px; font-weight: 600; font-size: 14px; }
  input[type=password] { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
  button { margin-top: 20px; padding: 10px 18px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
  .error { color: #b91c1c; margin-top: 12px; font-size: 14px; padding: 10px; background: #fef2f2; border-radius: 6px; }
  .hint { color: #666; font-size: 13px; margin-top: 8px; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style>
</head><body>
<h1>Connect to 2nd-brain MCP</h1>
<p>Paste your <code>BRAIN_MCP_TOKEN</code> to authorize this client.</p>
${p.error ? `<div class="error">${e(p.error)}</div>` : ''}
<form method="post" action="/authorize">
  <input type="hidden" name="redirect_uri" value="${e(p.redirect_uri)}">
  <input type="hidden" name="state" value="${e(p.state)}">
  <input type="hidden" name="code_challenge" value="${e(p.code_challenge)}">
  <input type="hidden" name="code_challenge_method" value="${e(p.code_challenge_method)}">
  <input type="hidden" name="client_id" value="${e(p.client_id)}">
  <label for="token">BRAIN_MCP_TOKEN</label>
  <input id="token" type="password" name="token" autofocus required autocomplete="off">
  <div class="hint">The token you set as the Worker secret. Stored only as the OAuth access_token after consent.</div>
  <button type="submit">Connect</button>
</form>
</body></html>`;
}

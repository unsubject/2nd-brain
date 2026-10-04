// Owner-console session cookies and CSRF tokens, without any server-side
// store: HMAC-signed with the owner secret (BRAIN_MCP_TOKEN), domain-
// separated by a purpose prefix. Rotating the secret logs everyone out.

import { constantTimeEqual, hmacBase64url, randomBase64url } from './crypto';

export const SESSION_COOKIE = '__Host-brain_console';
export const SESSION_TTL_SECONDS = 30 * 60;

export async function createSession(secret: string, nowSeconds: number): Promise<string> {
  const exp = nowSeconds + SESSION_TTL_SECONDS;
  const sid = randomBase64url(18);
  const payload = `v1.${exp}.${sid}`;
  const sig = await hmacBase64url(secret, `console-session|${payload}`);
  return `${payload}.${sig}`;
}

// Returns the session id when the cookie value is authentic and unexpired.
export async function verifySession(
  secret: string,
  value: string | null | undefined,
  nowSeconds: number,
): Promise<string | null> {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [v, expStr, sid, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp < nowSeconds) return null;
  const expected = await hmacBase64url(secret, `console-session|${v}.${expStr}.${sid}`);
  return constantTimeEqual(sig, expected) ? sid : null;
}

export async function csrfToken(secret: string, sid: string): Promise<string> {
  return hmacBase64url(secret, `console-csrf|${sid}`);
}

export async function verifyCsrf(secret: string, sid: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  return constantTimeEqual(token, await csrfToken(secret, sid));
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

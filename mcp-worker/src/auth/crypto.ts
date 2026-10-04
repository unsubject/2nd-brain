// Small crypto helpers on Workers' WebCrypto (also available in Node 20+).

const enc = new TextEncoder();

export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))));
}

export async function sha256Base64url(input: string): Promise<string> {
  return bytesToBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))));
}

export async function hmacBase64url(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return bytesToBase64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

export function randomBase64url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes);
}

// RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))).
export async function pkceS256(verifier: string): Promise<string> {
  return sha256Base64url(verifier);
}

// RFC 7636 §4.1: 43–128 chars of [A-Z a-z 0-9 - . _ ~].
export function isValidCodeVerifier(v: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

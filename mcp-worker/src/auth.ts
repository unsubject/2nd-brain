export function checkBearer(request: Request, expectedToken: string): boolean {
  const header = request.headers.get('Authorization');
  if (!header) return false;
  const m = header.match(/^Bearer (.+)$/);
  if (!m) return false;
  return constantTimeEqual(m[1], expectedToken);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

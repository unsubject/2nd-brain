// Who is calling /mcp. Every tool handler receives one (4th argument).

export type Principal = {
  // NULL for the legacy master bearer.
  credentialId: string | null;
  label: string;
  scope: string;
  via: 'master' | 'pat' | 'oauth';
};

export const MASTER_PRINCIPAL: Principal = {
  credentialId: null,
  label: 'master',
  scope: 'all',
  via: 'master',
};

// Scopes are a single token for now. Unknown scopes fail closed.
export function scopeAllows(scope: string, _tool: string): boolean {
  return scope === 'all';
}

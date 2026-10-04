// OAuth discovery documents.
//
// Deliberately NOT advertised: client_id_metadata_document_supported (CIMD).
// This server can't resolve URL client_ids. Without CIMD every supported
// client (Claude, ChatGPT, Gemini Spark) registers itself via DCR; with it,
// Claude/ChatGPT switch to CIMD and some servers saw Spark stop at a manual
// client-id prompt (reports conflict; see docs/phase-mcp-multi-client-spec.md §4).

import { baseUrl, CORS_HEADERS } from '../http';

export const SUPPORTED_SCOPES = ['mcp', 'offline_access'] as const;
// What the protected resource itself needs. offline_access is an
// authorization-server concern (MCP 2026-07-28 / SEP-2207: resource metadata
// SHOULD NOT list it); refresh tokens are issued regardless.
export const RESOURCE_SCOPES = ['mcp'] as const;

export function authServerMetadata(request: Request): Response {
  const base = baseUrl(request);
  return Response.json(
    {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SUPPORTED_SCOPES],
      authorization_response_iss_parameter_supported: true,
    },
    { headers: CORS_HEADERS },
  );
}

// RFC 9728: the `resource` must equal the URL the well-known suffix was
// inserted into — so /.well-known/oauth-protected-resource/mcp describes
// <base>/mcp and the root document describes <base>.
export function protectedResourceMetadata(request: Request, resourcePath: '' | '/mcp'): Response {
  const base = baseUrl(request);
  return Response.json(
    {
      resource: `${base}${resourcePath}`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: [...RESOURCE_SCOPES],
      resource_name: "Simon's 2nd-brain",
    },
    { headers: CORS_HEADERS },
  );
}

// Resource indicators (RFC 8707) we accept for this server: our origin
// (scheme and host compared case-insensitively, default port implied, as
// the MCP authorization spec asks) with path "", "/", "/mcp" or "/mcp/".
export function isOurResource(resource: string, request: Request): boolean {
  if (/[?#]/.test(resource)) return false;
  let u: URL;
  try {
    u = new URL(resource);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.origin !== new URL(request.url).origin) return false;
  const path = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  return path === '' || path === '/mcp';
}

export function normalizeScope(requested: string | null | undefined): string {
  const asked = (requested ?? '').split(/\s+/).filter(Boolean);
  const kept = SUPPORTED_SCOPES.filter((s) => asked.includes(s));
  return (kept.length > 0 ? kept : ['mcp']).join(' ');
}

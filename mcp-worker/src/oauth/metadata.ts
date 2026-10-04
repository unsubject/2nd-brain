// OAuth discovery documents.
//
// Deliberately NOT advertised: client_id_metadata_document_supported (CIMD).
// Gemini Spark tries CIMD first when it's advertised and never falls back
// to dynamic registration; Claude/ChatGPT fall back to DCR without it.

import { baseUrl, CORS_HEADERS } from '../http';

export const SUPPORTED_SCOPES = ['mcp', 'offline_access'] as const;

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
      scopes_supported: [...SUPPORTED_SCOPES],
      resource_name: "Simon's 2nd-brain",
    },
    { headers: CORS_HEADERS },
  );
}

// Resource indicators (RFC 8707) we accept for this server.
export function isOurResource(resource: string, request: Request): boolean {
  const base = baseUrl(request);
  return [base, `${base}/`, `${base}/mcp`, `${base}/mcp/`].includes(resource);
}

export function normalizeScope(requested: string | null | undefined): string {
  const asked = (requested ?? '').split(/\s+/).filter(Boolean);
  const kept = SUPPORTED_SCOPES.filter((s) => asked.includes(s));
  return (kept.length > 0 ? kept : ['mcp']).join(' ');
}

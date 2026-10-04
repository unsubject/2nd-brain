// OAuth redirect URI policy. A client may only register (and later use)
// redirect URIs that belong to a known MCP client family, a native-app
// loopback (RFC 8252), or an owner-configured extra prefix. This, plus
// owner consent on every authorization, is what keeps codes from being
// delivered to an attacker's site.

export type ClientFamily = 'claude' | 'chatgpt' | 'cursor' | 'google' | 'loopback' | 'custom';

export const FAMILY_NAMES: Record<ClientFamily, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  google: 'Google (Gemini Spark)',
  loopback: 'Local app (Claude Code, Gemini CLI, MCP Inspector…)',
  custom: 'Custom (allowed by OAUTH_EXTRA_REDIRECT_PREFIXES)',
};

type Rule =
  | { family: ClientFamily; exact: string }
  | { family: ClientFamily; origin: string; pathPrefix: string };

const RULES: Rule[] = [
  { family: 'claude', exact: 'https://claude.ai/api/mcp/auth_callback' },
  { family: 'claude', exact: 'https://claude.com/api/mcp/auth_callback' },
  { family: 'chatgpt', exact: 'https://chatgpt.com/connector_platform_oauth_redirect' },
  { family: 'chatgpt', origin: 'https://chatgpt.com', pathPrefix: '/connector/oauth/' },
  { family: 'cursor', exact: 'cursor://anysphere.cursor-mcp/oauth/callback' },
  // Cursor Cloud Agents; Cursor registers it alongside the cursor:// one.
  { family: 'cursor', exact: 'https://www.cursor.com/agents/mcp/oauth/callback' },
  // Gemini Spark's per-user, per-connector callback:
  // /r/user_bound_custom-mcp-<numeric id>-<server host, dots as underscores>.
  // The relay forwards any other /r/<id> to the Google Cloud project with
  // that id (project ids can't contain "_"), so a bare /r/ prefix would let
  // any project pose as "Google (Gemini Spark)".
  { family: 'google', origin: 'https://oauth-redirect.googleusercontent.com', pathPrefix: '/r/user_bound_custom-mcp-' },
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(uri: string): URL | null {
  if (uri.length > 2048) return null;
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function isLoopback(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

// A path under a prefix rule: no dot segments and no encoded slashes,
// backslashes or dots that a server might decode into a traversal.
function safeSubPath(path: string): boolean {
  return !/\/\.\.?(\/|$)/.test(path) && !/%(2f|5c|2e)/i.test(path);
}

// `prefix` matches the path itself or anything below it at a "/" boundary.
function underPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  return path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

// Returns the family a redirect URI belongs to, or null if it is not allowed.
export function classifyRedirect(uri: string, extraPrefixes: readonly string[] = []): ClientFamily | null {
  const u = parse(uri);
  if (!u) return null;
  if (u.username || u.password || u.hash) return null;
  if (isLoopback(u)) return 'loopback';
  for (const r of RULES) {
    if ('exact' in r) {
      if (uri === r.exact) return r.family;
    } else if (
      u.origin === r.origin &&
      u.pathname.startsWith(r.pathPrefix) &&
      u.pathname.length > r.pathPrefix.length &&
      safeSubPath(u.pathname)
    ) {
      return r.family;
    }
  }
  for (const prefix of extraPrefixes) {
    const p = parse(prefix);
    if (!p || p.protocol !== 'https:') continue;
    if (u.origin === p.origin && underPrefix(u.pathname, p.pathname) && safeSubPath(u.pathname)) {
      return 'custom';
    }
  }
  return null;
}

export function parseExtraPrefixes(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('https://'));
}

// Does a redirect_uri presented at /authorize or /token match one the
// client registered? Exact match, except loopback URIs ignore the port
// (RFC 8252 §7.3: native apps pick a free port at run time).
export function redirectMatchesRegistered(uri: string, registered: readonly string[]): boolean {
  if (registered.includes(uri)) return true;
  const u = parse(uri);
  if (!u || !isLoopback(u)) return false;
  return registered.some((r) => {
    const v = parse(r);
    return (
      !!v &&
      isLoopback(v) &&
      v.hostname === u.hostname &&
      v.pathname === u.pathname &&
      v.search === u.search
    );
  });
}

// The host shown on the consent page (trusted: derived from the URI, not
// from client-supplied metadata).
export function redirectDisplayHost(uri: string): string {
  const u = parse(uri);
  if (!u) return uri;
  return u.protocol === 'cursor:' ? 'cursor://anysphere.cursor-mcp' : u.host || u.protocol;
}

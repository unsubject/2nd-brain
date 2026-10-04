export interface Env {
  HYPERDRIVE: Hyperdrive;
  // Owner secret: approves OAuth connections and logs into /tokens. While
  // ALLOW_MASTER_BEARER is not "false" it is also accepted as a bearer token
  // on /mcp (legacy clients).
  BRAIN_MCP_TOKEN: string;
  OPENAI_API_KEY: string;
  BRAIN_USER_ID: string;
  // "false" disables the master token as an /mcp bearer (set in wrangler.jsonc vars).
  ALLOW_MASTER_BEARER?: string;
  // Comma-separated https:// prefixes of extra allowed OAuth redirect URIs.
  OAUTH_EXTRA_REDIRECT_PREFIXES?: string;
}

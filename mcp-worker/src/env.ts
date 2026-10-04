export interface Env {
  HYPERDRIVE: Hyperdrive;
  // Legacy master bearer for /mcp (while ALLOW_MASTER_BEARER is not
  // "false"). Also the owner secret when OWNER_SECRET is unset.
  BRAIN_MCP_TOKEN: string;
  // Owner secret: approves OAuth connections, signs in to /tokens and keys
  // the console's cookie/CSRF HMACs. Keep it separate from BRAIN_MCP_TOKEN,
  // which OAuth clients connected before migration 020 received as their
  // access token.
  OWNER_SECRET?: string;
  OPENAI_API_KEY: string;
  BRAIN_USER_ID: string;
  // "false" disables the master token as an /mcp bearer (set in wrangler.jsonc vars).
  ALLOW_MASTER_BEARER?: string;
  // Comma-separated https:// prefixes of extra allowed OAuth redirect URIs.
  OAUTH_EXTRA_REDIRECT_PREFIXES?: string;
}

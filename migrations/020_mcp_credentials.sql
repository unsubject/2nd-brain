-- 020_mcp_credentials.sql
--
-- Per-client, revocable credentials for the MCP Worker
-- (docs/phase-mcp-multi-client-spec.md). Until now every client — OAuth or
-- bearer — ended up holding the single master BRAIN_MCP_TOKEN. Now:
--
--   mcp_client      — OAuth dynamic client registrations (RFC 7591).
--   mcp_credential  — one per connected agent (OAuth grant or personal
--                     access token), with a label, scope, last-used time
--                     and revocation. Revoking it kills all its tokens.
--   mcp_token       — opaque tokens, stored only as SHA-256 hex hashes:
--                     access (1h), refresh (rotating), pat (no expiry).
--   mcp_auth_code   — single-use OAuth authorization codes (hashed).
--   mcp_call_log    — who called which tool, when, and whether it worked
--                     (never the arguments) — attribution across agents.

CREATE TABLE IF NOT EXISTS mcp_client (
  client_id TEXT PRIMARY KEY,
  client_name TEXT CHECK (client_name IS NULL OR length(client_name) <= 200),
  redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(redirect_uris) = 'array'),
  client_family TEXT,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  registration JSONB,
  -- Hash of the registering IP, for the per-source registration cap.
  registered_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_authorized_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_client_unused
  ON mcp_client (created_at) WHERE last_authorized_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_client_unused_source
  ON mcp_client (registered_from, created_at) WHERE last_authorized_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_credential (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('pat', 'oauth')),
  scope TEXT NOT NULL DEFAULT 'all',
  client_id TEXT REFERENCES mcp_client(client_id) ON DELETE SET NULL,
  redirect_uri TEXT,
  -- Last 4 characters of a PAT, so the owner can tell tokens apart.
  token_hint TEXT,
  -- clientInfo + protocol version from the most recent MCP initialize.
  last_client_info JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  -- owner: revoked in /tokens; replaced: superseded by a reconnect with the
  -- same label; client: via /revoke; code_reuse: an authorization code was
  -- redeemed twice.
  revoked_reason TEXT CHECK (revoked_reason IN ('owner', 'replaced', 'client', 'code_reuse')),
  CONSTRAINT mcp_credential_revoked_consistent CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- Labels identify agents in attribution; keep them unique among live credentials.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_credential_active_label
  ON mcp_credential (user_id, lower(btrim(label))) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_credential_client ON mcp_credential (client_id);

CREATE TABLE IF NOT EXISTS mcp_token (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  credential_id UUID NOT NULL REFERENCES mcp_credential(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh', 'pat')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  -- Refresh tokens only: set when first exchanged for a new pair. Within a
  -- short grace window the same token may be redeemed again (parallel
  -- requests, processes sharing one token store); reuse_count bounds that.
  rotated_at TIMESTAMPTZ,
  reuse_count INT NOT NULL DEFAULT 0,
  CONSTRAINT mcp_token_expiry CHECK (kind = 'pat' OR expires_at IS NOT NULL),
  CONSTRAINT mcp_token_rotation CHECK (kind = 'refresh' OR (rotated_at IS NULL AND reuse_count = 0))
);

CREATE INDEX IF NOT EXISTS idx_mcp_token_credential ON mcp_token (credential_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_token_one_pat
  ON mcp_token (credential_id) WHERE kind = 'pat';
CREATE INDEX IF NOT EXISTS idx_mcp_token_expires ON mcp_token (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_token_rotated ON mcp_token (rotated_at) WHERE rotated_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS mcp_auth_code (
  code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id TEXT NOT NULL REFERENCES mcp_client(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource TEXT,
  scope TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  -- Owner chose "replace the existing connection with this name".
  replace_label BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  -- The credential minted from this code (for code-replay revocation).
  credential_id UUID REFERENCES mcp_credential(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_auth_code_expires ON mcp_auth_code (expires_at);

CREATE TABLE IF NOT EXISTS mcp_call_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = the legacy master bearer.
  credential_id UUID REFERENCES mcp_credential(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  method TEXT NOT NULL,
  tool TEXT,
  is_write BOOLEAN NOT NULL DEFAULT false,
  ok BOOLEAN NOT NULL,
  error_code TEXT,
  duration_ms INT,
  result_ids JSONB
);

CREATE INDEX IF NOT EXISTS idx_mcp_call_log_credential ON mcp_call_log (credential_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_call_log_at ON mcp_call_log (at DESC);

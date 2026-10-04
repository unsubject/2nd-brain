# Phase: multi-client MCP access — build spec

Status: implemented. It consists of migration `020_mcp_credentials.sql`, `mcp-worker/src/auth/*`, `src/oauth/*`, `src/console.ts` and `src/calllog.ts`.
Setup guide for each client: [`mcp-client-setup.md`](mcp-client-setup.md).

## 1. Context and decisions

2nd-brain is reached only through AI agents over MCP. The Idea Parking Lot made that explicit: there is no front-end, so every agent the user works with has to reach the same tools. Those agents are:

- Claude (web, Desktop, Code)
- ChatGPT
- Cursor
- Gemini CLI
- **Gemini Spark** (Google's agent; custom apps over OAuth only)
- **Meta Muse** (Meta's agent; connectors are built in chat and use a static bearer token from its Secure Credentials Store)

Before this phase, every client ended up with the master `BRAIN_MCP_TOKEN`. The OAuth flow simply handed it out as the access token, accepted any redirect URI, and could not revoke anyone.

Decisions (2026-10-04):

| # | Decision |
|---|---|
| 1 | Every client gets **all tools**. A `scope` column exists for later; only `all` is honoured and anything else fails closed. |
| 2 | **Per-client revocable credentials**, of two kinds: **OAuth grants**, which the client obtains itself after the owner approves, and **personal access tokens** (PATs), which the owner creates in a console. Both are stored hashed, with a label and last-used time. |
| 3 | **Writes are attributed on the server.** Idea writes record the credential label in `captured_via` / `proposed_via`, and every tool call is logged per credential. |
| 4 | A **per-client setup guide** with a smoke test. |
| 5 | The master token is kept as a legacy bearer behind `ALLOW_MASTER_BEARER` until the console shows it is unused. After that it is only the owner password. |

## 2. Data model (migration 020)

| Table | Holds |
|---|---|
| `mcp_client` | RFC 7591 registrations: redirect URIs, client family, raw metadata. Rows never approved are swept after 7 days. |
| `mcp_credential` | One per connected agent: `label` (unique among live credentials, case-insensitive), `kind` `pat`/`oauth`, `scope`, `last_used_at`, `last_client_info` (from `initialize`), `revoked_at` + `revoked_reason` (`owner`, `client`, `refresh_reuse`, `code_reuse`). |
| `mcp_token` | SHA-256 hex hashes of opaque tokens: `access` (1 h), `refresh` (90-day idle expiry, rotated, at most one live per credential), `pat` (no expiry, one per credential). |
| `mcp_auth_code` | Single-use codes (hashed, 5 min). Each is bound to the client, redirect URI, PKCE challenge, resource and label, and records the credential it minted. |
| `mcp_call_log` | One row per tool call: credential, label, tool, write flag, ok, error code, duration, result ids. **Never arguments.** |

Revoking a credential leaves its token rows in place; every lookup joins on `revoked_at IS NULL`. Tokens are prefixed `brain_at_`, `brain_rt_` and `brain_pat_`, so a leaked token is easy to recognise and grep for.

## 3. `/mcp` authentication

1. Read the bearer token; the scheme name is matched case-insensitively.
2. Compare it in constant time with the master `BRAIN_MCP_TOKEN`, unless `ALLOW_MASTER_BEARER` is `"false"`.
3. If the token has the `brain_at_` or `brain_pat_` prefix, look it up by hash in one indexed query that includes `now()`, so Hyperdrive never serves it from cache. That makes revocation immediate.
4. Anything else gets a 401 with no database call. The 401 carries `WWW-Authenticate` with `resource_metadata=<base>/.well-known/oauth-protected-resource/mcp`, plus `error="invalid_token"` when a token was presented.
5. If the database is unreachable, answer **503 with Retry-After**, never 401, so clients keep their tokens.

Handlers receive the resulting `Principal {credentialId, label, scope, via}` as a fourth argument.

## 4. OAuth 2.1

- **Discovery**
  - Authorization-server metadata (RFC 8414) advertises:
    - the `authorization_code` and `refresh_token` grants
    - PKCE S256 only
    - auth method `none`
    - scopes `mcp` and `offline_access`
    - `authorization_response_iss_parameter_supported`
    - the revocation endpoint
  - It does **not** advertise client metadata documents (CIMD). When CIMD is advertised, Gemini Spark tries it first and never falls back to dynamic registration.
  - Protected-resource metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/mcp` (resource `<base>/mcp`) and at the root (resource `<base>`).
- **Registration** (`/register`)
  - Public clients only.
  - Each redirect URI must match the allow-list:

    | Family | Allowed redirect URIs |
    |---|---|
    | Claude | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` (exact) |
    | ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` (exact) or the `https://chatgpt.com/connector/oauth/` prefix |
    | Cursor | `cursor://anysphere.cursor-mcp/oauth/callback` |
    | Google | the `https://oauth-redirect.googleusercontent.com/r/` prefix |
    | Native apps | RFC 8252 loopback (`http://localhost`, `127.0.0.1`, `[::1]`); the port may differ from the registered one |
    | Custom | any `https://` prefix listed in `OAUTH_EXTRA_REDIRECT_PREFIXES` |

  - At most 50 registrations may wait unapproved in any hour.
- **Authorize**
  - Problems with the client or its redirect URI are shown as an error page and never redirected.
  - Every other error is redirected back with `state` and `iss`. That covers a wrong `response_type`, a missing or non-S256 PKCE challenge, and a foreign `resource` (`invalid_target`).
  - The consent page shows the client family and redirect host. Both are derived from the redirect URI, so they can be trusted. The client's self-declared name is shown and marked *unverified*.
  - The owner names the connection and types the owner secret to approve. The page cannot be framed, is never cached, and loads no third-party resources.
  - Legacy `mcp-client-<uuid>` ids issued by the old stateless flow are adopted on approval, provided the redirect URI they present passes the allow-list.
- **Token**
  - **Authorization-code grant:**
    - The code is consumed atomically.
    - A replayed code revokes the credential it minted (`code_reuse`).
    - The client id, the redirect URI (if sent), the PKCE verifier and the resource are all checked.
    - The label is made unique inside the transaction, under an advisory lock.
    - A refresh token is **always** issued: Claude does not ask for `offline_access`, and Spark needs a refresh token.
  - **Refresh grant:**
    - The row is locked and rotated.
    - Presenting an already-rotated token within 60 s is treated as a client race: it is rejected and nothing is revoked.
    - Presenting it later is treated as theft and revokes the credential (`refresh_reuse`).
  - Errors follow RFC 6749 JSON. Responses carry `Cache-Control: no-store`.
- **Revoke** (`/revoke`, RFC 7009)
  - Any of our tokens revokes its whole credential.
  - An unknown token still gets 200.

## 5. Owner console (`/tokens`)

- **Login:** the owner secret creates an HMAC-signed `__Host-brain_console` cookie (HttpOnly, Secure, SameSite=Strict, 30 min). No server-side session store is needed. Rotating `BRAIN_MCP_TOKEN` logs out every session.
- **POST protection:** every POST needs a same-origin `Origin` (or `Sec-Fetch-Site`). Once logged in, it also needs a CSRF token bound to the session id.
- **Page hardening:** CSP `default-src 'none'; form-action 'self'; frame-ancestors 'none'`.
- **Agents list:** label, kind (PAT hint / OAuth family), last used, calls in the last 7 days, last `clientInfo`, connection date, activity link, Revoke.
- **Master-token banner:** shown while the master token is still being used.
- **New PAT:** the token is shown **once**, with snippets for Meta Muse, Claude Code, Cursor and Gemini CLI, plus the smoke command.
- **Activity:** the latest 200 calls, either across all agents or for one of them.

## 6. Client compatibility

- **Transport**
  - Streamable HTTP with plain JSON responses.
  - `OPTIONS` is answered with 204 for CORS; `GET` and `DELETE` get 405.
  - Notifications and client responses get 202.
  - JSON-RPC batches of up to 20 messages are accepted leniently.
  - Protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 are negotiated.
  - Empty `prompts/list` and `resources/templates/list` are served, and `logging/setLevel` is accepted.
- **Tool descriptions**
  - All 38 tools have a `title` and full `annotations`. ChatGPT and Gemini use these to decide when to ask for confirmation.
  - Every write tool's "ONLY call when…" / "NEVER call autonomously" sentence appears in its first 300 characters, so clients that truncate still see it.
  - Nullable fields use `anyOf`, never JSON-Schema type arrays (Gemini).
  - `INSTRUCTIONS` is ≤ 2,000 characters (Claude Code truncates at 2,048).
  - `test/schema-portability.test.ts` enforces all of this.
- **`read_protocol` tool:** returns the same protocol text as the MCP resources, for clients that can't read resources (Muse, and possibly Spark and ChatGPT). Tool descriptions point to it.
- **Tool count:** 38 is close to Cursor's limit of roughly 40 tools.

## 7. Verification

- **Worker tests:** `mcp-worker` → `npm run typecheck`, then `TEST_DATABASE_URL=postgres://…/x_test npm test -- --run`. They cover:
  - pure auth, redirect, session, metadata and schema checks;
  - transport cases;
  - OAuth end to end, including rotation, reuse revocation and `/revoke`;
  - PAT authentication and attribution;
  - the console's CSRF, cookies, and PAT lifecycle.
- **Hyperdrive static test:** it checks that every read in an auth, OAuth or console file carries `now()`.
- **Smoke script:** `npm run smoke` (see the setup guide) has been checked against `wrangler dev` on a local Postgres, with the master token, a PAT, and the full OAuth flow including `--revoke`.

## 8. Rollout

1. Merge. The Node monolith applies migration 020 on its next boot.
   - Until that happens, the master token still works, but OAuth and the console return errors.
2. Run `npm run smoke` with the master token. Then create a PAT and run `--write`, and after revoking it run `--expect-401`.
3. Reconnect each client following the setup guide, so that each one gets its own label.
4. Watch the console's master-token banner. Give each remaining caller (for example socialisn2) its own PAT.
5. After a quiet week:
   1. Commit `ALLOW_MASTER_BEARER: "false"`.
   2. Rotate `BRAIN_MCP_TOKEN`.

## 9. Follow-ups (not in this phase)

- Prune `mcp_call_log` on a retention schedule, from the monolith scheduler.
- Per-tool scopes, such as read-only credentials for experimental agents.
- Rate-limit wrong owner-secret attempts. The secret is 256-bit random, so brute force is not practical today.

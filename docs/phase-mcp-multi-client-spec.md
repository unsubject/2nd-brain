# Phase: multi-client MCP access — build spec

Status: implemented. It consists of migration `020_mcp_credentials.sql`, `mcp-worker/src/auth/*`, `src/oauth/*`, `src/console.ts` and `src/calllog.ts`; follow-ups added write attribution (migration `022_idea_write_attribution.sql`), call-log retention (`src/mcp/retention.ts` in the monolith) and MCP 2026-07-28 support (`mcp-worker/src/protocol.ts`).
Setup guide for each client: [`mcp-client-setup.md`](mcp-client-setup.md).

## 1. Context and decisions

2nd-brain is reached only through AI agents over MCP. The Idea Parking Lot made that explicit: there is no front-end, so every agent the user works with has to reach the same tools. Those agents are:

- Claude (web, Desktop, Code)
- ChatGPT
- Cursor
- Gemini CLI
- **Gemini Spark** (Google's agent; custom apps over OAuth only)
- **Meta Muse** (Meta's agent; connectors are built in chat and sign in with OAuth and dynamic registration via `https://agent.meta.ai/api/hatch/oauth/callback`; a PAT from its Secure Credentials Store is the fallback)

Before this phase, every client ended up with the master `BRAIN_MCP_TOKEN`. The OAuth flow simply handed it out as the access token, accepted any redirect URI, and could not revoke anyone.

Decisions (2026-10-04):

| # | Decision |
|---|---|
| 1 | Every client gets **all tools**. A `scope` column exists for later; only `all` is honoured and anything else fails closed. |
| 2 | **Per-client revocable credentials**, of two kinds: **OAuth grants**, which the client obtains itself after the owner approves, and **personal access tokens** (PATs), which the owner creates in a console. Both are stored hashed, with a label and last-used time. |
| 3 | **Writes are attributed on the server.** Every idea write records the credential label permanently (`captured_via`, `proposed_via`, `decided_via`, note `credential`, the append-only `edit_log`; migration 022), and every tool call is logged per credential (pruned after the retention window). |
| 4 | A **per-client setup guide** with a smoke test. |
| 5 | The master token is kept as a legacy bearer behind `ALLOW_MASTER_BEARER` until the console shows it is unused. Approving connections and signing in to the console use a separate `OWNER_SECRET`, because earlier OAuth clients received `BRAIN_MCP_TOKEN` as their access token. Until `OWNER_SECRET` is set, it falls back to `BRAIN_MCP_TOKEN`, and the console warns about it. |

## 2. Data model (migration 020)

| Table | Holds |
|---|---|
| `mcp_client` | RFC 7591 registrations: the allowed redirect URIs, client family, raw metadata, and a hash of the registering IP (for the cap). Rows never approved are swept after 7 days. |
| `mcp_credential` | One per connected agent: `label` (unique among live credentials, case-insensitive), `kind` `pat`/`oauth`, `scope`, `last_used_at`, `last_client_info` (from `initialize`), `revoked_at` + `revoked_reason` (`owner`, `replaced`, `client`, `code_reuse`). The labels `master` and `unknown` are reserved. |
| `mcp_token` | SHA-256 hex hashes of opaque tokens: `access` (1 h); `refresh` (90-day idle expiry, rotated, with `reuse_count` bounding grace-window reuse); `pat` (no expiry, one per credential). |
| `mcp_auth_code` | Single-use codes (hashed, 5 min). Each is bound to the client, redirect URI, PKCE challenge, resource, label and the owner's "replace" choice, and records the credential it minted. |
| `mcp_call_log` | One row per tool call: credential, label, tool, write flag, ok, error code, duration, result ids. **Never arguments.** Kept `MCP_CALL_LOG_RETENTION_DAYS` days (default 90, minimum 7), pruned daily by the Node monolith (`src/mcp/retention.ts`). |

Revoking a credential leaves its token rows in place; every lookup joins on `revoked_at IS NULL`. The monolith's daily retention job (`src/mcp/retention.ts`) deletes tokens of credentials revoked more than a day ago, tokens expired or rotated more than a day ago, expired codes, and registrations never approved within 7 days; credential rows are kept for the console's "Recently revoked" list. The Worker's own sweeps after successful OAuth requests stay as a second line. Tokens are prefixed `brain_at_`, `brain_rt_` and `brain_pat_`, so a leaked token is easy to recognise and grep for.

## 3. `/mcp` authentication

1. Read the bearer token; the scheme name is matched case-insensitively.
2. Compare it in constant time with the master `BRAIN_MCP_TOKEN`, unless `ALLOW_MASTER_BEARER` is `"false"`.
3. If the token has the `brain_at_` or `brain_pat_` prefix, look it up by hash in one indexed query that includes `now()`, so Hyperdrive never serves it from cache. That makes revocation immediate.
4. Anything else gets a 401 with no database call. The 401 carries `WWW-Authenticate` with `scope="mcp"` and `resource_metadata=<base>/.well-known/oauth-protected-resource/mcp`, plus `error="invalid_token"` when a token was presented.
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
  - It does **not** advertise client metadata documents (CIMD). The server can't resolve URL client ids, and every target client registers itself (DCR) when CIMD isn't advertised. Field reports on Gemini Spark (July–September 2026; no Spark session has been run against this server yet):
    - It used a URL client_id under `https://accountlinking.google.com/clientidmetadata/…` with a server that offered CIMD and no registration endpoint.
    - Servers that advertised both saw it register via DCR.
    - A few servers that advertised CIMD saw it stop at a manual client ID/secret prompt, for disputed reasons.

    Leaving CIMD out avoids that ambiguity.
  - Protected-resource metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/mcp` (resource `<base>/mcp`) and at the root (resource `<base>`). It lists only the `mcp` scope: `offline_access` is advertised by the authorization server, as MCP 2026-07-28 asks, and a refresh token is issued either way.
  - Registration echoes `application_type` when the client sends `web` or `native`.
- **Registration** (`/register`)
  - Public clients only.
  - Each redirect URI must match the allow-list:

    | Family | Allowed redirect URIs |
    |---|---|
    | Claude | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` (exact) |
    | ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` (exact) or the `https://chatgpt.com/connector/oauth/` prefix |
    | Cursor | `cursor://anysphere.cursor-mcp/oauth/callback`, `https://www.cursor.com/agents/mcp/oauth/callback` (Cloud Agents) |
    | Google | the `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-` prefix (Gemini Spark's per-user, per-connector callback). Other `/r/<project-id>` paths on that relay deliver to arbitrary Google Cloud projects, whose ids can't contain `_`, so they are refused. |
    | Meta | `https://agent.meta.ai/api/hatch/oauth/callback` (exact; Meta Muse custom connectors) |
    | Native apps | RFC 8252 loopback (`http://localhost`, `127.0.0.1`, `[::1]`); the port may differ from the registered one |
    | Custom | any `https://` prefix listed in `OAUTH_EXTRA_REDIRECT_PREFIXES`, matched at a `/` boundary |

  - Prefix rules refuse dot segments and encoded `/`, `\` and `.` in the path.
  - URIs off the list are dropped from a registration (RFC 7591 §3.2.1). Registration fails only if none remains.
  - Registrations still waiting for approval are capped per hour: 10 per source IP and 200 in total. The count and the insert happen under one lock.
  - Request bodies over 16 KB are refused without being buffered.
- **Authorize**
  - Problems with the client or its redirect URI are shown as an error page and never redirected.
  - Every other error is redirected back with `state` and `iss`. The exception is a legacy client that hasn't been adopted yet: its redirect URI is merely allow-listed, not registered, so its errors and denials are shown as pages too. That covers a wrong `response_type`, a missing or non-S256 PKCE challenge, and a foreign `resource` (`invalid_target`).
  - The consent page shows the client family and redirect host. Both are derived from the redirect URI, so they can be trusted. The client's self-declared name is shown and marked *unverified*.
  - The owner names the connection and types the owner secret to approve.
    - The page doesn't look up existing labels, because it is unauthenticated. A clashing label gets " (2)" at `/token`.
    - A **Replace** checkbox revokes the owner's existing OAuth connection with exactly that label, so a reconnect keeps its name. It is ticked by default for Claude, ChatGPT, Google and Meta, whose vendors hold one connection per account. It never revokes an access token (PAT) with the same label; a live PAT keeps the name, and the new connection gets " (2)".
    - The page cannot be framed, is never cached, and loads no third-party resources.
  - Legacy `mcp-client-<uuid>` ids issued by the old stateless flow are adopted on approval, provided the redirect URI they present passes the allow-list.
- **Token**
  - **Authorization-code grant:** one transaction.
    - The code row is locked first. The client id, redirect URI (if sent) and PKCE verifier are checked *before* the code is consumed. Someone who merely saw a code can neither burn it nor trigger revocation.
    - A code redeemed again with the right verifier revokes the credential it minted (`code_reuse`).
    - The label is made unique under an advisory lock. Each candidate is checked with the index's own `lower(btrim())`, because JavaScript and Postgres case folding differ.
    - A refresh token is **always** issued. Claude does not ask for `offline_access`. Spark does ask for it, and a third-party server that issued none saw Spark get stuck once the 1-hour access token expired. Spark actually using a refresh token has not been observed yet.
  - **Refresh grant:**
    - The row is locked and rotated.
    - Within 5 minutes of its first rotation, the same token may be redeemed again, up to 10 times. Each time it gets its own new pair.
      - This is needed because SDK clients refresh in parallel, and Claude Code and Gemini CLI processes share one token store.
      - Reusing the token doesn't extend the window.
    - After the window the token is refused, and **nothing is revoked**.
      - Revoking would mean a stale copy in an idle process logs out the live ones.
      - Theft response is the owner's call in `/tokens`, where every call is visible.
  - Errors follow RFC 6749 JSON. Responses carry `Cache-Control: no-store`.
- **Revoke** (`/revoke`, RFC 7009)
  - Any of our tokens revokes its whole credential.
  - An unknown token still gets 200.

## 5. Owner console (`/tokens`)

- **Login:** the owner secret (`OWNER_SECRET`, else `BRAIN_MCP_TOKEN` with a warning banner) creates an HMAC-signed `__Host-brain_console` cookie (HttpOnly, Secure, SameSite=Strict, 30 min). No server-side session store is needed. Rotating `BRAIN_MCP_TOKEN` logs out every session.
- **POST protection:** every POST needs a same-origin `Origin` (or `Sec-Fetch-Site`). Once logged in, it also needs a CSRF token bound to the session id.
- **Page hardening:** CSP `default-src 'none'; form-action 'self'; frame-ancestors 'none'`.
- **Agents list:** label, kind (PAT hint / OAuth family), last used, calls in the last 7 days, last `clientInfo`, connection date, activity link, Revoke.
- **Master-token banner:** shown while the master token is still being used.
- **New PAT:** the token is shown **once**, with snippets for Meta Muse, Claude Code, Cursor and Gemini CLI, plus the smoke command.
- **Activity:** the latest 200 calls, either across all agents or for one of them, within the call-log retention window.

## 6. Client compatibility

- **Transport**
  - Streamable HTTP with plain JSON responses.
  - `OPTIONS` is answered with 204 for CORS.
  - A tokenless `HEAD` gets the same 401 discovery challenge as a tokenless `POST`, because Gemini Spark probes with it.
  - `GET`, `DELETE`, and a `HEAD` that carries a token get 405. The spec allows this when there is no SSE stream or session.
  - Notifications and client responses get 202.
  - JSON-RPC batches of up to 20 messages are accepted leniently (2025-era messages only).
  - Protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 are negotiated through `initialize`.
  - Empty `prompts/list` and `resources/templates/list` are served, and `logging/setLevel` is accepted.
- **MCP 2026-07-28 (dual-era server, `src/protocol.ts`)**
  - A message is served the 2026 way only on an explicit signal: method `server/discover`, the `io.modelcontextprotocol/protocolVersion` key in `params._meta` (any value: the key exists only from 2026-07-28, so a 2025 version there is a 2026 request with an unsupported version), or a 2026 `MCP-Protocol-Version` header. `initialize` is always 2025-era, and 2025-era requests never see a 2026 error or field, so 2026 clients that probe first still fall back cleanly.
  - `server/discover` returns `supportedVersions` (2026-07-28 first, then the 2025 versions), capabilities, instructions and `serverInfo`.
  - Each 2026 request is validated: missing `_meta` protocol version or client capabilities → `-32602`; missing or mismatched `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` (surrounding whitespace stripped, base64 sentinel decoded; raw non-ASCII or control characters are refused, so non-ASCII names must use `=?base64?…?=`) → `-32020`; unsupported version → `-32022` with `{supported, requested}`. All with HTTP 400, and no version strings in error messages (Claude Code misreads them).
  - Results carry `resultType: "complete"` and `serverInfo` in `_meta`; discover, lists and reads also carry `ttlMs` (5 minutes) and `cacheScope: "private"`.
  - `ping`, `logging/setLevel` (removed in 2026-07-28) and unknown methods answer HTTP 404 / `-32601`. A batch containing a 2026 message is refused.
  - `clientInfo` comes from `_meta` and is stored on the credential only when it changes.
  - The CORS preflight allows `Mcp-Method` and `Mcp-Name`.
- **Tool descriptions**
  - All 38 tools have a `title` and full `annotations`. ChatGPT asks for confirmation before any tool not marked read-only, and Gemini CLI reads `readOnlyHint`. Gemini Spark confirms write actions; July 2026 field notes saw it confirm every call on a server without annotations, so it is unverified whether it honours `readOnlyHint`.
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
  - PAT authentication and attribution, including proposer/decider stamps;
  - the console's CSRF, cookies, and PAT lifecycle;
  - the 2026-07-28 path (`test/protocol.test.ts` and the dual-era block in `test/dispatcher.test.ts`).
- **Root tests:** `test/mcp-retention.test.ts` covers the daily pruning.
- **Hyperdrive static test:** it checks that every read in an auth, OAuth or console file carries `now()`.
- **Smoke script:** `npm run smoke` (see the setup guide) has been checked against `wrangler dev` on a local Postgres, with the master token, a PAT, and the full OAuth flow including `--revoke`; `--modern` adds the 2026-07-28 checks.

## 8. Rollout

0. Set the `OWNER_SECRET` Worker secret (`openssl rand -hex 32`).
1. Apply the migrations, then merge. The Worker deploys from CI on its own while the Node monolith applies migrations only when it boots, and the Worker code needs migration 022's columns.
   - Recommended: first count the string-typed rows `021_repair_double_encoded_jsonb.sql` will repair (`SELECT count(*) FROM <table> WHERE jsonb_typeof(<column>) = 'string'` for each column it lists), then run `npm run migrate` against production from the branch, then merge; the monolith's boot then skips them. 020 and 022 are additive; 021 rewrites string-wrapped jsonb in place, which every reader already accepts; all three are idempotent.
   - A database that ran 022 from an earlier revision of the branch (it added `idea.updated_via`) still gets today's file, which has a different name; it drops `updated_via` and converges.
   - Rolling the Worker back to a build without 022's columns is safe: the `decided_via` CHECK only checks its shape, so the older reopen (which clears `decided_at` alone) still works. Links it reopens keep a stale `decided_via` until they are decided again.
   - Otherwise, until the monolith has booted: OAuth and the console return errors, and `get_idea`, `list_idea_links`, `update_idea`, `decide_idea_links`, `propose_idea_links` (reopen), `create_synthesis` and the `import_ideas` merge path fail with a missing-column error, even with the master token. Re-run the deploy workflow if the Worker went live first and something stays broken.
   - Rows the old `close_cycle`/`record_pick` write between the migration and the Worker deploy stay string-wrapped; readers unwrap them, and re-running that migration's `DO` block by hand (idempotent) repairs them.
   - Optionally set `MCP_CALL_LOG_RETENTION_DAYS` on the Railway service (default 90).
2. Run `npm run smoke` with the master token. Then create a PAT and run `--write`, and after revoking it run `--expect-401`.
3. Reconnect each client following the setup guide, so that each one gets its own label.
4. Watch the console's master-token banner. Give each remaining caller (for example socialisn2) its own PAT.
5. After a quiet week:
   1. Commit `ALLOW_MASTER_BEARER: "false"`.
   2. Rotate `BRAIN_MCP_TOKEN`.
   3. Review `/tokens` and revoke anything you don't recognise.
- **Residual risk:** an attacker can add their own vendor connector pointing at this server and send the owner its consent link. The page truthfully names the vendor. The only defences are the warning text and approving only connections you just started yourself. For Google, the pinned prefix makes the label truthful, but an attacker's own Spark connector still matches it, so the same defence applies.

## 9. Follow-ups (not in this phase)

- **Client ID Metadata Documents (CIMD), deferred.** MCP 2026-07-28 makes CIMD the preferred registration and deprecates DCR, but DCR can't be removed before 2027-07-28, and every target client registers itself when CIMD isn't advertised. Revisit when a client requires it. Accepting URL client ids needs an SSRF-safe fetch from the Worker, a host trust policy and caching.
- **`Origin` validation on `/mcp`, deferred.** The 2026 transport says servers MUST reject an invalid `Origin` with 403. `/mcp` is bearer-only with no cookies and serves browser-based clients (MCP Inspector) with wildcard CORS, so there is no DNS-rebinding exposure to protect; an allow-list would break those clients.

- Per-tool scopes, such as read-only credentials for experimental agents.
- Rate-limit wrong owner-secret attempts. The secret is 256-bit random, so brute force is not practical today.
- Spark callbacks are per user and per connector (`/r/user_bound_custom-mcp-<id>-<host>`), so the built-in rule pins that prefix rather than one exact URI. An owner-specific exact pin would belong in a private setting, never in the public repo.
- On the first real Gemini Spark connection, confirm:
  1. A tool call more than an hour after connecting succeeds. That is, a refresh is observed: Workers Logs show a second `POST /token`.
  2. `GET` returning 405, and the lack of a session id, don't stall Spark.
  3. Whether a read-only tool runs without a confirmation prompt.
  4. A tool whose schema has `additionalProperties` (e.g. `read_protocol`) loads and runs.

  If check 1 fails, consider a longer reuse grace for Google-family refresh tokens. Keep rotation itself: the MCP spec requires it for public clients.

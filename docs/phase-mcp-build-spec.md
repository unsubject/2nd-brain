# Phase: 2nd-brain MCP server

Build phase for a remote MCP server exposing the 2nd-brain journal to AI tools (Claude.ai, Claude Desktop, Cursor, ChatGPT). This is the first purpose-built MCP server in this repo; the existing `2nd-brain-pg` MCP is a generic Postgres MCP and is unrelated.

This doc reflects the **shipped reality** as of 2026-05-16 — the architecture, four working tools, OAuth flow, and CI deploy. The Implementation Order section below is preserved as historical record of how we got here.

## Goal

Two-way bridge between AI chat tools and the journal:

- **Save** — AI brainstorm sessions land in the journal as a new `ai_chat` channel so they're not lost.
- **Recall** — AI tools can semantic-search the journal before brainstorming, surfacing prior thinking the user might overlook.

## Non-goals (this phase)

- Morning-review surface to AI clients (`get_morning_review`)
- Family / multi-user auth
- Writes to `public_artifact` for long-form sessions
- Raw transcript storage (summary-only for v1)
- Knowledge-graph traversal tool over `link_edge`
- Searching the other 5-W tables (`calendar_event_ref`, `task_ref`, `email_ref`, `person_ref`, `public_artifact`) — only `journal_entry` is exposed in v1

## Architecture

```
AI client (Claude.ai / Desktop / Cursor / ChatGPT)
    │  Streamable HTTP MCP, Authorization: Bearer <access_token>
    │  (claude.ai obtains the access_token via OAuth 2.1 + PKCE;
    │   Desktop / curl can use BRAIN_MCP_TOKEN directly)
    ▼
CF Worker: 2nd-brain-mcp        (independent deploy, auto-deployed by CI)
    │  Hyperdrive binding (pooled, cached)
    ▼
Railway Postgres                ── same DB the Node monolith writes to ──
    │
    │  Worker INSERTs capture_event + journal_entry
    │  (channel='ai_chat', processing_status='pending')
    ▼
Existing src/worker.ts polling loop processes the row
    → src/processor.ts (OpenAI gpt-5.4-nano):
        clean_text, summary, tags[], primary_type, suggested_actions
    → src/embeddings.ts (OpenAI text-embedding-3-small, 1536d)
    → UPDATE journal_entry SET processing_status='processed'
```

The Node monolith needs **zero changes** — the worker already polls `processing_status='pending'` without filtering by channel.

The Worker also exposes the OAuth endpoints (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/register`, `/authorize`, `/token`) needed by claude.ai's custom-connector flow. State is stateless: authorization codes are HMAC-signed with `BRAIN_MCP_TOKEN`, so no KV / DO is required.

## Tool catalogue

All tools are bearer-gated. Tools live in `mcp-worker/src/tools/`, one file per tool.

### `save_session` — write

```ts
input: {
  title: string                                 // human-readable session label
  summary: string                               // AI-written narrative (NOT a transcript)
  scope?: 'personal' | 'family'                 // default: 'personal'
  source?: { client?: string; model?: string }  // e.g. { client: 'claude.ai', model: 'claude-opus-4-7' }
}

effect:
  BEGIN
    INSERT INTO journal_entry (
      user_id, channel, full_text, scope,
      created_at, updated_at,
      stitch_window_start, stitch_window_end, processing_status
    ) VALUES (
      <BRAIN_USER_ID>, 'ai_chat', '[<title>]\n\n<summary>', <scope>,
      now(), now(),
      now() - interval '15 minutes', now() - interval '15 minutes',
      'pending'
    ) RETURNING id;

    INSERT INTO capture_event (
      user_id, channel, channel_message_id, raw_text,
      received_at, journal_entry_id, is_system_command
    ) VALUES (...);
  COMMIT;

output: { entry_id: uuid, status: 'queued_for_processing', channel: 'ai_chat', scope }
```

`stitch_window_end` is backdated 15 minutes so the row is immediately past the monolith's 10-minute `STITCH_WINDOW_MS` and gets picked up on the next worker poll (~30s) instead of waiting the full window. `ai_chat` sessions are atomic — no stitching needed.

### `search_brain` — read

```ts
input: {
  query: string                                            // free-text question
  limit?: number = 10
  since?: string                                           // ISO 8601 lower bound on created_at
  until?: string                                           // ISO 8601 upper bound
  tags?: string[]                                          // entries must contain ALL given tags
  primary_type?: 'task_candidate' | 'goal_candidate'
                | 'knowledge_candidate' | 'archive_only'
  scope?: 'personal' | 'family' | 'all' = 'personal'
}

effect:
  vector = embed(query)                                    // text-embedding-3-small, 1536d
  SELECT id, summary, clean_text, to_jsonb(tags) AS tags,
         primary_type, created_at,
         1 - (embedding <=> $vector) AS similarity
    FROM journal_entry
   WHERE processing_status = 'processed' AND embedding IS NOT NULL
     AND (scope = $scope OR $scope = 'all')
     AND ($since IS NULL OR created_at >= $since)
     AND ($until IS NULL OR created_at <= $until)
     AND ($tags IS NULL OR tags @> $tags)
     AND ($primary_type IS NULL OR primary_type = $primary_type)
   ORDER BY embedding <=> $vector
   LIMIT $limit;

output: Array<{
  id, similarity, created_at, primary_type, tags, summary, preview
}>
```

`tags` is coerced via `to_jsonb` because `fetch_types: false` skips OID parsing for `text[]`. Mirrors the existing `findSimilarEntries(...)` SQL in `src/db/queries.ts`.

### `get_entry` — read

```ts
input:  { entry_id: uuid }
output: {
  id, channel, scope, processing_status,
  primary_type, primary_type_confidence,
  created_at, updated_at, tags, summary, clean_text, full_text,
  suggested_actions,
  links: Array<{ target_id, target_type, link_type, confidence, explanation }>
}
```

Joins `journal_entry` → `link_edge` where `source_type = 'journal_entry'` and `source_id = entry_id`.

### `list_recent` — read

```ts
input: {
  days?: number = 7
  scope?: 'personal' | 'family' | 'all' = 'personal'
  primary_type?: string
  limit?: number = 50
}

effect:
  SELECT id, summary, to_jsonb(tags) AS tags, primary_type, created_at
    FROM journal_entry
   WHERE processing_status = 'processed'
     AND created_at >= now() - make_interval(days => $days)
     AND (scope = $scope OR $scope = 'all')
     AND ($primary_type IS NULL OR primary_type = $primary_type)
   ORDER BY created_at DESC
   LIMIT $limit;
```

## Auth

Two paths, same underlying `BRAIN_MCP_TOKEN`:

### Path A — Bearer (Claude Desktop, curl, Cursor with direct bearer support)

- Header: `Authorization: Bearer <BRAIN_MCP_TOKEN>`
- Token lives in CF Worker secret: `BRAIN_MCP_TOKEN` (generated via `openssl rand -hex 32`)
- Constant-time compared inside the Worker
- On failure: HTTP 401 with `WWW-Authenticate: Bearer realm="2nd-brain", resource_metadata="<server>/.well-known/oauth-protected-resource"` so OAuth clients can self-discover

### Path B — OAuth 2.1 + PKCE (claude.ai's custom-connector UI)

claude.ai's connector UI does not accept a raw bearer; it requires OAuth discovery. The Worker exposes:

- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata
- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata
- `POST /register` — RFC 7591 dynamic client registration (accepts any client; single-user)
- `GET /authorize` — HTML consent form asking for `BRAIN_MCP_TOKEN`
- `POST /authorize` — validates the token, redirects with a code (HMAC-signed, 10-min TTL)
- `POST /token` — verifies PKCE S256, returns `BRAIN_MCP_TOKEN` as the `access_token`

No KV / DO needed — codes are stateless, HMAC-signed using `BRAIN_MCP_TOKEN` as the key. The OAuth dance ends up handing claude.ai the same bearer token, so `/mcp` auth is unchanged regardless of path.

### Token rotation

Generate a new `BRAIN_MCP_TOKEN`, set it via the CF Secrets API (`workers/scripts/2nd-brain-mcp/secrets` PUT), and re-authorize each connected client. claude.ai needs to re-do the OAuth dance; Desktop needs the new value in its `mcp-remote` `--header` flag.

## Hyperdrive setup

```jsonc
// wrangler.jsonc
{
  "name": "2nd-brain-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "hyperdrive": [
    { "binding": "HYPERDRIVE", "id": "<hyperdrive-config-id>" }
  ]
}
```

- Hyperdrive config (`2nd-brain-pg`) wraps the Railway PG connection string (the same one `src/db/client.ts` uses)
- Connection string lives **only** inside Hyperdrive — never as a separate Worker secret
- `postgres-js` driver, connected via `postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false })`

## Secrets (CF Worker)

| Name | Purpose | Source |
|---|---|---|
| `BRAIN_MCP_TOKEN` | Bearer / OAuth access_token | `openssl rand -hex 32` |
| `OPENAI_API_KEY` | Query embeddings in `search_brain` | Same key the monolith uses |
| `BRAIN_USER_ID` | Text identifier stamped on `ai_chat` entries | Telegram numeric id (matches existing personal entries; current value `236871164`) |

## Data path — writes

```
1. Client calls save_session(title, summary, scope?, source?)
2. Worker validates bearer (or OAuth-issued access_token, same thing)
3. Worker validates inputs (zod): title ≤ 200, summary ≤ 32k
4. Worker opens a tx via Hyperdrive:
     INSERT journal_entry(..., stitch_window_end = now() - 15min, processing_status='pending')
     INSERT capture_event(..., journal_entry_id = <new id>)
5. Worker returns { entry_id, status: 'queued_for_processing' }
6. monolith's worker.ts polls (every 30s), sees pending row, runs processor.ts + embeddings, marks processed
```

Lag from save → searchable is typically ~30–60s.

## Data path — reads

```
1. Client calls search_brain(query, ...filters)
2. Worker validates bearer
3. Worker embeds the query via OpenAI (env.OPENAI_API_KEY)
4. Worker runs filtered pgvector query via Hyperdrive
5. Returns top-N rows with similarity scores
```

`get_entry` and `list_recent` skip the embedding step.

## Deployment

The Worker auto-deploys on push to `main` when `mcp-worker/**` or the workflow file changes — see `.github/workflows/deploy-mcp-worker.yml`. The workflow runs `npm install`, `tsc --noEmit`, then `wrangler deploy` via `cloudflare/wrangler-action@v3`.

GitHub repo secrets used by CI:

- `CLOUDFLARE_API_TOKEN` — scoped to Workers Scripts:Edit, Hyperdrive:Edit, User Memberships:Read
- `CLOUDFLARE_ACCOUNT_ID` — `2f58eaae9db581b9856eaa50937f0098` (Simon Lee)

Worker secrets and Hyperdrive config are managed in the CF dashboard / via the CF API — not via this workflow.

First-time setup (already done; documented for posterity):

1. `wrangler hyperdrive create 2nd-brain-pg --connection-string="$RAILWAY_PG_URL"` (or POST `/accounts/{id}/hyperdrive/configs`)
2. Paste returned id into `wrangler.jsonc`
3. Set `BRAIN_MCP_TOKEN`, `OPENAI_API_KEY`, `BRAIN_USER_ID` via dashboard or CF Secrets API
4. Push the worker code → CI deploys
5. `curl https://<worker>.workers.dev/db-health` returns `{ ok: true, version: 'PostgreSQL 18.x...' }`
6. Connect from claude.ai (custom connector → URL = `https://<worker>.workers.dev/mcp`) or Claude Desktop (via `mcp-remote --header Authorization:"Bearer <token>"`)

## File layout

```
mcp-worker/
├── src/
│   ├── index.ts             # fetch handler: /health, /db-health, /mcp, OAuth routes
│   ├── env.ts               # shared Env interface
│   ├── mcp.ts               # JSON-RPC: initialize, tools/list, tools/call
│   ├── auth.ts              # bearer check + constant-time compare
│   ├── oauth.ts             # OAuth metadata + DCR + authorize + token + HMAC codes
│   ├── db.ts                # postgres-js client factory via HYPERDRIVE binding
│   ├── embeddings.ts        # OpenAI text-embedding-3-small (fetch-based)
│   └── tools/
│       ├── registry.ts      # Tool / ToolResult types + tools[] export
│       ├── save_session.ts
│       ├── search_brain.ts
│       ├── get_entry.ts
│       └── list_recent.ts
├── wrangler.jsonc
├── package.json
└── tsconfig.json

.github/workflows/
└── deploy-mcp-worker.yml    # auto-deploy on push to mcp-worker/**

docs/
├── phase-mcp-build-spec.md             # this file
└── mcp-behavior-and-dev-norms.md       # AI client behavior + dev norms
```

No tests yet — vitest setup is planned but not landed in v1.

## Implementation order (historical)

1. Worker skeleton: package, wrangler config, Hyperdrive binding, `/health` + `/db-health` route. Deploy and confirm PG connectivity.
2. Bearer auth + MCP protocol skeleton (`initialize`, `tools/list`, empty `tools/call`). Surface the behavioral doc's Part 1 in the MCP `instructions` field.
3. `search_brain` (read-only, lowest risk, highest immediate value).
4. `get_entry` and `list_recent` (mechanical).
5. `save_session` last — verified worker.ts in the Node monolith picks up the row and processes it end-to-end.
6. OAuth 2.1 + PKCE wrapper added so claude.ai's connector UI works.
7. Docs reconciled with shipped reality.

## Verification

End-to-end manual test after deploy:

1. From Claude.ai with the connector enabled: ask "search my brain for thoughts on `<known recent topic>`". Expect hits with similarity scores and matching `primary_type`.
2. Ask "what have I been thinking about this week" → `list_recent` returns recent entries.
3. Tell Claude "save this brainstorm to my brain, title it 'MCP server design'" → `save_session` returns `entry_id`. Verify the row exists in `journal_entry` with `channel='ai_chat'`, `processing_status='pending'`.
4. Wait ~30–60s: re-query. `processing_status='processed'`, `tags` populated, `embedding` non-null. Proves `worker.ts` picked it up unchanged.
5. Run `search_brain` for a phrase from the saved summary → the new entry appears.
6. Negative: call any tool with wrong / missing bearer → HTTP 401 with `WWW-Authenticate`.

All six were verified on 2026-05-16 against the live worker at `https://2nd-brain-mcp.simon-lee.workers.dev`.

## Error model

All tool errors return MCP `tools/call` results with `isError: true` and a human-readable message. Internal categories:

- `auth_failed` — bearer rejected (also returned as HTTP 401 before MCP layer, with `WWW-Authenticate` header)
- `validation_failed` — input failed zod parse
- `db_error` — Hyperdrive / PG query threw
- `embedding_failed` — OpenAI embeddings call failed (search_brain only)
- `not_found` — `get_entry` for nonexistent UUID

Errors never leak DB internals to the client. Stack traces stay in Worker logs (observability on).

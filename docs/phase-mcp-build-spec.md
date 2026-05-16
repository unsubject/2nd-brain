# Phase: 2nd-brain MCP server

Build phase for a remote MCP server exposing the 2nd-brain journal to AI tools (Claude.ai, Claude Desktop, Cursor, ChatGPT). This is the first purpose-built MCP server in this repo; the existing `2nd-brain-pg` MCP is a generic Postgres MCP and is unrelated.

## Goal

Two-way bridge between AI chat tools and the journal:

- **Save** — AI brainstorm sessions land in the journal as a new `ai_chat` channel so they're not lost.
- **Recall** — AI tools can semantic-search the journal before brainstorming, surfacing prior thinking the user might overlook.

## Non-goals (this phase)

- Morning-review surface to AI clients
- Family / multi-user auth
- OAuth (MCP dynamic client registration)
- Writes to `public_artifact`
- Raw transcript storage (summary-only for v1)
- Knowledge-graph traversal tool over `link_edge`

## Architecture

```
AI client (Claude.ai / Desktop / Cursor / ChatGPT)
    │  Streamable HTTP MCP, Authorization: Bearer $BRAIN_MCP_TOKEN
    ▼
CF Worker: 2nd-brain-mcp        (independent deploy, custom subdomain)
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

The Node monolith needs **zero changes** for v1. The worker already polls `processing_status='pending'` without filtering by channel.

## Tool catalogue

All tools are bearer-auth-gated. Tools live in `mcp-worker/src/tools/`, one file per tool.

### `save_session` — write

```ts
input: {
  title: string                                 // human-readable session label
  summary: string                               // AI-written narrative (NOT a transcript)
  scope?: 'personal' | 'family'                 // default: 'personal'
  source?: { client?: string; model?: string }  // e.g. { client: 'claude.ai', model: 'opus-4-7' }
}

effect:
  BEGIN
    INSERT INTO capture_event (
      journal_entry_id, user_id, channel, channel_message_id,
      raw_text, received_at, is_system_command
    ) VALUES (..., 'ai_chat', <synthetic-id>, summary, now(), false);

    INSERT INTO journal_entry (
      user_id, channel, stitch_window_start, stitch_window_end,
      full_text, scope, processing_status
    ) VALUES (..., 'ai_chat', now(), now(), summary, scope, 'pending');
  COMMIT;

output: { entry_id: uuid, status: 'queued_for_processing' }
```

`title` is stored in `capture_event.raw_text` prefix or as a tag-style annotation in `full_text` — pick one and keep it consistent. The processor will derive `summary`/`tags`/`primary_type` from `full_text` regardless.

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
  SELECT id, summary, clean_text, tags, primary_type,
         created_at, 1 - (embedding <=> $vector) AS similarity
    FROM journal_entry
   WHERE processing_status = 'processed'
     AND embedding IS NOT NULL
     AND (scope = $scope OR $scope = 'all')
     AND ($since IS NULL OR created_at >= $since)
     AND ($until IS NULL OR created_at <= $until)
     AND ($tags IS NULL OR tags @> $tags)
     AND ($primary_type IS NULL OR primary_type = $primary_type)
   ORDER BY embedding <=> $vector
   LIMIT $limit;

output: Array<{
  id: uuid, summary: string, clean_text: string,
  tags: string[], primary_type: string,
  created_at: ISO8601, similarity: number   // 0..1, higher = more similar
}>
```

Mirrors the existing `findSimilarEntries(...)` SQL in `src/db/queries.ts` — lift the same predicate shape rather than re-deriving.

### `get_entry` — read

```ts
input:  { entry_id: uuid }
output: {
  id, user_id, channel, full_text, clean_text, summary,
  tags, primary_type, primary_type_confidence,
  suggested_actions, processing_status, scope,
  created_at, updated_at,
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
  SELECT id, summary, tags, primary_type, created_at
    FROM journal_entry
   WHERE processing_status = 'processed'
     AND created_at >= now() - ($days || ' days')::interval
     AND (scope = $scope OR $scope = 'all')
     AND ($primary_type IS NULL OR primary_type = $primary_type)
   ORDER BY created_at DESC
   LIMIT $limit;

output: Array<{ id, summary, tags, primary_type, created_at }>
```

## Auth

- Header: `Authorization: Bearer <BRAIN_MCP_TOKEN>`
- Token lives in CF Worker secret store: `wrangler secret put BRAIN_MCP_TOKEN`
- Generate via `openssl rand -hex 32`
- Reject any request without a matching token: HTTP 401, no body
- Reject malformed bearer (wrong prefix, empty value): HTTP 401
- Rotation: generate new token, `wrangler secret put` overwrites, update every connected client. No grace period in v1.

The token is single-user and bearer-only. All entries are attributed to the same `user_id` (env-configured, single-tenant for v1).

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
    {
      "binding": "HYPERDRIVE",
      "id": "<hyperdrive-config-id>"
    }
  ]
}
```

- Hyperdrive config wraps the Railway PG connection string (the same one `src/db/client.ts` uses)
- Connection string stored only inside Hyperdrive config — never as a separate Worker secret
- Caching: default Hyperdrive query cache; OK for read tools (eventual consistency is fine for journal reads), `save_session` is a write so the cache is bypassed
- `postgres-js` driver, connect via `postgres(env.HYPERDRIVE.connectionString)`

## Data path — writes

```
1. Client calls save_session(title, summary, scope?, source?)
2. Worker validates bearer
3. Worker validates inputs (zod): non-empty title/summary, summary ≤ 32k chars
4. Worker opens a tx via Hyperdrive:
     INSERT capture_event(..., raw_text=`[${title}] ${summary}`)
     INSERT journal_entry(..., full_text=`[${title}] ${summary}`, processing_status='pending')
5. Worker returns { entry_id, status: 'queued_for_processing' }
6. Main Node app's worker.ts polls, sees pending row, runs processor.ts + embeddings, marks processed
```

There's a deliberate ~10–60s lag between save and the entry being searchable. That's fine — saves are user-prompted, search comes later.

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

1. `cd mcp-worker && npm install`
2. Create Hyperdrive config: `wrangler hyperdrive create 2nd-brain-pg --connection-string="$RAILWAY_PG_URL"`
3. Paste the returned config ID into `wrangler.jsonc`
4. `wrangler secret put BRAIN_MCP_TOKEN`
5. `wrangler secret put OPENAI_API_KEY` (must be a key with embeddings access)
6. `wrangler secret put BRAIN_USER_ID` (single-tenant user UUID for v1)
7. `wrangler deploy`
8. Optional: bind a custom domain (`brain-mcp.unsubject.dev` candidate); update DNS in Cloudflare
9. Hit `/health` to confirm the Worker is up
10. Hit `/mcp` with `Authorization: Bearer <token>` and an `initialize` MCP request to confirm the protocol round-trips
11. Add as a custom connector in claude.ai → settings → connectors; URL is the Worker's `/mcp` endpoint, auth is the bearer token
12. For Claude Desktop, follow the `mcp-remote` stdio proxy pattern

## File layout

```
mcp-worker/
├── src/
│   ├── index.ts             # fetch handler: /health, /mcp routes
│   ├── mcp.ts               # MCP protocol glue (initialize, tools/list, tools/call)
│   ├── auth.ts              # bearer check
│   ├── db.ts                # postgres-js client via HYPERDRIVE binding
│   ├── embeddings.ts        # OpenAI text-embedding-3-small call (mirrors src/embeddings.ts)
│   └── tools/
│       ├── save_session.ts
│       ├── search_brain.ts
│       ├── get_entry.ts
│       └── list_recent.ts
├── test/
│   └── tools.test.ts        # vitest + miniflare, real test PG
├── wrangler.jsonc
├── package.json
└── tsconfig.json

docs/
├── phase-mcp-build-spec.md             # this file
└── mcp-behavior-and-dev-norms.md       # AI client behavior + dev norms
```

## Implementation order

1. Worker skeleton: package, wrangler config, Hyperdrive binding, `/health` route. Deploy and confirm PG connectivity.
2. Bearer auth + MCP protocol skeleton (`initialize`, `tools/list`, empty `tools/call`). Surface the behavioral doc's Part 1 in the MCP `instructions` field.
3. `search_brain` (read-only, lowest risk, highest immediate value).
4. `get_entry` and `list_recent` (mechanical).
5. `save_session` last — verify worker.ts in the Node monolith picks up the row and processes it end-to-end before declaring done.
6. Land both docs (this file + behavioral doc) alongside the code.
7. Wire claude.ai connector; smoke-test all four tools from the web UI; then add to Claude Desktop via `mcp-remote`.

## Verification

End-to-end manual test after deploy:

1. From Claude.ai with the connector enabled: ask "search my brain for thoughts on `<known recent topic>`". Expect hits with similarity scores and matching `primary_type`.
2. Ask "what have I been thinking about this week" → `list_recent` returns recent entries.
3. Tell Claude "save this brainstorm to my brain, title it 'MCP server design'" → `save_session` returns `entry_id`. Verify with the `2nd-brain-pg` MCP that the row exists in `journal_entry` with `channel='ai_chat'`, `processing_status='pending'`.
4. Wait ~1 min: re-query. `processing_status='processed'`, `tags` populated, `embedding` non-null. Proves `worker.ts` picked it up unchanged.
5. Run `search_brain` for a phrase from the saved summary → the new entry appears.
6. Negative: call any tool with wrong / missing bearer → HTTP 401.

## Error model

All tool errors return MCP `tools/call` results with `isError: true` and a human-readable message. Internal categories:

- `auth_failed` — bearer rejected (also returned as HTTP 401 before MCP layer)
- `validation_failed` — input failed zod parse
- `db_error` — Hyperdrive / PG query threw
- `embedding_failed` — OpenAI embeddings call failed (search_brain only)
- `not_found` — `get_entry` for nonexistent UUID

Errors never leak DB internals to the client. Stack traces stay in Worker logs (observability on).

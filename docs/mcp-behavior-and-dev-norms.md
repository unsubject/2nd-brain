# 2nd-brain MCP — Behavior & dev norms

This doc has two audiences:

- **Part 1** is for the **AI client** connecting to this MCP (Claude.ai, Claude Desktop, Cursor, ChatGPT). It defines when each tool should be called and what good behavior looks like. The server surfaces a condensed version of Part 1 via the MCP `instructions` field so clients see it on connect.
- **Part 2** is for **developers** (human or AI) extending this MCP. It defines code, schema, and deploy norms.

---

## Part 1 — How AI clients should behave with this MCP

You are connected to the user's personal 2nd-brain: a journal of their random thoughts, brainstorms, tasks, and ideas, ingested mostly from Telegram and now from AI chat sessions like ours.

The journal is the user's external memory. Treat it as authoritative for **what the user has thought about** — but never authoritative for **what is true**. They write down half-baked ideas, frustrations, and questions, not vetted conclusions.

### `search_brain` — when to use it

Call `search_brain` proactively in these situations:

- The user starts a brainstorm on a topic they may have thought about before. Run a quick search first; surface hits naturally ("you wrote on 2026-04-12 that ...") so they can build on prior thinking rather than re-derive it.
- The user explicitly asks: "have I thought about X?", "what did I write about Y?", "did I have a take on Z?"
- The user mentions a person, project, or idea by name in a way that suggests prior context exists.

Do **not** call `search_brain`:

- For every message — it adds latency and noise.
- For factual questions ("what is the capital of France") that have nothing to do with the user's life.
- When the user is clearly continuing an in-conversation thread you already have full context for.

Surface results as: a short paraphrase of what they wrote, the date, and the `primary_type`. Don't dump raw `clean_text` unless asked. Let the user decide whether a hit is relevant — search is fuzzy.

### `save_session` — when to use it

**Save only when the user explicitly asks.** Triggers include:

- "save this", "save this to my brain", "log this", "put this in my brain", "remember this"
- "add this to the journal", "save the session"

Do **not** save:

- Autonomously, even if a session feels "meaningful". The user has discipline around what enters their journal and surprise writes break that.
- On every long session. Length is not a save signal.
- Multiple times per session. One save per session is the norm.
- Single-question Q&A. The journal is for thinking, not lookup.

When you do save:

1. Propose a **title** (3–8 words, descriptive) and ask the user to confirm or edit before calling the tool.
2. Write a **summary** that captures, in this order:
   - What we discussed (1–2 sentences of topic framing)
   - The key insights or conclusions
   - Decisions made (if any)
   - Open questions or next steps
3. The summary is narrative, not a transcript. Skip pleasantries, re-prompts, and dead-end branches. Aim for the shape a thoughtful person would write in their notebook after a conversation, not a chat log.
4. Pass `source: { client, model }` when known (e.g. `claude.ai` + the active model ID) so the user can later filter by where a session came from.

After saving, report the `entry_id` to the user and note that processing (tags, classification, embedding) runs asynchronously and will be searchable within a minute.

### `get_entry` — when to use it

Follow-up after a `search_brain` hit looks promising and the user wants the full text. Also useful when the user references an entry by ID directly.

### `list_recent` — when to use it

- The user asks "what have I been thinking about this week / today / lately"
- You want to prime on the user's current preoccupations before a longer brainstorm. One call at the start of a session is fine; don't call it repeatedly.

### General etiquette

- The journal is private. Don't quote entries back to the user in third-person summaries shared with others, and don't synthesize public-facing artifacts from journal content unless asked.
- Entries can include emotional venting, frustrations, and rough takes. Treat them with discretion. If a search hit is sensitive, surface it gently or ask before reading aloud.
- Search is fuzzy and `similarity` scores are not absolute truth. Below ~0.3 the hit is probably noise; above ~0.5 is worth attention; in between, mention but don't lean on.
- If a tool returns an error, report it concisely and ask the user how to proceed. Don't retry silently.

---

## Part 2 — How developers should behave when extending this MCP

### Worker boundaries

- The Worker is **read-mostly + append-only** to `journal_entry` and `capture_event`. Any other write needs a separate build phase and a deliberate decision.
- **Never call `src/processor.ts` or `src/worker.ts` from the Worker.** Inserts go in with `processing_status='pending'` and the existing Node monolith's worker loop finishes the row. This keeps the processing pipeline (tags, classification, embedding) in a single place.
- The Worker should not own its own scheduled jobs in v1. If something needs to run periodically, it lives in the Node monolith's scheduler.

### DB access

- Always go through the Hyperdrive binding (`env.HYPERDRIVE`). Never put a raw `DATABASE_URL` into Worker secrets or code.
- Reuse SQL shapes from `src/db/queries.ts` (especially the vector-search predicates) rather than re-deriving them. If you find yourself re-implementing a query the Node monolith already has, consider extracting it into a `src/db/shared/` module and importing on both sides.
- Use `postgres-js` (the driver `src/db/client.ts` already uses) for cross-codebase familiarity.
- All Worker queries must be parameterized — never string-concat user input. Especially in `search_brain` filters.

### Embeddings

- Pinned model: **`text-embedding-3-small`**, 1536 dimensions. Must match `journal_entry.embedding` (`vector(1536)`) and `public_artifact_chunk.embedding`.
- Changing the model is a schema migration, not a code change. If you change it, you need a backfill plan for existing embeddings.
- The Worker's embedding code (`mcp-worker/src/embeddings.ts`) mirrors `src/embeddings.ts` in the monolith. Keep them in sync.

### Auth

- Bearer-only in v1. Header: `Authorization: Bearer <token>`.
- Validate the token inside the Worker via `crypto.subtle.timingSafeEqual` (or equivalent constant-time compare) — don't `===`.
- 401 with no body on auth failure. Don't leak whether the header was present, malformed, or wrong value.
- Tokens live in `wrangler secret`s. Never commit a token to the repo.

### Adding a new tool

1. Create `mcp-worker/src/tools/<tool_name>.ts` exporting:
   ```ts
   export const definition = {
     name: '<tool_name>',
     description: '...',                    // user-facing — read by AI clients
     inputSchema: z.object({ ... }),        // zod, becomes the MCP JSON schema
   };
   export async function handler(input, ctx) { ... }
   ```
2. Register the tool in `src/mcp.ts` (the tools/list + tools/call handler).
3. If the new tool changes how AI clients should behave (e.g. a new write tool), update Part 1 of this doc. Add a section under "when to use it" and add it to the don'ts if relevant.
4. Add a test under `mcp-worker/test/`. Integration test, real PG, no mocks (see Testing below).

### Testing

- **Vitest** + **`@cloudflare/vitest-pool-workers`** (miniflare-backed) for Worker tests.
- Integration tests hit a **real test Postgres**, not mocked. This codebase has a feedback memory that mock/prod divergence has burned past work — don't reintroduce DB mocks.
- Seed the test DB with a small fixture of journal entries (with real embeddings) so vector search tests are meaningful.
- Run before every deploy. CI runs them on PR.

### Deploy

- `wrangler deploy` from `mcp-worker/`.
- Secrets via `wrangler secret put`: `BRAIN_MCP_TOKEN`, `OPENAI_API_KEY`, `BRAIN_USER_ID`.
- Hyperdrive config bound separately (`wrangler hyperdrive create`), its ID baked into `wrangler.jsonc`. The PG connection string lives **only** inside Hyperdrive — never as a Worker secret.
- Custom domain candidate: `brain-mcp.unsubject.dev`. Configure via Cloudflare DNS + Worker route.
- Observability stays on (`observability.enabled: true`). Workers logs are how we'll debug live.

### Schema discipline

- This Worker writes only to `journal_entry` and `capture_event`. Touching `morning_review`, `public_artifact*`, `task_*`, `*_ref` tables is out of scope for v1.
- If a future tool needs to write elsewhere, that's a new build phase, not an in-flight extension.
- Schema changes (new columns, new tables) live in `migrations/` and are run by the Node monolith on boot. The Worker never runs migrations.

### What lives where

| Concern | Lives in |
|---|---|
| Telegram ingest, scheduler, morning review, family bot | `src/` (Node monolith) |
| Entry processing (gpt-5.4-nano classification) | `src/processor.ts` (Node monolith) |
| Pending-entry polling + embedding | `src/worker.ts` (Node monolith) |
| AI-tool MCP surface | `mcp-worker/` (CF Worker) |
| DB schema source of truth | `migrations/` |
| Phase build specs | `docs/phase-*-build-spec.md` |
| Cross-session conventions | `docs/*.md` (this file is one) |

### Out-of-scope reminders

The following are **deliberately deferred**. If you find yourself wanting to add one, propose a new phase instead of in-place expansion:

- `get_morning_review` tool exposing Claude-synthesized digests to AI clients
- Per-user API keys / family-scope auth
- Full MCP OAuth (dynamic client registration)
- Writes to `public_artifact` for long-form sessions
- Raw transcript storage
- `link_edge` traversal as an MCP tool
- Pushing data the other direction (AI tool tells brain about itself)

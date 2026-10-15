# 2nd-brain MCP — Behavior & dev norms

> **What 2nd-brain is for.** Since the refocus of 2026-10-05, 2nd-brain is Simon's private home for three things he creates himself: his journal, his published work and the Idea Garden. Every assistant he connects reaches it through this one MCP server, with full access (decision D11). It stays pull-only: it never pushes, schedules or reminds. The Chief-of-Staff role (with its Google Calendar and Contacts syncs) and content discovery are retired, and the goal system retires in Phase 6. Read [`docs/decisions/2026-10-05-refocus.md`](decisions/2026-10-05-refocus.md) before changing 2nd-brain: it holds the plan, its guardrails and the owner actions each phase needs.

This doc has two audiences:

- **Part 1** is for the **AI client** connecting to this MCP: Claude (claude.ai, Desktop and mobile), Claude Code, ChatGPT, Cursor, Gemini CLI, Gemini Spark and Meta Muse (setup in [`mcp-client-setup.md`](mcp-client-setup.md)). It defines when each tool should be called and what good behavior looks like. The server sends a condensed version of Part 1 as the MCP `instructions` field (`INSTRUCTIONS` in `mcp-worker/src/mcp.ts`), so clients see it when they connect.
- **Part 2** is for **developers** (human or AI) extending the MCP Worker and the Node monolith behind it. It defines code, schema, test and deploy norms.

---

## Part 1 — How AI clients should behave with this MCP

You are connected to the user's personal 2nd-brain. It holds three things they create themselves:

1. **The journal**: their thinking, saved from AI chat sessions like ours with `save_session` (older entries came from a Telegram bot, since retired).
2. **Published work**: their columns, essays and YouTube episodes.
3. **The Idea Garden** (formerly the Idea Parking Lot): curated raw material one stage before work, not tasks. Links between ideas are only ever proposed (right after a capture, in gardening sessions and garden reviews the user starts, or by the import) and exist only when the user says yes.

It also still holds their goal system, whose tools retire in Phase 6 (see "Goal tools: retiring in Phase 6" below).

Downstream, the pipeline is **Garden → Subjects → Projects → Shipped**. The user promotes an episode-shaped idea to their Google Tasks "Subjects" list: they or Muse write the task, and 2nd-brain only records the promotion. When the piece is published it comes back into the archive, where a `became` link from the idea closes the loop.

The journal is the user's external memory. Treat it as authoritative for **what the user has thought about**, never for **what is true**: they write down half-baked ideas, frustrations and questions, not vetted conclusions. Published work is what they said in public, as of its date.

### Domain model — the user's view of the brain

| Table | Source | Question it answers |
|---|---|---|
| `journal_entry` | `save_session` (channel `ai_chat`); older rows from the retired Telegram bot | **How** the user is thinking things through and **why**: their raw, unfiltered notes |
| `public_artifact` (+ chunks, entities) | Archive consolidation rebuilds it from the Gmail "Writing" label, the Drive archive folders and the Substack and WordPress exports; the YouTube transcript sync adds the episodes. The archive worker summarises, chunks and embeds each piece | **What** the user has published: columns, essays and YouTube episodes. A copy that consolidation replaced is kept but leaves search (`status = 'superseded'`). `flag` marks a piece still to be checked (`review`) or an old imported row that matches no confirmed piece (`unmatched`) |
| `link_edge` | Machine-made by the journal linker (`src/google/linker.ts`) after each entry is processed | Links from a journal entry to a published piece it echoes (`echoes_artifact`), to an organisation, concept or work it mentions (`mentions_entity`) and, until Phase 7, to an open Google Tasks item it shares keywords with (`relates_to_task`). Read through `get_entry` |
| `task_ref` | Google Tasks sync (read-only), until Phase 7 | The "Subjects" list for the one-time idea import (`list_subjects_for_import`), and the task titles in `get_entry`'s links |
| `idea` | `park_idea` / `import_ideas` / `create_synthesis` (this MCP); `update_idea` and `decide_idea_links` (`mark_reviewed`) record reviews and promotions | The **Idea Garden** — parked ideas (when/where captured, the raw source, why it's interesting, the user's verbatim thoughts) and syntheses (ideas combined into an episode/essay/series seed). Not tasks. `reviewed_at` NULL means the idea waits in the garden inbox; `promoted_at` / `promoted_title` record a promotion to the Google Tasks "Subjects" list, which Simon or Muse writes (2nd-brain never writes Google Tasks). |
| `idea_source` | `park_idea` / `import_ideas` / `create_synthesis` (this MCP) | Provenance per idea (librarian / notion / gtasks_subjects / gardening), idempotency keys, and a lossless copy of imported rows |
| `idea_link` | `propose_idea_links` / `decide_idea_links` / `create_synthesis` (this MCP) | Typed associations between ideas, and from ideas to the user's published outputs: 11 stored types, each shown with a display label (`tension_with` shows as contradicts). Proposed at capture, in gardening or garden reviews, or by the import (`proposed_by` `capture` / `gardening` / `import`; `synthesis` for a synthesis's parts). Lifecycle: proposed → accepted / rejected / withdrawn, accepted → retracted. Separate from the machine-made `link_edge`. |

The goal-system tables are listed with their tools below.

When a `search_brain` hit looks relevant, `get_entry` follows its links to the published pieces it echoes and the things it mentions.

If the user asks something only answerable from outside 2nd-brain ("what's on my calendar", "who emailed me", "any open tasks"), tell them 2nd-brain doesn't cover it: their Gmail, Calendar, Contacts and Tasks stay in Google, and Muse works with them directly. Don't try to call a tool that doesn't exist.

### `search_brain` — when to use it

Call `search_brain` proactively in these situations:

- The user starts a brainstorm on a topic they may have thought about before. Run a quick search first; surface hits naturally ("you wrote on 2026-04-12 that ...") so they can build on prior thinking rather than re-derive it.
- The user explicitly asks: "have I thought about X?", "what did I write about Y?", "did I have a take on Z?"
- The user mentions a person, project, or idea by name in a way that suggests prior context exists.

Do **not** call `search_brain`:

- For every message — it adds latency and noise.
- For factual questions ("what is the capital of France") that have nothing to do with the user's life.
- When the user is clearly continuing an in-conversation thread you already have full context for.

Surface results as: a short paraphrase of what they wrote and the date. Don't dump raw `clean_text` unless asked. Each hit says how it matched: `semantic`, `text` or both. An entry found both ways ranks first. Text-only hits have no `similarity`, so the thresholds below apply only to semantic hits. A hit that shows a `processing_status` has no summary or embedding: `pending` means processing hasn't finished, and `error` means it failed (the full text is still there). Let the user decide whether a hit is relevant — search is fuzzy.

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

After saving, report the `entry_id` to the user and note that processing (summary, tags, embedding) runs asynchronously within ~30–60s; until then `search_brain` finds the entry by text only.

### `get_entry` — when to use it

Follow-up after a promising `search_brain` hit, when the user wants the full text. Its `links` come from `link_edge` and are only of three kinds:

- published pieces the entry echoes (`echoes_artifact`, target type `public_artifact`);
- organisations, concepts and works it mentions (`mentions_entity`, target type `entity_ref`);
- until Phase 7, Google Tasks items (`relates_to_task`, target type `task_ref`).

Each link carries a `target_title`. Links below `min_confidence` (default 0.5) are left out, and a family-scope entry shows only family-scope targets. Links to contacts, calendar events or emails never come back: `get_entry` keeps an allow-list of the three target types above. Surface links when they help ("this echoes your column on …").

### `list_recent` — when to use it

- The user asks "what have I been thinking about this week / today / lately"
- You want to prime on the user's current preoccupations before a longer brainstorm. One call at the start of a session is fine; don't call it repeatedly.

### Published work — `archive_search_text` now, `search_published` and `get_artifact` in Phase 5

- Use `archive_search_text` when the user asks what they wrote or said in public ("did I write about X?", "find my column on Y") or wants to cite their own work. "Have I thought about X?" is the journal (`search_brain`); "what do I have on X?" is the Idea Garden (`explore_topic`).
- It matches the meaning of the query against each piece's summary. It returns the best matches' title, link, date, type (`essay` or `episode`) and `flag`, and no body text. Copies that consolidation replaced never come back.
- Say so when a hit is flagged: `review` is an essay still to be checked (it may never have been published, or its text is uncertain), and `unmatched` is an old imported row that matches no confirmed piece.
- Phase 5 replaces `archive_search_text` with `search_published` (chunk-level, by meaning and by exact text) and `get_artifact` (reads one piece). It also brings in members-only episodes, marked as such (D10). Never quote or link a members-only piece in anything meant for the public.

### Idea Garden — when to use these tools

The executable protocol is `docs/idea-parking-lot-protocol.md`, also served as the MCP resource `second-brain://protocol/idea-parking-lot` — read it before capturing, gardening or reviewing, mapping or importing. In short:

- **`park_idea`** — ONLY when the user explicitly asks to park/file an idea. Confirm the title; copy their own thoughts **verbatim**. The receipt comes first. `park_idea` also returns up to 5 `link_candidates` (the nearest existing ideas); where one genuinely connects, save up to 3 typed proposals with one-line glosses (`propose_idea_links`, `origin: 'capture'`: idea to idea, all on the new idea, `part_of` only to a synthesis) and show them after the receipt, with their display labels. Never search for more yourself, and never suggest tags. Nothing is linked until the user says yes; proposals they ignore wait for the weekly garden review. No proposals for `[smoke]` test ideas. "Save this session" still means `save_session`; ask if unclear.
- **`explore_topic`** — "what do I have on X?" and episode planning: matching ideas with their linked clusters and glosses, plus the outputs they became. Present clusters, not a flat list. "Have I thought about X?" stays with `search_brain` (the journal).
- **`list_ideas` / `search_ideas` / `get_idea`** — pull-only: when the user asks about their ideas. Never surface parked ideas unprompted or in unrelated conversations. `list_ideas` filters `inbox` and `promoted`.
- **The weekly garden review** — weekly, on a day the user picks; Muse holds the reminder, and 2nd-brain never schedules or reminds. ONLY when the user starts it: pending proposals first (capture leftovers included), then the inbox oldest first (`garden_ideas` mode `inbox`), a linking pass (`propose_idea_links`, `origin: 'gardening'`), the user's verdicts (`decide_idea_links`), and `mark_reviewed` for the ideas they have been through.
- **`garden_ideas` → `propose_idea_links` → the user decides → `decide_idea_links`** — ONLY inside a gardening session or garden review the user started (or, for `propose_idea_links`, right after a capture as above). Proposals are not links; record exactly the user's verdicts, never on their behalf. Rejections are remembered — don't re-propose a rejected pair unless the user asks (`reconsider_rejected`). `list_idea_links` first to clear leftover proposals.
- **`create_synthesis`** — ONLY when the user decides to combine ideas into something bigger (episode / essay / series / learning seed). Confirm title, intent and parts first. A synthesis skips the inbox.
- **`update_idea`** — on the user's request, or to record a decision they just made (status changes, notes, `reviewed`). `promoted: {title}` records a promotion to the "Subjects" list that Simon or Muse made; it moves a parked or composted idea to exploring. Composting replaces deletion and withdraws the idea's pending proposals.
- **`export_idea_map`** — when the user asks to see their map: `format: 'html'` returns a self-contained interactive page (clusters, glosses on hover or tap, an as-of slider); save the second text block unchanged as the meta's `filename`, check `bytes`, and hand it over as a file. JSON (canonical), GraphML (Gephi/yEd/Cytoscape) and Mermaid (chat) remain for rendering it yourself. Read-only.
- **`import_ideas` / `list_subjects_for_import`** — ONLY during the one-time import protocol (§4) the user starts.

### Goal tools: retiring in Phase 6

The goal system (constitution domains, SMART goals and undertakings) retires in Phase 6 (decision D6): its rows are exported to a private location, then its 16 tools and their tables go. Until then the tools are live and these rules hold:

- **Amendments are never autonomous.** Call `propose_constitution_amendment`, `commit_constitution_amendment`, `propose_goal_amendment` or `commit_goal_amendment` only when the user explicitly asks for an amendment, and run the protocol: `docs/goal-amendment-interview.md` (Section 1A for the constitution, Section 1B for goals), served as the resource `second-brain://protocol/goal-amendment` and by `read_protocol('goal-amendment')`.
- **Constitution** (`list_constitution_domains`, `get_constitution_domain`, `list_pending_constitution_amendments`): the north-star domains. Read them at the start of a planning session, as the tool description asks, and when the user asks about them. Every amendment needs a `crisis_justification` and waits out a 14-day cooldown; only the first 5 lifetime `new` commits skip it. Bias hard toward `amend` over `new`.
- **Goals** (`list_goals`, `get_goal`, `list_pending_goal_amendments`): SMART goals under a domain, at most 3 active per domain, with a 72-hour cooldown. Call `list_goals` before proposing one, so you can default to `amend`. Moving a goal to another domain is `abandon` plus `new`.
- **Undertakings and cycles** (`list_undertakings`, `get_undertaking`, `create_undertaking`, `update_undertaking`, `start_cycle`, `close_cycle`): focused efforts serving a goal (`primary_goal_id` references `goals`), either `outcome` or `habit_forming` with 4-week cycles. `start_cycle` refuses while another cycle is active, and `close_cycle` never starts the next one.
- The constitution and goals are private and deliberate. Never quote them in anything public without permission, and don't propose amendments pre-emptively. If the user seems to drift from them, say so gently as information, never as a score.

Their tables are `constitution_domains`, `constitution_amendments` (audit log and cooldown staging), `goals`, `goal_amendments`, `undertakings` and `undertaking_cycles`.

### General etiquette

- The journal is private. Don't quote entries back to the user in third-person summaries shared with others, and don't synthesize public-facing artifacts from journal content unless asked.
- Entries can include emotional venting, frustrations, and rough takes. Treat them with discretion. If a search hit is sensitive, surface it gently or ask before reading aloud.
- Search is fuzzy and `similarity` scores are not absolute truth. Below ~0.3 the hit is probably noise; above ~0.5 is worth attention; in between, mention but don't lean on.
- If a tool returns an error, report it concisely and ask the user how to proceed. Don't retry silently.

---

## Part 2 — How developers should behave when extending this MCP

This repository is public. Tests, fixtures and docs use synthetic data only, and exports of retired data go to a private location, never here.

### Worker boundaries

- The Worker is **read-mostly + scoped-write**. It writes `journal_entry` and `capture_event` (`save_session`); the Idea Garden tables `idea`, `idea_source` and `idea_link` (spec in `docs/phase-idea-parking-lot-spec.md`); the goal-system tables until Phase 6 (`constitution_domains`, `constitution_amendments`, `goals`, `goal_amendments`, `undertakings`, `undertaking_cycles`); and its own credential tables and call log (migration 020). `editorial_pick` was a write target until the content-discovery tools were retired; nothing writes it now. Any further new write target needs a deliberate decision and a doc update here.
- The published archive (`public_artifact` and its chunks), `link_edge` and the Google Tasks copy belong to the Node monolith. The Worker only reads them.
- **Never call `src/processor.ts` or `src/worker.ts` from the Worker.** Inserts into `journal_entry` go in with `processing_status='pending'` and the existing Node monolith's worker loop finishes the row. This keeps the processing pipeline (summary, tags, embedding) in a single place. The same rule holds for ideas: the Worker inserts `idea` rows with `embedding NULL` and the Node sweeper `src/ideas/worker.ts` embeds them (and re-embeds after the `idea_before_update` trigger clears a stale embedding).
- The Worker doesn't own scheduled jobs. If something needs to run periodically, it lives in the Node monolith (e.g. `src/mcp/retention.ts` prunes the Worker's call log and stale auth rows daily).

### DB access

- Always go through the Hyperdrive binding (`env.HYPERDRIVE`). Never put a raw `DATABASE_URL` into Worker secrets or code.
- Reuse the SQL shapes the monolith already has (e.g. the vector-search predicates in `src/db/queries.ts` and `src/archive/queries.ts`) rather than re-deriving them. If you find yourself re-implementing a query the Node monolith already has, consider extracting it into a shared module and importing it on both sides.
- The Worker uses `postgres-js` (`mcp-worker/src/db.ts`, tagged templates, `fetch_types: false`, over Hyperdrive). The Node monolith uses node-postgres `pg` (`src/db/client.ts`, `$n` placeholders, direct to Railway, no Hyperdrive), which serialises JS arrays and objects itself; the rules below are about the Worker.
- All Worker queries must be parameterized — never string-concat user input. Especially in `search_brain` filters.
- `fetch_types: false` skips OID resolution, which means `text[]`/`uuid[]` columns come back as raw PG array literal strings. Coerce with `to_jsonb(col) AS col` in the SELECT so postgres-js parses to a JS array (e.g. `tags` in `get_entry`, `secondary_goal_ids` in the undertaking tools).
- For binding a JS array of UUIDs into PG (e.g. inserting `uuid[]`), build the array literal client-side as `'{uuid1,uuid2,...}'` and cast in SQL with `::uuid[]`. zod-validated UUIDs are safe to interpolate via parameter into the literal (postgres-js still parameterizes the literal string, PG parses it).
- For binding arbitrary **text** arrays (tags, statuses), route them through jsonb — `ARRAY(SELECT jsonb_array_elements_text(${sql.json(arr)}))::text[]` (`textArray()` in `mcp-worker/src/tools/idea_shared.ts`). A hand-built `{...}` literal breaks on commas, quotes and backslashes. Never bind a raw JS array (`` tags @> ${arr} ``): with `fetch_types: false` it is sent as `a,b` and fails as a malformed array literal (the `search_brain` tag-filter bug).
- Write jsonb with `sql.json(value)`, never `${JSON.stringify(value)}::jsonb` — the latter double-encodes into a jsonb *string* on this stack (PR #63). Migration `021_repair_double_encoded_jsonb.sql` repaired rows written that way (`close_cycle`, `record_pick`, early amendment payloads); readers still unwrap both shapes (`unwrapJsonb` in `idea_shared.ts`). `mcp-worker/test/sql-conventions.test.ts` rejects both patterns.
- **Hyperdrive query caching is ON** for this Worker (default `max_age` 60s; cached reads are not invalidated by writes). Any read that must reflect a write made moments earlier — e.g. the gardening loop propose → list → decide → list — includes `now() AS as_of` in its SELECT, which makes Hyperdrive treat the query as uncacheable. Never put such function names in SQL comments: Hyperdrive pattern-matches the query text. Every idea tool, the journal reads (`search_brain`, `get_entry`, `list_recent`) and every auth read follow this convention; a new read should too.

### Embeddings

- Pinned model: **`text-embedding-3-small`**, 1536 dimensions. Must match `journal_entry.embedding` (`vector(1536)`), `public_artifact.embedding` (the piece's summary, which `archive_search_text` matches), `public_artifact_chunk.embedding` and `idea.embedding`. The idea embedding text recipe lives in `src/ideas/embeddingText.ts`; any field it reads must also clear the embedding in the `idea_before_update` trigger (migration 019).
- Changing the model is a schema migration, not a code change. If you change it, you need a backfill plan for existing embeddings.
- The Worker's embedding code (`mcp-worker/src/embeddings.ts`) is a fetch-based REST call, not the OpenAI SDK (the SDK is heavier than necessary in a Worker). Keep behavior compatible with `src/embeddings.ts` in the monolith.

### Auth

Every client has **its own revocable credential**. The design is in [`phase-mcp-multi-client-spec.md`](phase-mcp-multi-client-spec.md); setup for each client is in [`mcp-client-setup.md`](mcp-client-setup.md).

- **`/mcp` bearer.** `mcp-worker/src/auth/middleware.ts` checks two things, in this order:
  1. The master `BRAIN_MCP_TOKEN`, accepted only while `ALLOW_MASTER_BEARER` is not `"false"` (set in `wrangler.jsonc` `vars`). It is still `"true"`; Phase 1 of the plan turns it off once Simon's own clients use OAuth.
  2. An opaque `brain_at_…` (OAuth access, 1 hour) or `brain_pat_…` (personal access token) token, looked up by SHA-256 hash on every request.

  Revoking a credential therefore takes effect on the next call. Anything else returns 401 without a database round-trip.
- **OAuth 2.1** lives in `mcp-worker/src/oauth/`:
  - Registrations are stored, and their redirect URIs must pass the allow-list in `mcp-worker/src/auth/redirects.ts`.
  - The owner approves each connection by typing the owner secret (`OWNER_SECRET`, falling back to `BRAIN_MCP_TOKEN`) and naming it. An optional **Replace** revokes the existing OAuth connection with that name.
  - Codes are single-use, bound to the client, redirect and PKCE S256, and expire in 5 minutes.
  - Every redirect carries `state` and `iss`.
  - Refresh tokens rotate. Reuse within 5 minutes of a rotation is tolerated, up to 10 times (parallel or shared-store clients). Later reuse is refused, and nothing is revoked.
  - `/revoke` follows RFC 7009.
- **Owner console** `/tokens` (`mcp-worker/src/console.ts`): sign in with the owner secret to see agents and activity, mint PATs, and revoke anything.
- **Attribution.** The tool handlers receive the caller's `Principal` as a fourth argument.
  - Every idea write records the calling connection permanently: `credential: <label>` in `idea.captured_via` (capture, import, synthesis), `idea_link.proposed_via` (proposals and synthesis links, capture proposals included), `idea_link.decided_via` (decisions, and the withdrawals that composting an idea triggers), each server-written note (`notes[].credential`, including the promotion and status notes), and the append-only `idea.edit_log` (`[{at, credential, tool, fields?}]`). `edit_log` gets one entry per `update_idea` call, with the fields it touched (`reviewed` and `promoted` included); one per idea marked by `decide_idea_links` `mark_reviewed` (`tool: 'decide_idea_links'`, `fields: ['reviewed']`); and one per import merge. Link `history` keeps what each change overwrote: a retract snapshots the accept (decider, time, note); an accept that changes the type or direction, a reopen and a revive snapshot the earlier proposal (proposer, time, score, rationale), and a reopen or revive also the earlier decider. Clients can't set any of these themselves: the schemas are strict, and `master` and `unknown` are reserved labels. Unlike the call log, these are never pruned.
  - `mcp-worker/src/calllog.ts` logs every tool call per credential: the tool, whether it was a write, whether it succeeded, its duration, and the result ids. Result ids are the uuids in top-level `*_id` fields, in `results[*].*_id`, and in `*_ids` arrays at the top level or one object down (e.g. `decide_idea_links`' `reviewed.idea_ids`), deduplicated and capped at 50. It never logs arguments. This runs in `ctx.waitUntil`, and any failure in it is swallowed.
- **Retention.** The monolith's daily job (`src/mcp/retention.ts`) prunes call-log rows older than `MCP_CALL_LOG_RETENTION_DAYS` (default 90, never below 7, since the console shows 7-day counts), tokens expired, rotated or revoked more than a day ago, authorization codes expired more than a day ago, and client registrations never approved within 7 days. Credential rows are kept for the console's "Recently revoked" list.

Every 401 carries `WWW-Authenticate: Bearer realm="2nd-brain", scope="mcp", resource_metadata="<server>/.well-known/oauth-protected-resource/mcp"`, plus `error="invalid_token"` when a token was presented. The response is the same whatever was wrong with the token. A database outage returns 503, never 401, so clients don't throw away good tokens.

Every auth read carries `now()` like the idea tools (Hyperdrive caching, above). The static test covers `mcp-worker/src/auth/`, `mcp-worker/src/oauth/`, `console.ts`, `calllog.ts` and `index.ts`.

### Adding a new tool

1. Create `mcp-worker/src/tools/<tool_name>.ts` exporting a handler. zod-validate inputs and convert errors to `{ content: [...], isError: true }`.
2. Register the tool in `mcp-worker/src/tools/registry.ts` (the `tools` array drives both tools/list and tools/call), and give it a title and annotations in `mcp-worker/src/tools/tool_meta.ts`. For a write tool, its "ONLY call when…" / "NEVER call autonomously" sentence must sit in the first 300 characters of the description. Nullable fields use `anyOf`, never type arrays. The server stays at 40 tools or fewer (Cursor's limit) and `INSTRUCTIONS` at 2,000 characters or fewer (Claude Code truncates at 2,048). `mcp-worker/test/schema-portability.test.ts` enforces all of this for every client in `docs/mcp-client-setup.md`.
3. If the new tool changes how AI clients should behave (e.g. a new write tool, or one that exposes a new table), update Part 1 of this doc. Add a section under "when to use it" and update the Domain model table if a new record type is exposed. If it adds or removes a tool, update the tool count in `docs/mcp-client-setup.md`.
4. If the new tool writes to a table this Worker hasn't written to before, update the Worker boundaries note in Part 2 to add the table.

### Testing

- **Vitest** + a tiny vite plugin (`mcp-worker/vitest.config.ts`) that transforms `.md` imports into string-default exports at test time, mirroring wrangler's Text rule. This lets the dispatcher tests exercise the real `resources.ts` (which imports the bundled protocol docs) without spinning up `@cloudflare/vitest-pool-workers`.
- Worker tests live in `mcp-worker/test/`. The dispatcher test pattern (drive `handleMcpRequest` with mock requests + Bearer header; assert JSON-RPC response shape) is the right one for any future `tools/*` or `resources/*` coverage. Every Worker test file starts with a `fetch` that fails fast (`mcp-worker/test/setup/no-network.ts`), so no test reaches the network unless it stubs `fetch` itself.
- Tests that need the database hit a **real test Postgres**, not mocks. This codebase has a feedback memory that mock/prod divergence has burned past work — don't reintroduce DB mocks. Only external HTTP (the OpenAI calls) may be stubbed, never the database.
  - The Worker's DB suites (`mcp-worker/test/db/`) run when `TEST_DATABASE_URL` points at a local `*_test` database: `mcp-worker/test/setup/test-db.ts` checks both the URL and the server it actually reached, resets that database and applies (and records) every migration, so the suites also prove the newest migration applies on top of the others. Without the variable they skip.
  - The root suite (`npm test` in the repo root, `tsx --test test/*.test.ts`) uses the same variable, against a database that is already migrated (run the Worker suite against it first, or `npm run migrate`). Its DB-backed files cover the idea embedding sweeper, the MCP retention job, the journal linker, the migration runner (in a scratch schema of its own) and the archive pipeline (staging, collection runs, extraction, matching, loading and the archive worker's passes). `node --test` runs files in parallel, so a DB-backed file that truncates or rewrites shared tables holds the lock in `test/support/database-lock.ts` from setup to teardown, as the sweeper, retention and archive files do. The other root tests need no database.
- **Static tests** guard the conventions in this doc:
  - `mcp-worker/test/ideas.fixes.test.ts` fails if a read query in an idea tool, a shared idea module or an auth module lacks `now()` (Hyperdrive, above).
  - `mcp-worker/test/sql-conventions.test.ts` rejects `JSON.stringify(…)::jsonb` and raw arrays bound to `@>`, `<@` or `&&`.
  - `mcp-worker/test/schema-portability.test.ts` checks the tool count, the `INSTRUCTIONS` length, titles and annotations, the write-tool sentence and the schema shapes.
  - `mcp-worker/test/retired-tables.test.ts` fails if Worker code names a retired table (`person_ref`, `calendar_event_ref`, `email_ref`, `morning_review`, `editorial_pick`, `task_suggestion`).
  - `test/retired-google-data.test.ts` fails if code in `src/` or `scripts/` names the retired contacts, calendar, COS and discovery tables, the link types the person and event matchers wrote, the Calendar and Contacts APIs and scopes, or `FAMILY_GOOGLE_CALENDAR_ID`. It also checks that the relink backfill (`scripts/relink_journal_entries.ts`) wipes only link types the linker writes back, so running it never deletes links for good.
- CI (`.github/workflows/ci.yml`, on pull requests and `main`) runs the root typecheck and build, the Worker typecheck and suite, then the root suite, against a `pgvector/pgvector:pg16` service. The deploy workflow's test step runs only the Worker suite. Tests must pass to ship.

### Deploy

CI auto-deploys the Worker on push to `main` when `mcp-worker/**` changes — see `.github/workflows/deploy-mcp-worker.yml`. The workflow installs deps, typechecks, runs tests, then `wrangler deploy` via `cloudflare/wrangler-action@v3`.

Docs bundled into the Worker via `mcp-worker/src/resources.ts` are an additional deploy trigger — the `paths:` filter has an explicit per-file allowlist (NOT `docs/**/*.md`) so the bundled surface stays auditable from the workflow file. Today that is `docs/goal-amendment-interview.md` (until Phase 6) and `docs/idea-parking-lot-protocol.md`; this doc is not bundled. If you import a new doc in `resources.ts`, add it to four places: (1) the import in `resources.ts`, (2) the `globs` in `wrangler.jsonc`'s Text rule, (3) the `paths:` trigger in the deploy workflow, (4) the `resources/list` assertion in `mcp-worker/test/dispatcher.test.ts`.

The Node monolith runs on Railway. When it boots, it applies any new migration in `migrations/` before anything else starts (`src/index.ts` calls `migrate()` from `src/db/migrate.ts`).

Secrets and settings are managed outside this repo:

- **Worker secrets** (`OWNER_SECRET`, `BRAIN_MCP_TOKEN`, `OPENAI_API_KEY`, `BRAIN_USER_ID`): set via CF dashboard or the CF API (`PUT /accounts/{id}/workers/scripts/2nd-brain-mcp/secrets`). Plain settings (`ALLOW_MASTER_BEARER`, the optional `OAUTH_EXTRA_REDIRECT_PREFIXES`) are `vars` in `wrangler.jsonc`.
- **Hyperdrive config**: created once via `POST /accounts/{id}/hyperdrive/configs`; its ID is baked into `wrangler.jsonc`. The Railway PG connection string lives **only** inside Hyperdrive — never as a Worker secret.
- **Railway variables** (Node monolith): `DATABASE_URL`, `OPENAI_API_KEY` (read by the OpenAI SDK itself), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ARCHIVE_API_KEY`, `OWNER_SECRET` (same value as the Worker's), `PORT` and the optional `MCP_CALL_LOG_RETENTION_DAYS`. Nothing reads `FAMILY_GOOGLE_CALENDAR_ID` any more.
- **GitHub repo secrets** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`): set via `gh secret set`.

Observability stays on (`observability.enabled: true`). Workers logs are how we debug live.

#### Deploy order

The Worker deploys when its PR merges; a migration runs only when the monolith next boots on Railway. So:

- A migration that adds a table or column lands, and has run in production (check `_migrations`), before the Worker PR that reads it merges.
- Code that reads a table changes before the migration that drops it. The retired-table static tests (above) hold this for the tables Phase 3 retires.
- Railway variables and Worker secrets are deleted only after the code no longer reads them.
- Migration files are applied in sorted name order and recorded by name, so a number is not reserved until its PR merges: take the next free one at merge time.
- Once a Worker deploy is live, fix forward rather than rolling it back: clients already hold its tool list, and an older build may fail on data its new tools wrote (as builds from before Idea Garden v2 fail on `mechanism_for` and `inverts` links). After a deploy that changes tools or `INSTRUCTIONS`, reconnect each client or start a new session in it; most clients read the instructions only when they connect.
- Data migrations follow the decision record's [guardrails](decisions/2026-10-05-refocus.md#guardrails-for-every-phase): each starts with `SET LOCAL statement_timeout = 0;` and is idempotent, and Simon takes a full Postgres backup and confirms it before any migration that deletes or drops data.

### Schema discipline

- Per-user data tables the Worker writes stamp `user_id TEXT NOT NULL` from `env.BRAIN_USER_ID` (e.g. `journal_entry`, the idea tables, the goal tables). The monolith writes its own rows (`task_ref`, `project_ref`, `public_artifact`, `entity_ref`, `link_edge`) as user `default`, so Worker reads of those don't filter on `BRAIN_USER_ID` (see `list_subjects_for_import` and `explore_topic`).
- Schema changes (new columns, new tables) live in `migrations/` and are run by the Node monolith on boot. The Worker never runs migrations.
- Constraints belong in the schema, not just the handler. Examples: `constitution_domains.crisis_origin NOT NULL`, the `goals_merge_consistency` CHECK, and the partial unique index on `undertaking_cycles` enforcing one-active-per-undertaking.
- **Cooldown immutability via trigger.** `constitution_amendments.cooldown_until` (14d) and `goal_amendments.cooldown_until` (72h) are both managed by `BEFORE INSERT OR UPDATE` triggers (`set_constitution_amendment_cooldown`, `set_goal_amendment_cooldown`). The original plan called for a `GENERATED ALWAYS … STORED` column, but PG requires generation expressions to be IMMUTABLE and `timestamptz + interval` is STABLE. The trigger restores the ironclad invariant: INSERT computes cooldown_until from proposed_at; UPDATE pins both `proposed_at` and `cooldown_until` back to their OLD values, so no client code path can move the cooldown forward or backward.
- **Cardinality caps via trigger** (new in 017). `goals` has a 3-active-per-`(user_id, constitution_domain_id)` cap enforced by the `enforce_goals_cap` trigger. Partial unique indexes can't express "count ≤ N", and an app-side check has a race-window problem (two concurrent INSERTs each see count=2 and both succeed). The trigger sees the row in its final state and raises `check_violation` if the cap would be exceeded — same atomic guarantee as a constraint, without the constraint-language limitation. Use this pattern for any future bounded-cardinality rule, after the goal tables are gone too.
- **Founding-bypass counter via lifetime-committed query** (new in 017). `commit_constitution_amendment` allows the first 5 lifetime `kind='new'` commits to skip the 14d cooldown, sized for the typical Mind/Body/Family/Wealth/Social bootstrap. The counter is computed server-side from the audit log (`SELECT count(*) FROM constitution_amendments WHERE status='committed' AND kind='new'`); retire/merge don't refund the counter. Irreversible by design.
- **Symmetric links in canonical order** (new in 019; `inverts` added in 028). `idea_link` stores symmetric types (`tension_with`, `same_mechanism`, `combines_with`, `related`, `inverts`) with `source_idea_id < target_idea_id` (CHECK), and a unique expression index on `(LEAST, GREATEST, link_type)` forbids both `A→B` and `B→A` of any type. Handlers canonicalise before writing (`mcp-worker/src/ideas/linkTypes.ts`).
- **Cross-row validation and invalidation via trigger** (new in 019). `idea_link_validate` checks that both idea endpoints belong to the link's user and that `part_of` targets a synthesis; `idea_before_update` keeps `idea.kind` immutable and clears the embedding when an embedded field changes.
- Array foreign keys are enforced app-side. Postgres can't FK individual elements of a `uuid[]`, so any handler accepting an array of foreign UUIDs (e.g. `create_undertaking.secondary_goal_ids`, `update_undertaking.secondary_goal_ids`, `propose_constitution_amendment.source_constitution_domain_ids`, `propose_goal_amendment.source_goal_ids`) must `SELECT ... WHERE id = ANY(...)` and refuse the write if any ID fails to resolve to an active row owned by the current user.
- **Retired tables, awaiting drop.** `person_ref` and `calendar_event_ref` (their syncs are stopped), `email_ref` (empty since migration 024), and the COS and discovery tables `morning_review`, `task_suggestion` and `editorial_pick` stay in the schema until a migration drops them; `task_ref` and `project_ref` follow in Phase 7. No code reads them (see the static tests under Testing). The `link_edge` rows that point at contacts and calendar events stay too, and their `explanation` names the contact or the event: `get_entry`'s allow-list keeps them from assistants. A migration that drops a link target table also deletes the `link_edge` rows that point at it, by `target_type`, as migration 024 did for `email_ref`. A delete by `link_type` would miss the rows of types older linkers wrote (`same_day_as_event`, `relates_to_location`).

### Google connection (Node monolith)

The Google Tasks sync (until Phase 7) and the archive collectors (the Gmail "Writing" label and the Drive archive folders, `src/archive/consolidation/gmail.ts` and `drive.ts`) use one refresh token stored for user `default` in `google_tokens`. Connecting therefore replaces that account, so only the owner may start it:

- Set `OWNER_SECRET` on the Railway service, with the same value as the Worker's. Without it, `/auth/google` answers 503.
- Open `https://<railway app>/auth/google`, enter the owner secret in the form (it is POSTed, never put in a URL), and approve in Google, leaving every box ticked. The callback page names any requested scope Google didn't grant.
- **Scopes.** `/auth/google` asks for `tasks.readonly`, `gmail.readonly` and `drive.readonly` (`SCOPES` in `src/google/auth.ts`). Calendar and Contacts are no longer read: the 30-minute sync (`src/google/sync.ts`) runs only the Tasks sync, and the journal linker no longer matches people or events. The rows those syncs stored stay until the drop migration.
- **Scopes shrink only through a revoke-and-reconnect:** first remove the app's access at myaccount.google.com/connections, then connect again. A plain reconnect stores a new token, but Google keeps the earlier, wider grant (and its old refresh token) until it is revoked. Until Simon does the Phase 3 one, the stored grant still carries `calendar.readonly` and `contacts.readonly`: check the connections page and `google_tokens.scope`, not only the callback page. Between the revoke and the reconnect, the Tasks sync and the collectors fail, so first check on `/archive/consolidation/status` that no collection is running. Phase 7 needs a second revoke-and-reconnect, to drop `tasks.readonly`.
- The callback accepts only a state that the form issued: it is HMAC'd with `OWNER_SECRET`, expires after 10 minutes, and works once (the process remembers the states it issued until they are redeemed).
- The form's CSP allows `form-action` to `https://accounts.google.com` as well as itself, because Chromium applies `form-action` to the redirect that follows a form submit.
- Errors from Google calls are logged through `describeGoogleError` (`src/google/errors.ts`): the message, HTTP status and Google's error code only. Logging the raw error object would print the token request, refresh token included.
- `deleted_client` in the sync logs means the Google Cloud OAuth client was deleted. Create a new one (Web application, redirect URI = `GOOGLE_REDIRECT_URI`), update `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on Railway, and connect again.
- The legal pages describe the Google data the app reads: the workflow page's list must match `SCOPES`, so update it whenever the scopes change ([`legal-site/README.md`](../legal-site/README.md)).

### What lives where

| Concern | Lives in |
|---|---|
| What 2nd-brain is for, the plan and its guardrails | [`docs/decisions/2026-10-05-refocus.md`](decisions/2026-10-05-refocus.md) |
| HTTP server: owner-only Google connect, the archive API (`/archive/*`, bearer `ARCHIVE_API_KEY`) | `src/server.ts` (Node monolith) |
| Journal entry processing (gpt-5.4-nano: summary, language, tags; the text itself is normalised in code) | `src/processor.ts` (Node monolith) |
| Pending-entry polling, embedding and journal linking | `src/worker.ts` (Node monolith) |
| Journal links (`echoes_artifact`, `mentions_entity`, `relates_to_task` until Phase 7) | `src/google/linker.ts` (Node monolith) |
| Google Tasks sync, every 30 minutes, until Phase 7 | `src/google/sync.ts`, `src/google/tasks.ts` (Node monolith); owner-only connect at `/auth/google` (`src/google/routes.ts`), scopes in `src/google/auth.ts` |
| Published archive: processing (summary, chunks, entities, embeddings) and the `/archive/*` routes | `src/archive/` (Node monolith) |
| Archive consolidation (collect from Gmail, Drive and the exports; extract, match, load) | `src/archive/consolidation/` (Node monolith); design in [`docs/archive-consolidation.md`](archive-consolidation.md) |
| YouTube episodes | The YouTube transcript sync in the YouTubeArchive repository POSTs each one to `/archive/import/youtube` (`src/archive/ingest/youtube.ts`) |
| AI-tool MCP surface | `mcp-worker/` (CF Worker); tools in `mcp-worker/src/tools/`, server instructions in `mcp-worker/src/mcp.ts` |
| Per-client credentials, OAuth, owner console | `mcp-worker/src/auth/`, `mcp-worker/src/oauth/`, `mcp-worker/src/console.ts`; tables in migration 020 |
| Client setup and the current tool count | [`docs/mcp-client-setup.md`](mcp-client-setup.md) |
| MCP resources (protocol docs) | `mcp-worker/src/resources.ts` + bundled `docs/*.md` via wrangler Text rule |
| Constitution + goal amendment protocol (until Phase 6) | `docs/goal-amendment-interview.md` (also served as MCP resource `second-brain://protocol/goal-amendment`) |
| Idea Garden protocol (capture, gardening and the weekly garden review, map, import, retrieval) | `docs/idea-parking-lot-protocol.md` (also served as MCP resource `second-brain://protocol/idea-parking-lot`); Simon's brief in [`docs/idea-garden-brief.md`](idea-garden-brief.md) |
| Idea embedding sweeper | `src/ideas/` (Node monolith) |
| MCP call-log and auth-row retention | `src/mcp/retention.ts` (Node monolith; `MCP_CALL_LOG_RETENTION_DAYS`) |
| DB schema source of truth | `migrations/` (applied by `src/db/migrate.ts`) |
| Legal pages (privacy, terms, the "workflow" app page) | `legal-site/` |
| Design specs | `docs/phase-*-spec.md` |
| The superseded Chief-of-Staff documents | `docs/history/` (moved there in Phase 3) |
| Cross-session conventions | `docs/*.md` (this file is one) |

### Out-of-scope reminders

The following are **deliberately deferred**. If you find yourself wanting to add one, propose a new phase instead of in-place expansion:

- Family-scope auth / multiple users (credentials are per client, but the Worker still serves one `BRAIN_USER_ID`)
- Per-tool scopes (`mcp_credential.scope` exists; only `all` is honoured)
- Writing to `public_artifact` from the MCP: the archive holds what Simon published, and only archive consolidation and the YouTube transcript import load it
- Storing raw chat transcripts (`save_session` keeps a narrative summary)
- `link_edge` traversal as an MCP tool (the idea graph lives in `idea_link` and is exported by `export_idea_map`; the machine-made `link_edge` graph is read only through `get_entry`)
- Copies of Calendar, Contacts, Gmail mail or open tasks, or tools over them: Muse works with those directly. The Tasks copy stays only for the Subjects import, until Phase 7: `list_subjects_for_import` reads the "Subjects" list, and `get_entry` shows task links
- Pushing data the other direction (AI tool tells brain about itself outside of `save_session` and the gated idea tools)
- Idea Garden follow-ups: automatic linking (capture proposals wait for the user's yes); proactive surfacing or reminders of parked ideas (the weekly review reminder lives in Muse); idea merge/delete tools (compost instead); chunk-level idea↔output matching; LISTEN/NOTIFY for instant idea embedding; a hosted map front-end (the HTML map is a file the assistant hands over); writing Google Tasks (promotions are only recorded); family-scope ideas; mirroring accepted idea links into `link_edge`
- Extending the goal system: it retires in Phase 6 (D6)

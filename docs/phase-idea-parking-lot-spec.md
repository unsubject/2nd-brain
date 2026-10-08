# Phase: Idea Parking Lot — build spec

Status: v1 implemented (migration `019_idea_parking_lot.sql`, 13 MCP tools, Node embedding sweeper, protocol resource). v2, the **Idea Garden** (refocus Phase 4): migration `028_idea_garden_v2.sql` and 14 idea tools (`explore_topic` is new).
Agent-facing protocol: [`docs/idea-parking-lot-protocol.md`](idea-parking-lot-protocol.md) (served as `second-brain://protocol/idea-parking-lot`).

> **Superseded in part (2026-10-05/06).** The refocus decision record [`docs/decisions/2026-10-05-refocus.md`](decisions/2026-10-05-refocus.md) renamed the Idea Parking Lot to the Idea Garden and changed several decisions below: link proposals at capture (D3, D12), the link vocabulary and display labels (D4, D13), a file-based interactive HTML map (D5), the weekly garden review (D8), the inbox (D14) and promotion records (D1, D15). Where this spec and the decision record differ, the decision record wins. The markers below say which parts changed.

## 1. Context and decisions

The user wants an **Idea Parking Lot that lives natively in 2nd-brain**, not a mirror of the Google Tasks "Subjects" list or of the old Notion database of the same name.

What the user said ideas are:

- Ideas are random; sometimes several combine into something bigger.
- Ideas are **curation of raw materials**, "not even work-in-progress". Google Tasks is for production-level topics; ideas live one stage earlier.

Requirements as stated:

- **Capture.** Each idea records when it was captured, where it was encountered, the raw content that inspired it, a quick note on why it is interesting, and the user's thoughts in their most unfiltered form. Capture happens through an AI acting as a **Librarian**: the user gives a link, says "park this", says why it interests them and what came to mind, and the AI files it.
- **Storage.** It must show **relationships between idea units**, not be a flat list. The user wants to work with AI agents on creating episodes from the units and on building "a kind of mindmap of me": a graph of their intellectual curiosity that they look at to choose directions of exploration. Notion is rejected as the active tool (UI and speed). The old Notion lot must be migrated, not abandoned.
- **Retrieval.** Pull, not push: the user consults it; it never notifies.
- **The hard part.** Creating the associations between filed items.

Decisions made in the design discussion (2026-10-03):

| # | Decision |
|---|---|
| 1 | Postgres in 2nd-brain is the source of truth. Ideas are not tasks: no due dates, no priorities. |
| 2 | ~~Capture is **strictly one-way**. The Librarian's receipt never suggests links, hubs or neighbours.~~ **Superseded by D3 and D12:** the receipt comes first; then `park_idea` returns up to 5 `link_candidates`, and the assistant may save up to 3 typed proposals with glosses (`origin: 'capture'`) and show them after the receipt. Nothing is linked without the user's yes. |
| 3 | Associations are **gardening only**: in sessions the user starts, an AI pulls candidates, proposes *typed* links with a one-line rationale, and the user accepts or rejects. Rejections are remembered. No automatic association edges are written. **Amended by D3 and D8:** proposals may also follow a capture (above), and the weekly garden review is the session where the inbox gets its linking pass. Still no automatic edges. |
| 4 | ~~No front-end in the repo.~~ The user reaches 2nd-brain only through AI agents over MCP. ~~When they want a picture, the agent pulls graph data (`export_idea_map`) and renders it with whatever visualisation tool it has.~~ **Superseded by D5:** the server generates a self-contained interactive HTML page (`export_idea_map(format: 'html')`) that any assistant hands over as a file. It is a file, not a hosted page; a full web app is built only if chat capture fails the 30-second test. |
| 5 | Several different AI agents will use these tools, so tool descriptions and the protocol resource are agent-agnostic and self-sufficient. |
| 6 | Seeds, one time: the Notion export (CSV) and the Google Tasks "Subjects" items already synced into `task_ref`, both imported as idea units; ~~the user retires the Subjects list afterwards~~ (**superseded by D1 and D2:** Subjects stays as the production shortlist, and its items are imported *and* recorded as promoted; that part of the import is not built yet). **The repo is public**, so the import runs through an AI agent calling MCP tools — no idea data is ever committed. |
| 7 | Deliverable: this spec plus the full v1. |

## 2. Goals and non-goals

**Goals:** frictionless, faithful capture; human-confirmed associations with rationale; ideas linked to the user's own published outputs (essays, episode transcripts in `public_artifact`) so the map shows *territory* vs *frontier*; graph export any agent can render; lossless, idempotent migration.

**Non-goals (v1):** automatic linking; reminders or proactive surfacing; a hosted map page; delete/merge tools (ideas are composted instead); family-scope ideas; writing idea links into `link_edge`.

These still hold in v2, with three clarifications. Capture proposals (D3) are not automatic links: they wait for the user's yes. The weekly review reminder (D8) lives in Muse, not in 2nd-brain. The HTML map (D5) is a file the assistant hands over, not a hosted page.

## 3. Concepts

- **Unit** — one parked idea. **Synthesis** — several ideas combined into something bigger, with an `intent`: `episode | essay | series | learning | undecided`. A synthesis is an idea row (`kind = 'synthesis'`) whose parts point at it with accepted `part_of` links, so it can itself be linked, mapped and searched.
- **Statuses** — `parked` → `exploring` → `used`, or `composted` (let go, kept). Changed only on the user's word; every change is logged as a `system` note.
- **Inbox** (v2, D14) — an idea is in the inbox while `reviewed_at` is NULL and it is not composted. Every idea starts there, including every idea that existed before migration 028 (no backfill) and every imported one; a synthesis is created already reviewed. A garden review takes it out (`decide_idea_links` `mark_reviewed`, or `update_idea` `reviewed`).
- **Promotion** (v2, D1, D15) — Simon or Muse writes the Google Task in "Subjects"; 2nd-brain only records it (`update_idea` `promoted: {title, at?}`: `promoted_at`, `promoted_title`). Recording it moves a `parked` or `composted` idea to `exploring` and takes it out of the inbox. 2nd-brain never writes Google Tasks.
- **Field ownership** — `thoughts` are the user's words, verbatim; `framing` is AI-written context; `notes` is a dated log where each entry records who wrote it (`simon | agent | import | system`).
- **Territory** — accepted `became` link → *territory*; only `revisits` → *adjacent*; otherwise *frontier*.
- **Link lifecycle** — `proposed → accepted | rejected | withdrawn`; `accepted → retracted`. Only `decide_idea_links` (accept) and `create_synthesis` produce accepted links.

## 4. Architecture

```
 AI agent (claude.ai, Claude Code, others)
      │  MCP (JSON-RPC, OAuth/Bearer)
      ▼
 Cloudflare Worker  mcp-worker/        ── Hyperdrive ──►  Railway Postgres (+pgvector)
   14 idea tools, protocol resource                         idea / idea_source / idea_link
                                                                   ▲
 Node monolith (Railway)  src/ideas/worker.ts ─────────────────────┘
   embedding sweeper (30s poll): embeds rows where embedding IS NULL
```

The Worker never processes rows (norms doc, Part 2): it inserts ideas with `embedding NULL`; the sweeper embeds them. Capture never fails because the embeddings API is down, there is one embedding recipe in one place, and edits re-embed automatically through the trigger.

## 5. Schema (`migrations/019_idea_parking_lot.sql`)

- **`idea`** — `kind`, `intent` (CHECK: present iff synthesis), `title`, `status`, `captured_at` (backdatable), `encountered_where`, `source_url/title/excerpt`, `why_interesting`, `thoughts`, `framing`, `notes jsonb[]` (server-written notes carry `credential`), `tags text[]`, `captured_via jsonb`, `edit_log jsonb[]` (append-only `{at, credential, tool, fields?}`, migration 022: one entry per update, with the fields it touched, or per import merge; in v2 also one per `decide_idea_links` `mark_reviewed`, with `fields: ['reviewed']`), `embedding vector(1536)` + bookkeeping (`embedding_model`, `embedded_at`, `embed_attempts`, `embed_error`, `embed_retry_at`), timestamps. Indexes: `(user_id, status, captured_at)`, GIN on tags, HNSW on embedding, partial index on rows needing embedding.
- **`idea_source`** — provenance; `UNIQUE (user_id, source_system, source_external_id)` makes imports idempotent and doubles as the Librarian's idempotency key store. `import_payload` keeps the original row. One idea can carry several sources (a Notion row and the Google task it came from) — the reason provenance is a table, not columns.
- **`idea_link`** — `source_idea_id` → `target_idea_id` **or** `target_artifact_id` (FK to `public_artifact`), `link_type`, `status`, `rationale` (required; shown to the user as the gloss), `similarity`, `proposed_by` (`gardening | import | synthesis | capture`, the last from 028), `proposed_via`, `decided_at`, `decided_via` (`{credential}`, set with `decided_at`, cleared on reopen; migration 022), `decision_note`, `history` (a retract snapshots the accept and its decider; an accept that changes type or direction, a reopen and a revive snapshot the earlier proposal and proposer, the last two also the decider).
- Constraints and triggers:
  - exactly one target; artifact targets only for `became` / `revisits`; no self-links;
  - symmetric types (`tension_with`, `same_mechanism`, `combines_with`, `related`, and `inverts` from 028) stored in canonical order (`source < target`) and a unique `(LEAST, GREATEST, link_type)` index, so `A→B` and `B→A` can't both exist;
  - `idea_link_validate`: both idea endpoints belong to the link's user; `part_of` targets a synthesis;
  - `idea_before_update`: `kind` immutable; any change to an embedded field (title, framing, why, thoughts, source title/excerpt, tags, or the user's own notes) clears the embedding and its retry bookkeeping; `status_changed_at` maintained.

**Migration `028_idea_garden_v2.sql`** (v2; additive, idempotent, nothing deleted; it ships before the Worker code that uses it, because the Worker deploys on merge while migrations run when the monolith boots):

- `idea.reviewed_at` — when a garden review handled the idea; NULL means in the inbox. No backfill. Partial index `idx_idea_inbox (user_id, captured_at) WHERE reviewed_at IS NULL`.
- `idea.promoted_at`, `idea.promoted_title` — the promotion record, set together or not at all (`idea_promoted_pair` CHECK; title 1–500 characters).
- `idea_link.link_type` CHECK adds `mechanism_for` and `inverts`; `idea_link_symmetric_canonical` adds `inverts`.
- `idea_link.proposed_by` CHECK adds `capture`.

Why a dedicated `idea_link` instead of `link_edge`: `link_edge` is the machine-made graph (no lifecycle, no FKs, `user_id = 'default'`); idea links are human-confirmed with a lifecycle and rationale. Keeping them apart means no dual writes and no change for `link_edge` readers (morning review, `get_entry`).

## 6. Link vocabulary

| Type | Label (v2) | Endpoints | Direction | Meaning |
|---|---|---|---|---|
| `builds_on` | extends | idea → idea | directed | A extends, refines or depends on B |
| `example_of` | example-of | idea → idea | directed | A is a concrete instance of B's general claim |
| `mechanism_for` | mechanism-for | idea → idea | directed | A explains why B happens; the source is the mechanism (v2) |
| `part_of` | part-of | idea → synthesis | directed | A is a component of synthesis B |
| `tension_with` | contradicts | idea ↔ idea | symmetric | A and B pull against or contradict each other |
| `same_mechanism` | rhymes-with | idea ↔ idea | symmetric | Same structural mechanism in different domains — the analogy/bridge type |
| `inverts` | inverts | idea ↔ idea | symmetric | Each is the other with the causality flipped (v2; symmetric per D13) |
| `combines_with` | combines-with | idea ↔ idea | symmetric | A and B could fuse into something bigger |
| `related` | related | idea ↔ idea | symmetric | Fallback; the rationale must say why nothing specific fits |
| `became` | became | idea → output | directed | The idea turned into this published output |
| `revisits` | revisits | idea → output | directed | The idea retreads an earlier output |

The vocabulary is a CHECK enum mirrored in `mcp-worker/src/ideas/linkTypes.ts`. v2 (D4) kept the nine stored names and added `mechanism_for` and `inverts`. Stored names never change and no confirmed link is renamed; the brief's names are display **labels** (`LINK_TYPE_INFO[type].label`), which every link read returns next to `link_type`. Similarity finds the obvious neighbours; the typed vocabulary is what makes the non-obvious associations (tension, cross-domain analogy) first-class.

## 7. Tools

Fourteen idea tools (v2 added `explore_topic`; the server has 36 tools in all):

| Tool | Kind | Rule |
|---|---|---|
| `park_idea` | write | ONLY on an explicit "park this". Idempotency key, plus a 10-minute guard that treats the same title **and** the same content as a retry (a different thought under the same title is a new idea). v2: the receipt fields come first, then `link_candidates` — up to 5 live, embedded ideas with similarity ≥ 0.30, nearest first. The new idea's text is embedded as a query vector only (the row stays `embedding NULL` for the sweeper), with a 5-second timeout; any failure gives `[]` and a warning, never a failed capture. |
| `update_idea` | write | On the user's request or to record a decision they just made. Tri-state fields, tag add/remove, status (logged), synthesis intent, append note. v2: `reviewed` (in or out of the inbox); `promoted: {title, at?}` or `null` (moves `parked`/`composted` to `exploring`, marks it reviewed); sending status `composted` withdraws the idea's pending proposals. |
| `get_idea` / `list_ideas` / `search_ideas` | read | Pull-only. v2: `get_idea` and `list_ideas` carry `inbox` and `promoted` (`search_ideas` hits do not); `list_ideas` filters `inbox` and `promoted`; link reads carry the display `label`. |
| `explore_topic` | read | v2. Pull-only: "what do I have on X?". The shared hybrid search (`mcp-worker/src/ideas/search.ts`) over live ideas, expanded over links `depth` hops (1–2), returned as clusters (here: the connected groups among the returned ideas, unlike the map's clusters in §11) with every link's label and gloss, plus published outputs. |
| `garden_ideas` | read | ONLY in a gardening session or garden review. Modes `near` / `band` / `orphans` / `outputs`, and v2 `inbox`. |
| `propose_idea_links` | write | ONLY in a gardening session, the import, or right after a capture. Batch ≤ 20; refuses rejected/retracted pairs unless `reconsider_rejected`; reopens withdrawn ones (history kept). v2 origin `capture`: at most 3 links, idea to idea, one idea at an endpoint of every link, checked before any write. |
| `list_idea_links` | read | Defaults to pending. v2: `proposed_by` filter accepts `capture`. |
| `decide_idea_links` | write | ONLY the user's stated verdicts. accept (optional retype / reverse) · reject · withdraw · retract. Row-locked, per-item transactions. v2: `mark_reviewed` (≤ 200 idea ids) takes ideas out of the inbox in one statement after the decisions. |
| `create_synthesis` | write | ONLY on the user's explicit decision; ≥ 2 parts; accepted `part_of` links. v2: the synthesis is inserted already reviewed. |
| `export_idea_map` | read | json (`idea-map/v1`) · graphml · mermaid (≤ 150 nodes) · v2 html (a self-contained interactive page, §11). |
| `import_ideas` / `list_subjects_for_import` | write / read | ONLY during the one-time import. |

Every write tool's description opens with its ONLY-rule and cites a protocol §; the dispatcher test enforces the ONLY-rule's presence.

## 8. Embedding pipeline

`src/ideas/embeddingText.ts` joins non-empty `title, framing, why_interesting, thoughts, user notes, source_title, source_excerpt (≤ 1,500 chars), "tags: …"` and truncates by an **estimated token budget** of 7,000 (CJK counted at 1.8 tokens per character — measured cl100k is ~1.6–1.7 for Traditional Chinese/Cantonese — ASCII at 0.3), always on code-point boundaries; the model limit is 8,191 tokens.

The sweeper (`src/ideas/worker.ts`, 30 s poll):

- batches pending rows (≤ 50, and ≤ 200k estimated tokens per request);
- **systemic failures** (auth, quota/rate limit, 5xx, network) charge nothing — the tick ends and the next poll retries;
- **row-specific failures** (HTTP 400/413/422) are isolated one row at a time; an over-long input is retried once with a shorter text; a row that still fails gets `embed_attempts + 1` and `embed_retry_at = now() + min(1 min · 2^attempts, 1 day)`, so it never blocks the queue and is still retried daily;
- writes (success or failure) carry an optimistic guard on `updated_at` (compared as text to keep microsecond precision), so nothing computed for old text lands on an edited row.

## 9. Search

Ideas are bilingual (English and Traditional Chinese). The hybrid search lives in `mcp-worker/src/ideas/search.ts`, shared by `search_ideas` (a flat list, composted included) and `explore_topic` (live ideas, then clusters). It merges a vector top-k (hits below `min_similarity`, default 0.25, dropped as noise) with an ILIKE match of every whitespace-separated term over all text fields, tags and notes. ILIKE covers Chinese (the english `tsvector` used elsewhere does not) and ideas filed seconds ago that aren't embedded yet. Score: `max(similarity, text match ? (all terms in title ? 0.8 : 0.6) : 0)`.

## 10. Gardening algorithms

| Mode | Candidates | Defaults |
|---|---|---|
| `near` | idea pairs, best first | similarity ≥ 0.50; ≥ 0.90 flagged `possible_duplicate` |
| `band` | idea pairs inside a similarity band — the zone where cross-domain analogies live | 0.30–0.45 |
| `orphans` | ideas with no accepted links, newest first by default (`order: 'oldest'` for the backlog), each with up to 3 unconsidered neighbours | neighbours ≥ 0.30 |
| `inbox` (v2) | the garden review queue: inbox ideas, oldest captured first, 8 per page (`offset` paging, `paging.total_inbox`), each with up to 3 unconsidered neighbours and its pending proposals (never one with a composted idea at either end) | neighbours ≥ 0.30 |
| `outputs` | a page of 40 ideas (newest first, `offset` paging) without an accepted `became`, each with its top-3 published outputs by summary embedding | ≥ 0.45 (the journal linker's `echoes_artifact` threshold); hint `became?` if published after capture, else `revisits?` |

All modes exclude pairs that already have a proposed, accepted, rejected or retracted link (withdrawn pairs may resurface). `per_idea_cap` (default 2) limits appearances per idea in near/band/outputs; `cross_domain` (no shared tags) applies to near/band/orphans/inbox.

Cost: `near` uses a per-idea HNSW nearest-neighbour lookup (k = 15) over the 1,000 most recently updated ideas — ~0.6 s at 2,000 ideas versus ~9 s for a full pair scan. `band` (low similarity, where an index can't help) scans pairs among the 600 most recently updated ideas, or all pairs of one `focus_idea_id`. Every query runs under `SET LOCAL statement_timeout = '8s'`; a timeout returns a message suggesting `focus_idea_id`.

## 11. Map export (`idea-map/v1`)

`{format, generated_at, filters, stats{nodes, edges, components, orphans}, truncated, omitted_count, nodes[], edges[], legend}`.

- **Nodes** — `id, node_type (idea | synthesis | output), label, status, kind, intent, captured_at, tags, degree, pending_degree, component, component_size, territory, url, published_at`, and in v2 `cluster, cluster_size, created_at, inbox, promoted_at`. Degree counts accepted links (output links included even when outputs are hidden, so orphan counts don't depend on the view); components are computed over accepted **idea↔idea** edges and ranked by size — an output takes the component of an idea that links to it, so one popular episode never glues unrelated clusters together; territory comes from accepted output links.
- **Edges** — `id, source, target, type, directed, status, rationale`, and in v2 `label` (display), `proposed_at`, `decided_at`.
- **Clusters** (v2) — Louvain communities (groups found by link density) over the same accepted idea↔idea edges as the components. A cluster never spans two components, but one component can split into several clusters. Clusters are ranked by size (1 = largest); an output takes the cluster of an idea that links to it. Top-level `clusters: [{id, name, size}]` lists the clusters of two or more ideas, each named after its highest-degree member. The HTML page colours the first eight of them and draws the rest grey.
- **Ego network** — `focus_idea_id` + `depth` (BFS; pending edges traversed only with `include_pending`; output nodes are leaves, never expanded).
- **Truncation** — focus/BFS order. Otherwise linked ideas by degree then recency, then the outputs linked to a kept idea, then isolated ideas, so a loose idea never pushes out a published output; outputs keep up to a tenth of `max_nodes` even when linked ideas alone would fill it. Outputs are kept only if linked to a kept idea.
- **GraphML** — typed `<key>`s, `edgedefault="directed"`; symmetric edges are marked by the `e_directed=false` data key (not a per-edge XML attribute — mixed graphs break common readers such as networkx); characters XML forbids are stripped. **Mermaid** — `flowchart LR`, labels ≤ 60 code points with markup characters (`# " & < > \` %`) entity-encoded, `-->` directed, `---` symmetric, dashed for proposed, each edge captioned with its display label (`contradicts`, `extends`, …; the JSON header's legend maps labels to stored types), class per territory; ≤ 150 nodes and ≤ 500 edges (Mermaid's default limit; proposals dropped first).

- **HTML** (v2, D5) — `format: 'html'` returns two text blocks: JSON meta (`stats`, `truncated`, `omitted_count`, `filename` `idea-map-YYYY-MM-DD.html`, `bytes`, `note`, and `warning` when the page is over 75,000 bytes), then one self-contained page (`mcp-worker/src/ideas/mapHtml.ts`). The assistant saves the second block unchanged as `filename`, checks it is `bytes` bytes, and hands it over as a file. `max_nodes` defaults to 150 for html (300 otherwise), because some clients cut tool results off near 25k tokens (150 synthetic ideas with 225 links make about 77 KB). The page: nodes coloured by cluster (eight colours, then grey), the label and gloss on hover or tap, a legend, an as-of slider with Play for journey reviews (ideas appear at `captured_at`, links at `decided_at`), inbox and promotion marks. Only published outputs appear; links to unpublished ones are dropped before the map is built, so they don't count toward degree, orphans or cluster names. Safety: a CSP that allows only inline script and style, no network, user text only in an escaped JSON block rendered with `textContent`. There is deliberately no embedded MCP resource: the result type is text-only, and repeating the page as a resource would double the result.

**Using the map to choose directions** (the user's open question): large frontier components show where curiosity has gathered without output; `same_mechanism` / `combines_with` bridges between components are candidate cross-domain episodes; `tension_with` and `inverts` pairs are arguments waiting to be had; orphans are gardening targets; components touching territory extend published work. Agents offer these as observations; the user decides.

## 12. Import design

Run by an AI agent through `import_ideas` / `list_subjects_for_import` / `propose_idea_links(origin: 'import')` — see protocol §4 for the column mapping. Key points: Notion rows are keyed `"<Added>|<Idea>"` (the CSV export has no page ids); `Added` is parsed server-side in the user-confirmed IANA timezone (DST-aware); `[YYYY-MM-DD]` markers that start a line become dated notes; the whole row is kept in `import_payload`; items are validated individually so one bad row never sinks a batch. Subjects items whose normalized title **exactly** matches a Notion row (many Notion rows originally came from Google Tasks) are **merged** into it — earliest `captured_at` wins, tags union case-insensitively in order, the task's notes appended verbatim as the user's note; partial ("contains") title matches and close semantic matches go to the user for confirmation. Tasks Google no longer returns (`stale`) are confirmed with the user first. Cross-references in Notion (series parts, "related to …") become **proposed** links for the first gardening session, never accepted ones. Google Tasks exposes no creation date, so Subjects `captured_at` is the first-sync time (approximate).

## 13. Hyperdrive caching

The Hyperdrive config has query caching on (60 s `max_age`, not invalidated by writes). Gardening and import are read-after-write loops, so every idea read includes `now() AS as_of`, which Hyperdrive treats as uncacheable. A deterministic alternative is disabling caching on the config (`wrangler hyperdrive update <id> --caching-disabled`) — an ops change left to the owner.

## 14. Privacy

The repository is public. No idea content, titles or exports are committed; tests use synthetic fixtures; the protocol forbids copying idea content into repos, issues or PRs.

## 15. Testing

- `mcp-worker`: dispatcher tests (tool surface, ONLY-rules, resources, the server instructions), pure unit tests (date parsing, note splitting, title dedup, link canonicalisation, graph build, GraphML/Mermaid escaping, the HTML page's safety contract), and DB suites in `test/db/` against a real Postgres (`TEST_DATABASE_URL`, local `*_test` only; reset + all migrations in `test/setup/test-db.ts`). CI (`.github/workflows/ci.yml`, plus the deploy workflow's test step) provides a `pgvector/pgvector:pg16` service, so the DB suites run there too; without `TEST_DATABASE_URL` they skip. A static test fails if any read in the 14 idea tools or the shared `mcp-worker/src/ideas/` modules lacks `now()`.
- Root: `npm test` — embedding text recipe, and the sweeper against Postgres (embed, mid-flight edit guard, failure isolation, attempt cap, trigger re-queue).

## 16. Rollout

1. Merge → Railway redeploys the monolith and applies 019 on boot; CI deploys the Worker. Idea tools may error for about a minute until the migration lands.
2. Reconnect MCP clients so they refresh `tools/list` and `resources/list`.
3. Smoke test from an agent: park a synthetic idea (receipt only) → search finds it after ~60 s → garden / propose / decide → `list_idea_links` reflects each step immediately → export Mermaid → compost the test idea.
4. Run the import (protocol §4) with the Notion export; then the first gardening session starts with the import proposals.

### v2 rollout (refocus Phase 4)

1. Migration 028 ships first and must have run in production before the Worker code merges (the Worker deploys on merge; migrations run when the monolith boots).
2. After the code deploys, reconnect each MCP client (or start a new session in it), so it gets the new tools and enums (`explore_topic`, `format: 'html'`, `origin: 'capture'`, `mechanism_for`, `inverts`) and the new server instructions. Don't rely on waiting: 2025-era clients get the instructions only in the `initialize` result, and only 2026-07-28 clients are given a cache lifetime (`ttlMs`, 5 minutes) on `server/discover` and `tools/list`. A session that kept the old instructions would be told never to suggest links at capture while the new tool descriptions tell it to propose them.
3. Update the agent-side `2nd-brain-mcp` skill to the new protocol.
4. Smoke test: park a `[smoke]` idea (the receipt may list `link_candidates`; no proposals are saved for smoke ideas) → compost it (any pending proposals are withdrawn).
5. The Notion part of the import (protocol §4, Passes 1 and 3) can run once the code is deployed; the Notion rows land in the inbox. The Subjects pass (Pass 2) comes later: after the import update that records Subjects items as promoted, and after the legal pages say that imported Subjects titles and notes reach assistants through every idea tool (decision record, Phase 4 owner actions).

## 17. Open questions

- Similarity thresholds are untuned for mixed-language pairs; tune after the import on real data.
- Instant embedding (LISTEN/NOTIFY) if the 30 s poll ever feels slow.
- Chunk-level idea ↔ output matching if summary-level `outputs` candidates prove too coarse.

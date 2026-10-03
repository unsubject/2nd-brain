# Phase: Idea Parking Lot — build spec

Status: v1 implemented (migration `019_idea_parking_lot.sql`, 13 MCP tools, Node embedding sweeper, protocol resource).
Agent-facing protocol: [`docs/idea-parking-lot-protocol.md`](idea-parking-lot-protocol.md) (served as `2nd-brain://protocol/idea-parking-lot`).

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
| 2 | Capture is **strictly one-way**. The Librarian's receipt never suggests links, hubs or neighbours. |
| 3 | Associations are **gardening only**: in sessions the user starts, an AI pulls candidates, proposes *typed* links with a one-line rationale, and the user accepts or rejects. Rejections are remembered. No automatic association edges are written. |
| 4 | No front-end in the repo. The user reaches 2nd-brain only through AI agents over MCP. When they want a picture, the agent pulls graph data (`export_idea_map`) and renders it with whatever visualisation tool it has. |
| 5 | Several different AI agents will use these tools, so tool descriptions and the protocol resource are agent-agnostic and self-sufficient. |
| 6 | Seeds, one time: the Notion export (CSV) and the Google Tasks "Subjects" items already synced into `task_ref`, both imported as idea units; the user retires the Subjects list afterwards. **The repo is public**, so the import runs through an AI agent calling MCP tools — no idea data is ever committed. |
| 7 | Deliverable: this spec plus the full v1. |

## 2. Goals and non-goals

**Goals:** frictionless, faithful capture; human-confirmed associations with rationale; ideas linked to the user's own published outputs (essays, episode transcripts in `public_artifact`) so the map shows *territory* vs *frontier*; graph export any agent can render; lossless, idempotent migration.

**Non-goals (v1):** automatic linking; reminders or proactive surfacing; a hosted map page; delete/merge tools (ideas are composted instead); family-scope ideas; writing idea links into `link_edge`.

## 3. Concepts

- **Unit** — one parked idea. **Synthesis** — several ideas combined into something bigger, with an `intent`: `episode | essay | series | learning | undecided`. A synthesis is an idea row (`kind = 'synthesis'`) whose parts point at it with accepted `part_of` links, so it can itself be linked, mapped and searched.
- **Statuses** — `parked` → `exploring` → `used`, or `composted` (let go, kept). Changed only on the user's word; every change is logged as a `system` note.
- **Field ownership** — `thoughts` are the user's words, verbatim; `framing` is AI-written context; `notes` is a dated log where each entry records who wrote it (`simon | agent | import | system`).
- **Territory** — accepted `became` link → *territory*; only `revisits` → *adjacent*; otherwise *frontier*.
- **Link lifecycle** — `proposed → accepted | rejected | withdrawn`; `accepted → retracted`. Only `decide_idea_links` (accept) and `create_synthesis` produce accepted links.

## 4. Architecture

```
 AI agent (claude.ai, Claude Code, others)
      │  MCP (JSON-RPC, OAuth/Bearer)
      ▼
 Cloudflare Worker  mcp-worker/        ── Hyperdrive ──►  Railway Postgres (+pgvector)
   13 idea tools, protocol resource                         idea / idea_source / idea_link
                                                                   ▲
 Node monolith (Railway)  src/ideas/worker.ts ─────────────────────┘
   embedding sweeper (30s poll): embeds rows where embedding IS NULL
```

The Worker never processes rows (norms doc, Part 2): it inserts ideas with `embedding NULL`; the sweeper embeds them. Capture never fails because the embeddings API is down, there is one embedding recipe in one place, and edits re-embed automatically through the trigger.

## 5. Schema (`migrations/019_idea_parking_lot.sql`)

- **`idea`** — `kind`, `intent` (CHECK: present iff synthesis), `title`, `status`, `captured_at` (backdatable), `encountered_where`, `source_url/title/excerpt`, `why_interesting`, `thoughts`, `framing`, `notes jsonb[]`, `tags text[]`, `captured_via jsonb`, `embedding vector(1536)` + bookkeeping (`embedding_model`, `embedded_at`, `embed_attempts`, `embed_error`), timestamps. Indexes: `(user_id, status, captured_at)`, GIN on tags, HNSW on embedding, partial index on rows needing embedding.
- **`idea_source`** — provenance; `UNIQUE (user_id, source_system, source_external_id)` makes imports idempotent and doubles as the Librarian's idempotency key store. `import_payload` keeps the original row. One idea can carry several sources (a Notion row and the Google task it came from) — the reason provenance is a table, not columns.
- **`idea_link`** — `source_idea_id` → `target_idea_id` **or** `target_artifact_id` (FK to `public_artifact`), `link_type`, `status`, `rationale` (required), `similarity`, `proposed_by` (`gardening | import | synthesis`), `proposed_via`, `decided_at`, `decision_note`, `history`.
- Constraints and triggers:
  - exactly one target; artifact targets only for `became` / `revisits`; no self-links;
  - symmetric types stored in canonical order (`source < target`) and a unique `(LEAST, GREATEST, link_type)` index, so `A→B` and `B→A` can't both exist;
  - `idea_link_validate`: both idea endpoints belong to the link's user; `part_of` targets a synthesis;
  - `idea_before_update`: `kind` immutable; any change to an embedded field (title, framing, why, thoughts, source title/excerpt, tags, or the user's own notes) clears the embedding; `status_changed_at` maintained.

Why a dedicated `idea_link` instead of `link_edge`: `link_edge` is the machine-made graph (no lifecycle, no FKs, `user_id = 'default'`); idea links are human-confirmed with a lifecycle and rationale. Keeping them apart means no dual writes and no change for `link_edge` readers (morning review, `get_entry`).

## 6. Link vocabulary

| Type | Endpoints | Direction | Meaning |
|---|---|---|---|
| `builds_on` | idea → idea | directed | A extends, refines or depends on B |
| `example_of` | idea → idea | directed | A is a concrete instance of B's general claim |
| `part_of` | idea → synthesis | directed | A is a component of synthesis B |
| `tension_with` | idea ↔ idea | symmetric | A and B pull against or contradict each other |
| `same_mechanism` | idea ↔ idea | symmetric | Same structural mechanism in different domains — the analogy/bridge type |
| `combines_with` | idea ↔ idea | symmetric | A and B could fuse into something bigger |
| `related` | idea ↔ idea | symmetric | Fallback; the rationale must say why nothing specific fits |
| `became` | idea → output | directed | The idea turned into this published output |
| `revisits` | idea → output | directed | The idea retreads an earlier output |

The vocabulary is a CHECK enum mirrored in `mcp-worker/src/ideas/linkTypes.ts`. Similarity finds the obvious neighbours; the typed vocabulary is what makes the non-obvious associations (tension, cross-domain analogy) first-class.

## 7. Tools

| Tool | Kind | Rule |
|---|---|---|
| `park_idea` | write | ONLY on an explicit "park this". Receipt only (exact key set tested). Idempotency key + 10-minute same-title guard. |
| `update_idea` | write | On the user's request or to record a decision they just made. Tri-state fields, tag add/remove, status (logged), synthesis intent, append note. |
| `get_idea` / `list_ideas` / `search_ideas` | read | Pull-only. |
| `garden_ideas` | read | ONLY in a gardening session. Modes `near` / `band` / `orphans` / `outputs`. |
| `propose_idea_links` | write | ONLY in a gardening session or the import. Batch ≤ 20; refuses rejected/retracted pairs unless `reconsider_rejected`; reopens withdrawn ones (history kept). |
| `list_idea_links` | read | Defaults to pending. |
| `decide_idea_links` | write | ONLY the user's stated verdicts. accept (optional retype / reverse) · reject · withdraw · retract. Row-locked, per-item transactions. |
| `create_synthesis` | write | ONLY on the user's explicit decision; ≥ 2 parts; accepted `part_of` links. |
| `export_idea_map` | read | json (`idea-map/v1`) · graphml · mermaid (≤ 150 nodes). |
| `import_ideas` / `list_subjects_for_import` | write / read | ONLY during the one-time import. |

Every write tool's description opens with its ONLY-rule and cites a protocol §; the dispatcher test enforces the ONLY-rule's presence.

## 8. Embedding pipeline

`src/ideas/embeddingText.ts` joins non-empty `title, framing, why_interesting, thoughts, user notes, source_title, source_excerpt (≤ 1,500 chars), "tags: …"`, capped at 6,000 characters (CJK runs ~1–1.5 tokens per character; the model limit is 8,191 tokens). The sweeper batch-embeds up to 50 pending rows, falls back to one-at-a-time to isolate a failing row, gives up after 5 attempts (`embed_error` kept), and writes with an optimistic guard on `updated_at` (compared as text to keep microsecond precision) so an embedding computed for old text never lands on an edited row.

## 9. Search

Ideas are bilingual (English and Traditional Chinese). `search_ideas` merges a vector top-k (hits below `min_similarity`, default 0.25, dropped as noise) with an ILIKE match of every whitespace-separated term over all text fields, tags and notes. ILIKE covers Chinese (the english `tsvector` used elsewhere does not) and ideas filed seconds ago that aren't embedded yet. Score: `max(similarity, text match ? (all terms in title ? 0.8 : 0.6) : 0)`.

## 10. Gardening algorithms

| Mode | Candidates | Defaults |
|---|---|---|
| `near` | idea pairs, best first | similarity ≥ 0.50; ≥ 0.90 flagged `possible_duplicate` |
| `band` | idea pairs inside a similarity band — the zone where cross-domain analogies live | 0.30–0.45 |
| `orphans` | ideas with no accepted links, oldest first, each with up to 3 unconsidered neighbours | neighbours ≥ 0.30 |
| `outputs` | up to 40 most recent ideas without an accepted `became`, each with its top-3 published outputs by summary embedding | ≥ 0.45 (the journal linker's `echoes_artifact` threshold); hint `became?` if published after capture, else `revisits?` |

All modes exclude pairs that already have a proposed, accepted, rejected or retracted link (withdrawn pairs may resurface), cap each idea at `per_idea_cap` appearances (default 2), and can require no shared tags (`cross_domain`). The pair scan is O(N²) over embedded ideas — fine to ~1–2k ideas; beyond that, switch to per-idea HNSW lateral joins.

## 11. Map export (`idea-map/v1`)

`{format, generated_at, filters, stats{nodes, edges, components, orphans}, truncated, omitted_count, nodes[], edges[], legend}`.

- **Nodes** — `id, node_type (idea | synthesis | output), label, status, kind, intent, captured_at, tags, degree, pending_degree, component, component_size, territory, url, published_at`. Degree counts accepted links; components are computed over accepted edges (ranked by size); territory from accepted output links.
- **Edges** — `id, source, target, type, directed, status, rationale`.
- **Ego network** — `focus_idea_id` + `depth` (BFS; pending edges traversed only with `include_pending`).
- **Truncation** — focus/BFS order, else degree then recency; outputs kept only if linked to a kept idea.
- **GraphML** — typed `<key>`s, `edgedefault="directed"`, symmetric edges `directed="false"`, XML-escaped. **Mermaid** — `flowchart LR`, labels ≤ 60 chars with `"` → `#quot;`, `-->` directed, `---` symmetric, dashed for proposed, class per territory.

**Using the map to choose directions** (the user's open question): large frontier components show where curiosity has gathered without output; `same_mechanism` / `combines_with` bridges between components are candidate cross-domain episodes; orphans are gardening targets; components touching territory extend published work. Agents offer these as observations; the user decides.

## 12. Import design

Run by an AI agent through `import_ideas` / `list_subjects_for_import` / `propose_idea_links(origin: 'import')` — see protocol §4 for the column mapping. Key points: Notion rows are keyed `"<Added>|<Idea>"` (the CSV export has no page ids); `Added` is parsed server-side at a user-confirmed UTC offset; dated Notes become dated notes; the whole row is kept in `import_payload`. Subjects items whose title matches a Notion row (many Notion rows originally came from Google Tasks) are **merged** into it — earliest `captured_at` wins, tags union, the task's notes appended verbatim as the user's note. Cross-references in Notion (series parts, "related to …") become **proposed** links for the first gardening session, never accepted ones. Google Tasks exposes no creation date, so Subjects `captured_at` is the first-sync time (approximate).

## 13. Hyperdrive caching

The Hyperdrive config has query caching on (60 s `max_age`, not invalidated by writes). Gardening and import are read-after-write loops, so every idea read includes `now() AS as_of`, which Hyperdrive treats as uncacheable. A deterministic alternative is disabling caching on the config (`wrangler hyperdrive update <id> --caching-disabled`) — an ops change left to the owner.

## 14. Privacy

The repository is public. No idea content, titles or exports are committed; tests use synthetic fixtures; the protocol forbids copying idea content into repos, issues or PRs.

## 15. Testing

- `mcp-worker`: dispatcher tests (tool surface, ONLY-rules, resources), pure unit tests (date parsing, note splitting, title dedup, link canonicalisation, graph build, GraphML/Mermaid escaping), and DB suites in `test/db/` against a real Postgres (`TEST_DATABASE_URL`, local `*_test` only; reset + all migrations in `test/setup/test-db.ts`). CI has no database, so the DB suites skip there.
- Root: `npm test` — embedding text recipe, and the sweeper against Postgres (embed, mid-flight edit guard, failure isolation, attempt cap, trigger re-queue).

## 16. Rollout

1. Merge → Railway redeploys the monolith and applies 019 on boot; CI deploys the Worker. Idea tools may error for about a minute until the migration lands.
2. Reconnect MCP clients so they refresh `tools/list` and `resources/list`.
3. Smoke test from an agent: park a synthetic idea (receipt only) → search finds it after ~60 s → garden / propose / decide → `list_idea_links` reflects each step immediately → export Mermaid → compost the test idea.
4. Run the import (protocol §4) with the Notion export; then the first gardening session starts with the import proposals.

## 17. Open questions

- Similarity thresholds are untuned for mixed-language pairs; tune after the import on real data.
- Instant embedding (LISTEN/NOTIFY) if the 30 s poll ever feels slow.
- Chunk-level idea ↔ output matching if summary-level `outputs` candidates prove too coarse.

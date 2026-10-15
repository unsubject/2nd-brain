# Phase 2: 5-W tool surface

Phase 1 shipped four MCP tools scoped entirely to `journal_entry`. The 2nd-brain Postgres holds six other record types that together cover the **who / when / where / what / why** of the user's life, but none of them are reachable from an AI client through this server. Phase 2 fixes that.

This is the **read-only cross-table phase**. No new infrastructure, no schema changes, no writes — five new tools layered onto the existing CF Worker.

## Context

The user's mental model of the brain (captured in the behavior doc's Domain model section):

| Table | Source | Question it answers |
|---|---|---|
| `public_artifact` (+ chunks, entities) | Long-form synthesis | **long-term memory** |
| `calendar_event_ref` | Google Calendar sync | **when** & **where** |
| `task_ref` | Google Tasks sync | **what (to do)** |
| `email_ref` | Gmail sync | **what (happened in correspondence)** |
| `journal_entry` | Telegram + `ai_chat` | **how** & **why** (current thinking) |
| `person_ref` | Google Contacts sync | **who** |
| `link_edge` | `src/google/linker.ts` | the relationships across all of the above |

Phase 1 exposed only `journal_entry`. AI clients can't currently answer "what's on my calendar tomorrow", "who emailed me about X", "any open tasks this week", or "what have I written about Y" (long-form). Phase 2 closes those gaps.

## Goal

Five new read-only MCP tools, one per 5-W table. Each tool uses the natural query shape for its data:

- **semantic** where embeddings already exist (`public_artifact` has 4,152 / 4,166 rows embedded)
- **structured filters or ILIKE** where they don't (`email_ref`, `task_ref`, `calendar_event_ref`, `person_ref` have 0 embeddings populated as of 2026-05-16)

## Non-goals

- **Writes** to any 5-W table — Google sync is the source of truth, the MCP doesn't mutate
- **Mutating Google services** (creating tasks, calendar events, sending mail) — separate phase
- **Embedding backfills** for `email_ref` / `person_ref` / `task_ref` / `calendar_event_ref` — defer until usage proves the need
- **A unified `search_everything`** tool — per-table is clearer for AI clients; can be added later if orchestration friction proves real
- **`link_edge` graph traversal** as a dedicated tool — `get_entry` already exposes outbound edges from journal entries, which covers the common case; defer broader traversal
- **`get_morning_review`** — still deferred (carried over from phase 1 non-goals)

## Data reality (as of 2026-05-16)

```
public_artifact          4,166 rows  (4,152 with embedding)  → semantic-ready
public_artifact_chunk    6,607 rows  (6,607 with embedding)  → semantic-ready
calendar_event_ref         129 rows  (0 embedding)            → time-filter only
task_ref                    81 rows  (0 embedding)            → status/due filter
email_ref                  251 rows  (0 embedding)            → ILIKE on subject/snippet
person_ref               2,931 rows  (0 embedding)            → ILIKE on name/email
link_edge               64,101 rows                           → consumed by get_entry only
```

## Architecture

Same as phase 1. No new bindings, secrets, or services.

```
AI client (claude.ai via OAuth, or Desktop via bearer)
    │  Authorization: Bearer <access_token>
    ▼
CF Worker: 2nd-brain-mcp           (same deployment, new tools added)
    │  Hyperdrive binding (existing)
    ▼
Railway Postgres                    (same DB, additional tables queried)
```

The four phase-1 tools (`search_brain`, `get_entry`, `list_recent`, `save_session`) stay unchanged.

## Tool catalogue

All tools live under `mcp-worker/src/tools/`, one file per tool, registered in `tools/registry.ts`.

### `search_artifacts` — read (semantic)

```ts
input: {
  query: string                                // free-text question
  type?: string                                // public_artifact.type filter (e.g. 'essay', 'note')
  status?: string                              // 'published' | 'draft' | etc.
  limit?: number = 10
}

effect:
  vector = embed(query)
  // chunk-level vector search, rolled up to artifact level (best chunk wins)
  SELECT DISTINCT ON (pa.id)
         pa.id, pa.title, pa.type, pa.status, pa.canonical_url, pa.published_at,
         pa.summary, c.chunk_text AS best_chunk,
         1 - (c.embedding <=> $vector) AS similarity
    FROM public_artifact pa
    JOIN public_artifact_chunk c ON c.public_artifact_id = pa.id
   WHERE c.embedding IS NOT NULL
     AND ($type IS NULL OR pa.type = $type)
     AND ($status IS NULL OR pa.status = $status)
   ORDER BY pa.id, c.embedding <=> $vector
   LIMIT $limit * 3;   -- over-fetch, then re-sort by best-per-artifact similarity DESC, cap at $limit
```

Returns top-N artifacts, each with the most-similar chunk as preview. Caller can request full content via a future `get_artifact` (deferred — out of scope for phase 2).

### `get_calendar` — read (time window)

```ts
input: {
  start?: string                               // ISO 8601; default: now
  end?: string                                 // ISO 8601; default: start + 7 days
  scope?: 'personal' | 'family' | 'all' = 'personal'
  limit?: number = 100
}

effect:
  SELECT id, title, description, location, start_at, end_at, attendees, status
    FROM calendar_event_ref
   WHERE start_at < $end AND end_at >= $start
     AND ($scope = 'all' OR scope = $scope)
   ORDER BY start_at ASC
   LIMIT $limit;
```

`attendees` is a JSONB array — return as-is. Default window is "next 7 days from now".

### `list_tasks` — read (structured filter)

```ts
input: {
  status?: 'needsAction' | 'completed' = 'needsAction'
  days_ahead?: number = 7                      // include tasks due within this window
  include_undated?: boolean = true             // tasks with due_at = null
  scope?: 'personal' | 'family' | 'all' = 'personal'
  project?: string                             // project_ref.name (ILIKE)
  limit?: number = 50
}

effect:
  // mirrors src/db/queries.ts getOpenTasks
  SELECT t.id, t.title, t.notes, t.due_at, t.status, t.completed_at,
         p.name AS list_name, p.list_type,
         parent.title AS parent_title
    FROM task_ref t
    LEFT JOIN project_ref p ON t.project_ref_id = p.id
    LEFT JOIN task_ref parent ON t.parent_task_ref_id = parent.id
   WHERE t.status = $status
     AND ($scope = 'all' OR t.scope = $scope)
     AND ($project IS NULL OR p.name ILIKE '%' || $project || '%')
     AND (t.due_at IS NULL AND $include_undated OR t.due_at <= now() + make_interval(days => $days_ahead))
   ORDER BY (t.due_at IS NULL) ASC, t.due_at ASC
   LIMIT $limit;
```

### `find_person` — read (name/email lookup)

```ts
input: {
  query: string                                // matched against full_name and primary_email
  limit?: number = 10
}

effect:
  SELECT id, full_name, primary_email, primary_phone, notes
    FROM person_ref
   WHERE full_name ILIKE '%' || $query || '%'
      OR primary_email ILIKE '%' || $query || '%'
   ORDER BY
     CASE WHEN full_name ILIKE $query THEN 0
          WHEN full_name ILIKE $query || '%' THEN 1
          ELSE 2 END,
     full_name ASC
   LIMIT $limit;
```

Rank: exact name match > prefix match > substring match. Notes are returned in full (most are short bios from People API).

Future (out of scope): semantic search across notes + name when `person_ref.embedding` is backfilled.

### `search_email` — read (ILIKE + structured)

```ts
input: {
  query?: string                               // matched against subject + snippet
  sender?: string                              // ILIKE on from_address
  since?: string                               // ISO 8601 sent_at lower bound
  until?: string                               // ISO 8601 upper bound
  is_starred?: boolean
  is_sent?: boolean
  limit?: number = 20
}

effect:
  SELECT id, thread_id, subject, from_address, to_addresses,
         snippet, is_starred, is_sent, sent_at
    FROM email_ref
   WHERE ($query IS NULL OR subject ILIKE '%' || $query || '%' OR snippet ILIKE '%' || $query || '%')
     AND ($sender IS NULL OR from_address ILIKE '%' || $sender || '%')
     AND ($since IS NULL OR sent_at >= $since)
     AND ($until IS NULL OR sent_at <= $until)
     AND ($is_starred IS NULL OR is_starred = $is_starred)
     AND ($is_sent IS NULL OR is_sent = $is_sent)
   ORDER BY sent_at DESC NULLS LAST
   LIMIT $limit;
```

`body_text` is **not** returned to keep responses small. AI client can use a future `get_email_by_id` for full body (deferred).

Future (out of scope): semantic search over subject/body once `email_ref.embedding` is backfilled.

## File layout (additions)

```
mcp-worker/src/tools/
├── search_artifacts.ts           # new
├── get_calendar.ts                # new
├── list_tasks.ts                  # new
├── find_person.ts                 # new
├── search_email.ts                # new
└── registry.ts                    # +5 entries
```

## Tool descriptions for AI clients

Each tool's `description` field follows the phase-1 pattern: it tells the AI when to call the tool, not just what it does. Same constraints (no autonomous saves, etc.) don't apply since all five are read-only.

Suggested triggers (to be reflected in Part 1 of `docs/mcp-behavior-and-dev-norms.md` when each tool ships):

- `search_artifacts` — "what have I written about X", "my notes on Y", "long-form thoughts on Z"
- `get_calendar` — "what's on my calendar", "am I free at 3pm", "next meeting"
- `list_tasks` — "what's on my todo list", "open tasks this week", "anything overdue"
- `find_person` — "who is X", "do I have a contact for Y", whenever a name comes up
- `search_email` — "did anyone email me about X", "find the email from Y", "latest mail from Z"

## Implementation order

1. **`search_artifacts`** — highest value (4k+ semantic-ready records), straightforward chunk → artifact rollup.
2. **`get_calendar`** — mechanical, time-window filter.
3. **`list_tasks`** — mechanical, mirrors existing `getOpenTasks` SQL.
4. **`find_person`** — ILIKE with ranking; trivial.
5. **`search_email`** — ILIKE on subject/snippet + structured filters; last because it has the most filter args.

Each tool: ~50–100 LOC including zod schema. Total ~400 LOC + registry wiring.

## Verification

Per-tool curl tests (against the live worker after deploy):

1. `search_artifacts({ query: "X", limit: 3 })` → 3 hits with `similarity > 0`, each with a `best_chunk` preview.
2. `get_calendar({})` → events in the next 7 days, ordered by `start_at`.
3. `list_tasks({})` → open tasks; spot-check one in Google Tasks UI.
4. `find_person({ query: "<known name>", limit: 5 })` → top result is the matching contact.
5. `search_email({ query: "<known subject term>" })` → emails with subject/snippet matching, ordered newest first.
6. Negative: each tool with missing required field → `Invalid arguments` `isError`.
7. Negative: empty result set → `count: 0` (not an error).

After all 5 pass via curl, re-test from claude.ai with the connector reloaded so it picks up the new tools/list response.

## Open questions for the implementer

- **Artifact rollup**: simplest implementation does chunk-level vector search and dedups by `artifact_id`, taking the best-per-artifact. Worth keeping the chunk metadata (start_offset, end_offset) in the response so the AI can quote it?
- **Calendar default window**: "next 7 days from now" matches list_recent's default. Sane for most queries; if the AI is asked about a past meeting it has to pass `start`/`end` explicitly. OK?
- **Person disambiguation**: when 2.9k contacts contain duplicates (same name, multiple emails), do we collapse or return all? Probably return all (limit guards size).
- **Email body**: skipping `body_text` from list responses is a size decision. Worth a `get_email_by_id` follow-up tool? (Out of scope for this phase but easy to slot in.)

## Out of scope (carried into phase 3+)

- Writes to any 5-W table
- Calls to Google APIs (calendar/tasks creation, sending mail) from the Worker
- Embedding backfills for emails / contacts / tasks / calendar
- Unified cross-table search
- `link_edge` traversal as a standalone tool
- `get_morning_review`
- `get_artifact_by_id`, `get_email_by_id`, `get_event_by_id`, `get_task_by_id` (decide later if the AI actually wants them)

When all five tools are live, the AI side of the brain can answer questions across the full who/when/where/what/why surface — not just the journal.

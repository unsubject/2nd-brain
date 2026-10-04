# Idea Parking Lot Protocol

Executable protocol for any AI agent using the 2nd-brain Idea Parking Lot tools over MCP. Read this before capturing, gardening, mapping or importing. Tool descriptions cite these section numbers. If your client can't read MCP resources, fetch any section with the `read_protocol` tool (`{"name": "idea-parking-lot", "section": "§2"}`).

- **§0** — The model in one page
- **§1** — Librarian capture (`park_idea`)
- **§2** — Gardening: creating associations (`garden_ideas`, `propose_idea_links`, `list_idea_links`, `decide_idea_links`, `create_synthesis`)
- **§3** — The curiosity map (`export_idea_map`)
- **§4** — One-time import (Notion + Google Tasks "Subjects")
- **§5** — Retrieval rituals (pull-only)
- **§6** — Cheat sheet

Design background: `docs/phase-idea-parking-lot-spec.md`.

---

## §0 — The model in one page

**An idea is curated raw material, one stage before work.** It is *not* a task: no due dates, no priorities, no "next steps". Production-level topics live elsewhere (Google Tasks).

**Two kinds of idea:**

- **unit** — one parked idea: when it was captured, where it was encountered, the raw content that inspired it, why it's interesting, and the user's own unfiltered thoughts.
- **synthesis** — several ideas combined into something bigger. Its `intent` says what it is meant to become: `episode | essay | series | learning | undecided`.

**Statuses:** `parked` (default, resting) · `exploring` (actively being developed) · `used` (became part of an output) · `composted` (deliberately let go, kept for history). Status changes only on the user's word.

**Field ownership:**

| Field | Whose words |
|---|---|
| `thoughts` | The user's, **verbatim**. Never paraphrased, summarized, translated or tidied. |
| `why_interesting` | Why it matters — the user's reason in their framing when captured by the Librarian; for imported rows, whatever the source recorded (see `idea_source`). |
| `framing` | AI-written context ("what it is / what it is not"). Never presented as the user's words. |
| `notes` | Dated development log; each note records `by`: `simon` (the user), `agent`, `import` or `system`. |

**Links are made only in gardening.** Capture is one-way. An AI proposes typed links with a one-line rationale; the user accepts or rejects. Only `decide_idea_links` (accept) and `create_synthesis` produce accepted links.

**Link vocabulary:**

| Type | Endpoints | Direction | Meaning |
|---|---|---|---|
| `builds_on` | idea → idea | directed | A extends, refines or depends on B |
| `example_of` | idea → idea | directed | A is a concrete instance of B's general claim |
| `part_of` | idea → synthesis | directed | A is a component of synthesis B |
| `tension_with` | idea ↔ idea | symmetric | A and B pull against or contradict each other |
| `same_mechanism` | idea ↔ idea | symmetric | Same structural mechanism in different domains (analogy, bridge) |
| `combines_with` | idea ↔ idea | symmetric | A and B could fuse into something bigger |
| `related` | idea ↔ idea | symmetric | Fallback — the rationale must say why nothing more specific fits |
| `became` | idea → output | directed | The idea turned into this published essay/episode (`public_artifact`) |
| `revisits` | idea → output | directed | The idea retreads ground an earlier output already covered |

**Link lifecycle:** `proposed → accepted | rejected | withdrawn`, then `accepted → retracted`. `rejected` and `retracted` are the user's negative decisions and are **remembered** — that pair is not re-proposed unless the user asks. `withdrawn` is the agent taking back its own proposal; it is not remembered as a rejection.

**Territory:** an idea with an accepted `became` link is *territory* (it became output); one with only `revisits` is *adjacent*; everything else is *frontier*.

**Pull, not push.** Never surface parked ideas unprompted, in unrelated conversations, or at capture time.

**Similarity guide** (cosine, `text-embedding-3-small`): < 0.30 noise · 0.30–0.45 the analogy zone · > 0.50 close · > 0.90 probably a duplicate. Mixed-language pairs (English vs Chinese on the same topic) score lower than same-language pairs.

---

## §1 — Librarian capture

**Triggers.** The user explicitly asks to park or file an idea: "park this", "park this idea", "add this to my parking lot", "file this idea", "記低呢個 idea", "park 咗佢". The usual shape: they give a link (or describe what they saw), say why they're interested, and say what came to mind.

**Not a trigger:** "save this session" / "log this conversation" → that is `save_session` (the journal), not this tool. If it's unclear which they mean, ask once.

### Step 1 — Gather the fields from what the user already said

| Field | Source |
|---|---|
| `title` | You propose it: short (≤ 12 words), in the language the user used. |
| `source.url`, `source.title`, `source.excerpt` | The link and the raw content that inspired them. If you can open the link, record its title and the passage they're reacting to. The excerpt is the source's own text, not your summary. |
| `encountered_where` | Where or how they encountered it (a book, a podcast, a conversation, a walk…). |
| `why_interesting` | Their stated reason, in their framing. |
| `thoughts` | **Their own words, verbatim.** Keep the language mix, typos and order. Several messages: join them with blank lines. Never translate or tidy. |
| `captured_at` | Omit (defaults to now) unless they say it came earlier ("this was from last Tuesday"). |
| `tags` | Only tags the user states. Never invent tags. |

### Step 2 — Confirm, minimally

Show the proposed title and ask for a yes or a better title. If they gave no reason and no thoughts, you may ask once — "anything in your own words?" — and accept "no". Do not ask anything else: no categories, no projects, no due dates.

### Step 3 — File

Call `park_idea` once per idea, with an `idempotency_key` (any unique string you generate) and `captured_via: {client, model}`. Several ideas → one call each, each with its own confirmed title. The server adds which connection filed it (`captured_via.credential`); don't send that field yourself.

### Step 4 — Receipt only

Reply with the receipt: title, captured time, id, and the fields filed. **Nothing else.** Do not say "this connects to…", do not search for related ideas, do not suggest tags, hubs or next steps. Associations happen only in gardening sessions the user starts (§2).

---

## §2 — Gardening (creating associations)

**Triggers.** The user starts it: "let's garden", "tend my parking lot", "help me connect my ideas", "what goes with what?". Never start gardening yourself, and never propose links outside a session the user started.

### Step 0 — Clear the queue first

Call `list_idea_links()` (defaults to pending proposals). If there are leftovers — from an earlier session or from the import (§4) — present those first (Step 5 format) before pulling new candidates.

### Step 1 — Pick a mode with the user

| Mode | Use it for | Defaults |
|---|---|---|
| `orphans` | New or never-connected ideas, each with its nearest neighbours (newest first; `order: 'oldest'` for the backlog) | similarity ≥ 0.30 |
| `near` | Tightening clusters; spotting duplicates (flagged at ≥ 0.90) | ≥ 0.50 |
| `band` | Cross-domain analogies (`same_mechanism`), tensions | 0.30–0.45 |
| `outputs` | Matching ideas to the user's own published essays/episodes (territory); 40 ideas per page | ≥ 0.45 |

`focus_idea_id` narrows any mode to one idea — and is the way to reach any idea when the lot is large (global `near` / `band` passes cover the most recently updated ideas; the response says so in `scope_note`). `cross_domain: true` keeps only pairs with no tag in common (near / band / orphans). `orphans` and `outputs` page with `offset` — follow `paging.next_offset`.

### Step 2 — Pull candidates

Call `garden_ideas` with `limit` ≤ 15. If `stats.unembedded` > 0, say that recently filed ideas will join once they're embedded (about a minute).

### Step 3 — Judge each candidate

For each pair, ask yourself: is there a specific, defensible relationship? Choose the **most specific** type. Write a one-line rationale that names the shared mechanism, the tension or the dependency — not "both are about economics". Proposing nothing for a pair is fine; proposing nothing at all is fine.

- For `outputs` candidates: the hint `became?` means the output was published after the idea was captured; `revisits?` means the output came first. Judge from the content, not just the hint.
- Directed types (`builds_on`, `example_of`): put the dependent/specific idea as `source_idea_id`.

### Step 4 — Propose

Call `propose_idea_links` with `origin: 'gardening'`. Results `skipped_rejected` mean the user already said no to that pair — drop it silently unless the user asks to revisit (`reconsider_rejected: true` only then).

### Step 5 — Present a numbered list

```
1. Idea A —builds_on→ Idea B: A applies B's mechanism to a new case.
2. Idea C —tension_with— Idea D: C assumes stable preferences; D argues they are constructed.
3. Idea E —became→ "Episode title": the episode develops E's core question.
```

### Step 6 — Record exactly the user's verdicts

Call `decide_idea_links` with only what the user said:

| User says | Decision |
|---|---|
| "yes to 1 and 3" | `accept` |
| "no to 2" | `reject` |
| "4, but as a tension" | `accept` with `link_type: 'tension_with'` |
| "5, but the other way round" | `accept` with `reverse: true` |
| "un-link X and Y" (already accepted) | `retract` |
| nothing about 6 | leave it pending |

If accepting with a new type collides with an older, rejected or withdrawn link of that type for the same pair, the older link is revived as the accepted one and the response names it (`superseded`). Use `withdraw` only to take back your own proposal (e.g. you proposed it by mistake). Never accept or reject on the user's behalf. After an accepted `became`, the response may carry a hint — ask whether to mark the idea `used`; change status only if they say so (`update_idea`).

### Syntheses (combining ideas into something bigger)

When the user decides to combine ideas — "these three are an episode" — confirm the title, the intent (`episode | essay | series | learning | undecided`) and the parts, then call `create_synthesis`. Put any words the user says about it in `thoughts`, verbatim. A synthesis with `intent: 'episode'` is the seed to take into episode preparation when the user asks.

### Duplicates

A pair flagged `possible_duplicate` (≥ 0.90): ask the user which to keep. Compost the other with `update_idea(status: 'composted', append_note: {by: 'agent', text: 'Duplicate of <kept title>'})`. There is no merge or delete tool.

---

## §3 — The curiosity map

**Triggers.** The user asks to see their map, graph or "mindmap" of ideas. Read-only — never write anything during a map request.

### Pick a format for your rendering tool

| Format | When |
|---|---|
| `json` (default) | You can render a graph yourself (an HTML/JS page, a notebook, a graph library). `idea-map/v1`: nodes, edges, stats, legend. |
| `graphml` | The user wants Gephi, yEd or Cytoscape. |
| `mermaid` | Chat-only rendering. Capped at 150 nodes. |

For `graphml` and `mermaid` the result has two text blocks: a JSON header (stats, legend), then the raw graph text.

### Recipes

| Ask | Call |
|---|---|
| "Show me everything" | `export_idea_map()` |
| "Show me what's around idea X" | `export_idea_map(focus_idea_id: X, depth: 2)` |
| "Only recent material" | `export_idea_map(since: <date>)` |
| "Include what you've proposed" | `export_idea_map(include_pending: true)` — draw proposed edges dashed |
| "Just the ideas, no outputs" | `export_idea_map(include_outputs: false)` |
| "Only connected ideas" | `export_idea_map(include_isolated: false)` |

### Rendering conventions (suggested, not required)

Colour ideas by `territory` (frontier / adjacent / territory); give `output` nodes (published essays/episodes) their own shape; size nodes by `degree`; group by `component`; draw `status: proposed` edges dashed; label edges with their `type`; grey out `composted` ideas if the user includes them.

### Reading the map (only when the user asks for help choosing a direction)

- Large **frontier** components: curiosity has gathered there without producing output yet.
- **Bridges** (`same_mechanism`, `combines_with` edges between components): candidate cross-domain episodes.
- **Orphans**: material that hasn't found its place — a good gardening target.
- Components next to **territory**: directions that extend work already published.

Offer these as observations; the user decides the direction.

---

## §4 — One-time import (Notion + Google Tasks "Subjects")

**Triggers.** The user explicitly starts the import and provides the Notion export (CSV). Run it once; it is idempotent, so a re-run reports `already_imported` and changes nothing.

**Privacy.** Never copy idea content into a repository, issue, pull request or public place. The data goes only through the MCP tools.

### Step 0 — Ask once

1. Which timezone the Notion workspace displayed dates in → pass the IANA name as `timezone` (e.g. `"Europe/London"`, `"Asia/Hong_Kong"`), which handles daylight-saving changes. Use `default_utc_offset` only if the user can't name a zone.
2. What completed Google Tasks items mean to them (default: import them, tagged `gtasks:completed`).

### Pass 1 — Notion rows → `import_ideas(source_system: 'notion')`

Batches of up to 25. One item per CSV row:

| Notion column | Goes to | Rule |
|---|---|---|
| (row key) | `source_external_id` | `"<Added verbatim>\|<Idea verbatim>"` |
| Idea | `title` | verbatim |
| Added | `captured_at` | the verbatim string; the server parses `"Month D, YYYY h:mm AM/PM"` in `timezone` |
| Horizon | `status` / `tags` | `Done` → `status: 'used'`; `Time Sensitive` → tag `time-sensitive`; `Evergreen` → nothing |
| Source / Trigger | `encountered_where` | verbatim; also `source_url` = the first http(s) URL that is not a Notion link |
| What is it? + What it is NOT | `framing` | `"<What is it?>\n\nWhat it is NOT: <What it is NOT>"` (omit empty parts) |
| Why it matters | `why_interesting` | verbatim |
| Related Project + Notes | `notes_raw` | `"Related Project: <verbatim>\n\n<Notes verbatim>"` (omit empty parts). The server splits Notes into dated notes on `[YYYY-MM-DD]` markers that start a line; anything else stays verbatim |
| Related Project | `tags` | if the value is a short channel/series name (≤ 52 chars, not a sentence): tag `project:<value>` (tags are capped at 60 chars). Longer values live only in the note |
| Next Step, Priority | — | `import_payload` only (ideas have no task fields) |
| whole row | `import_payload` | all columns as exact strings, including empty ones |

Do not put anything in `thoughts` for Notion rows unless a column is clearly the user's own unedited words. Items are validated one by one; an item that fails comes back with `result: 'error'` and its reason — fix and resend just that item (re-sending the others is harmless: they report `already_imported`).

### Pass 2 — Google Tasks "Subjects" → `import_ideas(source_system: 'gtasks_subjects')`

1. Wait until `list_ideas(source_system: 'notion')` shows the Notion rows with `embedded: true` (about a minute), so `search_ideas` can find semantic duplicates.
2. Page through `list_subjects_for_import()` following `next_offset` (paging over the full list is stable; `only_not_imported: true` shrinks as you import, so use it only for a final check). Skip tasks that are `already_imported`.
3. Tasks with `stale: true` were not in Google's latest sync — usually deleted or moved by the user. List them for the user and import only the ones they want.
4. For each remaining task:
   - `possible_duplicates` has an entry with `match: 'exact'` whose `source_systems` includes `notion` → **merge**: `merge_into_idea_id` = that idea.
   - `match: 'contains'` entries, and `search_ideas(query: <title + notes>)` hits with similarity ≥ 0.85 → put them in **one** confirmation table for the user (task title | candidate idea title | merge? y/n). Merge the ones they confirm.
   - Otherwise **create**.
5. Item mapping: `source_external_id` = `external_task_id`; `title` verbatim; task notes → `thoughts` verbatim (they are the user's own words); `captured_at` = `first_synced_at` (approximate — Google Tasks has no creation date); `encountered_where` = `"Google Tasks: Subjects list"`; completed top-level tasks get tag `gtasks:completed` unless the user said otherwise; `due_at` goes to `import_payload` only; `import_payload` = the task object as listed.
6. Subtasks (`parent_external_task_id` set): merge into the parent's idea (each subtask keeps its own source row). Send no status tags on these merges — the subtask's state stays in its `import_payload`.
7. Never merge two Notion rows with each other.

### Pass 3 — Cross-references → proposals only

Notion's Related Project and Notes columns often name other rows ("part 2 of …", "related to … entry", "connects to …", "absorbed into …"). Turn each resolvable reference into a **proposal** — never an accepted link:

1. Resolve the referenced title with `search_ideas` / `list_ideas`. If it can't be resolved confidently, leave it as a note; never guess.
2. Pick a type: series parts or "pair with" → `combines_with` (and mention a series synthesis in the next gardening session); extends/deepens → `builds_on`; contrast → `tension_with`; instance → `example_of`; "absorbed into <series>" with an output found via `archive_search_text` → `became`; `related` only as a last resort.
3. Call `propose_idea_links(origin: 'import')` with rationale `Notion <column>: "<quote ≤ 200 chars>"` (single line).

### Step 4 — Report

Counts by `source_system` (created / merged / already_imported / errors), the number of pending import proposals, and anything left as notes. Then tell the user the import is complete and they can retire the Google Tasks "Subjects" list themselves; the first gardening session will start with the import proposals (§2 Step 0).

---

## §5 — Retrieval rituals (pull-only)

Everything here happens only when the user asks.

| The user asks | Do |
|---|---|
| "What's in my parking lot?" | `list_ideas()` |
| "Anything parked about X?" | `search_ideas(query: X)` |
| "What did I park this week/month?" | `list_ideas(since: <date>)` |
| "Show me the frontier" | `list_ideas(territory: 'frontier')` |
| "What became output?" | `list_ideas(territory: 'territory')` |
| "What hasn't found a home?" | `list_ideas(unlinked: true)` — or a gardening session in `orphans` mode |
| "Tell me about idea X" | `get_idea(id)` |
| "What could be my next episode?" | `list_ideas(kind: 'synthesis')`, then `get_idea` on the candidates; offer to garden if nothing fits |
| "Show me the map" | §3 |
| "I'm done with this one" | confirm, then `update_idea(status: 'composted')` |

**Natural moments to pull** (the user's choice, never a reminder from you): before choosing the next episode or essay; a periodic gardening session; when closing a cycle on an undertaking under the Mind domain; when starting a learning plan.

---

## §6 — Cheat sheet

| Situation | Tool |
|---|---|
| "Park this idea" | §1 → `park_idea` |
| "Save this session" | `save_session` (journal), not `park_idea` |
| Fix or extend an idea; change status; add a note | `update_idea` |
| Look up ideas | `list_ideas`, `search_ideas`, `get_idea` |
| "Let's garden" | §2 → `list_idea_links` → `garden_ideas` → `propose_idea_links` → user decides → `decide_idea_links` |
| "Combine these into an episode" | `create_synthesis` |
| "Show me my idea map" | §3 → `export_idea_map` |
| One-time Notion / Subjects import | §4 → `import_ideas`, `list_subjects_for_import`, `propose_idea_links(origin: 'import')` |

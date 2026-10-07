# Idea Garden Protocol (Idea Parking Lot)

Executable protocol for any AI agent using the 2nd-brain Idea Garden tools over MCP. The Idea Garden was called the Idea Parking Lot; this protocol's name (`idea-parking-lot`) and its resource URI keep the old name. Read this before capturing, gardening or reviewing, mapping or importing. Tool descriptions cite these section numbers. If your client can't read MCP resources, fetch any section with the `read_protocol` tool (`{"name": "idea-parking-lot", "section": "§2"}`).

- **§0** — The model in one page (link types and their labels, the inbox, promotion)
- **§1** — Librarian capture (`park_idea`, then up to 3 link proposals)
- **§2** — Gardening and the weekly garden review (`garden_ideas`, `propose_idea_links`, `list_idea_links`, `decide_idea_links`, `create_synthesis`, `update_idea`)
- **§3** — The curiosity map (`export_idea_map`, the interactive HTML page)
- **§4** — One-time import (Notion + Google Tasks "Subjects")
- **§5** — Retrieval rituals (pull-only: `explore_topic`, `list_ideas`, `search_ideas`, `get_idea`)
- **§6** — Cheat sheet

Design background: `docs/phase-idea-parking-lot-spec.md` and the decision record `docs/decisions/2026-10-05-refocus.md`.

---

## §0 — The model in one page

**An idea is curated raw material, one stage before work.** It is *not* a task: no due dates, no priorities, no "next steps". Production-level topics live in the user's Google Tasks "Subjects" list (see **Promotion** below).

**Two kinds of idea:**

- **unit** — one parked idea: when it was captured, where it was encountered, the raw content that inspired it, why it's interesting, and the user's own unfiltered thoughts.
- **synthesis** — several ideas combined into something bigger. Its `intent` says what it is meant to become: `episode | essay | series | learning | undecided`.

**Statuses:** `parked` (default, resting) · `exploring` (actively being developed) · `used` (became part of an output) · `composted` (deliberately let go, kept for history). Status changes only on the user's word. Recording a promotion the user made also moves a `parked` or `composted` idea to `exploring` (see **Promotion**).

**Field ownership:**

| Field | Whose words |
|---|---|
| `thoughts` | The user's, **verbatim**. Never paraphrased, summarized, translated or tidied. |
| `why_interesting` | Why it matters — the user's reason in their framing when captured by the Librarian; for imported rows, whatever the source recorded (see `idea_source`). |
| `framing` | AI-written context ("what it is / what it is not"). Never presented as the user's words. |
| `notes` | Dated development log; each note records `by`: `simon` (the user), `agent`, `import` or `system`, and the server adds `credential` (which connection wrote it). |

**The inbox.** An idea is *in the inbox* until a garden review has handled it: its `reviewed_at` is empty and it is not composted. Every newly parked or imported idea starts there. So did every idea that existed before the inbox was added, so the first weekly review walks the whole garden (§2). A synthesis skips the inbox: it is made during a session. An idea leaves the inbox when the user has been through it in a review and you mark it reviewed (`decide_idea_links` with `mark_reviewed`, or `update_idea(reviewed: true)`); `update_idea(reviewed: false)` puts it back. Composted ideas never wait in the inbox. Every idea read (`get_idea`, `list_ideas`) shows `inbox: true | false`.

**Promotion.** When an idea is episode-shaped, the user may promote it to their Google Tasks "Subjects" list, the production shortlist (Garden → Subjects → Projects → Shipped). The user or Muse writes the Google Task; 2nd-brain never writes Google Tasks. 2nd-brain only records the promotion: when the user says they promoted an idea (or asks you to record it), call `update_idea(id, promoted: {title: <the task title used>, at?: <when, if not now>})`. Recording it:

- moves a `parked` or `composted` idea to `exploring`; `exploring` and `used` stay as they are, and an explicit `status` in the same call wins;
- takes the idea out of the inbox (an earlier review time is kept);
- adds a `system` note (`promoted to Subjects as "<title>"`).

`at` may not be in the future. `promoted: null` clears a promotion recorded by mistake. Reads show `promoted: {at, title}` or `null`; `list_ideas(promoted: true)` lists the promoted ideas.

**Links are proposed, then decided.** An AI proposes typed links, each with a one-line **gloss**: the gloss is stored in the `rationale` field (the same thing under two names). The user accepts or rejects. Proposals come from three places: right after a capture (§1, at most 3, `origin: 'capture'`), gardening and the weekly garden review (§2, `origin: 'gardening'`), and the import (§4, `origin: 'import'`). Only `decide_idea_links` (accept) and `create_synthesis` produce accepted links. Nothing is linked without the user's yes.

**Link vocabulary.** The stored type names never change, and no existing link is renamed. Show the user the **label**. Read every link source → target.

| Type (stored) | Label (show this) | Endpoints | Direction | Meaning |
|---|---|---|---|---|
| `builds_on` | extends | idea → idea | directed | A extends, refines or depends on B |
| `example_of` | example-of | idea → idea | directed | A is a concrete instance of B's general claim |
| `mechanism_for` | mechanism-for | idea → idea | directed | A explains why B happens (A is the mechanism, B the phenomenon) |
| `part_of` | part-of | idea → synthesis | directed | A is a component of synthesis B |
| `tension_with` | contradicts | idea ↔ idea | symmetric | A and B pull against or contradict each other |
| `same_mechanism` | rhymes-with | idea ↔ idea | symmetric | Same structural mechanism in different domains (analogy, bridge) |
| `inverts` | inverts | idea ↔ idea | symmetric | Each is the other with the causality flipped |
| `combines_with` | combines-with | idea ↔ idea | symmetric | A and B could fuse into something bigger |
| `related` | related | idea ↔ idea | symmetric | Fallback — the rationale must say why nothing more specific fits |
| `became` | became | idea → output | directed | The idea turned into this published essay/episode (`public_artifact`) |
| `revisits` | revisits | idea → output | directed | The idea retreads ground an earlier output already covered |

**Direction rules.**

- `builds_on`, `example_of`: the source is the dependent or specific idea.
- `mechanism_for`: the source is the mechanism; the target is what it explains.
- `part_of`: the source is the part; the target must be a synthesis.
- Symmetric types, `inverts` included, have no direction. The server stores each pair once, so either order is fine.
- Tools return each link's `label` next to its `link_type`. When the user names a label ("make it a contradiction"), send the stored name (`tension_with`).

**Link lifecycle:** `proposed → accepted | rejected | withdrawn`, then `accepted → retracted`. `rejected` and `retracted` are the user's negative decisions and are **remembered** — that pair is not re-proposed unless the user asks. `withdrawn` is the agent taking back its own proposal; it is not remembered as a rejection. Composting an idea withdraws its pending proposals; its accepted links stay.

**Territory:** an idea with an accepted `became` link is *territory* (it became output); one with only `revisits` is *adjacent*; everything else is *frontier*.

**Pull, not push.** Never surface ideas unprompted or in unrelated conversations. The one time you bring up other ideas without being asked is the up-to-3 link proposals right after a capture the user asked for (§1). The weekly garden review is started by the user. Muse may hold a reminder the user set; 2nd-brain itself never reminds or schedules.

**Similarity guide** (cosine, `text-embedding-3-small`): < 0.30 noise · 0.30–0.45 the analogy zone · > 0.50 close · > 0.90 probably a duplicate. Mixed-language pairs (English vs Chinese on the same topic) score lower than same-language pairs.

---

## §1 — Librarian capture

**Triggers.** The user explicitly asks to park or file an idea: "park this", "park this idea", "add this to my parking lot", "add this to my garden", "file this idea", "記低呢個 idea", "park 咗佢". The usual shape: they give a link (or describe what they saw), say why they're interested, and say what came to mind.

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

### Step 4 — The receipt comes first

Start the reply with the receipt: title, captured time, id, and the fields filed. Do not search for related ideas yourself, and do not suggest tags, hubs or next steps.

### Step 5 — Up to 3 link proposals, only from `link_candidates`

`park_idea` returns `link_candidates`: up to 5 live ideas nearest to the new one (similarity ≥ 0.30, nearest first), each with `id`, `title`, `kind`, `status`, `similarity` and a `snippet`. They are candidates, not links.

If one or more of them genuinely connects with the new idea — a specific relationship you can defend in one line — draft up to 3 typed proposals and save them in **one** `propose_idea_links` call:

- `origin: 'capture'`, at most 3 links;
- idea to idea only: every link is between the new idea and a candidate (no `became` or `revisits`, no outputs);
- `part_of` only when the candidate is a synthesis (`kind: 'synthesis'`): the new idea is part of it;
- the most specific type, with the direction rules of §0, and the candidate's `similarity`;
- a one-line gloss (`rationale`) naming the specific mechanism, tension or dependency, not "both are about economics";
- no tag suggestions.

Then show the saved proposals after the receipt, in the same reply, numbered, with their display labels. A synthetic example:

```
Parked "Queues as a hidden price" (7 Oct 2026, 09:12, id 0f3c2a9e-5b7d-4c1e-9a6f-2d8b4e7c1a03). Filed: title, thoughts, source, why it's interesting.

Possible links (nothing is linked until you say yes):
1. Queues as a hidden price —extends→ Rationing without money: applies the same rationing logic to restaurant waits.
2. Queues as a hidden price —contradicts— Free is always fair: one says waiting costs the poor more, the other assumes free means equal.
```

- **No proposal fits:** propose nothing. If `link_candidates` is empty (nothing close yet, a retry, or a warning that candidates were unavailable), the reply is the receipt only.
- **The user answers** ("yes to 1", "2, but the other way round"): record exactly their verdicts with `decide_idea_links` (the verdict table in §2). Don't press for an answer.
- **The user ignores them:** they stay pending, and the weekly garden review shows them (§2, Step 0).
- **`skipped_rejected`** in the result means the user already said no to that pair: drop it silently.
- **A retry** (`deduplicated: true`) returns no candidates; proposals saved after the first capture are still pending (`list_idea_links(idea_id)`).
- **Test captures** titled `[smoke] …` get no proposals.

---

## §2 — Gardening (creating associations) and the weekly garden review

Two kinds of session, both started by the user:

- **The weekly garden review** — the trust mechanic: nothing sits unprocessed for long. Weekly, on the day the user picks. The reminder lives in Muse, set by the user; 2nd-brain never schedules or reminds. Triggers: "weekly review", "garden review", "let's review the garden", "go through my inbox".
- **A free gardening session** — "let's garden", "tend my garden", "help me connect my ideas", "what goes with what?".

Never start either yourself, and never propose links outside a session the user started (the only exception is the capture proposals in §1).

### The weekly garden review

**Step 0 — Pending proposals first.** Call `garden_ideas(mode: 'inbox')`. Each inbox idea comes with its `pending` proposals, capture leftovers included, each with `label`, `direction`, the gloss (`rationale`) and the other idea. Proposals on ideas that have already left the inbox are not attached there: call `list_idea_links()` too (it defaults to pending proposals; `proposed_by: 'capture'` narrows it to capture leftovers). Present the pending proposals first ("Presenting proposals" below) and record the user's verdicts ("Recording the user's verdicts"). Proposals they still don't answer stay pending.

`list_idea_links` can also show a leftover pending proposal with a composted idea at one end (`source.status` or `target.status` is `composted`). Don't present it; withdraw it (`decide_idea_links`, `withdraw`) with the next verdicts you record. New proposals to a composted idea are refused (a per-link error) until the user revives it.

**Step 1 — The inbox, oldest first.** `garden_ideas(mode: 'inbox')` returns up to 8 inbox ideas per page (`limit` up to 30), oldest captured first (`order: 'newest'` reverses it), with `paging.total_inbox` and `paging.next_offset`. Tell the user how many ideas are waiting. Each idea also comes with:

- `neighbours`: up to 3 nearest live ideas it has no link or proposal with yet. An idea filed in the last minute or so has none yet (`embedded: false`).
- `pending`: its pending proposals (Step 0).

Paging: an idea leaves the inbox when it is marked reviewed, composted or promoted, and the ideas after it move up. For the next page, call again with `offset` = `next_offset` minus the number of ideas on this page that left the inbox: the same `offset` again if every idea on the page left, `next_offset` itself if the user left them all for another week. `focus_idea_id` reaches one idea; `cross_domain: true` keeps only neighbours with no tag in common.

**Step 2 — The linking pass.** Go through the page with the user, one idea at a time:

- judge its neighbours ("Judging a candidate" below) and propose any defensible typed links with `propose_idea_links(origin: 'gardening')`;
- for wider candidates on the same idea, use a gardening mode with `focus_idea_id` (table below);
- the user may also decide other things: compost it, record a promotion (§0), add a note, combine ideas into a synthesis.

Proposing nothing for an idea is fine. Being reviewed doesn't require a link.

**Step 3 — Decisions.** Present the proposals and record exactly the user's verdicts with `decide_idea_links` ("Recording the user's verdicts" below). Leave anything they don't answer pending.

**Step 4 — Mark reviewed.** When the user has been through an idea, whether or not anything was linked, mark it reviewed so it leaves the inbox:

- `decide_idea_links(mark_reviewed: [ids])` — in the same call as the verdicts or on its own, up to 200 ids. The decisions run first. Unknown ids come back in `reviewed.not_found`.
- `update_idea(id, reviewed: true)` for a single idea.

Mark only the ideas the user has actually been through. Ideas they skip stay in the inbox for next week.

**Composting during a review.** `update_idea(status: 'composted')` withdraws the idea's pending proposals (the response's `withdrawn_proposals` says how many), keeps its accepted links, and takes it out of the inbox while it stays composted. Composting does not mark it reviewed: if the user later revives an idea that was never reviewed, it is back in the inbox.

**A large first review.** Every idea that existed before the inbox was added starts in it, and the Notion import (§4) adds about 70 more. Don't try to clear it in one sitting. Page through oldest first, a few ideas per session (one page of 8 is plenty), and stop when the user wants to stop. Ideas not reached simply wait for the next session. Give the user the count (`paging.total_inbox`) so they can pace it.

### Free gardening

**Step 0 — Clear the queue first.** Call `list_idea_links()` (defaults to pending proposals; each link shows `proposed_by`, `proposed_via` and, once decided, `decided_via`, i.e. which connection proposed or recorded it). If there are leftovers — from capture, an earlier session or the import (§4) — present those first before pulling new candidates.

**Step 1 — Pick a mode with the user.**

| Mode | Use it for | Defaults |
|---|---|---|
| `inbox` | The garden review queue (above): ideas no review has handled, oldest first, each with neighbours and pending proposals; 8 per page | neighbours ≥ 0.30 |
| `orphans` | Ideas with no accepted links, reviewed or not, each with its nearest neighbours (newest first; `order: 'oldest'` for the backlog) | similarity ≥ 0.30 |
| `near` | Tightening clusters; spotting duplicates (flagged at ≥ 0.90) | ≥ 0.50 |
| `band` | Cross-domain analogies (`same_mechanism`, rhymes-with), tensions, inversions | 0.30–0.45 |
| `outputs` | Matching ideas to the user's own published essays/episodes (territory); 40 ideas per page | ≥ 0.45 |

`focus_idea_id` narrows any mode to one idea — and is the way to reach any idea when the garden is large (global `near` / `band` passes cover the most recently updated ideas; the response says so in `scope_note`). `cross_domain: true` keeps only pairs with no tag in common (near / band / orphans / inbox). `orphans`, `outputs` and `inbox` page with `offset`. Ideas leave these lists as you work (an inbox idea when marked reviewed, composted or promoted; an orphan when a link to it is accepted; an `outputs` idea when its `became` is accepted), and later ideas move up. So call again with `offset` = `paging.next_offset` minus the number of ideas on the page that left the list (see the weekly garden review, Step 1).

**Step 2 — Pull candidates.** Call `garden_ideas` with `limit` ≤ 15. If `stats.unembedded` > 0, say that recently filed ideas will join once they're embedded (about a minute).

**Step 3 — Judge each candidate** (below).

**Step 4 — Propose.** Call `propose_idea_links` with `origin: 'gardening'` (up to 20 links). Results `skipped_rejected` mean the user already said no to that pair — drop it silently unless the user asks to revisit (`reconsider_rejected: true` only then).

**Step 5 — Present a numbered list** (below).

**Step 6 — Record exactly the user's verdicts** (below). If this session was a review of particular ideas, mark them reviewed too (`mark_reviewed`).

### Judging a candidate

For each pair, ask yourself: is there a specific, defensible relationship? Choose the **most specific** type. Write a one-line gloss that names the shared mechanism, the tension or the dependency — not "both are about economics". Proposing nothing for a pair is fine; proposing nothing at all is fine.

- Follow the direction rules in §0: the dependent or specific idea is the source of `builds_on` and `example_of`; the mechanism is the source of `mechanism_for`.
- For `outputs` candidates: the hint `became?` means the output was published after the idea was captured; `revisits?` means the output came first. Judge from the content, not just the hint.

### Presenting proposals

A numbered list, one line each, with the display label, an arrow for directed types, and the gloss:

```
1. Idea A —extends→ Idea B: A applies B's mechanism to a new case.
2. Idea C —contradicts— Idea D: C assumes stable preferences; D argues they are constructed.
3. Idea E —mechanism-for→ Idea F: E's feedback loop is why F's prices overshoot.
4. Idea G —became→ "Episode title": the episode develops G's core question.
```

### Recording the user's verdicts

Call `decide_idea_links` with only what the user said:

| User says | Decision |
|---|---|
| "yes to 1 and 3" | `accept` |
| "no to 2" | `reject` |
| "4, but as a contradiction" | `accept` with `link_type: 'tension_with'` |
| "5, but the other way round" | `accept` with `reverse: true` |
| "6, but say it as '<their words>'" | reword it (below): `withdraw`, propose again with their words as the gloss, then `accept` |
| "un-link X and Y" (already accepted) | `retract` |
| nothing about 7 | leave it pending |

If accepting with a new type collides with an older, rejected or withdrawn link of that type for the same pair, the older link is revived as the accepted one and the response names it (`superseded`). Use `withdraw` only to take back your own proposal (e.g. you proposed it by mistake, it is a leftover on a composted idea, or the user reworded its gloss). Never accept or reject on the user's behalf. After an accepted `became`, the response may carry a hint — ask whether to mark the idea `used`; change status only if they say so (`update_idea`).

**Rewording a gloss.** `decide_idea_links` can't change a gloss, and its `note` is a decision note, not the gloss: never put the user's wording only there. To use their words:

1. `decide_idea_links`: `withdraw` your proposal.
2. `propose_idea_links` for the same pair, with the type and direction the user wants and their words as `rationale` (origin `capture` right after a capture, otherwise `gardening`). With the same type it comes back `reopened`, with the same `link_id`.
3. `decide_idea_links`: `accept` the `link_id` that result returned.

### Syntheses (combining ideas into something bigger)

When the user decides to combine ideas — "these three are an episode" — confirm the title, the intent (`episode | essay | series | learning | undecided`) and the parts, then call `create_synthesis`. Put any words the user says about it in `thoughts`, verbatim. A synthesis is already reviewed, so it skips the inbox. A synthesis with `intent: 'episode'` is the seed to take into episode preparation when the user asks.

### Duplicates

A pair flagged `possible_duplicate` (≥ 0.90): ask the user which to keep. Compost the other with `update_idea(status: 'composted', append_note: {by: 'agent', text: 'Duplicate of <kept title>'})`. There is no merge or delete tool.

---

## §3 — The curiosity map

**Triggers.** The user asks to see their map, graph or "mindmap" of ideas, or wants a journey review ("how has my thinking moved since spring?"). Read-only — never write anything during a map request.

### The default: an interactive HTML page

Call `export_idea_map(format: 'html')` and hand the page over as a file. The result has two text blocks:

1. JSON meta: `stats` (nodes, edges, components, orphans), `truncated`, `omitted_count`, `filename` (`idea-map-YYYY-MM-DD.html`), `bytes`, `note`, and a `warning` when the page is over about 75 KB.
2. The page itself.

Save the second block **unchanged** as `filename`, then check that the saved file is exactly `bytes` bytes. If it is, give it to the user as a file. If it isn't, the page arrived cut off (some clients cut tool results off near 25k tokens): call again with a smaller map — a lower `max_nodes`, `focus_idea_id` + `depth`, or `since` — and tell the user what the smaller map covers. A `warning` only says the page is large; a complete garden map often carries one. Retry only when the size check fails. Don't render, rewrite or summarise the page in place of the file.

`max_nodes` defaults to 150 for html (300 for the other formats). A cut map keeps the most-linked ideas and their published outputs, and leaves out loose ideas first. When `truncated` is true, tell the user how many nodes were left out (`omitted_count`) and offer a smaller map: `include_isolated: false`, `since`, or `focus_idea_id` + `depth`. The result has no embedded MCP resource: the page is the second text block and nothing else.

What the page shows, so you can explain it:

- ideas coloured by cluster: communities inside a connected group, found by link density (Louvain), so one connected group can hold several clusters. Each cluster of two or more ideas is named after its most-linked idea; the first eight get colours, the rest and loose ideas are grey. (`explore_topic`'s clusters are different: there, a cluster is a whole connected group.)
- each link's display label and gloss on hover or tap; tapping an idea shows its details and links;
- a legend of clusters and link types;
- an as-of slider with Play, which replays the garden over time — ideas appear when captured, links when accepted — for journey reviews;
- a mark on inbox ideas and a star on promoted ones;
- only published outputs (essays and episodes); unpublished ones and their links are left out.

The page works offline in any browser: it loads nothing from the network.

### Other formats

| Format | When |
|---|---|
| `json` (default) | You render a graph yourself (a notebook, a graph library). `idea-map/v1`: nodes (degree, component, cluster, territory, inbox, promotion), typed edges (type, display `label`, `rationale`, timestamps), named `clusters`, stats, legend. |
| `graphml` | The user wants Gephi, yEd or Cytoscape. |
| `mermaid` | Chat-only rendering. Capped at 150 nodes. |

For `graphml` and `mermaid` the result has two text blocks: a JSON header (stats, legend), then the raw graph text. Unlike html, these three formats include outputs of any status.

### Recipes

| Ask | Call |
|---|---|
| "Show me everything" | `export_idea_map(format: 'html')`; if `truncated`, say how many nodes were left out |
| "Show me what's around idea X" | `export_idea_map(format: 'html', focus_idea_id: X, depth: 2)` |
| "Only recent material" | `export_idea_map(format: 'html', since: <ISO date-time with offset, e.g. 2026-09-01T00:00:00Z>)` |
| "How has my thinking moved?" (journey review) | `export_idea_map(format: 'html')`; point the user to the as-of slider |
| "Include what you've proposed" | `include_pending: true` — proposed links are drawn dashed |
| "Just the ideas, no outputs" | `include_outputs: false` |
| "Only connected ideas" | `include_isolated: false` |

### Rendering conventions for json (suggested, not required)

Colour ideas by `cluster` (or by `territory`: frontier / adjacent / territory); give `output` nodes (published essays/episodes) their own shape; size nodes by `degree`; draw `status: proposed` edges dashed; label edges with their `label` and show the `rationale` as the gloss; grey out `composted` ideas if the user includes them.

### Reading the map (only when the user asks for help choosing a direction)

- Large **frontier** clusters: curiosity has gathered there without producing output yet.
- **Bridges** (`same_mechanism` rhymes-with and `combines_with` edges between clusters): candidate cross-domain episodes.
- **Tensions and inversions** (`tension_with` contradicts, `inverts`): arguments waiting to be had.
- **Orphans**: material that hasn't found its place — a good gardening target.
- Clusters next to **territory**: directions that extend work already published.

Offer these as observations; the user decides the direction.

---

## §4 — One-time import (Notion + Google Tasks "Subjects")

**Triggers.** The user explicitly starts the import and provides the Notion export (CSV). It runs in two parts: the Notion part (Pass 1, then Pass 3) now, and the Subjects pass (Pass 2) in a later release. Run each part once; both are idempotent, so a re-run reports `already_imported` and changes nothing.

**Privacy.** Never copy idea content into a repository, issue, pull request or public place. The data goes only through the MCP tools.

**Where imported ideas land.** Every imported idea starts in the inbox (§0) and waits for the weekly garden review. The import's link proposals (Pass 3) appear in the review's Step 0.

**Subjects items are imported and recorded as promoted.** The "Subjects" list stays: it is the production shortlist the garden promotes into (§0, Promotion). So each Subjects item is imported *and* recorded as promoted. The import code that records those promotions is not built yet; it comes in a later release, and the Subjects pass also waits for updated legal pages. Until this section says how, run Pass 1 and Pass 3, and do not run Pass 2.

### Step 0 — Ask once

1. Which timezone the Notion workspace displayed dates in → pass the IANA name as `timezone` (e.g. `"Europe/London"`, `"Asia/Hong_Kong"`), which handles daylight-saving changes. Use `default_utc_offset` only if the user can't name a zone.
2. For Pass 2, once it is available: what completed Google Tasks items mean to them (default: import them, tagged `gtasks:completed`).

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

**Not yet: this pass waits for the release that records Subjects items as promoted (see the top of §4).** The steps below describe the parts that exist today.

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
2. Pick a type: series parts or "pair with" → `combines_with` (and mention a series synthesis in the next garden review); extends/deepens → `builds_on`; contrast → `tension_with`; instance → `example_of`; explains why → `mechanism_for`; "absorbed into <series>" with an output found via `archive_search_text` → `became`; `related` only as a last resort.
3. Call `propose_idea_links(origin: 'import')` with rationale `Notion <column>: "<quote ≤ 200 chars>"` (single line).

### Step 4 — Report

Counts by `source_system` (created / merged / already_imported / errors), the number of pending import proposals, and anything left as notes. Then tell the user the Notion part is done: the imported ideas are in the inbox, the next weekly garden review starts with the import proposals (§2, Step 0), and the Subjects pass follows in a later release. Don't call the import complete until Pass 2 has run.

---

## §5 — Retrieval rituals (pull-only)

Everything here happens only when the user asks.

| The user asks | Do |
|---|---|
| "What do I have on X?" / planning an episode or essay | `explore_topic(query: X)`. Present the clusters with their glosses (`source —label→ target: gloss`) and the outputs they became or revisit, not a flat list. `depth: 2` reaches further; `include_pending: true` adds proposed links. |
| "Have I thought about X?" | That is the journal: `search_brain`. If they mean their ideas, offer `explore_topic`. |
| "Anything parked about X?" | `search_ideas(query: X)` — flat hits, composted ideas included |
| "What's in my garden?" | `list_ideas()` |
| "What's waiting in my inbox?" | `list_ideas(inbox: true)` — or start the weekly garden review (§2) |
| "What have I promoted to Subjects?" | `list_ideas(promoted: true)` |
| "I promoted X to Subjects" | record it: `update_idea(id, promoted: {title})` (§0) |
| "What did I park this week/month?" | `list_ideas(since: <ISO date-time with offset, e.g. 2026-09-01T00:00:00Z>)` — a plain date is refused |
| "Show me the frontier" | `list_ideas(territory: 'frontier')` |
| "What became output?" | `list_ideas(territory: 'territory')` |
| "What hasn't found a home?" | `list_ideas(unlinked: true)` — or a gardening session in `orphans` mode |
| "Tell me about idea X" | `get_idea(id)` |
| "What could be my next episode?" | `explore_topic` on the themes they name; `list_ideas(kind: 'synthesis')`, then `get_idea` on the candidates; offer to garden if nothing fits |
| "Show me the map" | §3: `export_idea_map(format: 'html')` |
| "How has my thinking moved?" (journey review) | §3: the HTML map's as-of slider; `since` for a period |
| "I'm done with this one" | confirm, then `update_idea(status: 'composted')` (its pending proposals are withdrawn) |

**Natural moments to pull** (the user's choice, never a reminder from you): the weekly garden review (§2); before choosing the next episode or essay (`explore_topic`); when starting a learning plan.

---

## §6 — Cheat sheet

| Situation | Tool |
|---|---|
| "Park this idea" | §1 → `park_idea` → receipt first → up to 3 proposals from `link_candidates` with `propose_idea_links(origin: 'capture')` |
| The user answers capture proposals | `decide_idea_links` with exactly their verdicts |
| "Save this session" | `save_session` (journal), not `park_idea` |
| "Weekly review" / "go through my inbox" | §2 → `garden_ideas(mode: 'inbox')` (+ `list_idea_links`) → `propose_idea_links` → user decides → `decide_idea_links` with `mark_reviewed` |
| "Let's garden" | §2 → `list_idea_links` → `garden_ideas` → `propose_idea_links` → user decides → `decide_idea_links` |
| "What do I have on X?" | §5 → `explore_topic` |
| "Have I thought about X?" | `search_brain` (journal) |
| Fix or extend an idea; change status; add a note | `update_idea` |
| "I promoted this to Subjects" | `update_idea(promoted: {title})` — 2nd-brain records it; it never writes Google Tasks |
| Look up ideas | `list_ideas` (`inbox`, `promoted` filters), `search_ideas`, `get_idea` |
| "Combine these into an episode" | `create_synthesis` |
| "Show me my idea map" | §3 → `export_idea_map(format: 'html')` → save the page as `filename`, check `bytes`, hand it over |
| One-time Notion / Subjects import | §4 → `import_ideas`, `list_subjects_for_import`, `propose_idea_links(origin: 'import')` (Subjects pass not yet) |

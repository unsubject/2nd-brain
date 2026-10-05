# Brief: The Idea Garden (Idea Parking Lot)

> **Kept as Simon's original brief (2026-10-05).** 2nd-brain builds the Idea Garden by extending its existing idea tools rather than from scratch. Where this brief and [`docs/decisions/2026-10-05-refocus.md`](decisions/2026-10-05-refocus.md) differ, the decision record wins: link proposals at capture (D3), link types and their display labels (D4), the inbox marker instead of an `inbox` status (Phase 4), and the answers to §9.

**For:** a vibe-coding agent building this from scratch.
**Owner:** Simon Lee — economist, YouTuber, writer. His core creative method is **bisociation**: connecting ideas across unrelated domains to make something new.

## 1. What this is

A **mental experiment lab** for interesting ideas. Not a notes app, not a todo list, not a second brain. Its two jobs:

1. **Keep** — capture interesting ideas so reliably that they stop "haunting" him (his word: ideas nag him when he doesn't trust the system holding them).
2. **Cross-fertilize** — make ideas collide with each other so combinations emerge. The combining is the product; storage is just the precondition.

An idea here is **raw material, not even work-in-progress**. It becomes work only when it graduates out of the garden (see §6).

## 2. What this is NOT (anti-goals)

- Not a task manager. No due dates, no priorities, no checkboxes on ideas.
- Not a Notion clone. He rejected Notion for this job: too slow, UI friction kills capture. **Speed is a feature** — capture must take seconds.
- No AI auto-filing. Nothing enters the garden without his explicit "park this." The agent (me, or another AI) may *propose*, he *confirms*.
- No auto-linking without confirmation. Same rule: propose links, he approves.

## 3. Core objects

### Idea unit
- `id`, `created_at`
- `source_url` (where he found it; often a link he pastes)
- `raw` (the content: quote, summary, or his dump — verbatim, unpolished)
- `why_interesting` (why it caught him, in his words)
- `unfiltered_take` (his immediate hot take — this is where the bisociation seed lives)
- `status`: `inbox` → `garden` (inbox = just captured, not yet reviewed/linked)

### Link (the important object)
A typed, directed connection between two idea units, with a **one-line gloss**. The gloss is where the bisociation lives — it's the whole point of the system.

Starter taxonomy (keep it tiny; he curates it):
- `contradicts` — the two ideas disagree; tension is productive
- `extends` — B is a special case / continuation of A
- `example-of` — B is a concrete instance of A's abstract claim
- `mechanism-for` — A explains *why* B happens
- `rhymes-with` — structural analogy across domains (his favorite move)
- `inverts` — B is A with the causality flipped

### Map
An interactive visual graph of idea units (nodes) and links (edges), with glosses visible on hover/click. This is the "mindmap of me." He must be able to **see** clusters forming — dense clusters are episode material.

## 4. Workflows

**Capture (librarian mode).** He dumps raw: a link + "park this" + why he's interested + what came to mind. The system (or his AI assistant) fills the idea-unit fields. Target: under 30 seconds from intent to captured. Mobile-friendly capture is essential.

**Curation.** At capture time and in periodic batch reviews, the assistant *proposes* links between the new idea and existing ones, each with a draft gloss. He confirms / edits / rejects. Confirmed links enter the graph. There is also a **garden review** cadence (he'll set it; default weekly) where unlinked inbox items get their linking pass — this is the trust mechanic: nothing sits unprocessed forever.

**Retrieval (pull-based).** Two modes:
1. **Episode-planning queries** — "what do I have on X?" returns the idea plus its linked cluster, glosses included. This is the money feature: he plans episodes from clusters, not single ideas.
2. **Journey reviews** — browse the map over time; the map is the substrate for planning his intellectual direction.

## 5. Key views (minimum viable)

1. **Capture box** — fastest possible input: link + text, one tap to park.
2. **Inbox queue** — unlinked ideas awaiting their linking pass.
3. **Garden map** — the interactive graph. The home screen.
4. **Idea detail** — full fields + its links with glosses + "propose link" action.
5. **Query** — search that returns clusters, not just keyword hits.

## 6. How it connects downstream

Pipeline: **Garden → Subjects → Projects → Shipped.**

- `Subjects` (a Google Tasks list) is the **production shortlist** — ideas promoted from the garden when they're episode-shaped. Promotion is a conscious human decision ("no done picture, no project").
- The garden never holds tasks. If something has a next action, it doesn't belong here.

## 7. Existing infrastructure (read before building fresh)

- There is a **2nd-brain MCP** skill at `~/workspace/skills/2nd-brain-mcp/SKILL.md` with ~40 tools including idea-garden operations (park, link, synthesis, map export). **Read it first** — extend it if it covers the need, build fresh only if it doesn't.
- **Migration pending:** 72 old ideas sit in a Notion database (CSV export available on request — ask him). 29 more live as one-liners in Google Tasks "Subjects". Plan an import path, but don't block v1 on it.

## 8. Acceptance criteria

- He can park an idea (link + why + take) in under 30 seconds, from his phone.
- The map renders with nodes, typed edges, and visible glosses; clusters are visually obvious.
- Querying a topic returns the idea **and its linked cluster**, not a flat list.
- He can export the map as a file (image or interactive HTML).
- After one week of real use, he reports that parked ideas feel "held" — the haunting stops. (Yes, this one is subjective. Ask him.)

## 9. Ask him before you build

1. Web app, local app, or chat-native? (He lives in chat with his AI assistants — capture may already happen there.)
2. Build on the 2nd-brain MCP garden tools or start fresh?
3. Import the 72 Notion ideas now, or start clean and import later?
4. Where does this run — his Mac, a server, or hosted?

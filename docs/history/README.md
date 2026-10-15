# History: the Chief of Staff documents

2nd-brain started as an AI Chief of Staff (COS). The documents in this folder describe that plan. The refocus decision record, [`docs/decisions/2026-10-05-refocus.md`](../decisions/2026-10-05-refocus.md), superseded them on 2026-10-05. 2nd-brain is now Simon's private home for his personal thoughts, his published work and the Idea Garden, and Meta's Muse works with his Gmail, Calendar, Contacts and Tasks directly.

They are kept for history only. Don't build from them or treat anything in them as a current requirement: read the decision record instead. They moved here in Phase 3 of the record's plan, with `git mv`, under their original filenames and with their text unchanged, so `git log --follow` still finds their history.

## What each document was

| File | What it was |
|---|---|
| [`CoS Charter Phase 1`](CoS%20Charter%20Phase%201) | The operating charter for the AI Chief of Staff: its role, operating principles, decision rights and output templates, and its two Phase 1 lanes. Lane A was daily executive planning and administrative triage, from Gmail, Google Calendar and Google Tasks. Lane B was topic development and episode preparation. |
| [`Specifications Phase 1`](Specifications%20Phase%201) | The product and technical spec for a mobile-first web app built on that charter: Today, Topics, Preferences and Activity screens, n8n workflows, Perplexity for research, model routing across Gemini, Claude and (optionally) OpenAI, and Gmail, Google Calendar and Google Tasks integration. |
| [`Lane A MVP Backlog.md`](Lane%20A%20MVP%20Backlog.md) | The build backlog (epics and stories) for Lane A of that spec, plus a mocked Topics screen to complete the app shell. |
| [`phase-2-five-w-tools.md`](phase-2-five-w-tools.md) | The MCP server's Phase 2 spec (2026-05-16): five read-only tools over the "5-W" tables, `search_artifacts`, `get_calendar`, `list_tasks`, `find_person` and `search_email`. None of the five was built. Its "Phase 2" is the MCP server's own numbering, not Phase 2 of the refocus plan. |

## The "future CoS" notes

The "Out-of-scope reminders" in [`docs/mcp-behavior-and-dev-norms.md`](../mcp-behavior-and-dev-norms.md) held two notes that left work to a future Chief of Staff. The decision record supersedes them too. They are copied here verbatim, as they stood at commit 4f41e30 (lines 295 and 296), so they outlive the Phase 3 rewrite of that doc:

- Automated alignment checks ("today's plan is N% on goal X") — that belongs in the future CoS, not in the constitution/goal tools themselves; those tools stay neutral read/write primitives.
- Vector-embedding constitution domains or goals for similarity search — interesting later if the CoS wants "the goal most relevant to this decision", but the constitution is small and re-reading it linearly is the right pattern for v1.

Both are about the goal system's constitution and goal tools, which the refocus retires as well (decision D6, Phase 6 of the plan).

## Where the COS features went

They are retired in stages. #87 removed `/feed` and the morning briefing, and #88 removed the Telegram bot, task suggestions and `/ask`. Phase 3 stops the Calendar and Contacts syncs, removes the person and event matchers from the journal linker, stops `get_entry` returning links to people, events and emails, and narrows the Google connection to `gmail.readonly`, `drive.readonly` and `tasks.readonly`. Phase 7 retires the Tasks sync once the Subjects import is done. The record's Plan table has the current status of each phase.

## Not moved

- `Journal_of_Random_Thoughts_Specifications` stays at the repository root. Whether to rewrite it as the current journal spec or move it here is an open item in the decision record.
- `docs/goal-amendment-interview.md` stays in `docs/`. The Worker bundles it (`mcp-worker/src/resources.ts`) and serves it until the goal system retires in Phase 6.

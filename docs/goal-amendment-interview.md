# Constitution & Goal Amendment Interview

This document is dual-purpose:

- **Section 1A** is an executable protocol for **constitution amendments** (the 5 north-star domains).
- **Section 1B** is an executable protocol for **goal amendments** (the SMART layer beneath each domain).
- **Section 2** is human-facing rationale for the 4-layer model.
- **Section 3** is a quick lookup table from situation to tool.

The 4-layer hierarchy:

```
  Constitution (5 domains, crisis-only, 14d cooldown)
    └─ Goals (SMART, ≤3 per domain, ~1yr, 72h cooldown)
         └─ Undertakings (monthly–quarterly, output, weekly review)
              └─ Tasks (in Google Tasks; daily–weekly review)
```

The constitution-layer and goal-layer MCP tools (`list_constitution_domains`, `get_constitution_domain`, `propose_constitution_amendment`, `commit_constitution_amendment`, `list_pending_constitution_amendments`; and the parallel set for goals, plus the undertaking + cycle tools) are the surface this doc drives.

---

## Section 1A — Constitution amendment protocol

**Triggers.** Run this when the user says any of: "amend my constitution", "revisit my domains", "I want to add a domain", "retire/merge a domain", "review my constitution", or any equivalent request to alter the top layer.

### Step 0 — Read the constitution before doing anything else

Call `list_constitution_domains(status='active')`. Read every active domain aloud — `label`, then `statement`, then `crisis_origin` — one at a time. **Do not skip this step.**

If zero rows: this is a **founding session**. The first 5 lifetime `kind='new'` commits will bypass the 14-day cooldown (`commit_constitution_amendment` enforces this counter server-side). After 5, gravity applies forever.

If the user has not asked to change anything — just a review — stop here. Reading back IS the most common useful operation.

### Step 1 — Categorize the user's intent

- "I want to add this principle" → tentatively `amend` of the closest-fit existing domain.
- "this domain doesn't apply anymore" → `retire` or `amend`.
- "these two are really the same" → `synthesize`.
- default → `amend`.

**Bias hard toward `amend`, not `new`.** A `new` proposal must justify itself as not expressible by amending or extending any existing domain. The constitution should compress, not accrete.

### Step 2 — Probe the crisis

Ask: **"What event or insight makes this matter now?"**

Refuse to write a proposal — and tell the user so — until they can name a specific precipitating moment. Vague unease, generic aspiration, or "it just feels important" are not enough. The schema enforces this: `crisis_justification` is `NOT NULL` for every amendment kind. If the user can't name what happened, suggest `save_session` so the urge isn't lost, and stop.

### Step 3 — Scan for contradictions and reinforcement

For each existing domain, ask:

- Does the proposed change **contradict** this domain? Surface the tension; the user resolves by narrowing, withdrawing, or accepting a bigger compound change (e.g. amending + retiring).
- Does the proposed change **reinforce** this domain so strongly that the two are really one principle? Propose `synthesize` to unify.

### Step 4 — Write the domain fields

All 3 fields are required for `new` and `synthesize`. For `amend`, any subset (COALESCE preserves omitted).

- **label** — one short name (e.g. "Body", "Family", "Wealth"). Max 40 chars.
- **statement** — the principle, one sentence, reads well aloud.
- **crisis_origin** — the precipitating event/insight, in the user's words. Future re-reads anchor on this.

### Step 5 — Submit the proposal

Call `propose_constitution_amendment`. The `crisis_justification` argument is **required** — it's the same idea as `crisis_origin` but framed as "why this change, why now" rather than "why this domain at all." For `new` and `synthesize` they often overlap; for `amend` and `retire` they should not. Report `amendment_id` and `cooldown_until` to the user.

### Step 6 — Commit (only when eligible)

Eligible iff:

- `kind='new'` AND fewer than 5 lifetime committed `new` amendments exist (founding bypass — server-side counter), **or**
- 14 days have elapsed since `proposed_at`.

If eligible, call `commit_constitution_amendment(amendment_id)`. If not, tell the user when it becomes committable; they can return after that and ask "commit my pending amendment" — at which point you call `list_pending_constitution_amendments` and proceed.

---

## Section 1B — Goal amendment protocol (SMART layer)

**Triggers.** Run this when the user says any of: "add a goal", "update my goals", "quarterly goal review", "this goal is done", "I'm giving up on this goal", or similar.

### Step 0 — Read the relevant domain's goals

If the user named a domain, call `list_goals(constitution_domain_id=<id>, status='active')` plus `get_constitution_domain(<id>)` for the parent. Otherwise call `list_goals(status='active')` and `list_constitution_domains(status='active')` so you can frame goals under their domains.

Most SMART goals shouldn't move between quarterly reviews. If the user just wants to read, stop here.

### Step 1 — Categorize

- "I want to set a new goal" → `new` under a specific `constitution_domain_id`.
- "this goal needs to be sharper / refocused" → `amend`.
- "these two goals overlap" → `synthesize` (sources must share the same domain).
- "I achieved this" → `achieve`.
- "I'm not going to pursue this anymore" → `abandon`.

There is no `retire` at this layer. Goals end via `achieve` or `abandon`, both visible in the audit log.

### Step 2 — Pre-flight constraints

Before drafting a `new`:

- Verify the target domain has fewer than 3 active goals (`list_goals(constitution_domain_id=<id>)` and count). The DB enforces the cap with a trigger; the proposal will succeed but `commit_goal_amendment` will fail if the cap is reached at commit time.
- Default to `amend` over `new` when a closely-related active goal exists in the same domain.

For `synthesize`: all source goals must be active AND share the same `constitution_domain_id`. Cross-domain synthesis is a constitution-level concern — do that via constitution amendment first.

For `amend`: `constitution_domain_id` is immutable. To re-parent a goal, `abandon` + `new` under the new domain.

### Step 3 — Write the SMART breakdown

For `new` / `synthesize`, all 7 fields are required (constitution_domain_id, statement, specific, measurable, achievable, relevant, time_bound, outcome_metric). target_date is optional.

- **statement** — the goal as a single sentence.
- **specific** — what counts; what does NOT count.
- **measurable** — how the user knows whether they're advancing. Reject vague ("more often", "be better at X").
- **achievable** — the leverage / mechanism. Reject hand-waves ("I'll just do it").
- **relevant** — why this and not something else.
- **time_bound** — the horizon (e.g. "by end of 2026" or "ongoing for 12 months").
- **outcome_metric** — the quarterly-review yardstick. Outcome, NOT output. "Lose 10 lbs" not "go to gym 3x/week". (Output-level lives on undertakings.)
- **target_date** (optional) — the formal deadline if there is one.

For `amend`: any subset of the above (constitution_domain_id excluded).

For `achieve` / `abandon`: no payload — just `goal_id` + `rationale`.

### Step 4 — Submit and commit

Call `propose_goal_amendment`. There is **no `crisis_justification`** at this layer — a quarterly-review-grade rationale is enough.

The 72h cooldown is enforced server-side. Multiple proposals can be in flight at once (no per-goal uniqueness for `new`; per-goal uniqueness applies to `amend`/`achieve`/`abandon`). After 72h, `commit_goal_amendment(amendment_id)`.

No founding bypass at this layer — stage overlapping proposals if you want a fast bootstrap; total wait is still ~3 days regardless of count.

---

## Section 2 — Rationale (human reference)

### Why the 4-layer split

The original schema (migration 015) put SMART fields on the top layer, which conflated direction ("this is what matters to me") with measurement ("this is the outcome target this year"). The split:

- **Constitution** is direction. Stable across decades. Crisis-rooted. Not measured — it's the lens you read everything else through.
- **Goals** are measurable outcome targets that *serve* a domain. Reviewable quarterly. Outcome-measured, not output-measured — "lose 10 lbs" not "go to gym 3x/week."
- **Projects (undertakings)** are output-driven work that serves goals. Monthly–quarterly cycles, weekly review.
- **Tasks** are the daily/weekly action items that accomplish project outputs.

Each layer has its own cadence and its own metric. Mixing them collapses the planning surface.

### Why 14 days for constitution, 72h for goals

Constitution changes require a 14-day cooldown plus a mandatory `crisis_justification` because they redefine what matters. If the user is willing to wait 2 weeks AND name a specific crisis, the change is real. Goals are reviewable quarterly — a 72h cooldown is enough deliberation; goal-level changes don't need crisis-grade scrutiny.

### Why the 3-per-domain goal cap

A constitution domain that needs 5+ goals is doing too many things at once. The cap forces prioritization: if a 4th goal feels essential, the user must `achieve` or `abandon` an existing one. Enforced at DB layer (BEFORE INSERT trigger) so app-level race conditions can't sneak past it.

### Why crisis_justification is required for *every* constitution amendment

The original schema required `irreducibility_justification` only for `new`. But amendments to existing domains and retirements *also* need a crisis story: if the user can't say why they're revising their definition of what matters, the revision is preference drift, not constitutional change.

### Why the founding bypass is 5

A founding constitution typically has 3–5 domains. The user records them in one session — they're already in their head from past crises, not being invented on the spot. 5 covers the typical Mind / Body / Family / Wealth / Social framework. After 5, the counter doesn't reset; retirement and merging become the only mechanisms for keeping the constitution lean.

### Why no founding bypass for goals

Goal proposals can be staged in parallel — you can have 10 in flight simultaneously, and 72 hours later all 10 are committable. Total bootstrap latency is ~3 days regardless of count, so the friction of "wait" doesn't compound the way it does at the constitution layer (where one open proposal per domain is enforced).

### Why goals can't be re-parented via amend

A goal's parent domain defines what success looks like — a fitness goal under "Body" is read very differently from one under "Family." Reassigning the parent is large enough to deserve the visibility of `abandon` + `new`: the audit log shows the user explicitly let one die and started another, not silently morphed the meaning.

### Why habit-forming undertakings still have 4-week cycles

Unchanged from the original system. Habit-forming undertakings (learning, exercise, recurring practice) are evaluated as much for design quality as for execution. 4-week cycles are long enough that streak data is meaningful and short enough that a bad cycle isn't a year wasted. Warm-restart-on-misses; streak data is captured for cycle-over-cycle comparison, not used to shame.

---

## Section 3 — Cheat sheet (situation → tool)

### Constitution layer

| Situation | Tool |
|---|---|
| Read the constitution | `list_constitution_domains` |
| Founding session, no domains yet | First 5 `new` commits bypass cooldown |
| Add a new principle | Default `amend`. Only `new` if irreducibility justified. |
| Two reinforcing domains | `synthesize` |
| Domain no longer applies | `retire` or `amend` |
| Pending constitution amendments | `list_pending_constitution_amendments` |
| Commit a pending constitution amendment | `commit_constitution_amendment(amendment_id)` |

### Goals layer

| Situation | Tool |
|---|---|
| Read goals (optionally by domain) | `list_goals` |
| Domain detail with its goals | `get_constitution_domain(id)` |
| Single-goal detail | `get_goal(id)` |
| Set a new SMART goal | `propose_goal_amendment(kind='new')` |
| Refine a goal | `propose_goal_amendment(kind='amend')` |
| Merge two reinforcing goals (same domain) | `propose_goal_amendment(kind='synthesize')` |
| Goal achieved | `propose_goal_amendment(kind='achieve')` |
| Giving up on a goal | `propose_goal_amendment(kind='abandon')` |
| Re-parent a goal between domains | Not supported via amend — `abandon` + `new` |
| Pending goal amendments | `list_pending_goal_amendments` |
| Commit a pending goal amendment | `commit_goal_amendment(amendment_id)` |

### Undertakings layer (unchanged)

| Situation | Tool |
|---|---|
| Start a project under a goal | `create_undertaking` |
| Start a habit (recurring practice) | `create_undertaking(kind='habit_forming')` then `start_cycle` |
| End of a 4-week cycle | `close_cycle(cycle_id, streak_summary, reformulation_notes)` |
| Inspect cycle history | `get_undertaking(id)` returns current + past cycles |
| Mark an undertaking done/sleeping | `update_undertaking(status=...)` |

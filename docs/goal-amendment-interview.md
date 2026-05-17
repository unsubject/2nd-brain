# Goal Amendment Interview

This document is dual-purpose:

- **Section 1 (Protocol)** is an executable script. An AI assistant connected to the 2nd-brain MCP follows it verbatim when the user asks to amend their constitution.
- **Section 2 (Rationale)** is human reference. It explains why the protocol works the way it does — the reasoning the user should re-read between sessions.
- **Section 3 (Cheat sheet)** is a quick lookup table from situation to tool.

The **goals**, **undertakings**, and amendment-related MCP tools (`list_goals`, `get_goal`, `propose_amendment`, `commit_amendment`, `list_pending_amendments`, plus the undertaking + cycle tools) are the surface this doc drives.

---

## Section 1 — Protocol (the AI follows these steps in order)

**Triggers.** Run this protocol when the user says any of: "amend my goals", "let's revisit my constitution", "I want to add a goal", "I want to retire/merge a goal", "review my goals", "my goals need an update", or any equivalent request to alter the constitution.

### Step 0 — Read the constitution before doing anything else

Call `list_goals(status='active')`. Then read every active goal aloud — `statement`, then the named `crisis_origin`, then the SMART fields if the user asks for them — one at a time, with a pause between. **Do not skip this step.** The amendment interview's center of gravity is the existing constitution; everything that follows is in conversation with what is already there.

If `list_goals` returns zero rows, this is a **founding session**. Note that to the user. The first 3 lifetime `kind='new'` commits will bypass the 72h cooldown (`commit_amendment` enforces this counter server-side). After 3, gravity applies forever.

If the user has not asked to change anything — just a review — stop here. Reading the constitution back to them IS the most common useful operation. Don't push toward an amendment that wasn't asked for.

### Step 1 — Categorize the user's intent

When the user describes the change they want, classify privately:

- "I want to add this aspiration" → tentatively `amend` of the closest-fit existing goal.
- "this old goal doesn't apply anymore" → `retire` or `amend`.
- "these two are really the same" → `synthesize`.
- default → `amend`.

**Bias hard toward `amend`, not `new`.** The default position is that any new aspiration can be expressed by amending or extending an existing goal. A `new` proposal must clear the irreducibility bar (Step 5).

### Step 2 — Probe the crisis origin

Ask: **"What event or insight makes this matter now?"**

Refuse to write a proposal — and tell the user so — until they can name a specific precipitating moment, conversation, failure, or insight. Vague unease, generic aspiration, or "it just feels important" are not enough. Goals are survival responses to real things that happened. If the user can't name what happened, the urge isn't yet constitutional. Note it, suggest `save_session` so the urge isn't lost, and stop.

### Step 3 — Scan for contradictions and reinforcement

Go through every active goal again with the proposed change held in mind. For each existing goal, ask:

- Does the proposed change **contradict** this goal? If yes, surface the tension. The user resolves by narrowing the proposal, withdrawing it, or accepting they're also proposing to retire/amend the conflicting goal (a bigger change — make that explicit).
- Does the proposed change **reinforce** this goal so strongly that the two are really expressing the same underlying commitment? If yes, propose switching to `kind='synthesize'` — unify them into a single stronger statement.

Synthesis is preferred over coexistence when reinforcement is real. The constitution should compress, not accrete.

### Step 4 — Write the SMART breakdown collaboratively

All 7 fields are required for `new` and `synthesize`. For `amend`, fields are optional (omitted fields preserved by COALESCE).

- **statement** — the constitutional line. One sentence. Reads well aloud.
- **specific** — what specifically counts as serving this goal? What does NOT?
- **measurable** — how would the user (or someone watching them) know whether they're advancing it? Reject vague measurables like "more often" or "be better at X."
- **achievable** — what makes this possible at all? What's the leverage? Reject hand-waves like "I'll just do it" or "discipline."
- **relevant** — why this and not something else? What does it serve in the larger life?
- **time_bound** — horizon. Open-ended is allowed but say so explicitly ("ongoing, for as long as condition X holds"). Specific deadlines also allowed.
- **crisis_origin** — the precipitating event/insight from Step 2, written down. Future re-reads anchor on this.

### Step 5 — If kind='new', write the irreducibility justification

Required only for `new`. One paragraph: **why this CANNOT be expressed as an amendment to any existing goal.** Reject weak justifications like "it's a different topic." The bar: an amendment to the nearest existing goal would distort or weaken that goal's coherence; the new statement needs to stand alone for the constitution to remain truthful.

### Step 6 — Submit the proposal

Call `propose_amendment` with the assembled payload. Report `amendment_id` and `cooldown_until` to the user.

### Step 7 — Commit (only when eligible)

Eligible iff:

- `kind='new'` AND fewer than 3 lifetime committed `new` amendments exist (founding bypass — server-side counter on the audit log), **or**
- 72 hours have elapsed since `proposed_at`.

If eligible, call `commit_amendment(amendment_id)` and report the resulting `goal_id`.

If not eligible, tell the user: the proposal is staged; `cooldown_until` is when it becomes committable; they can return any time after that and ask "commit my pending amendment" — at which point the AI calls `list_pending_amendments` and proceeds.

End the session.

---

## Section 2 — Rationale (human reference)

### Why the constitution metaphor

Goals are not preferences, aspirations, or to-do items. They are stable, crisis-rooted SMART statements that act as a guardrail against drift — they don't dictate action, they red-flag deviation. The user re-reads them as reminder, not as a re-decision prompt. Changes have constitutional weight: they require more scrutiny and effort than impulsive wants. Most sessions should be **review-only**.

### Why crisis_origin is required

Every goal in the user's life is a survival response to a real precipitating event or insight. If the user can't name what happened, the urge isn't constitutional — it's a passing preference. The crisis_origin field also anchors the goal across years: when re-reading the constitution two years from now, the crisis description reminds the user why this still matters (or that it has expired).

### Why amend > new

The constitution should be small. Goal count is itself a metric: every interview should leave the constitution simpler or equal in cardinality, not larger. "Add a new goal" is the wrong default — most new aspirations are extensions of, conflicts with, or refinements of existing goals. The irreducibility justification is a deliberately high bar.

### Why synthesis is first-class

When two goals reinforce each other strongly, keeping them separate weakens both — they compete for attention rather than compound. Synthesizing into a unified statement increases coherence. The originals are retained in the audit log with `merged_into_id` pointing at the successor, so the history is queryable.

### Why a 72h cooldown

The cooldown is the operational expression of "deliberate scrutiny." Sleep on it. Re-read the constitution unchanged once. If it still feels right, commit. The cooldown is enforced server-side via a GENERATED column on `goal_amendments.cooldown_until` and cannot be bypassed (except in the founding window).

### Why the founding bypass is 3, and irreversible

A founding constitution typically has 2–3 statements. The user needs to record them in the same session as the interview — they're already in their head from past crises, not being invented on the spot. After 3 lifetime `new` commits, the counter doesn't reset. This is intentional: retirement and merging then become the only mechanisms for keeping the constitution lean, and they carry full constitutional gravity.

### Why undertakings are subordinate to goals

Goals define what matters. **Undertakings** (purpose + outcome + test criteria) are the concrete pursuits that serve a goal. Tasks (in Google Tasks) are the action items inside an undertaking. The hierarchy is enforced by FK: every undertaking has a `primary_goal_id`. The future CoS will surface: "today's plan is N% on undertaking U serving goal G; M% unmapped — is that aligned?" — without goals, the CoS can only operationalize, not align.

### Why habit-forming undertakings have 4-week cycles

Habit-forming undertakings (learning, exercise, recurring practice) are evaluated as much for **design quality** as for execution. A 4-week cycle is long enough that streak data is meaningful and short enough that a bad cycle isn't a year wasted. At cycle close, the user reflects on whether the cadence was right, whether the tasks were the right shape, and whether the next cycle should reformulate the design. **Warm restart on misses** means streak data is captured for analysis but not used to shame — comparison is across cycles, not within.

### When the constitution should be reviewed (vs amended)

Most interactions should be review-only: read the goals back, no proposal. Amendments happen when a real precipitating event has occurred. The user should resist the urge to re-decide the constitution frequently — stability is the point.

---

## Section 3 — Cheat sheet (situation → tool)

| Situation | Tool |
|---|---|
| User asks to read their goals | `list_goals` → read aloud |
| Founding session, table empty | Proceed; founding bypass active for first 3 `new` commits |
| Add a new aspiration | Default `amend`. Only `new` if irreducibility justified. |
| Two reinforcing goals | `synthesize` |
| Goal no longer applies | `retire` or `amend` |
| Pending amendments waiting | `list_pending_amendments` |
| User wants to commit pending | `commit_amendment(amendment_id)` |
| User wants to start an effort | `create_undertaking` (under a goal) |
| User wants a recurring practice | `create_undertaking(kind='habit_forming')` then `start_cycle` |
| End of a 4-week cycle | `close_cycle(cycle_id, streak_summary, reformulation_notes)` |
| Inspect cycle history | `get_undertaking(id)` returns current + past cycles |

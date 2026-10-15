# Lane A MVP Backlog

## Scope
This backlog is centered on **Lane A — Daily Executive Planning and Administrative Triage** for Phase 1, with a narrow bootstrap requirement for a mocked **Topics** screen so the core app shell matches the intended console navigation.

## Build Constraints (Must-Haves)
- Single-user private application only (allowlisted owner account).
- Mobile-first by default (375px baseline).
- Chat is not the primary interface; structured UI interactions are primary.
- n8n webhooks must not be publicly exposed.
- Auth/session tokens must not be stored in `localStorage`.
- Google OAuth scopes must be least-privilege and only what is required.
- Do not use premium models (Claude) for routine classification/triage.
- Do not call Perplexity unless fresh external data is needed.
- Keep first shippable version narrow, reliable, and functional.

## Implementation Priority Order (Execution Sequence)
1. Auth and route protection.
2. Today screen with mocked data and structured interactions.
3. Topics screen with mocked data and structured interactions.
4. Persistence and preference model.
5. n8n integration.
6. Cheap-model triage.
7. Claude escalation for synthesis/ambiguity-heavy steps.
8. Perplexity integration where freshness is required.
9. Cost logging and observability.

---

## Epic 1 — Foundation & Security

### Story 1.1: Google Sign-In with Allowlist
**Description:** As the owner, I can sign in with Google and only allowlisted identities can access the app.

**Acceptance Criteria**
- Google OAuth web flow is implemented end-to-end.
- Only allowlisted Google account(s) can create sessions.
- Non-allowlisted users are denied with a clear error message.
- Session uses `httpOnly`, `Secure` cookies.
- OAuth scope request is documented and constrained to minimum required scopes.

### Story 1.2: Protected API & User Scoping
**Description:** As the owner, all API routes are protected and scoped to my user id.

**Acceptance Criteria**
- Every `/api/today*` and related endpoint requires authenticated session.
- Backend enforces user scoping for every read/write.
- Anonymous requests return 401/403.

### Story 1.3: n8n Trusted Invocation Path
**Description:** As the owner, frontend never calls n8n directly; backend mediates all workflow calls.

**Acceptance Criteria**
- Frontend invokes backend routes only.
- Backend signs/authenticates requests to internal n8n endpoints.
- No unauthenticated public n8n webhook is exposed.

### Story 1.4: Audit & Activity Baseline
**Description:** As the owner, I can inspect key activity and failures.

**Acceptance Criteria**
- System logs login success/failure, workflow starts/completions, approvals, preference updates, and errors.
- Each log contains timestamp, user id, action type, success/failure, and correlation id.

---

## Epic 2 — Lane A Data Ingest & Normalization

### Story 2.1: Calendar Ingest (Today + Near Future)
**Description:** As the owner, the system ingests my calendar constraints before planning.

**Acceptance Criteria**
- Workflow ingests today’s events plus near-future context window.
- Events are mapped to normalized internal entities.
- Fixed commitments are flagged deterministically.

### Story 2.2: Tasks Ingest
**Description:** As the owner, overdue, due-today, high-priority, and unscheduled tasks are surfaced.

**Acceptance Criteria**
- Google Tasks ingestion includes status, due date, and metadata.
- Overdue and due-today tasks are tagged.
- Unscheduled important tasks are identified.

### Story 2.3: Gmail Candidate Ingest
**Description:** As the owner, email candidates likely requiring action are identified.

**Acceptance Criteria**
- Gmail metadata is ingested with minimal body usage where required.
- Candidate set includes likely response/decision/follow-up messages.
- Newsletters are deprioritized unless action-relevant.

### Story 2.4: Deterministic Preprocessing
**Description:** As the owner, deterministic rules run before model calls to reduce cost and ambiguity.

**Acceptance Criteria**
- Preprocessing marks fixed commitments, overdue items, and unscheduled important tasks.
- Output is persisted for downstream model steps.

---

## Epic 3 — Lane A Planning Intelligence

### Story 3.1: Triage Classification (Cheap Model)
**Description:** As the owner, emails and tasks are triaged with cheap-model classification.

**Acceptance Criteria**
- Email classification labels: needs response, needs decision, FYI, ignore/archive.
- Task urgency and likely priority suggestions are generated.
- Batch processing is used to reduce token overhead.

### Story 3.2: Preference Retrieval
**Description:** As the owner, confirmed scheduling/task preferences are loaded before synthesis.

**Acceptance Criteria**
- Relevant confirmed preferences are selected by domain.
- Retrieval output is included in synthesis context.
- Deprecated preferences are excluded.

### Story 3.3: Ambiguity Detection
**Description:** As the owner, unresolved ambiguities are explicitly identified before final plan.

**Acceptance Criteria**
- Ambiguity detector flags conflicts, unclear urgency, and uncertain precedence.
- Detector outputs minimal clarifying questions for UI rendering.

### Story 3.4: Plan Synthesis (Premium Model)
**Description:** As the owner, I receive a structured executive brief + realistic proposed schedule.

**Acceptance Criteria**
- Generated output includes: fixed commitments, attention items, recommended priorities, proposed time blocks, risks, and questions.
- Morning blocks are preserved for content when feasible.
- Trade-offs and explicit deferrals are included.

---

## Epic 4 — Today Screen (Mobile-First)

### Story 4.1: Today Overview Cards
**Description:** As the owner, I can see today state in one screen.

**Acceptance Criteria**
- Cards show calendar, tasks needing attention, emails requiring action, and suggested priorities.
- Layout is single-column and mobile-first (375px baseline).
- First implementation supports mocked data before live integrations are enabled.

### Story 4.2: Proposed Schedule Interaction
**Description:** As the owner, I can approve/edit/reject time blocks quickly.

**Acceptance Criteria**
- Time blocks support approve, edit, reject actions.
- Duration chips (15/30/45/60/90/custom) are available.
- Sticky bottom action bar supports “Approve plan” and “Update plan”.

### Story 4.3: Triage Controls
**Description:** As the owner, I can quickly classify tasks/emails and rerun planning.

**Acceptance Criteria**
- Task controls include Must do today / Can wait / Defer.
- Email controls include Needs response / FYI / Ignore-archive.
- Reorder priorities is supported.
- User can trigger plan refresh after adjustments.

### Story 4.4: Clarification Prompt UX
**Description:** As the owner, minimal clarifying questions appear when ambiguity matters.

**Acceptance Criteria**
- Clarification questions are concise and tied to specific conflicts.
- User input can be captured without free-form typing in common cases.
- Interaction model remains structured (taps/selectors/chips), not chat-primary.

---

## Epic 4B — Topics Screen Bootstrap (Mocked, Structured, Non-Chat Primary)

### Story 4B.1: Topics Screen App-Shell Completion
**Description:** As the owner, I can access a Topics tab that matches the console navigation even before full Lane B automation.

**Acceptance Criteria**
- Topics screen exists in bottom navigation.
- Screen supports mocked topic cards and statuses.
- Layout is mobile-first and uses structured controls.

### Story 4B.2: Topic Card Structured Actions
**Description:** As the owner, I can classify mocked topics with simple structured actions.

**Acceptance Criteria**
- Actions include pursue now / later / discard / needs research.
- Supports short optional note fields for angle/questions.
- Does not rely on chat as primary interaction.

---

## Epic 5 — Finalization, Execution, and Guardrails

### Story 5.1: Finalize Plan from User Decisions
**Description:** As the owner, the finalized plan reflects my edits and constraints.

**Acceptance Criteria**
- Final synthesis incorporates user-edited priorities/durations/blocks.
- Final plan structure is persisted as approved schedule.

### Story 5.2: Calendar Update After Explicit Approval
**Description:** As the owner, calendar updates only occur after I approve.

**Acceptance Criteria**
- No event create/update occurs before approval.
- Approved blocks are written to Google Calendar with idempotency controls.

### Story 5.3: Optional Task Sync
**Description:** As the owner, task states can be updated post-approval.

**Acceptance Criteria**
- Optional update path syncs task statuses/associations.
- Failures are logged and retriable.

### Story 5.4: Boundary Enforcement
**Description:** As the owner, the assistant never exceeds approval boundaries.

**Acceptance Criteria**
- System cannot send emails or make sensitive commitments.
- Sensitive actions require explicit approval gates.

---

## Epic 6 — Preference Learning Lifecycle (Lane A)

### Story 6.1: Preference Proposal Drafting
**Description:** As the owner, the system proposes generalized preferences inferred from my repeated decisions.

**Acceptance Criteria**
- Proposal includes statement, domain, confidence, and example context.
- Proposal status is `proposed` until explicit confirmation.

### Story 6.2: Preference Confirmation/Refinement/Reject UI
**Description:** As the owner, I control whether inferred preferences become durable.

**Acceptance Criteria**
- UI supports confirm, refine, and reject actions.
- Only confirmed preferences move to `confirmed` and are retrievable.

### Story 6.3: Misalignment Review
**Description:** As the owner, outdated or conflicting preferences are surfaced for review.

**Acceptance Criteria**
- Repeated mismatch triggers `under_review` suggestion.
- User can deprecate or update preference statements.

---

## Epic 7 — Model Routing, Cost Controls, and Reliability

### Story 7.1: Routing Policy Enforcement
**Description:** As the owner, cheap/premium models are used according to workload type.

**Acceptance Criteria**
- Cheap model used for classification/extraction tasks.
- Premium model used for synthesis, ambiguity-heavy decisions, and trade-off framing.
- Routing decisions are logged per workflow run.
- Routine email/task triage explicitly avoids Claude unless escalation criteria are met.

### Story 7.2: Token & Cost Telemetry
**Description:** As the owner, I can track model usage by workflow.

**Acceptance Criteria**
- WorkflowRun stores per-step model calls and estimated cost.
- Activity view exposes high-level usage summaries.

### Story 7.3: Retry & Dead-Letter Handling
**Description:** As the owner, transient failures can be retried safely.

**Acceptance Criteria**
- n8n includes retry policies for external API calls.
- Hard failures are captured in error logs/dead-letter handling.
- Failed runs are visible in activity for manual retry.

### Story 7.4: Perplexity Usage Gating
**Description:** As the owner, Perplexity is used only when data freshness is necessary.

**Acceptance Criteria**
- Perplexity calls require a freshness trigger (events-driven topic, explicit user action, or stale evidence).
- No Perplexity invocation in routine Lane A planning runs.
- Perplexity invocation reason is logged in workflow metadata.

---

## Definition of Done (Lane A MVP)
Lane A MVP is complete when:
- Owner can authenticate and access is allowlist-restricted.
- Today screen presents an actionable executive brief and proposed schedule on mobile.
- User can triage tasks/emails, resolve ambiguities, and approve/update plan.
- Topics screen is available with mocked, structured interactions in app shell.
- Calendar updates only happen after explicit approval.
- Preference inference follows propose → confirm/refine/reject flow.
- Activity and workflow logging provide end-to-end auditability.

import type { Env } from '../env';
import { searchBrainHandler } from './search_brain';
import { getEntryHandler } from './get_entry';
import { listRecentHandler } from './list_recent';
import { saveSessionHandler } from './save_session';
import { archiveSearchHandler } from './archive_search';
import { archiveSearchTextHandler } from './archive_search_text';
import { recordPickHandler } from './record_pick';
import { recordEpisodeLinkHandler } from './record_episode_link';
import { listConstitutionDomainsHandler } from './list_constitution_domains';
import { getConstitutionDomainHandler } from './get_constitution_domain';
import { proposeConstitutionAmendmentHandler } from './propose_constitution_amendment';
import { commitConstitutionAmendmentHandler } from './commit_constitution_amendment';
import { listPendingConstitutionAmendmentsHandler } from './list_pending_constitution_amendments';
import { listGoalsHandler } from './list_goals';
import { getGoalHandler } from './get_goal';
import { proposeGoalAmendmentHandler } from './propose_goal_amendment';
import { commitGoalAmendmentHandler } from './commit_goal_amendment';
import { listPendingGoalAmendmentsHandler } from './list_pending_goal_amendments';
import { listUndertakingsHandler } from './list_undertakings';
import { getUndertakingHandler } from './get_undertaking';
import { createUndertakingHandler } from './create_undertaking';
import { updateUndertakingHandler } from './update_undertaking';
import { startCycleHandler } from './start_cycle';
import { closeCycleHandler } from './close_cycle';
import { EMBEDDING_DIMENSIONS } from '../embeddings';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, env: Env, ctx: ExecutionContext) => Promise<ToolResult>;
};

export const tools: Tool[] = [
  {
    name: 'search_brain',
    description:
      "Semantic search over the user's 2nd-brain journal. Use proactively when the user starts brainstorming a topic they may have thought about before, or when they ask 'have I thought about X?'. Returns top-N entries by vector similarity, optionally filtered by date range, tags, or entry type.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query embedded for vector search' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        since: { type: 'string', format: 'date-time', description: 'ISO 8601 lower bound on created_at' },
        until: { type: 'string', format: 'date-time', description: 'ISO 8601 upper bound on created_at' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Entries must contain ALL given tags' },
        primary_type: {
          type: 'string',
          enum: ['task_candidate', 'goal_candidate', 'knowledge_candidate', 'archive_only'],
        },
        scope: { type: 'string', enum: ['personal', 'family', 'all'], default: 'personal' },
      },
      required: ['query'],
    },
    handler: searchBrainHandler,
  },
  {
    name: 'get_entry',
    description:
      "Fetch a single journal entry by id, including full text, summary, tags, and outbound links to people, calendar events, tasks, emails, public artifacts, and entities. Each link includes a resolved target_title (full_name / title / subject / display_name depending on target_type) so no second tool call is needed to identify the target. Links are filtered by min_confidence (default 0.5) and deduped by target_id keeping the highest-confidence row. Use after a search_brain hit when the user wants the full entry and its connections.",
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', format: 'uuid', description: 'journal_entry.id' },
        min_confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.5,
          description: 'Minimum link confidence to return (default 0.5 — drops noisy same-day-as-event floor and similar low-signal links)',
        },
      },
      required: ['entry_id'],
    },
    handler: getEntryHandler,
  },
  {
    name: 'list_recent',
    description:
      "List recent journal entries in a time window. Use for prompts like 'what have I been thinking about this week'. Returns entries ordered by created_at DESC.",
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 365, default: 7 },
        scope: { type: 'string', enum: ['personal', 'family', 'all'], default: 'personal' },
        primary_type: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: listRecentHandler,
  },
  {
    name: 'save_session',
    description:
      "Save an AI brainstorm session as a journal_entry on channel 'ai_chat'. ONLY call when the user explicitly asks ('save this', 'log this', 'save to my brain'). Never autonomously. Propose a title and confirm with the user before calling. Write the summary as a narrative (what we discussed, key insights, decisions, open questions) — not a transcript. Returns an entry_id; processing (tags, classification, embedding) is async and completes within ~30–60s.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short session label, 3-8 words' },
        summary: { type: 'string', description: 'Narrative summary; NOT a transcript' },
        scope: { type: 'string', enum: ['personal', 'family'], default: 'personal' },
        source: {
          type: 'object',
          properties: {
            client: { type: 'string', description: 'e.g. claude.ai, claude-desktop, cursor' },
            model: { type: 'string', description: 'e.g. claude-opus-4-7' },
          },
        },
      },
      required: ['title', 'summary'],
    },
    handler: saveSessionHandler,
  },
  {
    name: 'archive_search',
    description:
      "Vector similarity search over Simon's published archive of essays and YouTube episodes. Caller supplies a pre-computed text-embedding-3-small embedding (1536 dims) — saves a round-trip when the caller already has one (e.g. socialisn2 candidate scoring). Returns top-K hits with {id, title, url, published_at, similarity, type: 'essay'|'episode'}. For text queries without a pre-computed embedding, use archive_search_text instead.",
    inputSchema: {
      type: 'object',
      properties: {
        query_embedding: {
          type: 'array',
          items: { type: 'number' },
          minItems: EMBEDDING_DIMENSIONS,
          maxItems: EMBEDDING_DIMENSIONS,
          description: `Pre-computed embedding from text-embedding-3-small (${EMBEDDING_DIMENSIONS} floats)`,
        },
        top_k: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query_embedding'],
    },
    handler: archiveSearchHandler,
  },
  {
    name: 'archive_search_text',
    description:
      "Text-query variant of archive_search: the worker embeds the query server-side via text-embedding-3-small, then runs the same vector similarity over Simon's published essays and YouTube episodes. Use this when the caller doesn't already have an embedding handy.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query embedded server-side' },
        top_k: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
    },
    handler: archiveSearchTextHandler,
  },
  {
    name: 'record_pick',
    description:
      "Record Simon's pick/pass/defer decision on an editorial candidate as training signal. Writes one row to editorial_pick with a denormalized snapshot of the candidate (so the signal survives after the upstream candidate is garbage-collected). Returns {ok, pick_id} — store pick_id if the candidate may later ship as an episode (see record_episode_link).",
    inputSchema: {
      type: 'object',
      properties: {
        candidate: {
          type: 'object',
          properties: {
            headline: { type: 'string', description: 'Candidate headline / one-line summary' },
            context: { type: 'string', description: 'Optional fuller context / excerpt' },
            domain: { type: 'string', description: 'Source domain, e.g. nytimes.com' },
            keywords: { type: 'array', items: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
            urls: { type: 'array', items: { type: 'string' } },
          },
          required: ['headline'],
        },
        decision: { type: 'string', enum: ['pick', 'pass', 'defer'] },
        reason: { type: 'string', description: 'Optional rationale, especially for pass/defer' },
      },
      required: ['candidate', 'decision'],
    },
    handler: recordPickHandler,
  },
  {
    name: 'record_episode_link',
    description:
      'Attach a published episode URL to a previously-recorded editorial_pick row, closing the loop from candidate decision to shipped episode. Sets episode_url + episode_linked_at on the row. candidate_id is the pick_id returned by record_pick.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string', format: 'uuid', description: 'pick_id returned by record_pick' },
        episode_url: { type: 'string', format: 'uri', description: 'URL of the shipped episode' },
      },
      required: ['candidate_id', 'episode_url'],
    },
    handler: recordEpisodeLinkHandler,
  },

  // ── Constitution (5 north-star domains) ─────────────────────────────
  // The crisis-rooted, stable layer. 14-day cooldown, mandatory
  // crisis_justification on every amendment, founding bypass of 5 covers
  // the typical Mind/Body/Family/Wealth/Social bootstrap. Drive these tools
  // ONLY from a deliberate user request, never autonomously. See
  // docs/goal-amendment-interview.md Section 1A.
  {
    name: 'list_constitution_domains',
    description:
      "List the user's constitution domains (the north-star principles). Default returns only status='active'. Pass status='all' for audit/history including merged or retired domains. Read these BEFORE any planning session: the constitution anchors all goals beneath it.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'merged', 'retired', 'all'],
          default: 'active',
        },
      },
    },
    handler: listConstitutionDomainsHandler,
  },
  {
    name: 'get_constitution_domain',
    description:
      'Fetch a single constitution domain with its child SMART goals (summary rows) and recent amendment history (up to 20). Use after list_constitution_domains when the user wants depth on one domain.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
    },
    handler: getConstitutionDomainHandler,
  },
  {
    name: 'propose_constitution_amendment',
    description:
      "Stage a constitutional change: a brand-new domain, an amendment to an existing one, a synthesis of two reinforcing domains, or a retirement. Enters a 14-day cooldown. crisis_justification is REQUIRED for every kind — if the user cannot name the crisis, the change is not constitutional yet. ONLY call from a deliberate user-driven session, never autonomously. Follow the protocol in docs/goal-amendment-interview.md Section 1A. Returns {amendment_id, kind, cooldown_until}.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['new', 'amend', 'synthesize', 'retire'] },
        constitution_domain_id: {
          type: 'string',
          format: 'uuid',
          description: "Required for kind='amend' or kind='retire'",
        },
        source_constitution_domain_ids: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          minItems: 2,
          description: "Required for kind='synthesize' — the domains being unified",
        },
        payload: {
          type: 'object',
          description:
            "Required for new/amend/synthesize. For 'new' and 'synthesize' all 3 fields are required. For 'amend' all 3 are optional; omitted fields preserved by COALESCE.",
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 40 },
            statement: { type: 'string', minLength: 3, maxLength: 500 },
            crisis_origin: {
              type: 'string',
              minLength: 3,
              maxLength: 4000,
              description:
                'The precipitating event/insight that grounds this domain in lived experience.',
            },
          },
        },
        rationale: {
          type: 'string',
          minLength: 3,
          maxLength: 4000,
          description: 'Why this change now. Required.',
        },
        crisis_justification: {
          type: 'string',
          minLength: 3,
          maxLength: 4000,
          description:
            'REQUIRED FOR EVERY KIND. Why this change is constitutional, not a passing preference — a specific event, conversation, failure, or insight that makes this matter now.',
        },
      },
      required: ['kind', 'rationale', 'crisis_justification'],
    },
    handler: proposeConstitutionAmendmentHandler,
  },
  {
    name: 'commit_constitution_amendment',
    description:
      "Apply a previously-proposed constitution amendment. Refuses unless cooldown_until has elapsed. Founding-period bypass: the first 5 lifetime kind='new' commits skip cooldown — sized for the typical 5-domain bootstrap, irreversible, counted from the audit log so retire/merge don't refund. Applies atomically: 'new' inserts a domain; 'amend' COALESCE-updates; 'synthesize' inserts the unified domain AND marks sources merged; 'retire' marks status='retired'. Returns {ok, constitution_domain_id, kind, bypassed_cooldown}.",
    inputSchema: {
      type: 'object',
      properties: { amendment_id: { type: 'string', format: 'uuid' } },
      required: ['amendment_id'],
    },
    handler: commitConstitutionAmendmentHandler,
  },
  {
    name: 'list_pending_constitution_amendments',
    description:
      "List all constitution amendments currently in the 14-day cooldown window (status='proposed'). Each row includes cooldown_remaining_seconds. Use to remind the user of pending constitutional changes that may be ready to commit.",
    inputSchema: { type: 'object', properties: {} },
    handler: listPendingConstitutionAmendmentsHandler,
  },

  // ── Goals (SMART layer, subordinate to constitution) ────────────────────
  // Up to 3 active goals per constitution_domain. Reviewable quarterly,
  // commitment ~1yr, outcome-measured. 72h cooldown on amendments; no
  // founding bypass (proposals can overlap so total bootstrap latency is
  // ~3 days regardless of count). See docs/goal-amendment-interview.md
  // Section 1B.
  {
    name: 'list_goals',
    description:
      "List SMART goals beneath the constitution. Default returns only status='active'. Optionally filter by constitution_domain_id. Cap is 3 active per domain (DB-enforced). Read these before proposing a new goal so you can default to amend/synthesize over new.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'achieved', 'abandoned', 'merged', 'all'],
          default: 'active',
        },
        constitution_domain_id: { type: 'string', format: 'uuid' },
      },
    },
    handler: listGoalsHandler,
  },
  {
    name: 'get_goal',
    description:
      'Fetch a single SMART goal with full breakdown (specific/measurable/achievable/relevant/time_bound + outcome_metric + target_date), its undertakings (id/name/status/kind), and recent amendment history (up to 20). Use after list_goals for depth on one goal.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
    },
    handler: getGoalHandler,
  },
  {
    name: 'propose_goal_amendment',
    description:
      "Stage a SMART-goal change: new goal under a constitution_domain, amendment to an existing one, synthesis of reinforcing goals (must share the same domain), or status transitions 'achieve' (outcome reached) and 'abandon' (gave up). 72h cooldown. Re-parenting a goal between domains is NOT supported via amend — abandon + new under the new domain. ONLY call from a deliberate user-driven session.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['new', 'amend', 'synthesize', 'achieve', 'abandon'],
        },
        goal_id: {
          type: 'string',
          format: 'uuid',
          description: "Required for kind in {'amend','achieve','abandon'}",
        },
        source_goal_ids: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          minItems: 2,
          description:
            "Required for kind='synthesize'. Sources must all be active and share the same constitution_domain_id.",
        },
        payload: {
          type: 'object',
          description:
            "Required for new/amend/synthesize. 'new' and 'synthesize' need the full SMART set plus constitution_domain_id. 'amend' allows any subset (constitution_domain_id is immutable).",
          properties: {
            constitution_domain_id: { type: 'string', format: 'uuid' },
            statement: { type: 'string', minLength: 3, maxLength: 500 },
            specific: { type: 'string', minLength: 3, maxLength: 2000 },
            measurable: { type: 'string', minLength: 3, maxLength: 2000 },
            achievable: { type: 'string', minLength: 3, maxLength: 2000 },
            relevant: { type: 'string', minLength: 3, maxLength: 2000 },
            time_bound: { type: 'string', minLength: 3, maxLength: 2000 },
            outcome_metric: {
              type: 'string',
              minLength: 3,
              maxLength: 2000,
              description: 'Outcome (e.g. "lose 10 lbs"), not output (e.g. "go to gym 3x/week")',
            },
            target_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
        rationale: { type: 'string', minLength: 3, maxLength: 4000 },
      },
      required: ['kind', 'rationale'],
    },
    handler: proposeGoalAmendmentHandler,
  },
  {
    name: 'commit_goal_amendment',
    description:
      "Apply a previously-proposed goal amendment. Refuses unless 72h cooldown has elapsed. No founding bypass at this layer. 'new'/'synthesize' insert (subject to 3-per-domain cap); 'amend' COALESCE-updates; 'achieve' marks status='achieved'; 'abandon' marks status='abandoned'. Returns {ok, goal_id, kind}.",
    inputSchema: {
      type: 'object',
      properties: { amendment_id: { type: 'string', format: 'uuid' } },
      required: ['amendment_id'],
    },
    handler: commitGoalAmendmentHandler,
  },
  {
    name: 'list_pending_goal_amendments',
    description:
      "List all goal amendments currently in the 72h cooldown window (status='proposed'). Each row includes cooldown_remaining_seconds. Multiple proposals can be in flight simultaneously — unlike constitution-layer, where one open proposal per domain is enforced.",
    inputSchema: { type: 'object', properties: {} },
    handler: listPendingGoalAmendmentsHandler,
  },

  // ── Undertakings & cycles (existing layer, unchanged) ──────────────────
  {
    name: 'list_undertakings',
    description:
      "List undertakings (focused efforts serving a goal). Default status='active'. Optionally filter by goal_id. Each undertaking has kind='outcome' (standard, evaluated by test_criteria) or 'habit_forming' (4-week cycles, evaluated as much for design quality as execution).",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'completed', 'archived', 'sleeping', 'all'],
          default: 'active',
        },
        goal_id: { type: 'string', format: 'uuid' },
      },
    },
    handler: listUndertakingsHandler,
  },
  {
    name: 'get_undertaking',
    description:
      'Fetch a single undertaking with its current cycle (if habit_forming and there is one open) and past closed cycles. Use to inspect cycle-over-cycle streak data and reformulation history.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
    },
    handler: getUndertakingHandler,
  },
  {
    name: 'create_undertaking',
    description:
      "Create a new undertaking. Must reference an active primary_goal_id (a SMART goal, not a constitution domain). secondary_goal_ids is a rare exception for undertakings serving multiple goals genuinely. kind defaults to 'outcome'. gtasks_parent_id can be set later via update_undertaking once the Google Tasks parent has been created.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        purpose: { type: 'string', minLength: 3, maxLength: 4000 },
        outcome: { type: 'string', minLength: 3, maxLength: 4000 },
        test_criteria: {
          type: 'string',
          minLength: 3,
          maxLength: 4000,
          description:
            "For 'outcome': how you know it shipped. For 'habit_forming': cadence + tolerance language (e.g. '5x/week with warm restart on misses').",
        },
        primary_goal_id: { type: 'string', format: 'uuid' },
        secondary_goal_ids: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
        },
        kind: {
          type: 'string',
          enum: ['outcome', 'habit_forming'],
          default: 'outcome',
        },
        gtasks_parent_id: { type: 'string', maxLength: 255 },
        target_date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'ISO YYYY-MM-DD',
        },
      },
      required: ['name', 'purpose', 'outcome', 'test_criteria', 'primary_goal_id'],
    },
    handler: createUndertakingHandler,
  },
  {
    name: 'update_undertaking',
    description:
      "Partial update of an undertaking on whitelisted fields. Pass only the fields you want to change. Use to attach gtasks_parent_id once the Google Tasks parent is created, to mark status='completed'/'archived'/'sleeping', or to refine purpose/outcome/test_criteria. gtasks_parent_id and target_date support tri-state: omit = leave; null = clear; value = set.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        purpose: { type: 'string' },
        outcome: { type: 'string' },
        test_criteria: { type: 'string' },
        secondary_goal_ids: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'archived', 'sleeping'],
        },
        gtasks_parent_id: { type: ['string', 'null'] },
        target_date: {
          type: ['string', 'null'],
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
      },
      required: ['id'],
    },
    handler: updateUndertakingHandler,
  },
  {
    name: 'start_cycle',
    description:
      "Start a new 4-week cycle on a habit_forming undertaking. Refuses if the undertaking isn't kind='habit_forming' or if an active cycle already exists. Returns the new {cycle_id, cycle_number, end_date} (start_date is today; end_date is today + 28 days). Warm-restart-on-misses semantics live in the close_cycle reformulation, not here.",
    inputSchema: {
      type: 'object',
      properties: { undertaking_id: { type: 'string', format: 'uuid' } },
      required: ['undertaking_id'],
    },
    handler: startCycleHandler,
  },
  {
    name: 'close_cycle',
    description:
      'Close an active 4-week cycle. Captures streak_summary (free-form JSON — typically the longest streak, gaps, and observed-regularity numbers pulled from Google Tasks completion events on subtasks of the undertaking parent) and reformulation_notes (what to change about the design for the next cycle). Does NOT auto-start the next cycle — the user decides whether to start_cycle again, mark the undertaking sleeping (habit graduated), or evolve it into a different shape.',
    inputSchema: {
      type: 'object',
      properties: {
        cycle_id: { type: 'string', format: 'uuid' },
        streak_summary: {
          type: 'object',
          description:
            'Free-form JSON capturing observed regularity, longest streak, gaps',
        },
        reformulation_notes: { type: 'string', maxLength: 8000 },
      },
      required: ['cycle_id'],
    },
    handler: closeCycleHandler,
  },
];

import type { Env } from '../env';
import { searchBrainHandler } from './search_brain';
import { getEntryHandler } from './get_entry';
import { listRecentHandler } from './list_recent';
import { saveSessionHandler } from './save_session';
import { archiveSearchTextHandler } from './archive_search_text';
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
import { parkIdeaHandler } from './park_idea';
import { importIdeasHandler } from './import_ideas';
import { listSubjectsForImportHandler } from './list_subjects_for_import';
import { updateIdeaHandler } from './update_idea';
import { getIdeaHandler } from './get_idea';
import { listIdeasHandler } from './list_ideas';
import { searchIdeasHandler } from './search_ideas';
import { gardenIdeasHandler } from './garden_ideas';
import { proposeIdeaLinksHandler } from './propose_idea_links';
import { listIdeaLinksHandler } from './list_idea_links';
import { decideIdeaLinksHandler } from './decide_idea_links';
import { createSynthesisHandler } from './create_synthesis';
import { exportIdeaMapHandler } from './export_idea_map';
import { LINK_TYPES, LINK_STATUSES } from '../ideas/linkTypes';
import { readProtocolHandler } from './read_protocol';
import { TOOL_META, type ToolAnnotations } from './tool_meta';
import type { Principal } from '../auth/principal';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, env: Env, ctx: ExecutionContext, principal: Principal) => Promise<ToolResult>;
};

export type Tool = ToolDefinition & { title: string; annotations: ToolAnnotations };

// Unknown tools default to the most cautious hints; the schema-portability
// test fails if any tool is missing from TOOL_META.
const CAUTIOUS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const definitions: ToolDefinition[] = [
  {
    name: 'search_brain',
    description:
      "Search the user's 2nd-brain journal by meaning and by exact text (the text match covers Chinese phrases, names, and entries still being processed). Use proactively when the user starts brainstorming a topic they may have thought about before, or when they ask 'have I thought about X?'. Returns top-N entries, each with match ['semantic'|'text'], optionally filtered by date range, tags or scope.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query: embedded for semantic search and matched as text (up to 5 whitespace-separated terms, all must appear)' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        since: { type: 'string', format: 'date-time', description: 'ISO 8601 lower bound on created_at' },
        until: { type: 'string', format: 'date-time', description: 'ISO 8601 upper bound on created_at' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Entries must contain ALL given tags' },
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
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: listRecentHandler,
  },
  {
    name: 'save_session',
    description:
      "Save an AI brainstorm session as a journal_entry on channel 'ai_chat'. ONLY call when the user explicitly asks ('save this', 'log this', 'save to my brain'). Never autonomously. Propose a title and confirm with the user before calling. Write the summary as a narrative (what we discussed, key insights, decisions, open questions) — not a transcript. Returns an entry_id; processing (summary, tags, embedding) is async and completes within ~30–60s; until then search_brain finds the entry by text.",
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
    name: 'archive_search_text',
    description:
      "Search Simon's published essays and YouTube episodes by meaning: the query is embedded server-side (text-embedding-3-small) and matched against each piece's summary embedding. Returns top-K hits with {id, title, url, published_at, similarity, type: 'essay'|'episode'}. Matches summaries only and returns no body text.",
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

  // ── Constitution (5 north-star domains) ───────────────────
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
      "Stage a constitutional change: a brand-new domain, an amendment to an existing one, a synthesis of two reinforcing domains, or a retirement. Enters a 14-day cooldown. crisis_justification is REQUIRED for every kind — if the user cannot name the crisis, the change is not constitutional yet. ONLY call from a deliberate user-driven session, never autonomously. Follow read_protocol('goal-amendment') Section 1A. Returns {amendment_id, kind, cooldown_until}.",
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
      "NEVER call autonomously: ONLY when the user explicitly asks to commit a pending constitution amendment, after reading it back to them (read_protocol('goal-amendment') Section 1A). Apply a previously-proposed constitution amendment. Refuses unless cooldown_until has elapsed. Founding-period bypass: the first 5 lifetime kind='new' commits skip cooldown — sized for the typical 5-domain bootstrap, irreversible, counted from the audit log so retire/merge don't refund. Applies atomically: 'new' inserts a domain; 'amend' COALESCE-updates; 'synthesize' inserts the unified domain AND marks sources merged; 'retire' marks status='retired'. Returns {ok, constitution_domain_id, kind, bypassed_cooldown}.",
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

  // ── Goals (SMART layer, subordinate to constitution) ────────────────
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
      "ONLY call from a deliberate user-driven session, never autonomously (read_protocol('goal-amendment') Section 1B). Stage a SMART-goal change: new goal under a constitution_domain, amendment to an existing one, synthesis of reinforcing goals (must share the same domain), or status transitions 'achieve' (outcome reached) and 'abandon' (gave up). 72h cooldown. Re-parenting a goal between domains is NOT supported via amend — abandon + new under the new domain.",
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
      "NEVER call autonomously: ONLY when the user explicitly asks to commit a pending goal amendment, after reading it back to them (read_protocol('goal-amendment') Section 1B). Apply a previously-proposed goal amendment. Refuses unless 72h cooldown has elapsed. No founding bypass at this layer. 'new'/'synthesize' insert (subject to 3-per-domain cap); 'amend' COALESCE-updates; 'achieve' marks status='achieved'; 'abandon' marks status='abandoned'. Returns {ok, goal_id, kind}.",
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

  // ── Undertakings & cycles (existing layer, unchanged) ──────────────
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
      "ONLY call when the user explicitly commits to a new undertaking under an existing goal; confirm purpose, output target and test criteria with them first. Create a new undertaking. Must reference an active primary_goal_id (a SMART goal, not a constitution domain). secondary_goal_ids is a rare exception for undertakings serving multiple goals genuinely. kind defaults to 'outcome'. gtasks_parent_id can be set later via update_undertaking once the Google Tasks parent has been created.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        purpose: { type: 'string', minLength: 3, maxLength: 4000 },
        output_target: {
          type: 'string',
          minLength: 3,
          maxLength: 4000,
          description:
            'The deliverable produced (output, not outcome). What ships at the end. Outcome-level metrics live one layer up on the parent goal.',
        },
        test_criteria: {
          type: 'string',
          minLength: 3,
          maxLength: 4000,
          description:
            "For 'outcome' kind: how you know it shipped. For 'habit_forming': cadence + tolerance language (e.g. '5x/week with warm restart on misses').",
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
      required: ['name', 'purpose', 'output_target', 'test_criteria', 'primary_goal_id'],
    },
    handler: createUndertakingHandler,
  },
  {
    name: 'update_undertaking',
    description:
      "ONLY call on the user's explicit request. Partial update of an undertaking on whitelisted fields. Pass only the fields you want to change. Use to attach gtasks_parent_id once the Google Tasks parent is created, to mark status='completed'/'archived'/'sleeping', or to refine purpose/output_target/test_criteria. gtasks_parent_id and target_date support tri-state: omit = leave; null = clear; value = set.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        purpose: { type: 'string' },
        output_target: { type: 'string' },
        test_criteria: { type: 'string' },
        secondary_goal_ids: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'archived', 'sleeping'],
        },
        gtasks_parent_id: { anyOf: [{ type: 'string', maxLength: 255 }, { type: 'null' }] },
        target_date: {
          anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }],
        },
      },
      required: ['id'],
    },
    handler: updateUndertakingHandler,
  },
  {
    name: 'start_cycle',
    description:
      "ONLY call when the user explicitly starts a new 4-week cycle. Start a new 4-week cycle on a habit_forming undertaking. Refuses if the undertaking isn't kind='habit_forming' or if an active cycle already exists. Returns the new {cycle_id, cycle_number, end_date} (start_date is today; end_date is today + 28 days). Warm-restart-on-misses semantics live in the close_cycle reformulation, not here.",
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
      'ONLY call when the user explicitly closes a cycle after reviewing the streak data and reformulation notes with you. Close an active 4-week cycle. Captures streak_summary (free-form JSON — typically the longest streak, gaps, and observed-regularity numbers pulled from Google Tasks completion events on subtasks of the undertaking parent) and reformulation_notes (what to change about the design for the next cycle). Does NOT auto-start the next cycle — the user decides whether to start_cycle again, mark the undertaking sleeping (habit graduated), or evolve it into a different shape.',
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

  // ── Idea Parking Lot ──────────────────────────────────────
  // Curated raw material, one stage before work — NOT tasks. Capture is
  // one-way (park_idea); associations exist only through gardening
  // sessions the user starts (garden_ideas → propose_idea_links → the
  // user decides → decide_idea_links). Pull-only: never surface ideas
  // unprompted. Protocol: docs/idea-parking-lot-protocol.md, served as
  // second-brain://protocol/idea-parking-lot.
  {
    name: 'park_idea',
    description:
      "Librarian capture: file ONE idea into the user's Idea Parking Lot. ONLY call when the user explicitly asks to park/file an idea ('park this', 'add to my parking lot', 'file this idea'). Propose a short title and get the user's confirmation first. `thoughts` must be the user's own words copied verbatim — never paraphrase, summarize, translate or tidy them. Only add tags the user states. Capture is one-way: reply with the receipt only and do NOT search for, suggest or mention related ideas, links, hubs or neighbours — associations happen only in gardening sessions the user starts. Ideas are not tasks (no due dates or priorities). 'Save this session' means save_session, not this tool. read_protocol('idea-parking-lot') §1.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 500, description: 'Short title, confirmed with the user' },
        thoughts: { type: 'string', maxLength: 20000, description: "The user's own words, verbatim (may be omitted)" },
        why_interesting: { type: 'string', maxLength: 8000, description: 'Why the user finds it interesting, in their framing' },
        encountered_where: { type: 'string', maxLength: 2000, description: 'Where/how they encountered it (medium, place, conversation…)' },
        source: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri', maxLength: 2048 },
            title: { type: 'string', maxLength: 1000 },
            excerpt: { type: 'string', maxLength: 8000, description: 'The raw content that inspired the idea' },
          },
          additionalProperties: false,
        },
        framing: { type: 'string', maxLength: 12000, description: 'Optional AI-written framing — never the user\'s words' },
        tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, maxItems: 20 },
        captured_at: { type: 'string', format: 'date-time', description: 'Only if the user says the idea came earlier than now' },
        idempotency_key: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Any unique string; makes retries safe (a retry with the same title and content is also recognised)',
        },
        captured_via: {
          type: 'object',
          properties: { client: { type: 'string', maxLength: 100 }, model: { type: 'string', maxLength: 100 } },
          additionalProperties: false,
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: parkIdeaHandler,
  },
  {
    name: 'import_ideas',
    description:
      "One-time import of up to 25 ideas from the old Notion Idea Parking Lot or the Google Tasks 'Subjects' list. ONLY call while running the import protocol (§4) that the user explicitly started. Idempotent on (source_system, source_external_id): re-sent rows come back 'already_imported' and are not changed. Put the original row, verbatim, in import_payload. merge_into_idea_id attaches a duplicate source to an existing idea (earliest captured_at wins, tags union, one verbatim note) instead of creating a new one. captured_at accepts ISO 8601 or Notion's 'March 8, 2026 12:26 PM' form, read in `timezone` (IANA, DST-aware; preferred) or at default_utc_offset. notes_raw is split into dated notes on [YYYY-MM-DD] markers at the start of a line. Items are validated one by one: a bad item comes back as result 'error' without sinking the batch.",
    inputSchema: {
      type: 'object',
      properties: {
        source_system: { type: 'string', enum: ['notion', 'gtasks_subjects'] },
        timezone: { type: 'string', maxLength: 64, description: 'IANA zone the source displayed times in, e.g. "Europe/London" (DST-aware)' },
        default_utc_offset: {
          type: 'string',
          maxLength: 10,
          description: 'Fixed offset used when timezone is absent, e.g. "+08:00", "-05:00", "Z" (default "+00:00")',
        },
        captured_via: {
          type: 'object',
          properties: { client: { type: 'string', maxLength: 100 }, model: { type: 'string', maxLength: 100 } },
          additionalProperties: false,
        },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: {
            type: 'object',
            properties: {
              source_external_id: { type: 'string', minLength: 1, maxLength: 500 },
              import_payload: { type: 'object', description: 'The original row, verbatim' },
              merge_into_idea_id: { type: 'string', format: 'uuid' },
              title: { type: 'string', minLength: 1, maxLength: 500, description: 'Required unless merging' },
              captured_at: { type: 'string', maxLength: 100 },
              encountered_where: { type: 'string', maxLength: 2000 },
              source_url: { type: 'string', format: 'uri', maxLength: 2048 },
              source_title: { type: 'string', maxLength: 1000 },
              source_excerpt: { type: 'string', maxLength: 8000 },
              why_interesting: { type: 'string', maxLength: 8000 },
              framing: { type: 'string', maxLength: 12000 },
              thoughts: { type: 'string', maxLength: 20000 },
              tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, maxItems: 20 },
              status: { type: 'string', enum: ['parked', 'exploring', 'used', 'composted'] },
              notes_raw: { type: 'string', maxLength: 40000 },
            },
            required: ['source_external_id', 'import_payload'],
            additionalProperties: false,
          },
        },
      },
      required: ['source_system', 'items'],
      additionalProperties: false,
    },
    handler: importIdeasHandler,
  },
  {
    name: 'list_subjects_for_import',
    description:
      "Read the Google Tasks 'Subjects' list items (already synced into 2nd-brain) for the one-time import. ONLY call during the import protocol (§4). Each task shows already_imported, stale (not in the latest sync — probably deleted or moved; confirm with the user) and possible_duplicates (existing ideas with a similar title, each marked match 'exact' or 'contains'). Page with next_offset over the full list; only_not_imported shrinks as you import, so use it only for a final check. first_synced_at is approximate — Google Tasks has no creation date.",
    inputSchema: {
      type: 'object',
      properties: {
        include_completed: { type: 'boolean', default: true },
        only_not_imported: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    handler: listSubjectsForImportHandler,
  },
  {
    name: 'update_idea',
    description:
      "Edit a parked idea: fields (null clears), tags (replace, or add_tags/remove_tags), status (parked | exploring | used | composted — status changes are logged as a note), a synthesis's intent, or append a dated note. ONLY call on the user's explicit request, or to record a decision they just made in a gardening session. Only replace `thoughts` with words the user dictates; prefer append_note (by: 'simon' for their words, 'agent' for yours). Composting keeps the idea; there is no delete. read_protocol('idea-parking-lot') §2/§5.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string', minLength: 1, maxLength: 500, description: 'Cannot be blank' },
        encountered_where: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] },
        source_url: { anyOf: [{ type: 'string', format: 'uri', maxLength: 2048 }, { type: 'null' }] },
        source_title: { anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }] },
        source_excerpt: { anyOf: [{ type: 'string', maxLength: 8000 }, { type: 'null' }] },
        why_interesting: { anyOf: [{ type: 'string', maxLength: 8000 }, { type: 'null' }] },
        framing: { anyOf: [{ type: 'string', maxLength: 12000 }, { type: 'null' }] },
        thoughts: { anyOf: [{ type: 'string', maxLength: 20000 }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, maxItems: 20 },
        add_tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, maxItems: 20 },
        remove_tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, maxItems: 20 },
        status: { type: 'string', enum: ['parked', 'exploring', 'used', 'composted'] },
        intent: { type: 'string', enum: ['episode', 'essay', 'series', 'learning', 'undecided'] },
        append_note: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 8000 },
            by: { type: 'string', enum: ['simon', 'agent'] },
            at: { type: 'string', format: 'date-time' },
          },
          required: ['text', 'by'],
          additionalProperties: false,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: updateIdeaHandler,
  },
  {
    name: 'get_idea',
    description:
      'Fetch one idea with all fields, notes, provenance sources, accepted links in both directions (with rationale), pending-proposal count, parts (for a synthesis) / syntheses it is part of, and territory (territory = became an output, adjacent = revisits one, frontier = no output yet). Read-only. Use when the user asks about a specific idea or during gardening.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        include_payloads: { type: 'boolean', default: false, description: 'Include the original import rows' },
        include_pending: { type: 'boolean', default: false, description: 'List pending proposals too' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: getIdeaHandler,
  },
  {
    name: 'list_ideas',
    description:
      "Browse the Idea Parking Lot (pull-only — only when the user asks). Defaults to all statuses except composted, newest captured first. Filters: kind, tags (all must match), source_system, since/until (captured_at), unlinked (orphans: no accepted links), territory ('frontier' = no output link, 'adjacent' = only revisits an output, 'territory' = became an output), has_output. Read-only. read_protocol('idea-parking-lot') §5.",
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['parked', 'exploring', 'used', 'composted'] },
          minItems: 1,
        },
        kind: { type: 'string', enum: ['unit', 'synthesis'] },
        tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, maxItems: 20 },
        source_system: { type: 'string', enum: ['librarian', 'notion', 'gtasks_subjects', 'gardening'] },
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        unlinked: { type: 'boolean' },
        has_output: { type: 'boolean' },
        territory: { type: 'string', enum: ['frontier', 'adjacent', 'territory'] },
        sort: { type: 'string', enum: ['captured_at', 'updated_at'], default: 'captured_at' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    handler: listIdeasHandler,
  },
  {
    name: 'search_ideas',
    description:
      "Search the Idea Parking Lot (pull-only — when the user asks 'anything parked about X?'). Hybrid: semantic similarity over embedded ideas plus text matching across all fields (works for Chinese and for ideas filed seconds ago). Includes composted ideas by default. Do NOT use at capture time to suggest links or check duplicates for the user. Read-only. read_protocol('idea-parking-lot') §5.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['parked', 'exploring', 'used', 'composted'] },
          minItems: 1,
        },
        kind: { type: 'string', enum: ['unit', 'synthesis'] },
        min_similarity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.25,
          description: 'Drop semantic hits below this cosine similarity (text matches are always kept)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: searchIdeasHandler,
  },
  {
    name: 'garden_ideas',
    description:
      "Gardening step 1: pull CANDIDATE pairs to judge. ONLY call inside a gardening session the user explicitly started ('let's garden', 'tend my parking lot') — never at capture time. Modes: near (similar ideas, ≥0.50; ≥0.90 flagged possible_duplicate), band (0.30–0.45, the analogy zone for same_mechanism links), orphans (ideas with no accepted links + their nearest neighbours; newest first, paged), outputs (ideas vs the user's own published essays/episodes, ≥0.45, hinted became?/revisits?; 40 ideas per page). Global near/band passes cover the most recently updated ideas; focus_idea_id reaches any idea. Excludes pairs already proposed, accepted, rejected or retracted. Candidates are NOT links. Read-only. read_protocol('idea-parking-lot') §2.",
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['near', 'band', 'orphans', 'outputs'] },
        focus_idea_id: { type: 'string', format: 'uuid' },
        min_similarity: { type: 'number', minimum: -1, maximum: 1 },
        max_similarity: { type: 'number', minimum: -1, maximum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Default 12 (8 orphans in orphans mode)' },
        per_idea_cap: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          default: 2,
          description: 'Max candidates per idea (near/band/outputs)',
        },
        cross_domain: { type: 'boolean', description: 'Only pairs with no tag in common (near/band/orphans)' },
        order: { type: 'string', enum: ['newest', 'oldest'], default: 'newest', description: 'orphans/outputs: by captured_at' },
        offset: { type: 'integer', minimum: 0, default: 0, description: 'orphans/outputs paging (see paging.next_offset)' },
        include_statuses: {
          type: 'array',
          items: { type: 'string', enum: ['parked', 'exploring', 'used', 'composted'] },
          minItems: 1,
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    handler: gardenIdeasHandler,
  },
  {
    name: 'propose_idea_links',
    description:
      `Gardening step 2: stage up to 20 typed link PROPOSALS. ONLY call inside a gardening session the user started (origin 'gardening') or during the import protocol (origin 'import'). Proposals are not links until the user accepts them. Rationale: one line naming the specific shared mechanism, tension or dependency. Types: builds_on, example_of (directed idea→idea); part_of (idea→synthesis); tension_with, same_mechanism, combines_with, related (symmetric; related only when nothing specific fits); became, revisits (idea→public_artifact). Pairs the user rejected or retracted are refused unless reconsider_rejected=true, which you may set ONLY when the user explicitly asks to revisit them. read_protocol('idea-parking-lot') §2.`,
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', enum: ['gardening', 'import'] },
        proposed_via: {
          type: 'object',
          properties: { client: { type: 'string', maxLength: 100 }, model: { type: 'string', maxLength: 100 } },
          additionalProperties: false,
        },
        reconsider_rejected: { type: 'boolean', default: false },
        links: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              source_idea_id: { type: 'string', format: 'uuid' },
              target_idea_id: { type: 'string', format: 'uuid' },
              target_artifact_id: { type: 'string', format: 'uuid' },
              link_type: { type: 'string', enum: [...LINK_TYPES] },
              rationale: { type: 'string', minLength: 10, maxLength: 300, description: 'One line' },
              similarity: { type: 'number', minimum: -1, maximum: 1 },
            },
            required: ['source_idea_id', 'link_type', 'rationale'],
            additionalProperties: false,
          },
        },
      },
      required: ['origin', 'links'],
      additionalProperties: false,
    },
    handler: proposeIdeaLinksHandler,
  },
  {
    name: 'list_idea_links',
    description:
      'List idea links with both endpoints resolved. Defaults to pending proposals (status proposed) — call this first in a gardening session to clear old or imported proposals. Filter by statuses, idea_id, link_type or proposed_by. Read-only. read_protocol(\'idea-parking-lot\') §2.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { type: 'string', enum: [...LINK_STATUSES] }, minItems: 1 },
        idea_id: { type: 'string', format: 'uuid' },
        link_type: { type: 'string', enum: [...LINK_TYPES] },
        proposed_by: { type: 'string', enum: ['gardening', 'import', 'synthesis'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    handler: listIdeaLinksHandler,
  },
  {
    name: 'decide_idea_links',
    description:
      "Record the user's verdicts on link proposals. ONLY with decisions the user explicitly stated in this conversation — never accept or reject on their behalf, and leave unanswered proposals pending. accept (optionally retype with link_type, or reverse a directed link) | reject (remembered; the pair won't be re-proposed) | withdraw (YOU take back your own proposal — not a rejection) | retract (the user un-accepts an accepted link). read_protocol('idea-parking-lot') §2.",
    inputSchema: {
      type: 'object',
      properties: {
        decisions: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              link_id: { type: 'string', format: 'uuid' },
              decision: { type: 'string', enum: ['accept', 'reject', 'withdraw', 'retract'] },
              link_type: { type: 'string', enum: [...LINK_TYPES], description: 'Retype on accept' },
              reverse: { type: 'boolean', description: 'Swap direction of a directed idea→idea link on accept' },
              note: { type: 'string', maxLength: 1000 },
            },
            required: ['link_id', 'decision'],
            additionalProperties: false,
          },
        },
      },
      required: ['decisions'],
      additionalProperties: false,
    },
    handler: decideIdeaLinksHandler,
  },
  {
    name: 'create_synthesis',
    description:
      "Combine 2+ ideas into something bigger — an episode seed, essay, series or learning thread. ONLY call when the user explicitly decides to combine them; confirm the title, intent and parts with the user first. Creates a synthesis idea (status exploring by default) with accepted part_of links from each part. read_protocol('idea-parking-lot') §2.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 500 },
        intent: { type: 'string', enum: ['episode', 'essay', 'series', 'learning', 'undecided'] },
        part_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 2, maxItems: 30 },
        thoughts: { type: 'string', maxLength: 20000, description: "The user's own words, verbatim" },
        framing: { type: 'string', maxLength: 12000 },
        why_interesting: { type: 'string', maxLength: 8000 },
        tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, maxItems: 20 },
        status: { type: 'string', enum: ['parked', 'exploring', 'used', 'composted'] },
        part_rationales: {
          type: 'object',
          additionalProperties: { type: 'string', minLength: 3, maxLength: 300 },
          description: 'Map of part id → one-line reason it belongs',
        },
        captured_via: {
          type: 'object',
          properties: { client: { type: 'string', maxLength: 100 }, model: { type: 'string', maxLength: 100 } },
          additionalProperties: false,
        },
      },
      required: ['title', 'intent', 'part_ids'],
      additionalProperties: false,
    },
    handler: createSynthesisHandler,
  },
  {
    name: 'export_idea_map',
    description:
      "Export the curiosity map as graph data for visualisation — call when the user asks to see their idea map/graph, then render it with whatever visualisation tool you have. format: json (canonical idea-map/v1: nodes with degree, connected component and territory; typed edges with rationale; legend), graphml (Gephi / yEd / Cytoscape), mermaid (inline chat, ≤150 nodes). Focus on one idea with focus_idea_id + depth for an ego network. Accepted links only unless include_pending. Read-only. read_protocol('idea-parking-lot') §3.",
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'graphml', 'mermaid'], default: 'json' },
        focus_idea_id: { type: 'string', format: 'uuid' },
        depth: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['parked', 'exploring', 'used', 'composted'] },
          minItems: 1,
        },
        since: { type: 'string', format: 'date-time' },
        include_outputs: { type: 'boolean', default: true },
        include_pending: { type: 'boolean', default: false },
        include_isolated: { type: 'boolean', default: true },
        max_nodes: { type: 'integer', minimum: 10, maximum: 1000, default: 300 },
      },
      additionalProperties: false,
    },
    handler: exportIdeaMapHandler,
  },
  // ── Protocols ──────────────────────────────────────────────
  {
    name: 'read_protocol',
    description:
      "Read an executable protocol: 'idea-parking-lot' (capture §1, gardening §2, map §3, import §4, retrieval §5) or 'goal-amendment' (Section 1A constitution, Section 1B goals). Same text as the MCP resources second-brain://protocol/*, for clients without resource support. Call before using idea tools or proposing amendments; pass section (e.g. '§2', '1B') to fetch one part. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['idea-parking-lot', 'goal-amendment'] },
        section: { type: 'string', maxLength: 20, description: "Optional, e.g. '§1' or '1A'" },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: readProtocolHandler,
  },
];

export const tools: Tool[] = definitions.map((t) => ({
  ...t,
  title: TOOL_META[t.name]?.title ?? t.name,
  annotations: TOOL_META[t.name]?.annotations ?? CAUTIOUS,
}));

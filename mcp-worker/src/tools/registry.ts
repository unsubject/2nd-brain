import type { Env } from '../env';
import { searchBrainHandler } from './search_brain';
import { getEntryHandler } from './get_entry';
import { listRecentHandler } from './list_recent';
import { saveSessionHandler } from './save_session';
import { archiveSearchHandler } from './archive_search';
import { archiveSearchTextHandler } from './archive_search_text';
import { recordPickHandler } from './record_pick';
import { recordEpisodeLinkHandler } from './record_episode_link';
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
      'Fetch a single journal entry by id, including full text, summary, tags, and linked entities. Use after a search_brain hit when the user wants the full content.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', format: 'uuid', description: 'journal_entry.id' },
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
];

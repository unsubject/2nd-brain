import type { Env } from '../env';
import { searchBrainHandler } from './search_brain';

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

function notImplemented(name: string): Tool['handler'] {
  return async () => ({
    content: [{ type: 'text', text: `${name} is not yet implemented in this build` }],
    isError: true,
  });
}

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
    handler: notImplemented('get_entry'),
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
    handler: notImplemented('list_recent'),
  },
  {
    name: 'save_session',
    description:
      "Save an AI brainstorm session as a journal_entry on channel 'ai_chat'. ONLY call when the user explicitly asks ('save this', 'log this', 'save to my brain'). Never autonomously. Propose a title and confirm with the user before calling. Write the summary as a narrative (what we discussed, key insights, decisions, open questions) — not a transcript.",
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
    handler: notImplemented('save_session'),
  },
];

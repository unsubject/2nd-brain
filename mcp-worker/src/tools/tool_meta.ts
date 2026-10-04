// Display titles and MCP tool annotations for every tool. Clients may use
// the annotations to decide when to ask the user before calling (e.g.
// ChatGPT; Gemini CLI reads readOnlyHint; Gemini Spark unverified). Hints only — the server enforces nothing
// from them. test/schema-portability.test.ts checks every tool has an entry.

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

// destructiveHint defaults to true in the spec; say false explicitly so no
// client treats a read as dangerous.
const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };
const WRITE_DESTRUCTIVE: ToolAnnotations = { ...WRITE, destructiveHint: true };
const WRITE_DESTRUCTIVE_IDEMPOTENT: ToolAnnotations = { ...WRITE, destructiveHint: true, idempotentHint: true };

export const TOOL_META: Record<string, { title: string; annotations: ToolAnnotations }> = {
  // Journal & archive
  search_brain: { title: 'Search journal', annotations: READ },
  get_entry: { title: 'Get journal entry', annotations: READ },
  list_recent: { title: 'List recent journal entries', annotations: READ },
  save_session: { title: 'Save session to journal', annotations: WRITE },
  archive_search: { title: 'Search published archive (embedding)', annotations: READ },
  archive_search_text: { title: 'Search published archive', annotations: READ },
  record_pick: { title: 'Record editorial pick', annotations: WRITE },
  record_episode_link: { title: 'Link episode to pick', annotations: WRITE_DESTRUCTIVE_IDEMPOTENT },
  // Constitution & goals
  list_constitution_domains: { title: 'List constitution domains', annotations: READ },
  get_constitution_domain: { title: 'Get constitution domain', annotations: READ },
  propose_constitution_amendment: { title: 'Propose constitution amendment', annotations: WRITE },
  commit_constitution_amendment: { title: 'Commit constitution amendment', annotations: WRITE_DESTRUCTIVE },
  list_pending_constitution_amendments: { title: 'List pending constitution amendments', annotations: READ },
  list_goals: { title: 'List goals', annotations: READ },
  get_goal: { title: 'Get goal', annotations: READ },
  propose_goal_amendment: { title: 'Propose goal amendment', annotations: WRITE },
  commit_goal_amendment: { title: 'Commit goal amendment', annotations: WRITE_DESTRUCTIVE },
  list_pending_goal_amendments: { title: 'List pending goal amendments', annotations: READ },
  list_undertakings: { title: 'List undertakings', annotations: READ },
  get_undertaking: { title: 'Get undertaking', annotations: READ },
  create_undertaking: { title: 'Create undertaking', annotations: WRITE },
  update_undertaking: { title: 'Update undertaking', annotations: WRITE_DESTRUCTIVE_IDEMPOTENT },
  start_cycle: { title: 'Start habit cycle', annotations: WRITE },
  close_cycle: { title: 'Close habit cycle', annotations: WRITE_DESTRUCTIVE },
  // Idea Parking Lot
  park_idea: { title: 'Park an idea', annotations: WRITE_IDEMPOTENT },
  import_ideas: { title: 'Import ideas (one-time)', annotations: WRITE_IDEMPOTENT },
  list_subjects_for_import: { title: 'List Subjects for import', annotations: READ },
  update_idea: { title: 'Update idea', annotations: WRITE_DESTRUCTIVE },
  get_idea: { title: 'Get idea', annotations: READ },
  list_ideas: { title: 'List ideas', annotations: READ },
  search_ideas: { title: 'Search ideas', annotations: READ },
  garden_ideas: { title: 'Garden: find candidate pairs', annotations: READ },
  propose_idea_links: { title: 'Garden: propose links', annotations: WRITE },
  list_idea_links: { title: 'List idea links', annotations: READ },
  decide_idea_links: { title: 'Garden: record decisions', annotations: WRITE_DESTRUCTIVE },
  create_synthesis: { title: 'Create synthesis', annotations: WRITE },
  export_idea_map: { title: 'Export idea map', annotations: READ },
  // Protocols
  read_protocol: { title: 'Read protocol', annotations: READ },
};

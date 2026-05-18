// MCP `resources` registry. Unlike tools (actions with side effects),
// resources are read-only reference material addressed by URI. AI
// clients call `resources/list` to discover what's available and
// `resources/read` to fetch content. claude.ai and other MCP clients
// surface them in a resource picker; the protocol-driving AI can pull
// the doc into context at the start of a session.
//
// To add a doc: import it here (the wrangler Text rule turns markdown
// into a string at build time), append an entry to `resources`. No tool
// surface change.

import goalAmendmentInterview from '../../docs/goal-amendment-interview.md';

export type McpResource = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
};

export const resources: McpResource[] = [
  {
    uri: '2nd-brain://protocol/goal-amendment',
    name: 'Goal & Constitution Amendment Interview',
    description:
      'Executable protocol for constitution-domain amendments (Section 1A) and SMART-goal amendments (Section 1B), plus rationale and a cheat sheet. Read at the start of any session that touches list_constitution_domains, list_goals, or any propose/commit_*_amendment tool. Source of truth: docs/goal-amendment-interview.md in the repo.',
    mimeType: 'text/markdown',
    text: goalAmendmentInterview,
  },
];

export function listResources(): Array<Omit<McpResource, 'text'>> {
  return resources.map(({ uri, name, description, mimeType }) => ({
    uri,
    name,
    description,
    mimeType,
  }));
}

export function readResource(uri: string): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  const r = resources.find((res) => res.uri === uri);
  if (!r) {
    throw new ResourceNotFoundError(uri);
  }
  return {
    contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.text }],
  };
}

export class ResourceNotFoundError extends Error {
  constructor(public uri: string) {
    super(`Resource not found: ${uri}`);
  }
}

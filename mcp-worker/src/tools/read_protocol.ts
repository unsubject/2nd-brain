import { z } from 'zod';
import type { Env } from '../env';
import type { ToolResult } from './registry';
import { resources } from '../resources';

// The executable protocols as a tool, for clients that don't support MCP
// resources (e.g. agent-built connectors). Same text as resources/read.

export const PROTOCOLS = {
  'idea-parking-lot': 'second-brain://protocol/idea-parking-lot',
  'goal-amendment': 'second-brain://protocol/goal-amendment',
} as const;

const inputSchema = z
  .object({
    name: z.enum(['idea-parking-lot', 'goal-amendment']),
    section: z.string().min(1).max(20).optional(),
  })
  .strict();

type Section = { key: string; heading: string; text: string };

// Split a markdown doc on "## " headings. Keys: "§1" style or "Section 1A".
export function splitSections(doc: string): Section[] {
  const lines = doc.split('\n');
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (cur) out.push(cur);
      const heading = line.slice(3).trim();
      const m = /^(§\s*\d+[A-Za-z]?|Section\s+\d+[A-Za-z]?)/i.exec(heading);
      cur = { key: m ? m[1].replace(/\s+/g, ' ') : heading, heading, text: `${line}\n` };
    } else if (cur) {
      cur.text += `${line}\n`;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/^section\s*/, '').replace(/^§\s*/, '').trim();
}

export async function readProtocolHandler(rawArgs: unknown, _env: Env, _ctx: ExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
  }
  const { name, section } = parsed.data;
  const doc = resources.find((r) => r.uri === PROTOCOLS[name]);
  if (!doc) return { content: [{ type: 'text', text: `Protocol not found: ${name}` }], isError: true };
  if (!section) return { content: [{ type: 'text', text: doc.text }] };

  const sections = splitSections(doc.text);
  const want = normalizeKey(section);
  const hit = sections.find((s) => normalizeKey(s.key) === want);
  if (!hit) {
    const keys = sections.filter((s) => /^(§|Section)/i.test(s.key)).map((s) => s.key);
    return {
      content: [{ type: 'text', text: `Section "${section}" not found in ${name}. Available: ${keys.join(', ')}` }],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: hit.text.trimEnd() }] };
}

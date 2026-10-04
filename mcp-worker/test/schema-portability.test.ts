// Tool schemas have to load in every client Simon uses: Claude (web,
// Desktop, Code), ChatGPT, Cursor, Gemini CLI, Gemini Spark and Meta
// Muse. These are the lowest common denominators we know of.

import { describe, it, expect } from 'vitest';
import { tools } from '../src/tools/registry';
import { TOOL_META } from '../src/tools/tool_meta';
import { INSTRUCTIONS } from '../src/mcp';

function walk(node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, visit, `${path}[${i}]`));
  } else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>, path);
    for (const [k, v] of Object.entries(node)) walk(v, visit, `${path}.${k}`);
  }
}

describe('tool schema portability', () => {
  it('stays under Cursor’s ~40-tool limit', () => {
    expect(tools.length).toBeLessThanOrEqual(40);
  });

  it('keeps INSTRUCTIONS under Claude Code’s 2,048-character cut-off', () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
  });

  for (const t of tools) {
    describe(t.name, () => {
      it('has a portable name and a bounded description', () => {
        expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
        expect(t.description.length).toBeGreaterThan(20);
        expect(t.description.length).toBeLessThanOrEqual(2048);
      });

      it('has an object input schema with no type arrays or references', () => {
        const schema = t.inputSchema as Record<string, unknown>;
        expect(schema.type).toBe('object');
        walk(schema, (n, path) => {
          expect(Array.isArray(n.type), `${path}.type is an array`).toBe(false);
          expect(n, `${path} uses $ref`).not.toHaveProperty('$ref');
          expect(n, `${path} uses $defs`).not.toHaveProperty('$defs');
          expect(n, `${path} uses definitions`).not.toHaveProperty('definitions');
        });
      });

      it('carries a title and complete annotations', () => {
        expect(TOOL_META[t.name], 'missing from TOOL_META').toBeDefined();
        expect(t.title.length).toBeGreaterThan(0);
        for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
          expect(typeof t.annotations[k], `${k}`).toBe('boolean');
        }
        if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint).toBe(false);
      });

      if (!TOOL_META[t.name]?.annotations.readOnlyHint) {
        it('states when (not) to call it within the first 300 characters', () => {
          // Clients that truncate descriptions must still see the guard.
          expect(t.description.slice(0, 300)).toMatch(/\b(ONLY|NEVER)\b/);
        });
      }
    });
  }

  it('has no TOOL_META entries for tools that do not exist', () => {
    const names = new Set(tools.map((t) => t.name));
    expect(Object.keys(TOOL_META).filter((k) => !names.has(k))).toEqual([]);
  });
});

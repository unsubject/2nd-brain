// Static guards for two postgres-js pitfalls on this stack (fetch_types:false):
//  - `${JSON.stringify(x)}::jsonb` stores a JSON *string*, not an object
//    (use sql.json / jsonParam);
//  - `tags @> ${jsArray}` sends "a,b" and fails as a malformed array
//    literal (use textArray).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url).href);
const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts'))
  // Comments may quote the bad patterns; only code counts.
  .map((f) => ({
    name: f,
    text: readFileSync(join(SRC, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  }));

describe('SQL binding conventions', () => {
  it('scans the Worker sources', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('never casts a JSON.stringify result to jsonb', () => {
    const offenders = files.filter((f) => /\$\{[^}]*JSON\.stringify\([^}]*\}\s*::\s*jsonb/.test(f.text)).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('never binds a raw array to an array containment operator', () => {
    const offenders = files
      .filter((f) => /(@>|<@|&&)\s*\$\{(?!\s*(textArray|jsonParam)\()/.test(f.text))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});

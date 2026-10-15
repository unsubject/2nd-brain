// Tables the refocus (docs/decisions/2026-10-05-refocus.md) retires: Phase 3
// drops the contacts, calendar and COS output tables, and email_ref has been
// empty since migration 024. Code that reads a table has to change before
// the migration that drops it, and the Worker deploys on merge while
// migrations run only when the monolith boots, so no Worker code may name
// them. task_ref and project_ref join the list in Phase 7, once get_entry's
// task links and list_subjects_for_import are gone.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RETIRED = ['person_ref', 'calendar_event_ref', 'email_ref', 'morning_review', 'editorial_pick', 'task_suggestion'];

const SRC = fileURLToPath(new URL('../src/', import.meta.url).href);
const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts'))
  // Comments may name them; only code counts.
  .map((f) => ({
    name: f,
    text: readFileSync(join(SRC, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
  }));

describe('retired tables', () => {
  it('scans the Worker sources', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('are named nowhere in Worker code', () => {
    const offenders = files.flatMap((f) =>
      RETIRED.filter((t) => new RegExp(`\\b${t}\\b`).test(f.text)).map((t) => `${f.name}: ${t}`),
    );
    expect(offenders).toEqual([]);
  });
});

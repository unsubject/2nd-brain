import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, callTool, ok, resetIdeaData, seedSubjects, TEST_DB } from './helpers';

afterAll(() => admin.end({ timeout: 5 }));

// Synthetic rows only — the repo is public.
const notionRow = (title: string, extra: Record<string, string> = {}) => ({
  Idea: title,
  Added: 'March 8, 2026 12:26 PM',
  Horizon: 'Evergreen',
  'Next Step': '',
  Notes: '',
  Priority: '',
  'Related Project': '',
  'Source / Trigger': '',
  'What is it?': '',
  'What it is NOT': '',
  'Why it matters': '',
  ...extra,
});

describe.skipIf(!TEST_DB)('import_ideas', () => {
  beforeEach(resetIdeaData);

  it('creates ideas from mapped rows, idempotently, with a lossless payload', async () => {
    const row = notionRow('Synthetic idea, with "quotes" \\ and 中文', {
      Notes: '[2026-03-10] Developed further.\n[2026-03-11] CLUSTER NOTE: grouped.',
      'Why it matters': 'Because.',
    });
    const item = {
      source_external_id: `${row.Added}|${row.Idea}`,
      import_payload: row,
      title: row.Idea,
      captured_at: row.Added,
      why_interesting: row['Why it matters'],
      framing: 'What it is.\n\nWhat it is NOT: not this.',
      tags: ['time-sensitive', 'project:Series, "one"', 'back\\slash', '中文標籤'],
      status: 'used',
      notes_raw: `Related Project: A series\n\n${row.Notes}`,
    };
    const r1 = await ok('import_ideas', { source_system: 'notion', default_utc_offset: '+08:00', items: [item] });
    expect(r1.counts).toEqual({ created: 1, merged: 0, already_imported: 0, error: 0 });
    const id = r1.results[0].idea_id;

    const row1 = await admin`
      SELECT title, status, captured_at, tags, notes, why_interesting, framing
        FROM idea WHERE id = ${id}
    `;
    expect(row1[0].title).toBe(row.Idea);
    expect(row1[0].status).toBe('used');
    expect(new Date(row1[0].captured_at).toISOString()).toBe('2026-03-08T04:26:00.000Z');
    expect(row1[0].tags).toEqual(['time-sensitive', 'project:Series, "one"', 'back\\slash', '中文標籤']);
    expect(row1[0].notes.map((n: any) => [n.at.slice(0, 10), n.by, n.text])).toEqual([
      ['2026-03-08', 'import', 'Related Project: A series'],
      ['2026-03-10', 'import', 'Developed further.'],
      ['2026-03-11', 'import', 'CLUSTER NOTE: grouped.'],
    ]);

    const src = await admin`
      SELECT source_system, jsonb_typeof(import_payload) AS t, import_payload
        FROM idea_source WHERE idea_id = ${id}
    `;
    expect(src[0].source_system).toBe('notion');
    expect(src[0].t).toBe('object'); // not a double-encoded string (PR #63 regression)
    expect(src[0].import_payload).toEqual(row);

    const r2 = await ok('import_ideas', { source_system: 'notion', default_utc_offset: '+08:00', items: [item] });
    expect(r2.counts.already_imported).toBe(1);
    expect(r2.results[0].idea_id).toBe(id);
    const n = await admin`SELECT count(*)::int AS n FROM idea`;
    expect(n[0].n).toBe(1);
  });

  it('merges a duplicate source into an existing idea', async () => {
    const created = await ok('import_ideas', {
      source_system: 'notion',
      default_utc_offset: '+00:00',
      items: [
        {
          source_external_id: 'n-1',
          import_payload: notionRow('Shared idea'),
          title: 'Shared idea',
          captured_at: 'March 8, 2026 12:26 PM',
          tags: ['a'],
        },
      ],
    });
    const id = created.results[0].idea_id;
    const merged = await ok('import_ideas', {
      source_system: 'gtasks_subjects',
      items: [
        {
          source_external_id: 'task-1',
          import_payload: { title: 'Shared idea', notes: 'my own words' },
          merge_into_idea_id: id,
          title: 'Shared idea',
          thoughts: 'my own words',
          captured_at: '2026-01-05T00:00:00Z',
          tags: ['b', 'a'],
        },
      ],
    });
    expect(merged.counts.merged).toBe(1);
    const row = await admin`SELECT captured_at, tags, notes FROM idea WHERE id = ${id}`;
    expect(new Date(row[0].captured_at).toISOString()).toBe('2026-01-05T00:00:00.000Z'); // earliest wins
    expect([...row[0].tags].sort()).toEqual(['a', 'b']);
    expect(row[0].notes).toHaveLength(1);
    expect(row[0].notes[0].by).toBe('simon');
    expect(row[0].notes[0].text).toContain('my own words');
    const sources = await admin`SELECT source_system, merged FROM idea_source WHERE idea_id = ${id} ORDER BY imported_at`;
    expect(sources.map((s) => [s.source_system, s.merged])).toEqual([
      ['notion', false],
      ['gtasks_subjects', true],
    ]);
  });

  it('reports per-item errors without failing the batch', async () => {
    const r = await ok('import_ideas', {
      source_system: 'notion',
      items: [
        { source_external_id: 'bad-date', import_payload: {}, title: 'X', captured_at: 'someday' },
        { source_external_id: 'no-title', import_payload: {} },
        { source_external_id: 'bad-merge', import_payload: {}, merge_into_idea_id: '00000000-0000-0000-0000-000000000000' },
        { source_external_id: 'good', import_payload: {}, title: 'Fine' },
      ],
    });
    expect(r.counts).toEqual({ created: 1, merged: 0, already_imported: 0, error: 3 });
    expect(r.results.map((x: any) => x.result)).toEqual(['error', 'error', 'error', 'created']);
    const bad = await callTool('import_ideas', { source_system: 'notion', default_utc_offset: 'PST', items: [] });
    expect(bad.isError).toBe(true);
  });
});

describe.skipIf(!TEST_DB)('list_subjects_for_import', () => {
  beforeEach(resetIdeaData);

  it("lists the Subjects list (user 'default' rows), flags imports and possible duplicates", async () => {
    await seedSubjects([
      { id: 't1', title: 'Shared idea', notes: 'n1' },
      { id: 't2', title: 'Fresh subject' },
      { id: 't3', title: 'Child', parent: 't2', status: 'completed' },
      { id: 't4', title: 'Family thing', scope: 'family' },
    ]);
    await ok('import_ideas', {
      source_system: 'notion',
      items: [{ source_external_id: 'n-1', import_payload: {}, title: 'Shared Idea!' }],
    });
    const fresh = await ok('import_ideas', {
      source_system: 'gtasks_subjects',
      items: [{ source_external_id: 't2', import_payload: {}, title: 'Fresh subject' }],
    });

    const all = await ok('list_subjects_for_import', {});
    expect(all.total).toBe(3); // family-scope and other lists excluded
    const byId = new Map<string, any>(all.tasks.map((t: any) => [t.external_task_id, t]));
    expect(byId.get('t1').possible_duplicates.map((d: any) => d.title)).toEqual(['Shared Idea!']);
    expect(byId.get('t1').possible_duplicates[0].source_systems).toEqual(['notion']);
    expect(byId.get('t2').already_imported).toBe(true);
    expect(byId.get('t2').imported_idea_id).toBe(fresh.results[0].idea_id);
    expect(byId.get('t3').parent_title).toBe('Fresh subject');
    expect(byId.get('t1').list_title).toBe('Subjects');

    const pending = await ok('list_subjects_for_import', { only_not_imported: true, include_completed: false });
    expect(pending.tasks.map((t: any) => t.external_task_id)).toEqual(['t1']);
  });
});

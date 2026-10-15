import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  admin,
  callTool,
  ok,
  resetAuthData,
  resetIdeaData,
  seedIdea,
  seedPat,
  seedSubjects,
  TEST_DB,
  USER,
} from './helpers';

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
    expect(r1.counts).toEqual({ created: 1, merged: 0, already_imported: 0, error: 0, promoted: 0 });
    expect(r1.results[0].promotion).toBeUndefined();
    const id = r1.results[0].idea_id;

    const row1 = await admin`
      SELECT title, status, captured_at, tags, notes, why_interesting, framing
        FROM idea WHERE id = ${id}
    `;
    expect(row1[0].title).toBe(row.Idea);
    expect(row1[0].status).toBe('used');
    expect(new Date(row1[0].captured_at).toISOString()).toBe('2026-03-08T04:26:00.000Z');
    expect(row1[0].tags).toEqual(['time-sensitive', 'project:Series, "one"', 'back\\slash', '中文標籤']);
    // Dated notes sit at local midnight in the import's zone (+08:00).
    expect(row1[0].notes.map((n: any) => [n.at, n.by, n.text])).toEqual([
      ['2026-03-08T04:26:00.000Z', 'import', 'Related Project: A series'],
      ['2026-03-09T16:00:00.000Z', 'import', 'Developed further.'],
      ['2026-03-10T16:00:00.000Z', 'import', 'CLUSTER NOTE: grouped.'],
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
    await seedSubjects([{ id: 'task-1', title: 'Shared idea', notes: 'my own words' }]);
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
    // The task's words, then the promotion the merge recorded (below).
    expect(row[0].notes.map((n: any) => n.by)).toEqual(['simon', 'system', 'system']);
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
    expect(r.counts).toEqual({ created: 1, merged: 0, already_imported: 0, error: 3, promoted: 0 });
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
    expect(byId.get('t2').imported_idea_promoted).toEqual({ at: byId.get('t2').first_synced_at, title: 'Fresh subject' });
    expect(byId.get('t1').imported_idea_promoted).toBeNull();
    expect(byId.get('t3').parent_title).toBe('Fresh subject');
    expect(byId.get('t1').list_title).toBe('Subjects');

    const pending = await ok('list_subjects_for_import', { only_not_imported: true, include_completed: false });
    expect(pending.tasks.map((t: any) => t.external_task_id)).toEqual(['t1']);
  });
});

// Subjects items are recorded as promoted (refocus D1, D2, D15), from the
// synced task_ref row: promoted_at is its first_synced_at, promoted_title
// its title. Synthetic rows only.
describe.skipIf(!TEST_DB)('import_ideas records Subjects items as promoted', () => {
  beforeEach(async () => {
    await resetAuthData();
    await resetIdeaData();
  });

  const SYNCED = '2026-01-05T09:30:00.000Z';
  const as = (token: string) => async (name: string, args: unknown) => {
    const r = await callTool(name, args, { token });
    if (r.isError) throw new Error(`${name}: ${r.texts.join(' ')}`);
    return r.json;
  };
  const importer = async () => as((await seedPat('Importer')).token);
  const ideaOf = async (id: string) => (await ok('get_idea', { id })).idea;
  const systemNotes = (idea: any) =>
    idea.notes.filter((n: any) => n.by === 'system').map((n: any) => [n.text, n.credential]);

  it('a new import records the promotion at first_synced_at and stays in the inbox', async () => {
    await seedSubjects([
      { id: 'p1', title: '  Episode: tides  ', notes: 'My own words.', syncedAt: SYNCED },
      { id: 'p2', title: 'Finished subject', status: 'completed', syncedAt: SYNCED },
    ]);
    const imp = await importer();
    const r = await imp('import_ideas', {
      source_system: 'gtasks_subjects',
      captured_via: { client: 'synthetic-client' },
      items: [
        {
          source_external_id: 'p1',
          import_payload: { external_task_id: 'p1', title: '  Episode: tides  ', first_synced_at: SYNCED },
          title: 'Episode: tides',
          thoughts: 'My own words.',
          captured_at: SYNCED,
        },
        // The status the user chose at Step 0 for completed tasks wins over D15.
        {
          source_external_id: 'p2',
          import_payload: { external_task_id: 'p2', title: 'Finished subject' },
          title: 'Finished subject',
          captured_at: SYNCED,
          status: 'used',
          tags: ['gtasks:completed'],
        },
      ],
    });
    expect(r.counts).toEqual({ created: 2, merged: 0, already_imported: 0, error: 0, promoted: 2 });
    expect(r.results.map((x: any) => x.promotion)).toEqual(['recorded', 'recorded']);

    const idea = await ideaOf(r.results[0].idea_id);
    expect(idea).toMatchObject({
      title: 'Episode: tides',
      status: 'exploring',
      captured_at: SYNCED,
      promoted: { at: SYNCED, title: 'Episode: tides' },
      inbox: true,
      reviewed_at: null,
      thoughts: 'My own words.',
    });
    // Attribution: the importing connection on the capture and on the note.
    expect(idea.captured_via).toEqual({ client: 'synthetic-client', role: 'importer', credential: 'Importer' });
    expect(systemNotes(idea)).toEqual([['promoted to Subjects as "Episode: tides" (Subjects import)', 'Importer']]);
    expect(idea.edit_log).toEqual([]);

    const used = await ideaOf(r.results[1].idea_id);
    expect(used).toMatchObject({ status: 'used', inbox: true, promoted: { at: SYNCED, title: 'Finished subject' } });

    const inbox = await ok('list_ideas', { inbox: true, promoted: true });
    expect(inbox.ideas.map((i: any) => i.title).sort()).toEqual(['Episode: tides', 'Finished subject']);
  });

  it('a re-run changes nothing', async () => {
    await seedSubjects([{ id: 'r1', title: 'Rerun subject', syncedAt: SYNCED }]);
    const item = { source_external_id: 'r1', import_payload: {}, title: 'Rerun subject', captured_at: SYNCED };
    const first = await ok('import_ideas', { source_system: 'gtasks_subjects', items: [item] });
    const id = first.results[0].idea_id;
    const read = () =>
      admin`SELECT status, notes, edit_log, updated_at, reviewed_at, promoted_at, promoted_title FROM idea WHERE id = ${id}`;
    const before = await read();

    const again = await ok('import_ideas', { source_system: 'gtasks_subjects', items: [item, item] });
    expect(again.counts).toEqual({ created: 0, merged: 0, already_imported: 2, error: 0, promoted: 0 });
    expect(again.results[0]).toMatchObject({ result: 'already_imported', idea_id: id, promotion: 'already_recorded' });
    expect(await read()).toEqual(before);
    const n = await admin`SELECT (SELECT count(*)::int FROM idea) AS ideas, (SELECT count(*)::int FROM idea_source) AS sources`;
    expect(n[0]).toEqual({ ideas: 1, sources: 1 });

    // A promotion the user cleared stays cleared when the item comes again.
    await ok('update_idea', { id, promoted: null });
    const cleared = await read();
    const third = await ok('import_ideas', { source_system: 'gtasks_subjects', items: [item] });
    expect(third.counts.promoted).toBe(0);
    expect(third.results[0]).toMatchObject({ result: 'already_imported', promotion: 'cleared' });
    expect(await read()).toEqual(cleared);
    expect(cleared[0]).toMatchObject({ promoted_at: null, promoted_title: null });
  });

  it('a merge into an unpromoted earlier import records the promotion; later merges keep it', async () => {
    const notion = await ok('import_ideas', {
      source_system: 'notion',
      items: [{ source_external_id: 'n-1', import_payload: {}, title: 'Tides and moons', captured_at: '2026-03-01T00:00:00Z', tags: ['a'] }],
    });
    const id = notion.results[0].idea_id;
    expect(await ideaOf(id)).toMatchObject({ status: 'parked', promoted: null, inbox: true });
    await seedSubjects([
      { id: 'm1', title: 'Tides and moons', syncedAt: SYNCED },
      { id: 'm2', title: 'Moons, again', syncedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'm3', title: 'A sub-point', parent: 'm1', syncedAt: SYNCED },
    ]);
    const imp = await importer();

    const r = await imp('import_ideas', {
      source_system: 'gtasks_subjects',
      items: [
        { source_external_id: 'm1', import_payload: {}, merge_into_idea_id: id, title: 'Tides and moons', captured_at: SYNCED, tags: ['b'] },
      ],
    });
    expect(r.counts).toEqual({ created: 0, merged: 1, already_imported: 0, error: 0, promoted: 1 });
    expect(r.results[0].promotion).toBe('recorded');
    const idea = await ideaOf(id);
    expect(idea).toMatchObject({
      status: 'exploring',
      captured_at: SYNCED,
      tags: ['a', 'b'],
      promoted: { at: SYNCED, title: 'Tides and moons' },
      inbox: true,
      reviewed_at: null,
    });
    expect(systemNotes(idea)).toEqual([
      ['promoted to Subjects as "Tides and moons" (Subjects import)', 'Importer'],
      ['status: parked → exploring', 'Importer'],
    ]);
    expect(idea.edit_log).toEqual([
      expect.objectContaining({ credential: 'Importer', tool: 'import_ideas', fields: ['promoted', 'status'] }),
    ]);

    // A second task merged in keeps the first promotion and ignores its
    // status; a subtask merged into its parent records none.
    const more = await imp('import_ideas', {
      source_system: 'gtasks_subjects',
      items: [
        { source_external_id: 'm2', import_payload: {}, merge_into_idea_id: id, title: 'Moons, again', status: 'used' },
        { source_external_id: 'm3', import_payload: {}, merge_into_idea_id: id, title: 'A sub-point' },
      ],
    });
    expect(more.counts).toEqual({ created: 0, merged: 2, already_imported: 0, error: 0, promoted: 0 });
    expect(more.results.map((x: any) => x.promotion)).toEqual(['already_recorded', undefined]);
    const after = await ideaOf(id);
    expect(after).toMatchObject({ status: 'exploring', promoted: { at: SYNCED, title: 'Tides and moons' }, inbox: true });
    expect(systemNotes(after)).toHaveLength(2);
    expect(after.edit_log).toHaveLength(3);
    expect(after.edit_log.at(-1).fields).toBeUndefined();
  });

  it('merges follow D15: composted comes back, used stays, a review is kept, an explicit status applies', async () => {
    const composted = await seedIdea('Let go once');
    await ok('update_idea', { id: composted, status: 'composted' });
    const used = await seedIdea('Became an episode');
    await ok('update_idea', { id: used, status: 'used', reviewed: true });
    const target = await seedIdea('Done with this');
    const neighbour = await seedIdea('A neighbour');
    await admin`
      INSERT INTO idea_link (user_id, source_idea_id, target_idea_id, link_type, rationale, proposed_by, proposed_via)
      VALUES (${USER}, ${target}, ${neighbour}, 'builds_on', 'A synthetic one-line gloss', 'import', ${admin.json({ credential: 'master' })})
    `;
    await seedSubjects([
      { id: 'c1', title: 'Let go once', syncedAt: SYNCED },
      { id: 'c2', title: 'Became an episode', syncedAt: SYNCED },
      { id: 'c3', title: 'Done with this', status: 'completed', syncedAt: SYNCED },
    ]);
    const r = await ok('import_ideas', {
      source_system: 'gtasks_subjects',
      items: [
        { source_external_id: 'c1', import_payload: {}, merge_into_idea_id: composted },
        { source_external_id: 'c2', import_payload: {}, merge_into_idea_id: used },
        { source_external_id: 'c3', import_payload: {}, merge_into_idea_id: target, status: 'composted' },
      ],
    });
    expect(r.counts).toEqual({ created: 0, merged: 3, already_imported: 0, error: 0, promoted: 3 });

    expect(await ideaOf(composted)).toMatchObject({ status: 'exploring', inbox: true, promoted: { title: 'Let go once' } });
    const u = await ideaOf(used);
    expect(u).toMatchObject({ status: 'used', inbox: false, promoted: { title: 'Became an episode' } });
    expect(u.reviewed_at).not.toBeNull();
    expect(u.edit_log.at(-1).fields).toEqual(['promoted']);
    // Composting withdraws the idea's pending proposals, as update_idea does.
    expect(await ideaOf(target)).toMatchObject({ status: 'composted', promoted: { title: 'Done with this' } });
    const [link] = await admin`SELECT status, decision_note FROM idea_link WHERE source_idea_id = ${target}`;
    expect(link).toEqual({ status: 'withdrawn', decision_note: 'endpoint composted' });
  });

  it('a task an earlier pass imported unpromoted gets its promotion when re-sent, once', async () => {
    await seedSubjects([
      { id: 'b1', title: 'Backfilled subject', syncedAt: SYNCED },
      { id: 'b2', title: 'Its child', parent: 'b1', syncedAt: SYNCED },
    ]);
    // What a pass from before promotions were recorded left behind.
    const [old] = await admin<Array<{ id: string }>>`
      INSERT INTO idea (user_id, title, captured_at, captured_via)
      VALUES (${USER}, 'Backfilled subject', ${SYNCED}, ${admin.json({ role: 'importer', credential: 'Earlier' })})
      RETURNING id
    `;
    await admin`
      INSERT INTO idea_source (idea_id, user_id, source_system, source_external_id, import_payload, merged)
      VALUES (${old.id}, ${USER}, 'gtasks_subjects', 'b1', ${admin.json({})}, false),
             (${old.id}, ${USER}, 'gtasks_subjects', 'b2', ${admin.json({})}, true)
    `;
    const listed = await ok('list_subjects_for_import', {});
    expect(listed.tasks.find((t: any) => t.external_task_id === 'b1')).toMatchObject({
      already_imported: true,
      imported_idea_promoted: null,
    });

    const imp = await importer();
    const items = [
      { source_external_id: 'b1', import_payload: {}, title: 'Backfilled subject', captured_at: SYNCED },
      { source_external_id: 'b2', import_payload: {}, merge_into_idea_id: old.id },
    ];
    const r = await imp('import_ideas', { source_system: 'gtasks_subjects', items });
    expect(r.counts).toEqual({ created: 0, merged: 0, already_imported: 2, error: 0, promoted: 1 });
    expect(r.results.map((x: any) => x.promotion)).toEqual(['recorded', undefined]);
    const idea = await ideaOf(old.id);
    expect(idea).toMatchObject({
      status: 'exploring',
      promoted: { at: SYNCED, title: 'Backfilled subject' },
      inbox: true,
      captured_via: { role: 'importer', credential: 'Earlier' },
    });
    expect(systemNotes(idea)).toEqual([
      ['promoted to Subjects as "Backfilled subject" (Subjects import)', 'Importer'],
      ['status: parked → exploring', 'Importer'],
    ]);
    expect(idea.edit_log).toEqual([
      expect.objectContaining({ credential: 'Importer', tool: 'import_ideas', fields: ['promoted', 'status'] }),
    ]);

    const again = await imp('import_ideas', { source_system: 'gtasks_subjects', items });
    expect(again.counts.promoted).toBe(0);
    expect(again.results[0].promotion).toBe('already_recorded');
    expect((await ideaOf(old.id)).edit_log).toHaveLength(1);

    const relisted = await ok('list_subjects_for_import', {});
    expect(relisted.tasks.find((t: any) => t.external_task_id === 'b1').imported_idea_promoted).toEqual({
      at: SYNCED,
      title: 'Backfilled subject',
    });
  });

  it('a long task title is trimmed and cut to 500 characters for the promotion', async () => {
    // 13 + 480 + 20 code points before the tail; the cut lands inside the
    // run of astral characters and must not split one.
    const long = `  Long subject ${'潮'.repeat(480)}${'🌊'.repeat(20)} and a tail  `;
    await seedSubjects([{ id: 'l1', title: long, syncedAt: SYNCED }]);
    const r = await ok('import_ideas', {
      source_system: 'gtasks_subjects',
      items: [
        // The idea title is limited to 500 too, so the agent shortens it;
        // the full title travels in import_payload.
        { source_external_id: 'l1', import_payload: { title: long }, title: `Long subject ${'潮'.repeat(480)}`, captured_at: SYNCED },
      ],
    });
    expect(r.results[0]).toMatchObject({ result: 'created', promotion: 'recorded' });
    const expected = `Long subject ${'潮'.repeat(480)}${'🌊'.repeat(7)}`;
    const [row] = await admin`
      SELECT promoted_title, char_length(promoted_title) AS n, promoted_at FROM idea WHERE id = ${r.results[0].idea_id}
    `;
    expect(row.promoted_title).toBe(expected);
    expect(row.n).toBe(500);
    expect(new Date(row.promoted_at).toISOString()).toBe(SYNCED);
    const [src] = await admin`SELECT import_payload FROM idea_source WHERE source_external_id = 'l1'`;
    expect(src.import_payload.title).toBe(long);
  });

  it('refuses an item that is not a synced Subjects task, without sinking the batch', async () => {
    await seedSubjects([
      { id: 'real', title: 'Real subject' },
      { id: 'fam', title: 'Family subject', scope: 'family' },
    ]);
    const r = await ok('import_ideas', {
      source_system: 'gtasks_subjects',
      items: [
        { source_external_id: 'missing', import_payload: {}, title: 'Ghost' },
        { source_external_id: 'fam', import_payload: {}, title: 'Family subject' },
        { source_external_id: 'real', import_payload: {}, title: 'Real subject' },
      ],
    });
    expect(r.counts).toEqual({ created: 1, merged: 0, already_imported: 0, error: 2, promoted: 1 });
    expect(r.results[0].error).toMatch(/^not_found: /);
    expect(r.results[1].error).toMatch(/^not_found: /);
  });

  it('list_subjects_for_import matches a task against promoted titles too', async () => {
    const tides = await seedIdea('Tides');
    await ok('update_idea', { id: tides, promoted: { title: 'Episode: tides angle', at: '2026-02-01T00:00:00Z' } });
    const same = await seedIdea('Episode: tides angle');
    await seedSubjects([{ id: 's1', title: 'Episode: tides angle' }]);
    const listed = await ok('list_subjects_for_import', {});
    const task = listed.tasks.find((t: any) => t.external_task_id === 's1');
    expect(task.imported_idea_promoted).toBeNull();
    const byIdea = new Map<string, any>(task.possible_duplicates.map((d: any) => [d.idea_id, d]));
    expect(byIdea.get(tides)).toMatchObject({
      title: 'Tides',
      match: 'exact',
      matched_on: 'promoted_title',
      promoted: { at: '2026-02-01T00:00:00.000Z', title: 'Episode: tides angle' },
    });
    expect(byIdea.get(same)).toMatchObject({ match: 'exact', matched_on: 'title', promoted: null });
  });
});

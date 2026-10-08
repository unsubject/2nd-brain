import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, axis, callTool, mix, ok, resetIdeaData, seedArtifact, seedIdea, seedSubjects, setEmbedding, TEST_DB } from './helpers';

afterAll(() => admin.end({ timeout: 5 }));

// Regression tests for the review findings fixed after v1.

describe.skipIf(!TEST_DB)('capture fixes', () => {
  beforeEach(resetIdeaData);

  it('same title with different thoughts is a new idea, even under a fresh key', async () => {
    const a = await ok('park_idea', { title: 'Same title', thoughts: 'first angle', idempotency_key: 'k1' });
    const b = await ok('park_idea', { title: 'Same title', thoughts: 'second angle', idempotency_key: 'k2' });
    expect(b.idea_id).not.toBe(a.idea_id);
    expect(b.deduplicated).toBe(false);
    const c = await ok('park_idea', { title: 'Same title', thoughts: 'second angle', idempotency_key: 'k3' });
    expect(c.idea_id).toBe(b.idea_id); // a retry with a regenerated key
    expect(c.deduplicated).toBe(true);
    const d = await ok('park_idea', { title: 'Same title', thoughts: 'whatever', idempotency_key: 'k3' });
    expect(d.idea_id).toBe(b.idea_id); // k3 was recorded
    const keyless = await ok('park_idea', { title: 'Same title', thoughts: 'third angle' });
    expect(keyless.deduplicated).toBe(false);
  });

  it('a resend that differs in any other captured field is a new idea, and the key goes with it', async () => {
    const full = {
      title: 'Every field',
      thoughts: 'same thought',
      why_interesting: 'same why',
      encountered_where: 'a podcast',
      source: { url: 'https://example.com/a', title: 'Source', excerpt: 'An excerpt' },
      framing: 'A framing',
      tags: ['alpha', 'beta'],
      captured_at: '2026-03-01T10:00:00Z',
    };
    const first = await ok('park_idea', { ...full, idempotency_key: 'k0' });
    // An exact resend under a regenerated key is still a retry.
    const again = await ok('park_idea', { ...full, idempotency_key: 'k0-again' });
    expect(again).toMatchObject({ idea_id: first.idea_id, deduplicated: true });

    const variants: Record<string, unknown>[] = [
      { encountered_where: 'a book' },
      { source: { ...full.source, title: 'Another source' } },
      { source: { ...full.source, excerpt: 'Another excerpt' } },
      { framing: 'Another framing' },
      { tags: ['alpha'] },
      { captured_at: '2026-03-02T10:00:00Z' },
      { captured_at: undefined },
    ];
    const ids = new Set<string>([first.idea_id]);
    for (const [i, v] of variants.entries()) {
      const r = await ok('park_idea', { ...full, ...v, idempotency_key: `k${i + 1}` });
      expect(r.deduplicated, JSON.stringify(v)).toBe(false);
      expect(ids.has(r.idea_id), JSON.stringify(v)).toBe(false);
      ids.add(r.idea_id);
    }
    const keyless = await ok('park_idea', { ...full, framing: 'Keyless framing' });
    expect(keyless.deduplicated).toBe(false);
    expect(ids.has(keyless.idea_id)).toBe(false);

    // Only the exact resend's key was attached to the first idea.
    const keys = await admin`
      SELECT source_external_id FROM idea_source WHERE idea_id = ${first.idea_id} ORDER BY source_external_id
    `;
    expect(keys.map((r) => r.source_external_id)).toEqual(['k0', 'k0-again']);
    const [stored] = await admin`SELECT framing, tags FROM idea WHERE id = ${keyless.idea_id}`;
    expect(stored).toMatchObject({ framing: 'Keyless framing', tags: ['alpha', 'beta'] });

    // Without captured_at, an exact keyless resend still dedups.
    const plain = await ok('park_idea', { title: 'Plain', thoughts: 'x', tags: ['t'] });
    const plainAgain = await ok('park_idea', { title: 'Plain', thoughts: 'x', tags: ['t'] });
    expect(plainAgain).toMatchObject({ idea_id: plain.idea_id, deduplicated: true });
  });

  it('update_idea rejects a blank title and accepts imported-length fields', async () => {
    const id = await seedIdea('Editable');
    const blank = await callTool('update_idea', { id, title: '   ' });
    expect(blank.isError).toBe(true);
    const long = await ok('update_idea', { id, why_interesting: 'w'.repeat(7000), framing: 'f'.repeat(11000) });
    expect(long.changed).toEqual(['why_interesting', 'framing']);
  });

  it('get_idea and export_idea_map accept upper-case ids', async () => {
    const a = await seedIdea('Part A');
    const b = await seedIdea('Part B');
    const s = await ok('create_synthesis', { title: 'Seed', intent: 'episode', part_ids: [a, b] });
    const g = await ok('get_idea', { id: s.synthesis_id.toUpperCase() });
    expect(g.parts).toHaveLength(2);
    expect(g.links.every((l: any) => l.direction === 'in')).toBe(true);
    const ga = await ok('get_idea', { id: a.toUpperCase() });
    expect(ga.part_of).toHaveLength(1);
    expect(ga.links[0].direction).toBe('out');
    const m = await ok('export_idea_map', { focus_idea_id: a.toUpperCase(), depth: 1 });
    expect(m.nodes.map((x: any) => x.id)).toContain(a);
  });
});

describe.skipIf(!TEST_DB)('import fixes', () => {
  beforeEach(resetIdeaData);

  it('validates items one by one, so one bad row does not sink the batch', async () => {
    const r = await ok('import_ideas', {
      source_system: 'notion',
      items: [
        { source_external_id: 'too-long-tag', import_payload: {}, title: 'X', tags: [`project:${'n'.repeat(59)}`] },
        { source_external_id: 'fine', import_payload: {}, title: 'Fine' },
        'not even an object',
      ],
    });
    expect(r.counts).toEqual({ created: 1, merged: 0, already_imported: 0, error: 2 });
    expect(r.results[0]).toMatchObject({ index: 0, source_external_id: 'too-long-tag', result: 'error' });
    expect(r.results[2]).toMatchObject({ index: 2, source_external_id: null, result: 'error' });
  });

  it('reads Notion times in an IANA zone (DST-aware)', async () => {
    const r = await ok('import_ideas', {
      source_system: 'notion',
      timezone: 'Europe/London',
      items: [
        { source_external_id: 'w', import_payload: {}, title: 'Winter', captured_at: 'March 8, 2026 12:26 PM' },
        { source_external_id: 's', import_payload: {}, title: 'Summer', captured_at: 'March 31, 2026 10:19 PM' },
      ],
    });
    const rows = await admin`SELECT title, captured_at FROM idea ORDER BY title`;
    expect(rows.map((x) => [x.title, new Date(x.captured_at).toISOString()])).toEqual([
      ['Summer', '2026-03-31T21:19:00.000Z'],
      ['Winter', '2026-03-08T12:26:00.000Z'],
    ]);
    expect(r.counts.created).toBe(2);
    const bad = await callTool('import_ideas', { source_system: 'notion', timezone: 'Mars/Olympus', items: [{}] });
    expect(bad.isError).toBe(true);
  });

  it('merges tags case-insensitively, keeping the existing order', async () => {
    const c = await ok('import_ideas', {
      source_system: 'notion',
      items: [{ source_external_id: 'n', import_payload: {}, title: 'T', tags: ['Physics', 'oceans'] }],
    });
    await ok('import_ideas', {
      source_system: 'gtasks_subjects',
      items: [
        {
          source_external_id: 't',
          import_payload: {},
          merge_into_idea_id: c.results[0].idea_id.toUpperCase(),
          tags: ['physics', 'moons'],
        },
      ],
    });
    const row = await admin`SELECT tags FROM idea WHERE id = ${c.results[0].idea_id}`;
    expect(row[0].tags).toEqual(['Physics', 'oceans', 'moons']);
  });

  it('Subjects listing: match kinds, stale rows and stable paging', async () => {
    await seedSubjects([
      { id: 's1', title: 'Tide tables' },
      { id: 's2', title: 'Tide' },
      { id: 's3', title: 'Old deleted topic' },
      { id: 's4', title: 'Fourth' },
    ]);
    await ok('import_ideas', {
      source_system: 'notion',
      items: [
        { source_external_id: 'n1', import_payload: {}, title: 'tide-tables' },
        { source_external_id: 'n2', import_payload: {}, title: 'Tide tables of the north sea' },
      ],
    });
    // Simulate a later sync that no longer returns s3 (deleted in Google).
    await admin`UPDATE project_ref SET updated_at = now() + interval '1 minute' WHERE list_type = 'subjects'`;
    await admin`UPDATE task_ref SET updated_at = now() + interval '2 minutes' WHERE external_task_id <> 's3'`;

    const page1 = await ok('list_subjects_for_import', { limit: 2 });
    expect(page1.total).toBe(4);
    expect(page1.next_offset).toBe(2);
    const page2 = await ok('list_subjects_for_import', { limit: 2, offset: 2 });
    expect(page2.next_offset).toBeNull();
    const all = [...page1.tasks, ...page2.tasks];
    expect(new Set(all.map((t: any) => t.external_task_id)).size).toBe(4);
    const byId = new Map<string, any>(all.map((t: any) => [t.external_task_id, t]));
    expect(byId.get('s1').possible_duplicates.map((d: any) => d.match)).toEqual(['exact', 'contains']);
    expect(byId.get('s2').possible_duplicates).toEqual([]); // 'tide' is too short to suggest
    expect(byId.get('s3').stale).toBe(true);
    expect(byId.get('s1').stale).toBe(false);
  });
});

describe.skipIf(!TEST_DB)('gardening fixes', () => {
  beforeEach(resetIdeaData);

  it('accepting with a retype revives a dead row of the new type instead of failing', async () => {
    const x = await seedIdea('X');
    const y = await seedIdea('Y');
    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: x, target_idea_id: y, link_type: 'builds_on', rationale: 'X extends Y in some way' },
        { source_idea_id: x, target_idea_id: y, link_type: 'related', rationale: 'X and Y are related' },
      ],
    });
    const [builds, related] = p.results.map((r: any) => r.link_id);
    await ok('decide_idea_links', { decisions: [{ link_id: builds, decision: 'reject' }] });
    const d = await ok('decide_idea_links', {
      decisions: [{ link_id: related, decision: 'accept', link_type: 'builds_on' }],
    });
    expect(d.results[0]).toMatchObject({ result: 'accepted', link_id: builds, superseded: related });
    const rows = await admin`SELECT id, status, link_type, rationale, jsonb_array_length(history) AS h FROM idea_link ORDER BY link_type`;
    expect(rows.map((r) => [r.link_type, r.status])).toEqual([
      ['builds_on', 'accepted'],
      ['related', 'withdrawn'],
    ]);
    expect(rows[0].rationale).toBe('X and Y are related');
    expect(rows[0].h).toBe(1);

    // A live row of the new type is a real conflict.
    const z = await seedIdea('Z');
    const q = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: x, target_idea_id: z, link_type: 'example_of', rationale: 'X is an example of Z' },
        { source_idea_id: x, target_idea_id: z, link_type: 'related', rationale: 'X and Z are related' },
      ],
    });
    const c = await ok('decide_idea_links', {
      decisions: [{ link_id: q.results[1].link_id, decision: 'accept', link_type: 'example_of' }],
    });
    expect(c.results[0].result).toBe('error');
    expect(c.results[0].error).toMatch(/conflict.*decide that one instead/);
  });

  it('orphans: newest first, paging and cross_domain neighbours', async () => {
    const old = await seedIdea('Old', { captured_at: '2026-01-01T00:00:00Z', tags: ['t'] });
    const mid = await seedIdea('Mid', { captured_at: '2026-02-01T00:00:00Z', tags: ['t'] });
    const fresh = await seedIdea('Fresh', { tags: ['u'] });
    await setEmbedding(old, axis(0));
    await setEmbedding(mid, mix(0, 1, 0.8));
    await setEmbedding(fresh, mix(0, 2, 0.7));
    const p1 = await ok('garden_ideas', { mode: 'orphans', limit: 2 });
    expect(p1.orphans.map((o: any) => o.idea.title)).toEqual(['Fresh', 'Mid']);
    expect(p1.paging).toEqual({ offset: 0, total_orphans: 3, next_offset: 2 });
    const p2 = await ok('garden_ideas', { mode: 'orphans', limit: 2, offset: 2 });
    expect(p2.orphans.map((o: any) => o.idea.title)).toEqual(['Old']);
    const oldest = await ok('garden_ideas', { mode: 'orphans', limit: 1, order: 'oldest' });
    expect(oldest.orphans[0].idea.title).toBe('Old');
    const cross = await ok('garden_ideas', { mode: 'orphans', focus_idea_id: old, cross_domain: true });
    expect(cross.orphans[0].neighbours.map((n: any) => n.b.title)).toEqual(['Fresh']); // Mid shares tag t
  });

  it('outputs mode pages beyond the first 40 ideas', async () => {
    const x = await seedArtifact('Essay', axis(0));
    for (let i = 0; i < 42; i++) {
      const id = await seedIdea(`Idea ${String(i).padStart(2, '0')}`, {
        captured_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      });
      await setEmbedding(id, mix(0, 3 + i, 0.6));
    }
    const p1 = await ok('garden_ideas', { mode: 'outputs', limit: 30 });
    expect(p1.paging.next_offset).toBe(40);
    const p2 = await ok('garden_ideas', { mode: 'outputs', offset: 40 });
    expect(p2.paging.next_offset).toBeNull();
    expect(p2.candidates).toHaveLength(2);
    expect(p2.candidates[0].artifact.id).toBe(x);
  });

  it('outputs mode keeps paging past a page with no candidates', async () => {
    const x = await seedArtifact('Essay', axis(0));
    // The 40 newest ideas are orthogonal to the essay; the 2 oldest match it.
    for (let i = 0; i < 40; i++) {
      const id = await seedIdea(`Far ${String(i).padStart(2, '0')}`, {
        captured_at: `2026-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      });
      await setEmbedding(id, axis(10 + i));
    }
    for (let i = 0; i < 2; i++) {
      const id = await seedIdea(`Near ${i}`, { captured_at: `2026-01-0${i + 1}T00:00:00Z` });
      await setEmbedding(id, mix(0, 3 + i, 0.8 - i * 0.1));
    }
    const p1 = await ok('garden_ideas', { mode: 'outputs' });
    expect(p1.candidates).toEqual([]);
    expect(p1.paging.next_offset).toBe(40);
    const p2 = await ok('garden_ideas', { mode: 'outputs', offset: p1.paging.next_offset });
    expect(p2.candidates.map((c: any) => [c.a.title, c.artifact.id])).toEqual([
      ['Near 0', x],
      ['Near 1', x],
    ]);
    expect(p2.paging.next_offset).toBeNull();
  });

  it('band mode with a focus idea and near mode via nearest neighbours', async () => {
    const a = await seedIdea('A');
    const b = await seedIdea('B');
    const c = await seedIdea('C');
    await setEmbedding(a, axis(0));
    await setEmbedding(b, mix(0, 1, 0.4));
    await setEmbedding(c, mix(0, 2, 0.95));
    const band = await ok('garden_ideas', { mode: 'band', focus_idea_id: a });
    expect(band.candidates.map((x: any) => [x.a.title, x.b.title].sort().join('+'))).toEqual(['A+B']);
    const near = await ok('garden_ideas', { mode: 'near' });
    expect(near.candidates.map((x: any) => [x.a.title, x.b.title].sort().join('+'))).toEqual(['A+C']);
    expect(near.candidates[0].hint).toBe('possible_duplicate');
  });
});

describe.skipIf(!TEST_DB)('list fixes', () => {
  beforeEach(resetIdeaData);

  it('filters by territory (frontier excludes revisits-only ideas)', async () => {
    const t = await seedIdea('Territory');
    const ad = await seedIdea('Adjacent');
    await seedIdea('Frontier');
    const x = await seedArtifact('Episode', null);
    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: t, target_artifact_id: x, link_type: 'became', rationale: 'became the episode' },
        { source_idea_id: ad, target_artifact_id: x, link_type: 'revisits', rationale: 'retreads the episode' },
      ],
    });
    await ok('decide_idea_links', { decisions: p.results.map((r: any) => ({ link_id: r.link_id, decision: 'accept' })) });
    const by = async (territory: string) =>
      (await ok('list_ideas', { territory })).ideas.map((i: any) => [i.title, i.territory]);
    expect(await by('frontier')).toEqual([['Frontier', 'frontier']]);
    expect(await by('adjacent')).toEqual([['Adjacent', 'adjacent']]);
    expect(await by('territory')).toEqual([['Territory', 'territory']]);
    expect((await ok('list_ideas', { has_output: false })).total).toBe(2);
  });
});

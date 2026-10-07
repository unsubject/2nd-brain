import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { admin, callTool, ok, resetIdeaData, seedIdea, setEmbedding, axis, TEST_DB, USER } from './helpers';

const MIGRATION_028 = readFileSync(new URL('../../../migrations/028_idea_garden_v2.sql', import.meta.url), 'utf8');

afterAll(() => admin.end({ timeout: 5 }));

describe.skipIf(!TEST_DB)('capture: park_idea / get_idea / update_idea', () => {
  beforeEach(resetIdeaData);

  it('files an idea and returns only the receipt', async () => {
    const r = await ok('park_idea', {
      title: '  Why do tides have two bulges?  ',
      thoughts: 'raw  thought,\n\n第二段 — keep me exactly 🙂  ',
      why_interesting: 'Gravity gradients are unintuitive',
      encountered_where: 'a walk on the beach',
      source: { url: 'https://example.com/a', title: 'An article', excerpt: 'The passage.' },
      tags: ['physics', 'Physics', ' oceans '],
      idempotency_key: 'k-1',
      captured_via: { client: 'test', model: 'm' },
    });
    expect(Object.keys(r).sort()).toEqual(
      ['captured_at', 'deduplicated', 'embedding', 'fields_filed', 'idea_id', 'note', 'status', 'title'].sort(),
    );
    expect(r.title).toBe('Why do tides have two bulges?');
    expect(r.status).toBe('parked');
    expect(r.deduplicated).toBe(false);
    expect(r.fields_filed).toEqual(
      expect.arrayContaining(['title', 'thoughts', 'why_interesting', 'encountered_where', 'source_url', 'tags']),
    );

    const row = await admin`SELECT thoughts, tags, user_id, captured_via FROM idea WHERE id = ${r.idea_id}`;
    expect(row[0].thoughts).toBe('raw  thought,\n\n第二段 — keep me exactly 🙂  ');
    expect(row[0].tags).toEqual(['physics', 'oceans']);
    expect(row[0].user_id).toBe(USER);
    expect(row[0].captured_via).toEqual({ client: 'test', model: 'm', role: 'librarian', credential: 'master' });

    const src = await admin`SELECT source_system, source_external_id FROM idea_source WHERE idea_id = ${r.idea_id}`;
    expect(src).toEqual([{ source_system: 'librarian', source_external_id: 'k-1' }]);
  });

  it('is idempotent on the key and guards same-title retries', async () => {
    const a = await ok('park_idea', { title: 'Idea A', idempotency_key: 'same' });
    const b = await ok('park_idea', { title: 'Idea A (retry)', idempotency_key: 'same' });
    expect(b.idea_id).toBe(a.idea_id);
    expect(b.deduplicated).toBe(true);
    const c = await ok('park_idea', { title: 'idea a' });
    expect(c.idea_id).toBe(a.idea_id);
    const n = await admin`SELECT count(*)::int AS n FROM idea`;
    expect(n[0].n).toBe(1);
  });

  it('backdates captured_at but refuses the future', async () => {
    const r = await ok('park_idea', { title: 'Old one', captured_at: '2026-01-02T03:04:05Z' });
    expect(r.captured_at).toBe('2026-01-02T03:04:05.000Z');
    const bad = await callTool('park_idea', { title: 'Future', captured_at: '2999-01-01T00:00:00Z' });
    expect(bad.isError).toBe(true);
    const invalid = await callTool('park_idea', { thoughts: 'no title' });
    expect(invalid.isError).toBe(true);
    expect(invalid.texts[0]).toMatch(/Invalid arguments/);
  });

  it('get_idea returns fields, sources, links and territory', async () => {
    const id = await seedIdea('Get me', { thoughts: 'mine', why_interesting: 'why' });
    const r = await ok('get_idea', { id });
    expect(r.idea.title).toBe('Get me');
    expect(r.idea.thoughts).toBe('mine');
    expect(r.idea.embedding_status).toBe('pending');
    expect(r.territory).toBe('frontier');
    expect(r.sources).toHaveLength(1);
    expect(r.links).toEqual([]);
    expect(r.pending_count).toBe(0);
    expect(typeof r.as_of).toBe('string');
    const missing = await callTool('get_idea', { id: '00000000-0000-0000-0000-000000000000' });
    expect(missing.isError).toBe(true);
  });

  it('update_idea: tri-state fields, tags, status note, append note, re-embed', async () => {
    const id = await seedIdea('Update me', { why_interesting: 'w', encountered_where: 'x', tags: ['a', 'b'] });
    await setEmbedding(id, axis(0));

    const r1 = await ok('update_idea', { id, encountered_where: null, add_tags: ['c'], remove_tags: ['A'] });
    expect(r1.changed).toEqual(['encountered_where', 'add_tags', 'remove_tags']);
    expect(r1.embedding).toBe('pending'); // tags changed → embedding cleared
    let row = await admin`SELECT encountered_where, why_interesting, tags, embedding IS NULL AS cleared FROM idea WHERE id = ${id}`;
    expect(row[0]).toEqual({ encountered_where: null, why_interesting: 'w', tags: ['b', 'c'], cleared: true });

    await setEmbedding(id, axis(0));
    const r2 = await ok('update_idea', { id, status: 'exploring', append_note: { text: 'agent thought', by: 'agent' } });
    expect(r2.embedding).toBe('unchanged');
    const g = await ok('get_idea', { id });
    expect(g.idea.status).toBe('exploring');
    expect(g.idea.notes.map((n: any) => [n.by, n.text])).toEqual([
      ['system', 'status: parked → exploring'],
      ['agent', 'agent thought'],
    ]);

    const r3 = await ok('update_idea', { id, append_note: { text: 'my words', by: 'simon' } });
    expect(r3.embedding).toBe('pending');

    const bad = await callTool('update_idea', { id, intent: 'episode' });
    expect(bad.isError).toBe(true);
    expect(bad.texts[0]).toMatch(/intent applies only to syntheses/);
    const none = await callTool('update_idea', { id });
    expect(none.isError).toBe(true);
    const both = await callTool('update_idea', { id, tags: ['x'], add_tags: ['y'] });
    expect(both.isError).toBe(true);
  });

  it('never touches another user’s ideas', async () => {
    const rows = await admin<Array<{ id: string }>>`
      INSERT INTO idea (user_id, title) VALUES ('someone-else', 'Not yours') RETURNING id
    `;
    const g = await callTool('get_idea', { id: rows[0].id });
    expect(g.isError).toBe(true);
    const u = await callTool('update_idea', { id: rows[0].id, title: 'mine now' });
    expect(u.isError).toBe(true);
  });
});

describe.skipIf(!TEST_DB)('migration 019 constraints', () => {
  beforeEach(resetIdeaData);

  const insertLink = (src: string, tgt: string, type: string) => admin`
    INSERT INTO idea_link (user_id, source_idea_id, target_idea_id, link_type, rationale, proposed_by)
    VALUES (${USER}, ${src}, ${tgt}, ${type}, 'a reason here', 'gardening')
  `;

  it('enforces canonical symmetric order, pair uniqueness, part_of targets and ownership', async () => {
    const a = await seedIdea('A');
    const b = await seedIdea('B');
    const [lo, hi] = [a, b].sort();
    await expect(insertLink(hi, lo, 'tension_with')).rejects.toThrow(/idea_link_symmetric_canonical/);
    await insertLink(lo, hi, 'tension_with');
    await insertLink(a, b, 'builds_on');
    await expect(insertLink(b, a, 'builds_on')).rejects.toThrow(/idx_idea_link_pair_type/);
    await expect(insertLink(a, b, 'part_of')).rejects.toThrow(/part_of must target a synthesis/);
    const other = await admin<Array<{ id: string }>>`INSERT INTO idea (user_id, title) VALUES ('x', 'X') RETURNING id`;
    await expect(insertLink(a, other[0].id, 'related')).rejects.toThrow(/does not belong/);
  });

  it('keeps kind immutable and stamps status changes', async () => {
    const a = await seedIdea('A');
    await expect(admin`UPDATE idea SET kind = 'synthesis', intent = 'essay' WHERE id = ${a}`).rejects.toThrow(
      /immutable/,
    );
    const before = await admin`SELECT status_changed_at FROM idea WHERE id = ${a}`;
    await admin`UPDATE idea SET status = 'composted' WHERE id = ${a}`;
    const after = await admin`SELECT status_changed_at FROM idea WHERE id = ${a}`;
    expect(new Date(after[0].status_changed_at) >= new Date(before[0].status_changed_at)).toBe(true);
  });
});

describe.skipIf(!TEST_DB)('migration 028 (Idea Garden v2)', () => {
  beforeEach(resetIdeaData);

  const insertLink = (src: string, tgt: string, type: string, proposedBy = 'gardening') => admin`
    INSERT INTO idea_link (user_id, source_idea_id, target_idea_id, link_type, rationale, proposed_by)
    VALUES (${USER}, ${src}, ${tgt}, ${type}, 'a reason here', ${proposedBy})
  `;

  it('accepts mechanism_for (directed) and inverts (symmetric, canonical order)', async () => {
    const a = await seedIdea('A');
    const b = await seedIdea('B');
    const [lo, hi] = [a, b].sort();
    await insertLink(a, b, 'mechanism_for');
    await expect(insertLink(b, a, 'mechanism_for')).rejects.toThrow(/idx_idea_link_pair_type/);
    await expect(insertLink(hi, lo, 'inverts')).rejects.toThrow(/idea_link_symmetric_canonical/);
    await insertLink(lo, hi, 'inverts');
    await expect(insertLink(lo, hi, 'contradicts')).rejects.toThrow(/idea_link_link_type_check/);
  });

  it("allows proposed_by 'capture' and nothing new beyond it", async () => {
    const a = await seedIdea('A');
    const b = await seedIdea('B');
    await insertLink(a, b, 'builds_on', 'capture');
    await expect(insertLink(a, b, 'example_of', 'assistant')).rejects.toThrow(/idea_link_proposed_by_check/);
  });

  it('starts ideas in the inbox and pairs the promotion columns', async () => {
    const a = await seedIdea('A');
    const rows = await admin`SELECT reviewed_at, promoted_at, promoted_title FROM idea WHERE id = ${a}`;
    expect(rows[0]).toEqual({ reviewed_at: null, promoted_at: null, promoted_title: null });
    await expect(admin`UPDATE idea SET promoted_at = now() WHERE id = ${a}`).rejects.toThrow(/idea_promoted_pair/);
    await expect(admin`UPDATE idea SET promoted_at = now(), promoted_title = '  ' WHERE id = ${a}`).rejects.toThrow(
      /idea_promoted_pair/,
    );
    await admin`UPDATE idea SET promoted_at = now(), promoted_title = 'Episode: tides' WHERE id = ${a}`;
  });

  it('keeps the embedding when only the review or promotion fields change', async () => {
    const a = await seedIdea('A');
    await setEmbedding(a, axis(0));
    await admin`UPDATE idea SET reviewed_at = now(), promoted_at = now(), promoted_title = 'T' WHERE id = ${a}`;
    const rows = await admin`SELECT embedding IS NOT NULL AS has FROM idea WHERE id = ${a}`;
    expect(rows[0].has).toBe(true);
  });

  it('runs again without changing anything', async () => {
    const a = await seedIdea('A');
    const b = await seedIdea('B');
    const [lo, hi] = [a, b].sort();
    await insertLink(lo, hi, 'inverts', 'capture');
    await admin.unsafe(MIGRATION_028).simple();
    const n = await admin`SELECT count(*)::int AS n FROM idea_link WHERE link_type = 'inverts'`;
    expect(n[0].n).toBe(1);
  });
});

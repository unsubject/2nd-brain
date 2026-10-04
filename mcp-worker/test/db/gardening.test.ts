import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, axis, callTool, mix, ok, resetIdeaData, seedArtifact, seedIdea, setEmbedding, TEST_DB } from './helpers';

afterAll(() => admin.end({ timeout: 5 }));

type Ids = { a: string; b: string; c: string; d: string; e: string; x: string };

// Cosines: a·b 0.95, a·c 0.6, b·c 0.57, a·d 0.4, b·d 0.38, c·d 0.24, e ⟂ all,
// a·X 0.7, b·X 0.665, c·X 0.42, d·X 0.28
async function seedGarden(): Promise<Ids> {
  const a = await seedIdea('Idea A', { tags: ['econ'] });
  const b = await seedIdea('Idea B', { tags: ['econ'] });
  const c = await seedIdea('Idea C', { tags: ['history'] });
  const d = await seedIdea('Idea D');
  const e = await seedIdea('Idea E');
  await setEmbedding(a, axis(0));
  await setEmbedding(b, mix(0, 1, 0.95));
  await setEmbedding(c, mix(0, 2, 0.6));
  await setEmbedding(d, mix(0, 3, 0.4));
  await setEmbedding(e, axis(5));
  const x = await seedArtifact('Episode X', mix(0, 6, 0.7), '2026-06-01T00:00:00Z');
  return { a, b, c, d, e, x };
}

const pairKey = (c: any) => [c.a.title, c.b.title].sort().join('+');

describe.skipIf(!TEST_DB)('gardening', () => {
  let ids: Ids;
  beforeEach(async () => {
    await resetIdeaData();
    ids = await seedGarden();
  });

  it('near / band modes return candidate pairs in range, flagging duplicates', async () => {
    const near = await ok('garden_ideas', { mode: 'near' });
    expect(near.candidates.map(pairKey)).toEqual(['Idea A+Idea B', 'Idea A+Idea C', 'Idea B+Idea C']);
    expect(near.candidates[0].similarity).toBeCloseTo(0.95, 3);
    expect(near.candidates[0].hint).toBe('possible_duplicate');
    expect(near.candidates[1].hint).toBeNull();
    expect(near.stats).toEqual({ embedded: 5, unembedded: 0 });
    expect(near.reminder).toMatch(/NOT links/);

    const band = await ok('garden_ideas', { mode: 'band' });
    expect(band.candidates.map(pairKey)).toEqual(['Idea A+Idea D', 'Idea B+Idea D']);

    const cross = await ok('garden_ideas', { mode: 'near', cross_domain: true });
    expect(cross.candidates.map(pairKey)).toEqual(['Idea A+Idea C', 'Idea B+Idea C']);

    const focused = await ok('garden_ideas', { mode: 'near', focus_idea_id: ids.c });
    expect(focused.candidates.map(pairKey)).toEqual(['Idea A+Idea C', 'Idea B+Idea C']);

    const capped = await ok('garden_ideas', { mode: 'near', per_idea_cap: 1 });
    expect(capped.candidates.map(pairKey)).toEqual(['Idea A+Idea B']);
  });

  it('propose → list → decide, with retype, rejection memory and reopen', async () => {
    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: ids.a, target_idea_id: ids.c, link_type: 'builds_on', rationale: 'A applies C to a new case' },
        { source_idea_id: ids.d, target_idea_id: ids.b, link_type: 'tension_with', rationale: 'D contradicts the premise of B' },
      ],
    });
    expect(p.counts.proposed).toBe(2);
    const [l1, l2] = p.results.map((r: any) => r.link_id);

    // Symmetric link stored canonically.
    const stored = await admin`SELECT source_idea_id, target_idea_id FROM idea_link WHERE id = ${l2}`;
    expect(stored[0].source_idea_id < stored[0].target_idea_id).toBe(true);

    // Proposed pairs no longer come back as candidates.
    const near = await ok('garden_ideas', { mode: 'near' });
    expect(near.candidates.map(pairKey)).not.toContain('Idea A+Idea C');

    const dup = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [{ source_idea_id: ids.c, target_idea_id: ids.a, link_type: 'builds_on', rationale: 'reverse of the same thing' }],
    });
    expect(dup.results[0]).toMatchObject({ result: 'skipped_duplicate', link_id: l1, existing_status: 'proposed' });

    const pending = await ok('list_idea_links', {});
    expect(pending.total).toBe(2);
    expect(pending.links[0].source.title).toBe('Idea A');
    expect(pending.links[0].target.title).toBe('Idea C');

    const d = await ok('decide_idea_links', {
      decisions: [
        { link_id: l1, decision: 'accept', link_type: 'same_mechanism', note: 'more of an analogy' },
        { link_id: l2, decision: 'reject' },
      ],
    });
    expect(d.counts).toEqual({ accepted: 1, rejected: 1 });
    const acc = await admin`SELECT link_type, source_idea_id, target_idea_id, decided_at FROM idea_link WHERE id = ${l1}`;
    expect(acc[0].link_type).toBe('same_mechanism');
    expect(acc[0].source_idea_id < acc[0].target_idea_id).toBe(true); // re-canonicalised
    expect(acc[0].decided_at).not.toBeNull();

    // Rejections are remembered at pair level, whatever the type.
    const again = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [{ source_idea_id: ids.b, target_idea_id: ids.d, link_type: 'combines_with', rationale: 'maybe they combine' }],
    });
    expect(again.results[0]).toMatchObject({ result: 'skipped_rejected', existing_status: 'rejected' });

    const reopened = await ok('propose_idea_links', {
      origin: 'gardening',
      reconsider_rejected: true,
      links: [{ source_idea_id: ids.b, target_idea_id: ids.d, link_type: 'tension_with', rationale: 'user asked to revisit this' }],
    });
    expect(reopened.results[0]).toMatchObject({ result: 'reopened', link_id: l2 });
    const hist = await admin`SELECT status, history FROM idea_link WHERE id = ${l2}`;
    expect(hist[0].status).toBe('proposed');
    expect(hist[0].history).toHaveLength(1);
    expect(hist[0].history[0].status).toBe('rejected');

    const accepted = await ok('list_idea_links', { statuses: ['accepted'] });
    expect(accepted.links.map((l: any) => l.link_type)).toEqual(['same_mechanism']);

    // get_idea shows the accepted link from both ends.
    const ga = await ok('get_idea', { id: ids.a });
    const gc = await ok('get_idea', { id: ids.c });
    expect(ga.links[0].other.title).toBe('Idea C');
    expect(gc.links[0].other.title).toBe('Idea A');
    expect(ga.links[0].direction).toBe('both');
  });

  it('enforces the transition matrix; withdraw lets a pair resurface; retract is remembered', async () => {
    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [{ source_idea_id: ids.a, target_idea_id: ids.d, link_type: 'related', rationale: 'proposed by mistake' }],
    });
    const id = p.results[0].link_id;
    const w = await ok('decide_idea_links', { decisions: [{ link_id: id, decision: 'withdraw' }] });
    expect(w.counts).toEqual({ withdrawn: 1 });
    const band = await ok('garden_ideas', { mode: 'band' });
    expect(band.candidates.map(pairKey)).toContain('Idea A+Idea D');

    const re = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [{ source_idea_id: ids.d, target_idea_id: ids.a, link_type: 'related', rationale: 'second thoughts, still related' }],
    });
    expect(re.results[0]).toMatchObject({ result: 'reopened', link_id: id, existing_status: 'withdrawn' });

    await ok('decide_idea_links', { decisions: [{ link_id: id, decision: 'accept' }] });
    const bad = await ok('decide_idea_links', {
      decisions: [
        { link_id: id, decision: 'reject' },
      ],
    });
    expect(bad.results[0].result).toBe('error');
    expect(bad.results[0].error).toMatch(/invalid_transition/);

    const r = await ok('decide_idea_links', { decisions: [{ link_id: id, decision: 'retract', note: 'not really' }] });
    expect(r.counts).toEqual({ retracted: 1 });
    const again = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [{ source_idea_id: ids.a, target_idea_id: ids.d, link_type: 'builds_on', rationale: 'trying a different type' }],
    });
    expect(again.results[0].result).toBe('skipped_rejected');

    const dupIds = await callTool('decide_idea_links', {
      decisions: [
        { link_id: id, decision: 'accept' },
        { link_id: id, decision: 'reject' },
      ],
    });
    expect(dupIds.isError).toBe(true);
  });

  it('reverse and invalid retypes on accept', async () => {
    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: ids.a, target_idea_id: ids.b, link_type: 'example_of', rationale: 'A is a case of B' },
        { source_idea_id: ids.a, target_idea_id: ids.c, link_type: 'builds_on', rationale: 'A extends C somehow' },
      ],
    });
    const [l1, l2] = p.results.map((r: any) => r.link_id);
    const d = await ok('decide_idea_links', {
      decisions: [
        { link_id: l1, decision: 'accept', reverse: true },
        { link_id: l2, decision: 'accept', link_type: 'part_of' },
      ],
    });
    expect(d.results[0].result).toBe('accepted');
    expect(d.results[1].result).toBe('error');
    expect(d.results[1].error).toMatch(/part_of must target a synthesis/);
    const row = await admin`SELECT source_idea_id, target_idea_id FROM idea_link WHERE id = ${l1}`;
    expect(row[0]).toEqual({ source_idea_id: ids.b, target_idea_id: ids.a });
    const still = await admin`SELECT status FROM idea_link WHERE id = ${l2}`;
    expect(still[0].status).toBe('proposed'); // failed item rolled back

    const bad = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: ids.a, target_idea_id: ids.b, link_type: 'became', rationale: 'wrong endpoint type' },
        { source_idea_id: ids.a, target_idea_id: '00000000-0000-0000-0000-000000000000', link_type: 'related', rationale: 'missing target idea' },
      ],
    });
    expect(bad.counts.error).toBe(2);
  });

  it('outputs mode, became links and territory', async () => {
    const out = await ok('garden_ideas', { mode: 'outputs' });
    // a·X = 0.7, b·X = 0.95 × 0.7 = 0.665; c·X = 0.42 and d·X = 0.28 fall below 0.45.
    expect(out.candidates.map((c: any) => c.a.id)).toEqual([ids.a, ids.b]);
    expect(out.candidates[0].a.id).toBe(ids.a);
    expect(out.candidates[0].artifact.id).toBe(ids.x);
    expect(out.candidates[0].similarity).toBeCloseTo(0.7, 3);
    expect(out.candidates[0].hint).toBe('revisits?'); // published before the idea was captured

    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [{ source_idea_id: ids.a, target_artifact_id: ids.x, link_type: 'became', rationale: 'the episode develops A' }],
    });
    const d = await ok('decide_idea_links', { decisions: [{ link_id: p.results[0].link_id, decision: 'accept' }] });
    expect(d.hints[0]).toMatch(/mark it used/);
    const g = await ok('get_idea', { id: ids.a });
    expect(g.territory).toBe('territory');
    expect(g.links[0].artifact.title).toBe('Episode X');

    const after = await ok('garden_ideas', { mode: 'outputs' });
    expect(after.candidates.map((c: any) => c.a.id)).toEqual([ids.b]);
  });

  it('orphans mode lists unconnected ideas with neighbours', async () => {
    const o = await ok('garden_ideas', { mode: 'orphans', limit: 10 });
    expect(o.orphans).toHaveLength(5);
    const e = o.orphans.find((x: any) => x.idea.id === ids.e);
    expect(e.neighbours).toEqual([]);
    const a = o.orphans.find((x: any) => x.idea.id === ids.a);
    expect(a.neighbours.map((n: any) => n.b.title)).toEqual(['Idea B', 'Idea C', 'Idea D']);
  });

  it('create_synthesis writes accepted part_of links', async () => {
    const s = await ok('create_synthesis', {
      title: 'Episode seed',
      intent: 'episode',
      part_ids: [ids.a, ids.c, ids.a],
      thoughts: 'my words',
      part_rationales: { [ids.a]: 'the hook' },
    });
    expect(s.parts.map((p: any) => p.id).sort()).toEqual([ids.a, ids.c].sort());
    const g = await ok('get_idea', { id: s.synthesis_id });
    expect(g.idea.kind).toBe('synthesis');
    expect(g.idea.intent).toBe('episode');
    expect(g.idea.status).toBe('exploring');
    expect(g.parts.map((p: any) => p.id).sort()).toEqual([ids.a, ids.c].sort());
    const ga = await ok('get_idea', { id: ids.a });
    expect(ga.part_of[0].id).toBe(s.synthesis_id);
    const links = await admin`SELECT status, proposed_by, rationale FROM idea_link WHERE target_idea_id = ${s.synthesis_id} ORDER BY rationale`;
    expect(links.every((l) => l.status === 'accepted' && l.proposed_by === 'synthesis')).toBe(true);
    expect(links.map((l) => l.rationale)).toContain('the hook');

    const one = await callTool('create_synthesis', { title: 'Too small', intent: 'essay', part_ids: [ids.a, ids.a] });
    expect(one.isError).toBe(true);
    const missing = await callTool('create_synthesis', {
      title: 'Ghost parts',
      intent: 'essay',
      part_ids: [ids.a, '00000000-0000-0000-0000-000000000000'],
    });
    expect(missing.isError).toBe(true);
    expect(missing.texts[0]).toMatch(/not_found/);
  });
});

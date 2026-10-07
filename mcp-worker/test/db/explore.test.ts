import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { admin, axis, callTool, mix, ok, resetIdeaData, seedArtifact, seedIdea, setEmbedding, TEST_DB, USER } from './helpers';

// Synthetic data only (the repository is public).

afterAll(() => admin.end({ timeout: 5 }));

function stubEmbeddings(vector: number[] | 'fail') {
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).includes('api.openai.com')) throw new Error(`unexpected fetch ${url}`);
    if (vector === 'fail') return new Response('boom', { status: 500 });
    return Response.json({ data: [{ embedding: vector }] });
  });
}

type Proposal = {
  source_idea_id: string;
  target_idea_id?: string;
  target_artifact_id?: string;
  link_type: string;
  rationale: string;
};

// Propose links and accept all of them (or leave them proposed).
async function linkAll(links: Proposal[], accept = true): Promise<string[]> {
  const p = await ok('propose_idea_links', { origin: 'gardening', links });
  const ids = p.results.map((r: any) => r.link_id as string);
  if (accept) await ok('decide_idea_links', { decisions: ids.map((link_id: string) => ({ link_id, decision: 'accept' })) });
  return ids;
}

const ideaIds = (r: any) => r.clusters.map((c: any) => c.ideas.map((i: any) => i.id));

describe.skipIf(!TEST_DB)('explore_topic', () => {
  beforeEach(resetIdeaData);
  afterEach(() => vi.unstubAllGlobals());

  it('returns the matching ideas with their linked clusters, labels and glosses', async () => {
    // Two topic matches (semantic), each with its own neighbourhood.
    const tides = await seedIdea('Tidal locking');
    const moon = await seedIdea('Moon drifts away');
    const year = await seedIdea('Days get longer');
    const pools = await seedIdea('Rock pools as labs');
    const crabs = await seedIdea('Crab behaviour');
    const noise = await seedIdea('Unrelated knitting');
    await setEmbedding(tides, axis(0));
    await setEmbedding(pools, mix(0, 1, 0.6));
    for (const id of [moon, year, crabs, noise]) await setEmbedding(id, axis(5));
    await linkAll([
      { source_idea_id: tides, target_idea_id: moon, link_type: 'mechanism_for', rationale: 'Tidal friction pushes the Moon outward' },
      { source_idea_id: moon, target_idea_id: year, link_type: 'tension_with', rationale: 'Drift and day length trade off in angular momentum' },
      { source_idea_id: crabs, target_idea_id: pools, link_type: 'example_of', rationale: 'Crabs are the classic rock pool experiment' },
    ]);

    stubEmbeddings(axis(0));
    const r = await ok('explore_topic', { query: 'orbital drift' });
    expect(r.query).toBe('orbital drift');
    expect(r.as_of).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(r.warnings).toEqual([]);
    expect(r.seeds.map((s: any) => s.id)).toEqual([tides, pools]);
    expect(r.seeds[0]).toMatchObject({ title: 'Tidal locking', match: ['semantic'] });
    expect(r.seeds[0].similarity).toBeCloseTo(1, 3);
    // Grouped, best match first; depth 1 stops before `year`.
    expect(ideaIds(r)).toEqual([[tides, moon], [pools, crabs]]);
    expect(r.clusters[0].ideas[0]).toEqual({ id: tides, title: 'Tidal locking', status: 'parked', kind: 'unit', is_seed: true, inbox: true });
    expect(r.clusters[0].ideas[1].is_seed).toBe(false);
    expect(r.clusters[0].links).toEqual([
      {
        source_id: tides,
        source_title: 'Tidal locking',
        link_type: 'mechanism_for',
        label: 'mechanism-for',
        target_id: moon,
        target_title: 'Moon drifts away',
        gloss: 'Tidal friction pushes the Moon outward',
        status: 'accepted',
      },
    ]);
    expect(r.clusters[1].links[0]).toMatchObject({ source_id: crabs, label: 'example-of', target_id: pools });
    expect(r.truncated).toBe(false);

    // depth 2 reaches the second hop, with the display label of tension_with.
    const d2 = await ok('explore_topic', { query: 'orbital drift', depth: 2 });
    expect(ideaIds(d2)[0]).toEqual([tides, moon, year]);
    expect(d2.clusters[0].links.map((l: any) => l.label)).toEqual(['mechanism-for', 'contradicts']);

    // max_ideas caps the result (matches first) and says so.
    const capped = await ok('explore_topic', { query: 'orbital drift', depth: 2, max_ideas: 2 });
    expect(ideaIds(capped)).toEqual([[tides], [pools]]);
    expect(capped.truncated).toBe(true);

    // A reviewed idea is out of the inbox.
    await admin`UPDATE idea SET reviewed_at = now() WHERE id = ${moon}`;
    const reviewed = await ok('explore_topic', { query: 'orbital drift' });
    expect(reviewed.clusters[0].ideas[1]).toMatchObject({ id: moon, inbox: false });

    const bad = await callTool('explore_topic', { query: 'x', depth: 3 });
    expect(bad.isError).toBe(true);
  });

  it('leaves proposals out unless include_pending, and composted ideas out always', async () => {
    const seed = await seedIdea('Price signals');
    const accepted = await seedIdea('Hayek on knowledge');
    const pending = await seedIdea('Shadow prices');
    const gone = await seedIdea('Price signals, composted');
    await linkAll([{ source_idea_id: seed, target_idea_id: accepted, link_type: 'builds_on', rationale: 'Prices carry dispersed knowledge' }]);
    await linkAll([{ source_idea_id: pending, target_idea_id: seed, link_type: 'example_of', rationale: 'Shadow prices are signals without markets' }], false);
    await linkAll([{ source_idea_id: gone, target_idea_id: seed, link_type: 'builds_on', rationale: 'A composted take on the same signals' }]);
    await ok('update_idea', { id: gone, status: 'composted' });

    stubEmbeddings(axis(9)); // matches nothing semantically: text only
    const r = await ok('explore_topic', { query: 'price signals' });
    expect(r.seeds.map((s: any) => s.id)).toEqual([seed]);
    expect(ideaIds(r)).toEqual([[seed, accepted]]);

    const withPending = await ok('explore_topic', { query: 'price signals', include_pending: true });
    expect(ideaIds(withPending)).toEqual([[seed, accepted, pending]]);
    const proposed = withPending.clusters[0].links.find((l: any) => l.status === 'proposed');
    expect(proposed).toMatchObject({ source_id: pending, label: 'example-of', target_id: seed, gloss: 'Shadow prices are signals without markets' });
    expect(JSON.stringify(withPending)).not.toContain(gone);
  });

  it('dedupes a neighbour shared by two matches and lists published outputs', async () => {
    const a = await seedIdea('Inflation expectations');
    const b = await seedIdea('Inflation as a tax');
    const shared = await seedIdea('Central bank credibility');
    const ep = await seedArtifact('Episode on credibility', null);
    const draft = await seedArtifact('Draft on inflation taxes', null);
    await admin`UPDATE public_artifact SET status = 'draft' WHERE id = ${draft}`;
    await linkAll([
      { source_idea_id: a, target_idea_id: shared, link_type: 'builds_on', rationale: 'Expectations anchor on credibility' },
      { source_idea_id: b, target_idea_id: shared, link_type: 'same_mechanism', rationale: 'Both erode when the bank is doubted' },
      { source_idea_id: shared, target_artifact_id: ep, link_type: 'became', rationale: 'Credibility became the episode' },
      { source_idea_id: b, target_artifact_id: draft, link_type: 'became', rationale: 'The tax idea became a draft' },
    ]);

    stubEmbeddings(axis(9));
    const r = await ok('explore_topic', { query: 'inflation' });
    expect(r.seeds).toHaveLength(2);
    expect(r.clusters).toHaveLength(1);
    const ids = r.clusters[0].ideas.map((i: any) => i.id);
    expect(ids.filter((id: string) => id === shared)).toHaveLength(1);
    expect(new Set(ids)).toEqual(new Set([a, b, shared]));
    expect(r.clusters[0].links).toHaveLength(2);
    expect(r.outputs).toEqual([
      {
        id: ep,
        title: 'Episode on credibility',
        url: 'https://example.com/Episode%20on%20credibility',
        link_type: 'became',
        label: 'became',
        idea_id: shared,
        status: 'accepted',
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('Draft on inflation taxes');
  });

  it('finds an unembedded Chinese idea by text, and falls back to text when embeddings fail', async () => {
    const zh = await seedIdea('潮汐點樣形成', { thoughts: '月球引力係關鍵' });
    const neighbour = await seedIdea('Moon and tides');
    await linkAll([{ source_idea_id: zh, target_idea_id: neighbour, link_type: 'related', rationale: 'Same question asked in two languages' }]);

    stubEmbeddings(axis(7));
    const r = await ok('explore_topic', { query: '引力' });
    expect(r.seeds).toEqual([{ id: zh, title: '潮汐點樣形成', similarity: null, match: ['text'] }]);
    expect(new Set(ideaIds(r)[0])).toEqual(new Set([zh, neighbour]));

    stubEmbeddings('fail');
    const failed = await ok('explore_topic', { query: '潮汐' });
    expect(failed.warnings[0]).toMatch(/Semantic search unavailable/);
    expect(failed.seeds.map((s: any) => s.id)).toEqual([zh]);
    expect(failed.clusters[0].links[0]).toMatchObject({ label: 'related', gloss: 'Same question asked in two languages' });

    const none = await ok('explore_topic', { query: 'nothing matches this' });
    expect(none).toMatchObject({ seeds: [], clusters: [], outputs: [], truncated: false });
    expect(none.as_of).toMatch(/^\d{4}-/);
  });
});

describe.skipIf(!TEST_DB)('export_idea_map html', () => {
  beforeEach(resetIdeaData);

  it('returns meta then a self-contained page with only published outputs', async () => {
    const a = await seedIdea('Map idea </script> A', { captured_at: '2026-01-02T03:04:05Z' });
    const b = await seedIdea('Map idea B');
    const c = await seedIdea('Map idea C');
    const pub = await seedArtifact('Published essay', null);
    const draft = await seedArtifact('Draft essay', null);
    await admin`UPDATE public_artifact SET status = 'draft' WHERE id = ${draft}`;
    await admin`UPDATE idea SET promoted_at = now(), promoted_title = 'Subject task' WHERE id = ${b}`;
    await linkAll([
      { source_idea_id: a, target_idea_id: b, link_type: 'tension_with', rationale: 'A and B disagree about it' },
      { source_idea_id: a, target_artifact_id: pub, link_type: 'became', rationale: 'A became the essay' },
      { source_idea_id: b, target_artifact_id: draft, link_type: 'became', rationale: 'B became a draft' },
      { source_idea_id: c, target_artifact_id: draft, link_type: 'revisits', rationale: 'C is revisited in the draft' },
    ]);

    const r = await callTool('export_idea_map', { format: 'html' });
    expect(r.isError).toBe(false);
    expect(r.texts).toHaveLength(2);
    expect(r.texts[1].startsWith('<!doctype html')).toBe(true);
    expect(r.json).toMatchObject({ format: 'html', truncated: false, omitted_count: 0 });
    expect(r.json.filename).toMatch(/^idea-map-\d{4}-\d\d-\d\d\.html$/);
    expect(r.json.bytes).toBe(Buffer.byteLength(r.texts[1], 'utf8'));
    // The draft links are gone from the file, degrees and orphans included.
    expect(r.json.stats).toEqual({ nodes: 4, edges: 2, components: 2, orphans: 1 });
    expect(r.json.warning).toBeUndefined();

    const html = r.texts[1];
    expect(html).toContain('Published essay');
    expect(html).not.toContain('Draft essay');
    expect(html).not.toContain('B became a draft');
    expect(html).not.toContain('Subject task');
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    const data = JSON.parse(html.match(/<script type="application\/json" id="map-data">([\s\S]*?)<\/script>/)![1]);
    expect(data.from).toBe(Date.parse('2026-01-02T03:04:05Z'));
    expect(data.nodes.find((x: any) => x.n === 'Map idea B').p).toBeGreaterThan(0);
    expect(data.nodes.filter((x: any) => x.i === 1)).toHaveLength(3);
    expect(data.nodes.find((x: any) => x.n === 'Map idea B').d).toBe(1);
    expect(data.nodes.find((x: any) => x.n === 'Map idea C').d).toBe(0);
    expect(data.clusters).toEqual([{ id: 1, name: 'Map idea </script> A', size: 2 }]);

    // The json export keeps draft outputs and carries the new fields.
    const json = await ok('export_idea_map', {});
    expect(json.nodes.map((x: any) => x.label)).toContain('Draft essay');
    expect(json.nodes.find((x: any) => x.id === c).degree).toBe(1);
    expect(json.stats.orphans).toBe(0);
    const nodeB = json.nodes.find((x: any) => x.id === b);
    expect(nodeB).toMatchObject({ inbox: true, cluster: 1, cluster_size: 2 });
    expect(nodeB.promoted_at).toMatch(/^\d{4}-/);
    expect(nodeB.created_at).toMatch(/^\d{4}-/);
    const edge = json.edges.find((e: any) => e.type === 'tension_with');
    expect(edge).toMatchObject({ label: 'contradicts', status: 'accepted' });
    expect(edge.decided_at).toMatch(/^\d{4}-/);
    expect(edge.proposed_at).toMatch(/^\d{4}-/);
    // Both ideas have two links; the tie goes to the smaller id.
    const [first] = [a, b].sort();
    expect(json.clusters).toEqual([{ id: 1, name: first === a ? 'Map idea </script> A' : 'Map idea B', size: 2 }]);
  });

  it('defaults html to 150 nodes and warns when the page is large', async () => {
    await admin`
      INSERT INTO idea (user_id, title)
      SELECT ${USER}, 'Bulk idea ' || g || ' ' || repeat('padding ', 50) FROM generate_series(1, 160) g
    `;
    const r = await callTool('export_idea_map', { format: 'html' });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ truncated: true, omitted_count: 10, stats: { nodes: 150 } });
    expect(r.json.bytes).toBeGreaterThan(75_000);
    expect(r.json.warning).toMatch(/lower max_nodes, focus_idea_id \+ depth, or since/);

    const small = await callTool('export_idea_map', { format: 'html', max_nodes: 20 });
    expect(small.json).toMatchObject({ truncated: true, omitted_count: 140, stats: { nodes: 20 } });
    expect(small.json.warning).toBeUndefined();

    // Other formats keep the 300 default.
    const json = await ok('export_idea_map', {});
    expect(json).toMatchObject({ truncated: false, stats: { nodes: 160 } });
  });
});

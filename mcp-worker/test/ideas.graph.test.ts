import { describe, it, expect } from 'vitest';
import { buildIdeaMap, louvain, toGraphML, toMermaid, type MapIdea, type MapLink, type BuildOptions } from '../src/ideas/graph';
import { buildExplore, type ExploreIdea, type ExploreLink } from '../src/ideas/explore';

const idea = (id: string, title = id, extra: Partial<MapIdea> = {}): MapIdea => ({
  id,
  title,
  kind: 'unit',
  intent: null,
  status: 'parked',
  captured_at: `2026-01-0${id.length % 9 + 1}T00:00:00.000Z`,
  tags: [],
  ...extra,
});

let n = 0;
const link = (src: string, tgt: string, type: MapLink['link_type'], status: MapLink['status'] = 'accepted', artifact = false): MapLink => ({
  id: `l${++n}`,
  source_idea_id: src,
  target_idea_id: artifact ? null : tgt,
  target_artifact_id: artifact ? tgt : null,
  link_type: type,
  status,
  rationale: `${src} ${type} ${tgt}`,
});

const opts = (o: Partial<BuildOptions> = {}): BuildOptions => ({
  depth: 2,
  include_outputs: true,
  include_pending: false,
  include_isolated: true,
  max_nodes: 300,
  generated_at: '2026-10-03T00:00:00.000Z',
  filters: {},
  ...o,
});

// a—b—c chain, d isolated, e—f pair, a became artifact X, f revisits Y, pending b~e.
const ideas = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => idea(id));
const artifacts = [
  { id: 'X', title: 'Episode X', url: 'https://example.com/x', published_at: '2026-02-01T00:00:00.000Z', type: 'transcript' },
  { id: 'Y', title: 'Essay Y', url: null, published_at: null, type: 'essay' },
];
const links = [
  link('a', 'b', 'builds_on'),
  link('b', 'c', 'tension_with'),
  link('e', 'f', 'same_mechanism'),
  link('a', 'X', 'became', 'accepted', true),
  link('f', 'Y', 'revisits', 'accepted', true),
  link('b', 'e', 'combines_with', 'proposed'),
];

describe('buildIdeaMap', () => {
  it('computes degree, components, territory and orphans over accepted links', () => {
    const m = buildIdeaMap(ideas, links, artifacts, opts());
    const node = (id: string) => m.nodes.find((x) => x.id === id)!;
    expect(m.stats.nodes).toBe(8); // 6 ideas + 2 outputs
    expect(m.stats.edges).toBe(5); // pending excluded
    expect(node('a').degree).toBe(2);
    expect(node('b').pending_degree).toBe(1);
    expect(node('a').territory).toBe('territory');
    expect(node('f').territory).toBe('adjacent');
    expect(node('c').territory).toBe('frontier');
    expect(node('X').node_type).toBe('output');
    expect(node('a').component).toBe(node('c').component);
    expect(node('a').component).toBe(node('X').component); // outputs join their idea's component
    expect(node('a').component_size).toBe(3); // ideas only
    expect(node('e').component).not.toBe(node('a').component);
    expect(node('d').component_size).toBe(1);
    expect(m.stats.orphans).toBe(1);
    expect(m.truncated).toBe(false);
  });

  it('includes pending edges only on request, without merging components', () => {
    const m = buildIdeaMap(ideas, links, artifacts, opts({ include_pending: true }));
    expect(m.edges.filter((e) => e.status === 'proposed')).toHaveLength(1);
    const node = (id: string) => m.nodes.find((x) => x.id === id)!;
    expect(node('b').component).not.toBe(node('e').component);
  });

  it('excludes outputs and isolated ideas when asked', () => {
    const m = buildIdeaMap(ideas, links, artifacts, opts({ include_outputs: false, include_isolated: false }));
    expect(m.nodes.map((x) => x.id).sort()).toEqual(['a', 'b', 'c', 'e', 'f']);
    // territory still reflects accepted output links even when outputs are hidden
    expect(m.nodes.find((x) => x.id === 'a')!.territory).toBe('territory');
  });

  it('builds an ego network by BFS depth', () => {
    const d1 = buildIdeaMap(ideas, links, artifacts, opts({ focus_idea_id: 'c', depth: 1 }));
    expect(d1.nodes.map((x) => x.id)).toEqual(['c', 'b']);
    const d2 = buildIdeaMap(ideas, links, artifacts, opts({ focus_idea_id: 'c', depth: 2 }));
    expect(d2.nodes.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
    const d3 = buildIdeaMap(ideas, links, artifacts, opts({ focus_idea_id: 'c', depth: 3 }));
    expect(d3.nodes.map((x) => x.id)).toContain('X');
  });

  it('truncates by degree and reports omissions; keeps only linked outputs', () => {
    const m = buildIdeaMap(ideas, links, artifacts, opts({ max_nodes: 3 }));
    expect(m.nodes).toHaveLength(3);
    expect(m.truncated).toBe(true);
    expect(m.omitted_count).toBe(5);
    expect(m.nodes[0].id).toBe('a');
    for (const e of m.edges) {
      expect(m.nodes.some((x) => x.id === e.source)).toBe(true);
      expect(m.nodes.some((x) => x.id === e.target)).toBe(true);
    }
  });

  it('keeps linked outputs ahead of isolated ideas, and a share of them in a big connected garden', () => {
    const pad = (i: number) => `m${String(i).padStart(3, '0')}`;
    const many = Array.from({ length: 160 }, (_, i) => idea(pad(i)));
    const output = (id: string) => ({ id, title: `Essay ${id}`, url: null, published_at: '2026-03-01T00:00:00.000Z', type: 'essay' });

    // Mostly loose ideas (the html default of 150 nodes); the best-connected one became an essay.
    const loose = buildIdeaMap(
      many,
      [link(pad(0), pad(1), 'builds_on'), link(pad(0), 'E', 'became', 'accepted', true)],
      [output('E')],
      opts({ max_nodes: 150 }),
    );
    expect(loose.nodes).toHaveLength(150);
    expect(loose.nodes.map((x) => x.id)).toContain('E');
    expect(loose.edges.map((e) => e.type)).toContain('became');
    expect(loose).toMatchObject({ truncated: true, omitted_count: 11 });

    // Connected ideas alone would fill the map: up to a tenth of it is kept for their outputs.
    const chain = Array.from({ length: 159 }, (_, i) => link(pad(i), pad(i + 1), 'builds_on'));
    const outs = Array.from({ length: 20 }, (_, i) => output(`E${i}`));
    const became = outs.map((o, i) => link(pad(i), o.id, 'became', 'accepted', true));
    const dense = buildIdeaMap(many, [...chain, ...became], outs, opts({ max_nodes: 150 }));
    expect(dense.nodes).toHaveLength(150);
    expect(dense.nodes.filter((x) => x.node_type === 'output')).toHaveLength(15);
    expect(dense.omitted_count).toBe(30);
    for (const e of dense.edges) expect(dense.nodes.some((x) => x.id === e.source)).toBe(true);
  });

  it('ignores links whose endpoints are filtered out', () => {
    const m = buildIdeaMap(ideas.filter((i) => i.id !== 'b'), links, artifacts, opts());
    expect(m.edges.some((e) => e.source === 'b' || e.target === 'b')).toBe(false);
  });
});

describe('serialisers', () => {
  const tricky = [
    idea('p', 'Fish & "chips" <b> \'q\' 中文\u0001'),
    idea('q', 'Line one\nline "two" that is quite long and goes on beyond the sixty character mermaid cap'),
    idea('s', 'A synthesis', { kind: 'synthesis', intent: 'episode' }),
  ];
  const tl = [link('p', 'q', 'tension_with'), link('p', 's', 'part_of'), link('q', 's', 'part_of', 'proposed')];

  it('GraphML escapes XML and marks symmetric edges via the directed data key', () => {
    const m = buildIdeaMap(tricky, tl, [], opts({ include_pending: true }));
    const xml = toGraphML(m);
    expect(xml).toContain('Fish &amp; &quot;chips&quot; &lt;b&gt; &apos;q&apos; 中文</data>');
    expect(xml).not.toContain('\u0001');
    expect(xml).not.toContain('directed="false"'); // mixed graphs break networkx
    expect(xml).toMatch(/<edge id="[^"]+" source="p" target="q">\n      <data key="e_type">tension_with<\/data>[\s\S]*?<data key="e_directed">false<\/data>/);
    expect(xml).toMatch(/<edge id="[^"]+" source="p" target="s">/);
    expect(xml.startsWith('<?xml')).toBe(true);
  });

  it('Mermaid escapes quotes, strips newlines, truncates labels and styles edges', () => {
    const m = buildIdeaMap(tricky, tl, [], opts({ include_pending: true }));
    const mmd = toMermaid(m);
    expect(mmd.startsWith('flowchart LR')).toBe(true);
    expect(mmd).toContain('#quot;chips#quot;');
    expect(mmd).not.toMatch(/Line one\n/);
    expect(mmd).toContain('…');
    expect(mmd).toMatch(/n\d+ ---\|tension_with\| n\d+/);
    expect(mmd).toMatch(/n\d+ -->\|part_of\| n\d+/);
    expect(mmd).toMatch(/n\d+ -\.->\|part_of\?\| n\d+/);
    expect(mmd).toMatch(/n\d+\{\{"A synthesis"\}\}/);
    expect(mmd).toContain('classDef frontier');
  });
});

describe('clusters (Louvain) and the additive v1 fields', () => {
  // Two dense groups (4-cliques) joined by a single bridge, plus a loner.
  const ids = ['g1', 'g2', 'g3', 'g4', 'h1', 'h2', 'h3', 'h4', 'z'];
  const groupIdeas = ids.map((id) => idea(id, `Title ${id}`));
  const clique = (xs: string[]) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => link(a, b, 'related')));
  const groupLinks = [
    ...clique(['g1', 'g2', 'g3', 'g4']),
    ...clique(['h1', 'h2', 'h3', 'h4']),
    link('g4', 'h1', 'builds_on'),
    link('h2', 'g1', 'same_mechanism', 'proposed'),
  ];

  it('splits one component into two clusters along the bridge', () => {
    const m = buildIdeaMap(groupIdeas, groupLinks, [], opts());
    const node = (id: string) => m.nodes.find((x) => x.id === id)!;
    expect(node('g1').component).toBe(node('h1').component);
    expect(new Set(['g1', 'g2', 'g3', 'g4'].map((id) => node(id).cluster)).size).toBe(1);
    expect(new Set(['h1', 'h2', 'h3', 'h4'].map((id) => node(id).cluster)).size).toBe(1);
    expect(node('g1').cluster).not.toBe(node('h1').cluster);
    expect(node('g1').cluster_size).toBe(4);
    expect(node('z').cluster_size).toBe(1);
    // Named after the highest-degree member (the bridge ends have 4 links;
    // ties go to the smaller id); singletons get no entry.
    expect(m.clusters).toEqual([
      { id: 1, name: 'Title g4', size: 4 },
      { id: 2, name: 'Title h1', size: 4 },
    ]);
  });

  it('is deterministic whatever the input order', () => {
    const a = buildIdeaMap(groupIdeas, groupLinks, [], opts());
    const b = buildIdeaMap([...groupIdeas].reverse(), [...groupLinks].reverse(), [], opts());
    const clusterOf = (m: typeof a) => Object.fromEntries(m.nodes.map((x) => [x.id, [x.cluster, x.cluster_size]]));
    expect(clusterOf(b)).toEqual(clusterOf(a));
    expect(b.clusters).toEqual(a.clusters);
    expect(buildIdeaMap(groupIdeas, groupLinks, [], opts())).toEqual(a);
  });

  it('louvain keeps chains whole and isolated nodes apart', () => {
    expect(louvain(3, [[0, 1, 1], [1, 2, 1]])).toEqual([0, 0, 0]);
    expect(louvain(3, [])).toEqual([0, 1, 2]);
    expect(louvain(0, [])).toEqual([]);
  });

  it('outputs inherit the cluster of an idea they link to', () => {
    const m = buildIdeaMap(ideas, links, artifacts, opts());
    const node = (id: string) => m.nodes.find((x) => x.id === id)!;
    expect(node('X').cluster).toBe(node('a').cluster);
    expect(node('Y').cluster).toBe(node('f').cluster);
  });

  it('adds labels, timestamps, inbox and promotion without changing existing keys', () => {
    const withTimes: MapLink[] = [
      { ...link('a', 'b', 'tension_with'), proposed_at: '2026-02-01T00:00:00.000Z', decided_at: '2026-02-03T00:00:00.000Z' },
      { ...link('b', 'c', 'mechanism_for', 'proposed'), proposed_at: '2026-02-05T00:00:00.000Z', decided_at: null },
    ];
    const extra = [
      idea('a', 'A', { created_at: '2026-01-09T00:00:00.000Z', inbox: true }),
      idea('b', 'B', { promoted_at: '2026-03-01T00:00:00.000Z' }),
      idea('c', 'C'),
    ];
    const m = buildIdeaMap(extra, withTimes, [], opts({ include_pending: true }));
    const e = (type: string) => m.edges.find((x) => x.type === type)!;
    expect(e('tension_with')).toMatchObject({ label: 'contradicts', directed: false, decided_at: '2026-02-03T00:00:00.000Z' });
    expect(e('mechanism_for')).toMatchObject({ label: 'mechanism-for', directed: true, proposed_at: '2026-02-05T00:00:00.000Z', decided_at: null });
    const node = (id: string) => m.nodes.find((x) => x.id === id)!;
    expect(node('a')).toMatchObject({ created_at: '2026-01-09T00:00:00.000Z', inbox: true, promoted_at: null });
    expect(node('b')).toMatchObject({ inbox: false, promoted_at: '2026-03-01T00:00:00.000Z' });
    // Callers that predate these fields get nulls and false.
    const old = buildIdeaMap(ideas, links, artifacts, opts());
    expect(old.nodes.find((x) => x.id === 'a')).toMatchObject({ created_at: null, inbox: false, promoted_at: null });
    expect(old.edges[0]).toMatchObject({ proposed_at: null, decided_at: null });

    const xml = toGraphML(m);
    expect(xml).toContain('<key id="n_cluster" for="node" attr.name="cluster" attr.type="int"/>');
    expect(xml).toContain('<key id="e_label" for="edge" attr.name="label" attr.type="string"/>');
    expect(xml).toContain('<data key="e_label">contradicts</data>');
    expect(xml).toContain('<data key="n_inbox">true</data>');
    expect(xml).not.toContain('>null<');
    // Mermaid keeps the stored type names.
    expect(toMermaid(m)).toMatch(/\|tension_with\|/);
  });
});

describe('buildExplore', () => {
  const ei = (id: string, extra: Partial<ExploreIdea> = {}): ExploreIdea => ({
    id,
    title: `Idea ${id}`,
    status: 'parked',
    kind: 'unit',
    inbox: true,
    ...extra,
  });
  let k = 0;
  const el = (s: string, t: string, type: ExploreLink['link_type'], status: ExploreLink['status'] = 'accepted', artifact = false): ExploreLink => ({
    id: `e${String(++k).padStart(3, '0')}`,
    source_idea_id: s,
    target_idea_id: artifact ? null : t,
    target_artifact_id: artifact ? t : null,
    link_type: type,
    status,
    rationale: `${s} ${type} ${t}`,
  });
  // s1—n—s2 share a neighbour; n—far is two hops from s1; s3 stands alone
  // with an output; p is linked to s3 only by a proposal.
  const exIdeas = ['s1', 's2', 's3', 'n', 'far', 'p'].map((id) => ei(id));
  const exLinks = [
    el('s1', 'n', 'builds_on'),
    el('s2', 'n', 'tension_with'),
    el('n', 'far', 'example_of'),
    el('s3', 'p', 'related', 'proposed'),
    el('s3', 'A', 'became', 'accepted', true),
  ];
  const seeds = ['s1', 's2', 's3'].map((id, i) => ({ id, title: `Idea ${id}`, similarity: 0.9 - i / 10, match: ['semantic'] }));
  const art = [{ id: 'A', title: 'Episode A', url: 'https://example.com/a' }];

  it('groups by connected component, with labels and glosses, best seed first', () => {
    const r = buildExplore(seeds, exIdeas, exLinks, art, { depth: 1, max_ideas: 40 });
    expect(r.clusters.map((c) => c.ideas.map((i) => i.id))).toEqual([['s1', 's2', 'n'], ['s3', 'p']]);
    expect(r.clusters[0].name).toBe('Idea n'); // highest degree
    expect(r.clusters[0].links[0]).toEqual({
      source_id: 's1',
      source_title: 'Idea s1',
      link_type: 'builds_on',
      label: 'extends',
      target_id: 'n',
      target_title: 'Idea n',
      gloss: 's1 builds_on n',
      status: 'accepted',
    });
    expect(r.clusters[0].ideas.map((i) => i.is_seed)).toEqual([true, true, false]);
    expect(r.clusters[1].links[0]).toMatchObject({ label: 'related', status: 'proposed' });
    expect(r.outputs).toEqual([
      { id: 'A', title: 'Episode A', url: 'https://example.com/a', link_type: 'became', label: 'became', idea_id: 's3', status: 'accepted' },
    ]);
    expect(r.truncated).toBe(false);
  });

  it('follows depth hops and caps the idea count', () => {
    const d2 = buildExplore(seeds, exIdeas, exLinks, art, { depth: 2, max_ideas: 40 });
    expect(d2.clusters[0].ideas.map((i) => i.id)).toEqual(['s1', 's2', 'n', 'far']);
    const capped = buildExplore(seeds, exIdeas, exLinks, art, { depth: 2, max_ideas: 3 });
    expect(capped.clusters.flatMap((c) => c.ideas.map((i) => i.id))).toEqual(['s1', 's2', 's3']);
    expect(capped.truncated).toBe(true);
    // Without the shared neighbour, s1 and s2 are separate clusters.
    expect(capped.clusters).toHaveLength(3);
  });
});

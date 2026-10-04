import { describe, it, expect } from 'vitest';
import { buildIdeaMap, toGraphML, toMermaid, type MapIdea, type MapLink, type BuildOptions } from '../src/ideas/graph';

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

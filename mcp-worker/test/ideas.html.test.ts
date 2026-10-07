import { describe, it, expect } from 'vitest';
import { buildIdeaMap, type BuildOptions, type MapIdea, type MapLink } from '../src/ideas/graph';
import { htmlFilename, htmlPayload, scriptJson, toHtml, type HtmlPayload } from '../src/ideas/mapHtml';

// Synthetic data only (the repository is public).

const idea = (id: string, title: string, extra: Partial<MapIdea> = {}): MapIdea => ({
  id,
  title,
  kind: 'unit',
  intent: null,
  status: 'parked',
  captured_at: '2026-01-01T00:00:00.000Z',
  tags: [],
  ...extra,
});

let n = 0;
const link = (src: string, tgt: string, type: MapLink['link_type'], extra: Partial<MapLink> = {}): MapLink => ({
  id: `l${String(++n).padStart(3, '0')}`,
  source_idea_id: src,
  target_idea_id: tgt,
  target_artifact_id: null,
  link_type: type,
  status: 'accepted',
  rationale: `${src} and ${tgt} share a mechanism`,
  proposed_at: '2026-02-01T00:00:00.000Z',
  decided_at: '2026-02-02T00:00:00.000Z',
  ...extra,
});

const opts = (o: Partial<BuildOptions> = {}): BuildOptions => ({
  depth: 2,
  include_outputs: true,
  include_pending: true,
  include_isolated: true,
  max_nodes: 300,
  generated_at: '2026-10-07T12:00:00.000Z',
  filters: {},
  ...o,
});

const NASTY = 'Close </script><script>alert(1)</script> <!-- open \u2028 line \u2029 para \uD800 lone \uDC00 too 中文 🙂';

function dataOf(html: string): HtmlPayload {
  const m = html.match(/<script type="application\/json" id="map-data">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]) as HtmlPayload;
}

function sample() {
  const ideas = [
    idea('a', NASTY, { captured_at: '2025-03-04T05:06:07.000Z', inbox: true }),
    idea('b', 'Beta', { promoted_at: '2026-05-01T00:00:00.000Z' }),
    idea('c', 'Gamma synthesis', { kind: 'synthesis', intent: 'episode' }),
    idea('d', 'Delta, from the future', { captured_at: '2026-10-07T12:30:00.000Z' }),
  ];
  const links = [
    link('a', 'b', 'tension_with', { rationale: `gloss ${NASTY}` }),
    link('b', 'c', 'part_of'),
    link('a', 'c', 'builds_on', { status: 'proposed', decided_at: null }),
    { ...link('b', 'X', 'became'), target_idea_id: null, target_artifact_id: 'X' },
    { ...link('a', 'Y', 'revisits'), target_idea_id: null, target_artifact_id: 'Y' },
  ];
  const artifacts = [
    { id: 'X', title: 'Episode X', url: 'https://example.com/episode-x?a=1&b=<2>', published_at: '2026-06-01T00:00:00.000Z', type: 'transcript' },
    { id: 'Y', title: 'Essay Y', url: 'javascript:alert(1)', published_at: null, type: 'essay' },
  ];
  return buildIdeaMap(ideas, links, artifacts, opts());
}

describe('toHtml', () => {
  const map = sample();
  const html = toHtml(map);

  it('is one self-contained HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(htmlFilename(map)).toBe('idea-map-2026-10-07.html');
  });

  it('declares a CSP that allows only inline script and style', () => {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain("default-src 'none'");
    expect(csp![1]).toContain("script-src 'unsafe-inline'");
    expect(csp![1]).toContain("style-src 'unsafe-inline'");
    expect(csp![1]).not.toMatch(/https?:|unsafe-eval|\*/);
  });

  it('loads nothing from the network; output URLs only as runtime anchors', () => {
    expect(html).not.toMatch(/\ssrc\s*=/i);
    expect(html).not.toMatch(/\shref\s*=/i);
    expect(html).not.toMatch(/<(link|img|iframe|object|embed|base)\b/i);
    expect(html).not.toMatch(/@import|url\(\s*['"]?(https?:|\/\/)/i);
    expect(html).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon)\b/);
    // Every absolute URL in the file is an http(s) output URL inside the
    // data block; the javascript: one is dropped.
    const data = dataOf(html);
    const urls = data.nodes.map((x) => x.u).filter(Boolean);
    expect(urls).toEqual(['https://example.com/episode-x?a=1&b=<2>']);
    expect(html).not.toContain('javascript:');
    const outside = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '');
    expect(outside).not.toMatch(/https?:\/\//);
  });

  it('renders user text via textContent only', () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(script).toContain('.textContent');
  });

  it('escapes </script>, <!--, U+2028/2029 and strips lone surrogates', () => {
    // Only the page's own two script elements close.
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).not.toContain('<!--');
    expect(html).not.toMatch(/[\u2028\u2029]/);
    expect(html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(html).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const data = dataOf(html);
    const clean = NASTY.replace('\uD800', '').replace('\uDC00', '');
    expect(data.nodes.find((x) => x.n.startsWith('Close'))!.n).toBe(clean);
    expect(data.edges.some((e) => e.g === `gloss ${clean}`)).toBe(true);
    // Cluster names (an idea title) go through the same cleaning.
    const hub = buildIdeaMap([idea('a', NASTY), idea('b', 'B'), idea('c', 'C')], [link('a', 'b', 'related'), link('a', 'c', 'related')], [], opts());
    expect(dataOf(toHtml(hub)).clusters).toEqual([{ id: 1, name: clean, size: 3 }]);
    expect(scriptJson({ s: '</script>&\u2028' })).toBe('{"s":"\\u003c/script\\u003e\\u0026\\u2028"}');
  });

  it('embeds legend data with display labels', () => {
    const data = dataOf(html);
    expect(data.types.map((t) => t.label)).toEqual(['extends', 'part-of', 'contradicts', 'became', 'revisits']);
    expect(data.types.find((t) => t.label === 'contradicts')!.directed).toBe(false);
    expect(data.types.find((t) => t.label === 'extends')!.directed).toBe(true);
    // The proposed link is marked for a dashed line.
    const proposed = data.edges.filter((e) => e.p === 1);
    expect(proposed).toHaveLength(1);
    expect(data.types[proposed[0].y].label).toBe('extends');
    expect(data.clusters).toEqual([{ id: 1, name: 'Beta', size: 3 }]);
    expect(html).toContain('id="legend-clusters"');
    expect(html).toContain('id="legend-types"');
  });

  it('runs the as-of slider from the earliest captured_at to generated_at', () => {
    const data = dataOf(html);
    const from = Date.parse('2025-03-04T05:06:07.000Z');
    const to = Date.parse('2026-10-07T12:00:00.000Z');
    expect([data.from, data.to]).toEqual([from, to]);
    expect(html).toContain(`<input type="range" id="asof" min="${from}" max="${to}" step="any" value="${to}"`);
    // An idea captured after generated_at (allowed up to an hour ahead)
    // still shows at the end of the slider.
    expect(data.nodes.find((x) => x.n.startsWith('Delta'))!.t).toBe(to);
    // Edges appear when decided (accepted) or proposed (pending).
    expect(data.edges.find((e) => e.p === 1)!.t).toBe(Date.parse('2026-02-01T00:00:00.000Z'));
    expect(data.edges.find((e) => e.p !== 1)!.t).toBe(Date.parse('2026-02-02T00:00:00.000Z'));
    // Outputs appear when published, else with their first link.
    const out = data.nodes.filter((x) => x.y === 2);
    expect(out.map((x) => x.t).sort()).toEqual([Date.parse('2026-02-02T00:00:00.000Z'), Date.parse('2026-06-01T00:00:00.000Z')]);
  });

  it('carries the inbox badge, promoted marker and node shapes', () => {
    const data = dataOf(html);
    const byTitle = (t: string) => data.nodes.find((x) => x.n.startsWith(t))!;
    expect(byTitle('Close').i).toBe(1);
    expect(byTitle('Beta').i).toBeUndefined();
    expect(byTitle('Beta').p).toBe(Date.parse('2026-05-01T00:00:00.000Z'));
    expect(byTitle('Gamma').y).toBe(1);
    expect(byTitle('Episode').y).toBe(2);
    expect(byTitle('Close').y).toBe(0);
  });

  it('is deterministic and reports truncation', () => {
    expect(toHtml(sample())).toBe(html);
    const small = buildIdeaMap(
      Array.from({ length: 12 }, (_, i) => idea(`i${String(i).padStart(2, '0')}`, `Idea ${i}`)),
      [],
      [],
      opts({ max_nodes: 10 }),
    );
    const data = htmlPayload(small);
    expect(data).toMatchObject({ truncated: true, omitted: 2 });
    expect(toHtml(small)).toContain('id="trunc"');
  });

  it('renders an empty garden', () => {
    const empty = buildIdeaMap([], [], [], opts());
    const data = dataOf(toHtml(empty));
    expect(data).toMatchObject({ nodes: [], edges: [], clusters: [], types: [] });
    expect(data.from).toBe(data.to);
  });
});

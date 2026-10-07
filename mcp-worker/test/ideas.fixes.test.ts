import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCapturedAt, splitDatedNotes } from '../src/ideas/parse';
import { titleMatch, truncateChars, snippet } from '../src/ideas/text';
import { buildIdeaMap, mermaidLabel, toGraphML, toMermaid, MERMAID_MAX_EDGES, type MapLink } from '../src/ideas/graph';
import { assertSafeTestUrl, isLocalAddress } from './setup/test-db';

describe('Hyperdrive cache-busting convention', () => {
  // Every read in an idea tool must carry a STABLE function so Hyperdrive
  // never serves it from cache (read-after-write loops in gardening/import).
  const dir = fileURLToPath(new URL('../src/tools/', import.meta.url).href);
  const ideaTools = readdirSync(dir).filter((f) =>
    /^(park_idea|update_idea|get_idea|list_ideas|search_ideas|garden_ideas|propose_idea_links|list_idea_links|decide_idea_links|create_synthesis|export_idea_map|explore_topic|import_ideas|list_subjects_for_import)\.ts$/.test(
      f,
    ),
  );

  it('covers all 14 idea tools', () => {
    expect(ideaTools).toHaveLength(14);
  });

  // Shared idea modules may hold SQL too (the hybrid search lives in
  // src/ideas/search.ts), so every one of them is scanned.
  const ideasDir = fileURLToPath(new URL('../src/ideas/', import.meta.url).href);
  const ideaModules = readdirSync(ideasDir).filter((f) => f.endsWith('.ts'));

  it('scans the shared idea modules, including the hybrid search', () => {
    expect(ideaModules).toEqual(expect.arrayContaining(['search.ts', 'graph.ts', 'explore.ts']));
  });

  // Auth reads must never be cached either: a revoked token has to stop
  // working on the next request, and a used code must stay used.
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url).href);
  const authFiles = [
    ...readdirSync(`${srcDir}/auth`).filter((f) => f.endsWith('.ts')).map((f) => `auth/${f}`),
    ...readdirSync(`${srcDir}/oauth`).filter((f) => f.endsWith('.ts')).map((f) => `oauth/${f}`),
    'console.ts',
    'calllog.ts',
    'index.ts',
  ];

  it('scans every auth and OAuth module', () => {
    expect(authFiles).toEqual(expect.arrayContaining(['auth/middleware.ts', 'auth/labels.ts', 'oauth/token.ts', 'oauth/register.ts']));
  });
  const scanned = [
    ...ideaTools.map((f) => ({ path: `${dir}/${f}`, name: f, mustQuery: true })),
    ...ideaModules.map((f) => ({ path: `${ideasDir}/${f}`, name: `ideas/${f}`, mustQuery: f === 'search.ts' })),
    ...authFiles.map((f) => ({ path: `${srcDir}/${f}`, name: f, mustQuery: false })),
  ];

  // Read a template literal starting just after its opening backtick,
  // including nested `${ ... `...` ... }` fragments; returns [text, end].
  function readTemplate(src: string, i: number): [string, number] {
    let out = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        return [out, i + 1];
      } else if (c === '$' && src[i + 1] === '{') {
        let depth = 1;
        i += 2;
        out += '${';
        while (i < src.length && depth > 0) {
          const d = src[i];
          if (d === '`') {
            const [inner, end] = readTemplate(src, i + 1);
            out += '`' + inner + '`';
            i = end;
            continue;
          }
          if (d === '{') depth++;
          if (d === '}') depth--;
          out += d;
          i++;
        }
      } else {
        out += c;
        i++;
      }
    }
    throw new Error('unterminated template');
  }

  for (const { path, name, mustQuery } of scanned) {
    it(`${name}: every top-level SELECT/WITH query includes now()`, () => {
      const src = readFileSync(path, 'utf8');
      // Tagged templates whose text starts with SELECT or WITH are queries;
      // fragments (column lists, conditions) start with anything else.
      const queries: string[] = [];
      for (const m of src.matchAll(/\b(?:sql|tx|db)(?=[<`])/g)) {
        let i = (m.index ?? 0) + m[0].length;
        if (src[i] === '<') {
          // Skip a (possibly nested, multi-line) generic argument list.
          let depth = 0;
          do {
            if (src[i] === '<') depth++;
            else if (src[i] === '>' && src[i - 1] !== '=') depth--;
            i++;
          } while (depth > 0 && i < src.length);
        }
        if (src[i] !== '`') continue;
        const [text] = readTemplate(src, i + 1);
        if (/^\s*(SELECT|WITH)\b/.test(text)) queries.push(text);
      }
      if (mustQuery) expect(queries.length).toBeGreaterThan(0);
      for (const q of queries) {
        expect(q, q.slice(0, 120)).toMatch(/now\(\)/);
      }
    });
  }
});

describe('parse fixes', () => {
  it('reads Notion times in an IANA zone across DST', () => {
    // London: GMT in March before the 29th, BST after.
    expect(parseCapturedAt('March 8, 2026 12:26 PM', { timeZone: 'Europe/London' })).toBe('2026-03-08T12:26:00.000Z');
    expect(parseCapturedAt('March 31, 2026 10:19 PM', { timeZone: 'Europe/London' })).toBe('2026-03-31T21:19:00.000Z');
    expect(parseCapturedAt('March 8, 2026 12:26 PM', { timeZone: 'Asia/Hong_Kong' })).toBe('2026-03-08T04:26:00.000Z');
    expect(parseCapturedAt('March 8, 2026', { timeZone: 'Not/AZone' })).toBeNull();
  });

  it('rejects ISO day overflow', () => {
    expect(parseCapturedAt('2026-02-30T10:00:00Z')).toBeNull();
    expect(parseCapturedAt('2026-02-28T24:00:00Z')).toBeNull();
    expect(parseCapturedAt('2026-02-28T10:00:00Z')).toBe('2026-02-28T10:00:00.000Z');
  });

  it('splits only on line-start markers and keeps invalid or inline ones verbatim', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const raw = 'Intro — see [2026-03-10] entry.\n[2026-13-45] not a date\n[2026-03-11] Real note.';
    expect(splitDatedNotes(raw, at)).toEqual([
      { at, text: 'Intro — see [2026-03-10] entry.\n[2026-13-45] not a date' },
      { at: '2026-03-11T00:00:00.000Z', text: 'Real note.' },
    ]);
    expect(splitDatedNotes('[2026-03-11] A', at, { timeZone: 'Asia/Hong_Kong' })).toEqual([
      { at: '2026-03-10T16:00:00.000Z', text: 'A' },
    ]);
  });
});

describe('text fixes', () => {
  it('labels title matches exact vs contains, ignoring format chars', () => {
    expect(titleMatch('Tide tables', 'tide-tables!')).toBe('exact');
    expect(titleMatch('Tide tables​', 'Tide tables')).toBe('exact');
    expect(titleMatch('Tide tables', 'Tide tables of the north sea')).toBe('contains');
    expect(titleMatch('潮汐', '潮汐點樣形成')).toBeNull(); // 2 CJK chars is too short
    expect(titleMatch('潮汐點樣', '潮汐點樣形成')).toBe('contains');
    expect(titleMatch('Tides', 'Why tides turn')).toBeNull();
  });

  it('never splits surrogate pairs when truncating', () => {
    const s = '🙂'.repeat(10);
    const cut = truncateChars(s, 4);
    expect(cut).toBe('🙂🙂🙂…');
    expect(snippet('a🙂b🙂c', 3)).toBe('a🙂…');
    expect(JSON.parse(JSON.stringify(cut))).toBe(cut);
  });
});

describe('graph fixes', () => {
  const idea = (id: string, title = id) => ({
    id,
    title,
    kind: 'unit' as const,
    intent: null,
    status: 'parked',
    captured_at: '2026-01-01T00:00:00.000Z',
    tags: [],
  });
  let n = 0;
  const link = (src: string, tgt: string, type: MapLink['link_type'], artifact = false): MapLink => ({
    id: `x${++n}`,
    source_idea_id: src,
    target_idea_id: artifact ? null : tgt,
    target_artifact_id: artifact ? tgt : null,
    link_type: type,
    status: 'accepted',
    rationale: 'r',
  });
  const opts = {
    depth: 2,
    include_outputs: true,
    include_pending: false,
    include_isolated: true,
    max_nodes: 300,
    generated_at: 'now',
    filters: {},
  };
  const hub = { id: 'H', title: 'Hub episode', url: null, published_at: null, type: 'transcript' };

  it('does not glue unrelated ideas together through a shared output', () => {
    const ideas = [idea('c'), idea('d'), idea('e')];
    const links = [link('c', 'H', 'revisits', true), link('d', 'H', 'revisits', true), link('c', 'e', 'builds_on')];
    const m = buildIdeaMap(ideas, links, [hub], opts);
    const node = (id: string) => m.nodes.find((x) => x.id === id)!;
    expect(node('c').component).not.toBe(node('d').component);
    expect(m.stats.components).toBe(2);
    // Orphan status doesn't depend on whether outputs are shown.
    const hidden = buildIdeaMap(ideas, links, [hub], { ...opts, include_outputs: false });
    expect(hidden.stats.orphans).toBe(m.stats.orphans);
    expect(m.stats.orphans).toBe(0);
    // Ego network: outputs are leaves, not bridges.
    const ego = buildIdeaMap(ideas, links, [hub], { ...opts, focus_idea_id: 'd', depth: 3 });
    expect(ego.nodes.map((x) => x.id).sort()).toEqual(['H', 'd']);
  });

  it('escapes Mermaid markup and handles empty labels', () => {
    expect(mermaidLabel('`git bisect` <b> #12; 50% & "q"')).toBe('#96;git bisect#96; #60;b#62; #35;12; 50#37; #38; #quot;q#quot;');
    expect(mermaidLabel('   ')).toBe('(untitled)');
    const m = buildIdeaMap([idea('a', '`tick`'), idea('b', '')], [link('a', 'b', 'related')], [], opts);
    const mmd = toMermaid(m);
    expect(mmd).toContain('n1["#96;tick#96;"]');
    expect(mmd).toContain('(untitled)');
  });

  it('caps Mermaid edges at the renderer limit, keeping accepted ones', () => {
    const ideas = Array.from({ length: 40 }, (_, i) => idea(`i${String(i).padStart(2, '0')}`));
    const links: MapLink[] = [];
    for (let i = 0; i < 40; i++) for (let j = i + 1; j < 40; j++) links.push(link(ideas[i].id, ideas[j].id, 'builds_on'));
    const m = buildIdeaMap(ideas, links, [], opts);
    expect(m.edges.length).toBeGreaterThan(MERMAID_MAX_EDGES);
    const edgeLines = toMermaid(m).split('\n').filter((l) => l.includes('-->'));
    expect(edgeLines).toHaveLength(MERMAID_MAX_EDGES);
  });

  it('strips characters XML forbids, including lone surrogates', () => {
    const m = buildIdeaMap([idea('a', 'ok￾bad\uD800half 🙂')], [], [], opts);
    const xml = toGraphML(m);
    expect(xml).toContain('<data key="n_label">okbadhalf 🙂</data>');
  });
});

describe('test DB guard', () => {
  it('rejects URLs the driver would read differently', () => {
    expect(() => assertSafeTestUrl('postgres://u:p@localhost:5432/x_test?database=prod')).toThrow();
    expect(() => assertSafeTestUrl('postgres://u:p@prod.example.com,x@localhost:5432/x_test')).toThrow();
    expect(() => assertSafeTestUrl('postgres://u:p@prod.example.com:5432/x_test')).toThrow();
    expect(() => assertSafeTestUrl('postgres://u:p@localhost:5432/prod')).toThrow();
    expect(() => assertSafeTestUrl('postgres://u:p@localhost:5432/x_test')).not.toThrow();
  });

  it('treats loopback, sockets and private networks (CI containers) as local', () => {
    for (const a of [null, '127.0.0.1', '::1', '172.18.0.2', '10.1.2.3', '192.168.1.5', '::ffff:172.17.0.2', 'fd00::5']) {
      expect(isLocalAddress(a), String(a)).toBe(true);
    }
    for (const a of ['34.120.1.9', '172.32.0.1', '8.8.8.8', '2600:1f18::1']) {
      expect(isLocalAddress(a), a).toBe(false);
    }
  });
});

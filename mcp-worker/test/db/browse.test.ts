import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
  admin,
  axis,
  callTool,
  mix,
  ok,
  resetIdeaData,
  resetJournalData,
  seedArtifact,
  seedIdea,
  seedJournalEntry,
  setEmbedding,
  TEST_DB,
} from './helpers';

afterAll(() => admin.end({ timeout: 5 }));

function stubEmbeddings(vector: number[] | 'fail') {
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).includes('api.openai.com')) throw new Error(`unexpected fetch ${url}`);
    if (vector === 'fail') return new Response('boom', { status: 500 });
    return Response.json({ data: [{ embedding: vector }] });
  });
}

describe.skipIf(!TEST_DB)('list_ideas', () => {
  beforeEach(resetIdeaData);

  it('filters by status, kind, tags, source, dates, links and outputs', async () => {
    const a = await seedIdea('Alpha', { tags: ['econ', 'history'], captured_at: '2026-01-01T00:00:00Z' });
    const b = await seedIdea('Beta', { tags: ['econ'] });
    const c = await seedIdea('Gamma');
    await ok('update_idea', { id: c, status: 'composted' });
    await ok('import_ideas', {
      source_system: 'notion',
      items: [{ source_external_id: 'n1', import_payload: {}, title: 'Delta' }],
    });
    const x = await seedArtifact('Episode', null);
    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: a, target_idea_id: b, link_type: 'builds_on', rationale: 'Alpha extends Beta' },
        { source_idea_id: a, target_artifact_id: x, link_type: 'became', rationale: 'Alpha became the episode' },
      ],
    });
    await ok('decide_idea_links', { decisions: p.results.map((r: any) => ({ link_id: r.link_id, decision: 'accept' })) });

    const all = await ok('list_ideas', {});
    expect(all.total).toBe(3); // composted excluded by default
    expect(all.ideas.map((i: any) => i.title)).not.toContain('Gamma');
    const alpha = all.ideas.find((i: any) => i.title === 'Alpha');
    expect(alpha).toMatchObject({ link_count: 2, has_output: true, tags: ['econ', 'history'], embedded: false });

    const comp = await ok('list_ideas', { statuses: ['composted'] });
    expect(comp.ideas.map((i: any) => i.title)).toEqual(['Gamma']);
    expect((await ok('list_ideas', { tags: ['econ', 'history'] })).ideas.map((i: any) => i.title)).toEqual(['Alpha']);
    expect((await ok('list_ideas', { source_system: 'notion' })).ideas.map((i: any) => i.title)).toEqual(['Delta']);
    expect((await ok('list_ideas', { unlinked: true })).ideas.map((i: any) => i.title)).toEqual(['Delta']);
    expect((await ok('list_ideas', { has_output: false })).total).toBe(2);
    expect((await ok('list_ideas', { until: '2026-02-01T00:00:00Z' })).ideas.map((i: any) => i.title)).toEqual(['Alpha']);
    const page = await ok('list_ideas', { limit: 1, offset: 1 });
    expect(page.count).toBe(1);
    expect(page.total).toBe(3);
    const empty = await ok('list_ideas', { kind: 'synthesis' });
    expect(empty).toMatchObject({ total: 0, count: 0, ideas: [] });
  });
});

describe.skipIf(!TEST_DB)('search_ideas', () => {
  beforeEach(resetIdeaData);
  afterEach(() => vi.unstubAllGlobals());

  it('finds unembedded ideas by text (incl. Chinese) and embedded ones semantically', async () => {
    const zh = await seedIdea('潮汐點樣形成', { thoughts: '月球引力係關鍵' });
    const en = await seedIdea('Tidal bulges', { why_interesting: 'orbital mechanics' });
    const far = await seedIdea('Unrelated gardening');
    await setEmbedding(en, axis(0));
    await setEmbedding(far, axis(9));

    // A query vector far from everything: only the text match on the
    // not-yet-embedded Chinese idea comes back (no low-similarity noise).
    stubEmbeddings(axis(7));
    const r1 = await ok('search_ideas', { query: '形成' });
    expect(r1.hits.map((h: any) => h.id)).toEqual([zh]);
    expect(r1.hits[0].match).toEqual(['text']);
    expect(r1.unembedded_count).toBe(1);

    stubEmbeddings(mix(0, 1, 0.8));
    const r2 = await ok('search_ideas', { query: 'orbital mechanics' });
    expect(r2.hits[0].id).toBe(en);
    expect(r2.hits[0].match).toEqual(['semantic', 'text']);
    expect(r2.hits[0].similarity).toBeCloseTo(0.8, 3);
    const lowFloor = await ok('search_ideas', { query: 'anything', min_similarity: 0 });
    expect(lowFloor.hits.map((h: any) => h.id)).toContain(far);

    const r3 = await ok('search_ideas', { query: '引力' });
    expect(r3.hits.map((h: any) => h.id)).toContain(zh); // matches thoughts

    const wild = await ok('search_ideas', { query: '%' });
    expect(wild.hits.filter((h: any) => h.match.includes('text'))).toEqual([]);
  });

  it('degrades to text-only search when embeddings fail', async () => {
    await seedIdea('Fallback works');
    stubEmbeddings('fail');
    const r = await ok('search_ideas', { query: 'fallback' });
    expect(r.hits).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Semantic search unavailable/);
  });
});

describe.skipIf(!TEST_DB)('export_idea_map', () => {
  beforeEach(resetIdeaData);

  it('exports json / graphml / mermaid with focus, pending and truncation', async () => {
    const a = await seedIdea('Map "A" & co');
    const b = await seedIdea('Map B');
    const c = await seedIdea('Map C');
    const d = await seedIdea('Map D (isolated)');
    const x = await seedArtifact('Essay X', null);
    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: a, target_idea_id: b, link_type: 'builds_on', rationale: 'A extends B here' },
        { source_idea_id: b, target_idea_id: c, link_type: 'tension_with', rationale: 'B and C disagree' },
        { source_idea_id: a, target_artifact_id: x, link_type: 'became', rationale: 'A became essay X' },
        { source_idea_id: c, target_idea_id: d, link_type: 'related', rationale: 'still only proposed' },
      ],
    });
    await ok('decide_idea_links', {
      decisions: p.results.slice(0, 3).map((r: any) => ({ link_id: r.link_id, decision: 'accept' })),
    });

    const json = await ok('export_idea_map', {});
    expect(json.format).toBe('idea-map/v1');
    expect(json.stats).toEqual({ nodes: 5, edges: 3, components: 2, orphans: 1 });
    const node = (id: string) => json.nodes.find((n: any) => n.id === id);
    expect(node(a).territory).toBe('territory');
    expect(node(x).node_type).toBe('output');
    expect(node(d).pending_degree).toBe(1);

    const pending = await ok('export_idea_map', { include_pending: true });
    expect(pending.edges.filter((e: any) => e.status === 'proposed')).toHaveLength(1);

    const ego = await ok('export_idea_map', { focus_idea_id: c, depth: 1 });
    expect(ego.nodes.map((n: any) => n.id).sort()).toEqual([b, c].sort());

    const small = await ok('export_idea_map', { max_nodes: 10, include_isolated: false });
    expect(small.nodes.map((n: any) => n.id)).not.toContain(d);

    const gm = await callTool('export_idea_map', { format: 'graphml' });
    expect(gm.isError).toBe(false);
    expect(gm.json.format).toBe('graphml');
    expect(gm.texts[1]).toContain('<graphml');
    expect(gm.texts[1]).toContain('Map &quot;A&quot; &amp; co');

    const mm = await callTool('export_idea_map', { format: 'mermaid', max_nodes: 1000 });
    expect(mm.texts[1].startsWith('flowchart LR')).toBe(true);
    expect(mm.json.note).toMatch(/capped at 150/);

    const missing = await callTool('export_idea_map', { focus_idea_id: '00000000-0000-0000-0000-000000000000' });
    expect(missing.isError).toBe(true);
  });
});

describe.skipIf(!TEST_DB)('search_brain', () => {
  beforeEach(resetJournalData);
  afterEach(() => vi.unstubAllGlobals());

  const titles = (r: any) => (r.hits as Array<{ summary: string }>).map((h) => h.summary).sort();

  it('filters by tags, including tags with commas and quotes', async () => {
    stubEmbeddings(axis(0));
    await seedJournalEntry({ vector: axis(0), tags: ['alpha'], summary: 'A' });
    await seedJournalEntry({ vector: mix(0, 1, 0.9), tags: ['beta', 'a,b"c'], summary: 'B' });
    await seedJournalEntry({ vector: mix(0, 1, 0.8), summary: 'C' });

    expect(titles(await ok('search_brain', { query: 'q', tags: ['alpha'] }))).toEqual(['A']);
    // A JS array bound raw used to fail here with "malformed array literal".
    expect(titles(await ok('search_brain', { query: 'q', tags: ['a,b"c'] }))).toEqual(['B']);
    expect(titles(await ok('search_brain', { query: 'q', tags: ['beta', 'a,b"c'] }))).toEqual(['B']);
    expect(titles(await ok('search_brain', { query: 'q' }))).toEqual(['A', 'B', 'C']);
  });

  it('keeps the scope filter; the retired primary_type filter is ignored', async () => {
    stubEmbeddings(axis(0));
    await seedJournalEntry({ vector: axis(0), summary: 'P', primaryType: 'task_candidate' });
    await seedJournalEntry({ vector: axis(0), summary: 'F', scope: 'family' });
    await seedJournalEntry({ vector: null, summary: 'U', status: 'pending' });

    expect(titles(await ok('search_brain', { query: 'q' }))).toEqual(['P']);
    expect(titles(await ok('search_brain', { query: 'q', scope: 'all' }))).toEqual(['F', 'P']);
    expect(titles(await ok('search_brain', { query: 'q', primary_type: 'knowledge_candidate' }))).toEqual(['P']);
  });

  it('finds Chinese phrases and unprocessed entries by text', async () => {
    stubEmbeddings(axis(0));
    const near = await seedJournalEntry({ vector: axis(0), summary: 'Unrelated but semantically near' });
    const zh = await seedJournalEntry({ vector: axis(1), summary: '關於貨幣政策的筆記', fullText: '今天想到貨幣政策與通脹預期的關係' });
    const pending = await seedJournalEntry({ vector: null, status: 'pending', fullText: '一段很長的對話總結，提到貨幣政策' });
    await seedJournalEntry({ vector: null, status: 'cancelled', fullText: '貨幣政策 (cancelled draft)' });

    const r = await ok('search_brain', { query: '貨幣政策', limit: 10 });
    const byId = new Map((r.hits as Array<any>).map((h) => [h.id, h]));
    expect(byId.get(near).match).toEqual(['semantic']);
    expect(byId.get(zh).match).toEqual(['semantic', 'text']);
    expect(byId.get(pending)).toMatchObject({ match: ['text'], similarity: null, processing_status: 'pending', summary: null });
    expect(byId.get(pending).preview).toContain('貨幣政策');
    expect(r.hits).toHaveLength(3);
    // Found by both legs first; then the top semantic hit ties the top text
    // hit and wins on similarity.
    expect(r.hits.map((h: any) => h.id)).toEqual([zh, near, pending]);
  });

  it('matches short Latin terms as whole words, also next to Chinese', async () => {
    stubEmbeddings('fail');
    await seedJournalEntry({ vector: null, status: 'pending', fullText: 'He said it again, aiming high' });
    const zh = await seedJournalEntry({ vector: null, status: 'pending', fullText: '我覺得AI會改變教育' });
    const dash = await seedJournalEntry({ vector: null, status: 'pending', fullText: 'Notes on AI-driven tutoring' });
    const prefix = await seedJournalEntry({ vector: null, status: 'pending', fullText: 'Central bank policymakers met' });

    const ids = (r: any) => (r.hits as Array<{ id: string }>).map((h) => h.id).sort();
    expect(ids(await ok('search_brain', { query: 'AI' }))).toEqual([zh, dash].sort());
    // Longer terms match at the start of a word.
    expect(ids(await ok('search_brain', { query: 'policy' }))).toEqual([prefix]);
    expect(ids(await ok('search_brain', { query: 'olicy' }))).toEqual([]);
    // Regex characters in a term are literal.
    expect(ids(await ok('search_brain', { query: 'C++ (a.b) [x] \\' }))).toEqual([]);
  });

  it('keeps semantic hits when many newer entries match by text', async () => {
    stubEmbeddings(axis(0));
    // Older, and its summary matches: it leads the text leg despite its age.
    const old = await seedJournalEntry({
      vector: axis(1),
      summary: 'Moving back to Hong Kong',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const sem = await seedJournalEntry({ vector: mix(0, 1, 0.5), summary: 'Thoughts on schooling abroad' });
    for (let i = 0; i < 8; i++) {
      await seedJournalEntry({ vector: null, status: 'pending', fullText: `Kong mention ${i}` });
    }

    const r = await ok('search_brain', { query: 'Kong', limit: 5 });
    const ids = (r.hits as Array<{ id: string }>).map((h) => h.id);
    expect(ids).toHaveLength(5);
    expect(ids.slice(0, 2)).toEqual([old, sem]);
    expect(r.hits[0].match).toEqual(['semantic', 'text']);
    expect(r.hits.slice(2).every((h: any) => h.match[0] === 'text')).toBe(true);
  });

  it('falls back to text when the embedding call fails', async () => {
    stubEmbeddings('fail');
    const id = await seedJournalEntry({ vector: axis(0), summary: 'Notes on the gold standard' });
    const r = await ok('search_brain', { query: 'gold standard' });
    expect(r.hits.map((h: any) => h.id)).toEqual([id]);
    expect(r.warnings[0]).toMatch(/Semantic search unavailable/);
  });
});

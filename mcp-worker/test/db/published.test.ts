import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { admin, axis, callTool, mix, ok, resetIdeaData, seedPiece, stubEmbeddings, TEST_DB } from './helpers';

// Synthetic data only (the repository is public).

afterAll(() => admin.end({ timeout: 5 }));

const titles = (r: any) => (r.hits as Array<{ title: string }>).map((h) => h.title);
const sorted = (xs: string[]) => [...xs].sort();
const chars = (s: string) => Array.from(s).length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe.skipIf(!TEST_DB)('search_published', () => {
  beforeEach(resetIdeaData);
  afterEach(() => vi.unstubAllGlobals());

  it('ranks a piece found both ways first and returns one hit per piece with its best passages', async () => {
    stubEmbeddings(axis(0));
    const both = await seedPiece({
      title: 'Morning at the harbour',
      publishedAt: '2026-05-01T00:00:00Z',
      chunks: [
        { text: 'Opening words about the sea.', vector: mix(0, 1, 0.97) },
        { text: 'Reading tide tables before dawn.', vector: axis(0), headings: ['Part one'] },
        { text: 'More on tide tables and harbours.', vector: mix(0, 1, 0.5) },
      ],
    });
    await seedPiece({ title: 'Moon and water', chunks: [{ text: 'How the moon moves water.', vector: mix(0, 1, 0.95) }] });
    await seedPiece({
      title: 'A drawer of papers',
      publishedAt: '2026-01-01T00:00:00Z',
      chunks: [{ text: 'Old tide tables in a drawer.', vector: null }],
    });

    const r = await ok('search_published', { query: 'tide tables' });
    expect(titles(r)).toEqual(['Morning at the harbour', 'Moon and water', 'A drawer of papers']);
    expect(r).toMatchObject({ query: 'tide tables', count: 3, truncated: false });
    expect(r.as_of).toMatch(/^\d{4}-/);
    expect(r.warnings).toBeUndefined();
    expect(r.hits.map((h: any) => h.match)).toEqual([['semantic', 'text'], ['semantic'], ['text']]);

    const top = r.hits[0];
    expect(top).toMatchObject({
      artifact_id: both,
      type: 'essay',
      flag: null,
      members_only: false,
      similarity: 1,
      summary: 'Summary of Morning at the harbour',
      url: 'https://example.com/Morning%20at%20the%20harbour',
    });
    // Chunks both legs found come first: the opening ranks second in the
    // semantic leg, but only that leg found it.
    expect(top.passages).toEqual([
      { chunk_index: 1, heading_path: ['Part one'], match: ['semantic', 'text'], similarity: 1, text: 'Reading tide tables before dawn.' },
      { chunk_index: 2, heading_path: [], match: ['semantic', 'text'], similarity: 0.5, text: 'More on tide tables and harbours.' },
    ]);
    expect(r.hits[2]).toMatchObject({ similarity: null, passages: [{ match: ['text'], similarity: null }] });

    const one = await ok('search_published', { query: 'tide tables', passages: 1, limit: 2 });
    expect(titles(one)).toEqual(['Morning at the harbour', 'Moon and water']);
    expect(one.hits[0].passages.map((p: any) => p.chunk_index)).toEqual([1]);
  });

  it('finds a Chinese phrase the embedding misses and centres the passage on it', async () => {
    stubEmbeddings(axis(0));
    await seedPiece({ title: 'Unrelated piece', chunks: [{ text: 'Nothing about it here.', vector: axis(0) }] });
    const before = '這是一段關於城市規劃的長文。'.repeat(40);
    const after = '之後再談交通與房屋。'.repeat(40);
    const zh = await seedPiece({
      title: '香港的制度',
      chunks: [{ text: `${before}聯繫匯率與貨幣局制度的由來${after}`, vector: axis(3) }],
    });

    const r = await ok('search_published', { query: '貨幣局制度' });
    expect(r.hits[0]).toMatchObject({ artifact_id: zh, match: ['semantic', 'text'] });
    const text = r.hits[0].passages[0].text as string;
    expect(text).toContain('聯繫匯率與貨幣局制度的由來');
    expect(text.startsWith('…') && text.endsWith('…')).toBe(true);
    expect(chars(text)).toBe(500);
    expect(r.hits[1]).toMatchObject({ title: 'Unrelated piece', match: ['semantic'] });
  });

  it('matches short Latin terms as whole words, treats regex characters literally, and falls back to text', async () => {
    stubEmbeddings('fail');
    await seedPiece({ title: 'Essay one', chunks: [{ text: 'He said it again, aiming high', vector: axis(0) }] });
    await seedPiece({ title: 'Essay two', chunks: [{ text: '我覺得AI會改變教育', vector: axis(0) }] });
    await seedPiece({ title: 'Essay three', chunks: [{ text: 'Notes on AI-driven tutoring', vector: axis(0) }] });
    await seedPiece({ title: 'Essay four', chunks: [{ text: 'Central bank policymakers met', vector: axis(0) }] });

    const r = await ok('search_published', { query: 'AI' });
    expect(sorted(titles(r))).toEqual(['Essay three', 'Essay two']);
    expect(r.warnings[0]).toMatch(/^Semantic search unavailable/);
    expect(r.hits.every((h: any) => h.similarity === null && h.match.join() === 'text')).toBe(true);
    // Longer terms match at the start of a word; every term must match.
    expect(titles(await ok('search_published', { query: 'policy' }))).toEqual(['Essay four']);
    expect(titles(await ok('search_published', { query: 'olicy' }))).toEqual([]);
    expect(titles(await ok('search_published', { query: 'policy tutoring' }))).toEqual([]);
    // A title term and a passage term together.
    expect(titles(await ok('search_published', { query: 'four central' }))).toEqual(['Essay four']);
    expect(titles(await ok('search_published', { query: 'C++ (a.b) [x] \\' }))).toEqual([]);
  });

  it('ranks title matches first in the text leg and lets no long piece fill it', async () => {
    stubEmbeddings('fail');
    await seedPiece({
      title: 'Very long transcript',
      sourceSystem: 'youtube',
      publishedAt: '2026-06-01T00:00:00Z',
      chunks: Array.from({ length: 45 }, (_, i) => ({ text: `第${i}段：再談颱風信號。`, vector: null })),
    });
    await seedPiece({ title: 'Short essay', publishedAt: '2020-01-01T00:00:00Z', chunks: [{ text: '颱風信號的歷史', vector: null }] });
    await seedPiece({ title: '颱風信號簡史', publishedAt: '2019-01-01T00:00:00Z', chunks: [{ text: '一篇舊文。', vector: null }] });

    const r = await ok('search_published', { query: '颱風信號' });
    expect(titles(r)).toEqual(['颱風信號簡史', 'Very long transcript', 'Short essay']);
    expect(r.hits[0].passages).toMatchObject([{ chunk_index: 0, text: '一篇舊文。' }]);
    expect(r.hits[1].passages.map((p: any) => p.chunk_index)).toEqual([0, 1]);
  });

  it('lets no long piece fill the semantic leg', async () => {
    stubEmbeddings(axis(0));
    // No text matches: only the semantic leg finds these.
    await seedPiece({
      title: 'Long transcript',
      sourceSystem: 'youtube',
      chunks: Array.from({ length: 45 }, (_, i) => ({ text: `Part ${i} of a long talk.`, vector: mix(0, 1, 0.99 - i / 10_000) })),
    });
    for (let i = 0; i < 5; i++) {
      await seedPiece({ title: `Short essay ${i}`, chunks: [{ text: 'A short essay.', vector: mix(0, 1, 0.9) }] });
    }

    const r = await ok('search_published', { query: 'quiet rivers' });
    expect(r.count).toBe(6);
    expect(titles(r)[0]).toBe('Long transcript');
    expect(sorted(titles(r).slice(1))).toEqual([0, 1, 2, 3, 4].map((i) => `Short essay ${i}`));
    expect(r.hits[0].passages.map((p: any) => p.chunk_index)).toEqual([0, 1]);
  });

  it('finds the other pieces when one long piece owns every pooled chunk', async () => {
    stubEmbeddings(axis(0));
    // 210 chunks, all nearer than anything else: the 200-chunk pool holds
    // only this piece, so the leg ranks every chunk exactly instead.
    await seedPiece({
      title: 'Very long transcript',
      sourceSystem: 'youtube',
      chunks: Array.from({ length: 210 }, (_, i) => ({ text: `Segment ${i} of a very long talk.`, vector: mix(0, 1, 0.99 - i / 1_000_000) })),
    });
    for (let i = 0; i < 4; i++) {
      await seedPiece({ title: `Short essay ${i}`, chunks: [{ text: 'A short essay.', vector: mix(0, 1, 0.9 - i / 100) }] });
    }
    // Nearer than the essays, but the exact scan still applies the filters.
    await seedPiece({ title: 'Superseded copy', status: 'superseded', chunks: [{ text: 'An old copy.', vector: mix(0, 1, 0.95) }] });

    const r = await ok('search_published', { query: 'quiet rivers', passages: 3 });
    expect(titles(r)).toEqual(['Very long transcript', 'Short essay 0', 'Short essay 1', 'Short essay 2', 'Short essay 3']);
    expect(r.hits[0].passages.map((p: any) => p.chunk_index)).toEqual([0, 1, 2]);
    expect(r.hits.every((h: any) => h.match.includes('semantic'))).toBe(true);
  });

  it('never returns a superseded copy, a hidden fragment or an unprocessed row', async () => {
    stubEmbeddings(axis(0));
    const live = await seedPiece({ title: 'Harbour lights', chunks: [{ text: 'harbour lights at night', vector: axis(0) }] });
    const old = await seedPiece({
      title: 'Harbour lights (first import)',
      status: 'superseded',
      chunks: [{ text: 'harbour lights at night', vector: axis(0) }],
    });
    await admin`UPDATE public_artifact SET superseded_by = ${live} WHERE id = ${old}`;
    await seedPiece({
      title: 'Harbour lights (queued)',
      processingStatus: 'pending',
      chunks: [{ text: 'harbour lights at night', vector: axis(0) }],
    });
    // Migration 034: a fragment leaves search, but get_artifact still reads it by id.
    const fragment = await seedPiece({
      title: 'Re: harbour lights',
      status: 'hidden',
      flag: 'fragment',
      chunks: [{ text: 'harbour lights at night', vector: axis(0) }],
    });

    const r = await ok('search_published', { query: 'harbour lights' });
    expect(r.hits.map((h: any) => h.artifact_id)).toEqual([live]);
    const f = await ok('get_artifact', { artifact_id: fragment, include_text: false });
    expect([f.artifact.status, f.artifact.flag]).toEqual(['hidden', 'fragment']);
  });

  it('applies each filter and marks flag and members_only on every hit', async () => {
    stubEmbeddings(axis(0));
    await seedPiece({
      title: 'Column A',
      series: '經濟日報專欄',
      outlets: ['經濟日報', 'Substack'],
      publishedAt: '2024-03-01T00:00:00Z',
      chunks: [{ text: 'On inflation expectations.', vector: axis(0) }],
    });
    await seedPiece({
      title: 'Column B',
      outlets: ['Patreon'],
      flag: 'review',
      publishedAt: '2025-05-01T00:00:00Z',
      chunks: [{ text: 'Inflation again.', vector: mix(0, 1, 0.9) }],
    });
    await seedPiece({
      title: 'Column C',
      flag: 'unmatched',
      publishedAt: '2023-01-01T00:00:00Z',
      chunks: [{ text: 'An old note on inflation.', vector: mix(0, 1, 0.8) }],
    });
    await seedPiece({
      title: 'Episode M',
      sourceSystem: 'youtube',
      membersOnly: true,
      publishedAt: '2025-08-01T00:00:00Z',
      chunks: [{ text: 'Members talk about inflation.', vector: mix(0, 1, 0.85) }],
    });
    await seedPiece({
      title: 'Episode P',
      sourceSystem: 'youtube',
      publishedAt: '2025-09-01T00:00:00Z',
      chunks: [{ text: 'A public episode on inflation.', vector: mix(0, 1, 0.7) }],
    });
    const find = async (extra: Record<string, unknown>) => sorted(titles(await ok('search_published', { query: 'inflation', ...extra })));

    const all = await ok('search_published', { query: 'inflation' });
    const byTitle = new Map((all.hits as Array<any>).map((h) => [h.title, h]));
    expect(byTitle.size).toBe(5);
    expect(byTitle.get('Column A')).toMatchObject({
      type: 'essay',
      flag: null,
      members_only: false,
      series: '經濟日報專欄',
      outlets: ['經濟日報', 'Substack'],
      published_at: '2024-03-01T00:00:00.000Z',
    });
    expect(byTitle.get('Column B')).toMatchObject({ flag: 'review', members_only: false });
    expect(byTitle.get('Column C')).toMatchObject({ flag: 'unmatched', outlets: [] });
    expect(byTitle.get('Episode M')).toMatchObject({ type: 'episode', members_only: true, flag: null });
    expect(byTitle.get('Episode P')).toMatchObject({ type: 'episode', members_only: false });

    expect(await find({ type: 'episode' })).toEqual(['Episode M', 'Episode P']);
    expect(await find({ type: 'essay' })).toEqual(['Column A', 'Column B', 'Column C']);
    expect(await find({ since: '2025-01-01T00:00:00Z' })).toEqual(['Column B', 'Episode M', 'Episode P']);
    expect(await find({ until: '2024-12-31T23:59:59Z' })).toEqual(['Column A', 'Column C']);
    expect(await find({ since: '2025-06-01T00:00:00+08:00', until: '2025-08-31T00:00:00Z' })).toEqual(['Episode M']);
    expect(await find({ outlet: '經濟' })).toEqual(['Column A']);
    expect(await find({ outlet: 'SUBSTACK' })).toEqual(['Column A']);
    expect(await find({ outlet: 'patreon' })).toEqual(['Column B']);
    expect(await find({ outlet: '%' })).toEqual([]);
    expect(await find({ confirmed_only: true })).toEqual(['Column A', 'Episode M', 'Episode P']);
    expect(await find({ members_only: 'exclude' })).toEqual(['Column A', 'Column B', 'Column C', 'Episode P']);
    expect(await find({ members_only: 'only' })).toEqual(['Episode M']);
    expect(await find({ members_only: 'include', type: 'episode', confirmed_only: true })).toEqual(['Episode M', 'Episode P']);
  });

  it('keeps the passages within the character budget, dropping the lowest-ranked extras first', async () => {
    stubEmbeddings('fail');
    // Twelve pieces, newest first, each with three long chunks that match.
    for (let i = 0; i < 12; i++) {
      await seedPiece({
        title: `Long piece ${String(i).padStart(2, '0')}`,
        publishedAt: `2026-01-${String(28 - i).padStart(2, '0')}T00:00:00Z`,
        chunks: [0, 1, 2].map((k) => ({ text: `${'潮汐'.repeat(150)}港口${k}${'海浪'.repeat(150)}`, vector: null })),
      });
    }

    const r = await ok('search_published', { query: '港口', limit: 12, passages: 3 });
    expect(r.count).toBe(12);
    expect(r.truncated).toBe(true);
    expect(r.hits.map((h: any) => h.passages.length)).toEqual([3, 3, 3, 3, 3, 2, 1, 1, 1, 1, 1, 1]);
    const total = (r.hits as Array<any>).reduce(
      (n, h) => n + chars(h.summary ?? '') + h.passages.reduce((k: number, p: any) => k + chars(p.text), 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(12_000);
    for (const h of r.hits) {
      for (const p of h.passages) {
        expect(chars(p.text)).toBeLessThanOrEqual(500);
        expect(p.text).toContain('港口');
      }
    }

    const small = await ok('search_published', { query: '港口', limit: 12, passages: 1 });
    expect(small.truncated).toBe(false);
  });

  it('rejects unknown arguments and returns an empty result when nothing matches', async () => {
    stubEmbeddings('fail');
    const bad = await callTool('search_published', { query: 'tides', top_k: 5 });
    expect(bad.isError).toBe(true);
    expect(bad.texts[0]).toMatch(/Unrecognized key/);
    expect((await callTool('search_published', { query: 'tides', type: 'transcript' })).isError).toBe(true);

    const none = await ok('search_published', { query: 'nothing at all' });
    expect(none).toMatchObject({ count: 0, hits: [], truncated: false });
    expect(none.as_of).toMatch(/^\d{4}-/);
  });
});

describe.skipIf(!TEST_DB)('get_artifact', () => {
  beforeEach(resetIdeaData);

  it('returns the text in parts without splitting a surrogate pair', async () => {
    const text = `${'漢'.repeat(11_999)}🙂${'字'.repeat(5_000)}`;
    const id = await seedPiece({ title: 'Long essay', text, chunks: [{ text: '漢字', vector: null }] });

    const first = await ok('get_artifact', { artifact_id: id });
    expect(first).toMatchObject({ resolved_from: null, text_chars: 17_000, offset: 0, next_offset: 12_000 });
    expect(first.text.endsWith('漢🙂')).toBe(true);
    expect(chars(first.text)).toBe(12_000);
    expect(LONE_SURROGATE.test(first.text)).toBe(false);
    expect(first.as_of).toMatch(/^\d{4}-/);

    const second = await ok('get_artifact', { artifact_id: id, offset: first.next_offset });
    expect(second).toMatchObject({ offset: 12_000, next_offset: null });
    expect(first.text + second.text).toBe(text);

    const emoji = await ok('get_artifact', { artifact_id: id, offset: 11_999, limit: 1 });
    expect(emoji).toMatchObject({ text: '🙂', next_offset: 12_000 });

    // Past the end is an empty part; past any text, an argument error, not
    // a database one.
    expect(await ok('get_artifact', { artifact_id: id, offset: 2_000_000_000 })).toMatchObject({ text: '', next_offset: null });
    const huge = await callTool('get_artifact', { artifact_id: id, offset: 3_000_000_000 });
    expect(huge.isError).toBe(true);
    expect(huge.texts[0]).toMatch(/^Invalid arguments/);

    const meta = await ok('get_artifact', { artifact_id: id, include_text: false });
    expect(meta.text).toBeUndefined();
    expect(meta.next_offset).toBeUndefined();
    expect(meta.text_chars).toBe(17_000);
    expect(meta.artifact).toMatchObject({ id, title: 'Long essay', type: 'essay', status: 'published', flag: null });
  });

  it('follows replacements to the current piece and says so', async () => {
    const current = await seedPiece({ title: 'Current text', chunks: [{ text: 'final', vector: null }] });
    const middle = await seedPiece({ title: 'Second import', status: 'superseded', chunks: [{ text: 'mid', vector: null }] });
    const first = await seedPiece({ title: 'First import', status: 'superseded', chunks: [{ text: 'old', vector: null }] });
    await admin`UPDATE public_artifact SET superseded_by = ${current} WHERE id = ${middle}`;
    await admin`UPDATE public_artifact SET superseded_by = ${middle} WHERE id = ${first}`;

    const r = await ok('get_artifact', { artifact_id: first.toUpperCase() });
    expect(r.artifact).toMatchObject({ id: current, title: 'Current text', status: 'published' });
    expect(r.resolved_from).toEqual([first, middle]);
    expect(r.note).toMatch(/was replaced/);
    expect(r.text).toBe('final');

    // A row whose replacement still waits to be processed is the live one.
    const waiting = await seedPiece({ title: 'Queued replacement', processingStatus: 'pending', chunks: [] });
    const live = await seedPiece({ title: 'Still live', chunks: [{ text: 'live', vector: null }] });
    await admin`UPDATE public_artifact SET superseded_by = ${waiting} WHERE id = ${live}`;
    const l = await ok('get_artifact', { artifact_id: live });
    expect(l.artifact.id).toBe(live);
    expect(l.resolved_from).toBeNull();
    expect(l.note).toBeUndefined();
  });

  it('marks a members-only piece and refuses unknown ids and arguments', async () => {
    const m = await seedPiece({
      title: 'Members episode',
      sourceSystem: 'youtube',
      membersOnly: true,
      flag: 'review',
      chunks: [{ text: 'members only words', vector: null }],
    });
    const r = await ok('get_artifact', { artifact_id: m });
    expect(r.artifact).toMatchObject({ type: 'episode', members_only: true, flag: 'review' });
    expect(r.members_only_notice).toMatch(/never quote, link or use it in anything public/);
    const pub = await seedPiece({ title: 'Public essay', chunks: [{ text: 'open words', vector: null }] });
    const p = await ok('get_artifact', { artifact_id: pub });
    expect(p.artifact.members_only).toBe(false);
    expect(p.members_only_notice).toBeUndefined();

    const missing = await callTool('get_artifact', { artifact_id: '00000000-0000-4000-8000-000000000000' });
    expect(missing.isError).toBe(true);
    expect(missing.texts[0]).toMatch(/not found/);
    const bad = await callTool('get_artifact', { artifact_id: pub, part: 2 });
    expect(bad.isError).toBe(true);
    expect(bad.texts[0]).toMatch(/Unrecognized key/);
  });
});

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { admin, axis, mix, ok, seedArtifact, TEST_DB } from './helpers';

// Synthetic data only (the repository is public).

afterAll(() => admin.end({ timeout: 5 }));

function stubEmbeddings(vector: number[]) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).includes('api.openai.com')) throw new Error(`unexpected fetch ${url}`);
    return Response.json({ data: [{ embedding: vector }] });
  });
}

describe.skipIf(!TEST_DB)('archive_search_text', () => {
  beforeEach(async () => {
    await admin`DELETE FROM public_artifact WHERE source_system = 'youtube'`;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns each hit with its flag, and leaves out superseded rows', async () => {
    const confirmed = await seedArtifact('Confirmed piece', axis(0));
    const toCheck = await seedArtifact('Piece to check', mix(0, 1, 0.9));
    const unmatched = await seedArtifact('Old unmatched row', mix(0, 1, 0.8));
    const retired = await seedArtifact('Retired copy', mix(0, 1, 0.95));
    await admin`UPDATE public_artifact SET flag = 'review' WHERE id = ${toCheck}`;
    await admin`UPDATE public_artifact SET flag = 'unmatched' WHERE id = ${unmatched}`;
    await admin`UPDATE public_artifact SET status = 'superseded', superseded_by = ${confirmed} WHERE id = ${retired}`;
    stubEmbeddings(axis(0));

    const r = await ok('archive_search_text', { query: 'piece', top_k: 10 });
    expect(r.hits.map((h: any) => [h.title, h.flag])).toEqual([
      ['Confirmed piece', null],
      ['Piece to check', 'review'],
      ['Old unmatched row', 'unmatched'],
    ]);
  });
});

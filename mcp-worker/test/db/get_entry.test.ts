import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, ok, resetJournalData, seedArtifact, seedJournalEntry, TEST_DB } from './helpers';

// Synthetic data only (the repository is public).

afterAll(() => admin.end({ timeout: 5 }));

describe.skipIf(!TEST_DB)('get_entry', () => {
  beforeEach(async () => {
    await resetJournalData();
    await admin`DELETE FROM link_edge WHERE source_type = 'journal_entry'`;
    await admin`DELETE FROM public_artifact WHERE source_system = 'youtube'`;
  });

  it('leaves out links to artifacts that have left search', async () => {
    const entry = await seedJournalEntry({ vector: null });
    const live = await seedArtifact('Live piece', null);
    const retired = await seedArtifact('Retired piece', null);
    await admin`UPDATE public_artifact SET status = 'superseded' WHERE id = ${retired}`;
    await admin`
      INSERT INTO link_edge (user_id, source_type, source_id, target_type, target_id, link_type, confidence)
      VALUES ('default', 'journal_entry', ${entry}, 'public_artifact', ${live}, 'echoes_artifact', 0.9),
             ('default', 'journal_entry', ${entry}, 'public_artifact', ${retired}, 'echoes_artifact', 0.8)
    `;
    const r = await ok('get_entry', { entry_id: entry });
    expect(r.links.map((l: any) => l.target_title)).toEqual(['Live piece']);
  });
});

// Link proposals at capture (refocus D3, D12): park_idea returns the
// nearest existing ideas as link_candidates; the assistant saves up to 3
// proposals with propose_idea_links(origin 'capture'); the user decides.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  admin,
  axis,
  callTool,
  mix,
  ok,
  resetAuthData,
  resetIdeaData,
  seedArtifact,
  seedIdea,
  seedPat,
  setEmbedding,
  stubEmbeddings,
  TEST_DB,
  vecLiteral,
} from './helpers';
import { blockedFetches, noNetworkFetch } from '../setup/no-network';
import { buildIdeaEmbeddingText } from '../../src/ideas/embeddingText';
import { LINK_TYPES, LINK_TYPE_INFO } from '../../src/ideas/linkTypes';
import { CANDIDATE_EMBED_TIMEOUT_MS } from '../../src/tools/park_idea';
import { tools } from '../../src/tools/registry';

afterAll(() => admin.end({ timeout: 5 }));

describe('test-wide network guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts every test file with a fetch that fails fast', async () => {
    expect(globalThis.fetch).toBe(noNetworkFetch);
    const before = blockedFetches.length;
    await expect(fetch('https://api.openai.com/v1/embeddings', { method: 'POST' })).rejects.toThrow(
      /Network access is disabled in tests/,
    );
    expect(blockedFetches.slice(before)).toEqual(['https://api.openai.com/v1/embeddings']);
  });

  it('restores the fail-fast fetch, not the real one, after a test stub', () => {
    stubEmbeddings(axis(0));
    expect(globalThis.fetch).not.toBe(noNetworkFetch);
    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(noNetworkFetch);
  });
});

describe('display labels in the capture wording', () => {
  it('names every type with its label in the propose_idea_links description', () => {
    const description = tools.find((t) => t.name === 'propose_idea_links')!.description;
    for (const t of LINK_TYPES) expect(description).toContain(`${t} (${LINK_TYPE_INFO[t].label}`);
  });
});

describe.skipIf(!TEST_DB)('park_idea link candidates', () => {
  beforeEach(resetIdeaData);
  afterEach(() => vi.unstubAllGlobals());

  it('returns the nearest live ideas, nearest first, above the floor', async () => {
    // Seeded before anything is embedded, so these captures embed nothing.
    const near = await seedIdea('Tidal locking', { why_interesting: 'the moon always shows one face' });
    const mid = await seedIdea('Orbital resonance');
    const far = await seedIdea('Ocean currents');
    const noise = await seedIdea('Sourdough starters');
    const composted = await seedIdea('Composted twin');
    const unembedded = await seedIdea('Still waiting for the sweeper');
    await ok('update_idea', { id: composted, status: 'composted' });
    await setEmbedding(near, mix(0, 1, 0.9));
    await setEmbedding(mid, mix(0, 2, 0.6));
    // The floor is the protocol's 0.3 noise line: just above it is kept,
    // just below it is dropped.
    await setEmbedding(far, mix(0, 3, 0.31));
    await setEmbedding(noise, mix(0, 4, 0.29));
    await setEmbedding(composted, axis(0)); // the closest of all, but composted

    // The sweeper embeds the new row while the candidates are computed:
    // the idea must still never be its own candidate.
    const spy = stubEmbeddings(axis(0), () =>
      admin`UPDATE idea SET embedding = ${vecLiteral(axis(0))}::vector WHERE title = 'Why the moon drifts away'`,
    );
    const r = await ok('park_idea', {
      title: 'Why the moon drifts away',
      thoughts: '潮汐摩擦 slows the earth',
      why_interesting: 'angular momentum moves outward',
      tags: ['astronomy'],
    });

    expect(r.deduplicated).toBe(false);
    expect(r.warnings).toBeUndefined();
    expect(r.link_candidates.map((c: any) => c.title)).toEqual(['Tidal locking', 'Orbital resonance', 'Ocean currents']);
    const [first] = r.link_candidates;
    expect(Object.keys(first)).toEqual(['id', 'title', 'kind', 'status', 'similarity', 'snippet']);
    expect(first).toMatchObject({ id: near, kind: 'unit', status: 'parked', snippet: 'the moon always shows one face' });
    expect(first.similarity).toBeCloseTo(0.9, 4);
    expect(r.link_candidates[2].similarity).toBeCloseTo(0.31, 4);
    const ids = r.link_candidates.map((c: any) => c.id);
    expect(ids).not.toContain(r.idea_id);
    expect(ids).not.toContain(composted);
    expect(ids).not.toContain(noise);
    expect(ids).not.toContain(unembedded);
    expect(r.note).toMatch(/propose_idea_links \(origin 'capture'\)/);
    expect(r.note).toMatch(/tension_with \(contradicts\)/);
    expect(r.note).toMatch(/part_of \(part-of; only to a candidate of kind 'synthesis'\)/);
    expect(r.note).not.toMatch(/became|revisits/);

    // One embedding call, with the text the sweeper would embed for this row.
    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(body.input).toBe(
      buildIdeaEmbeddingText({
        title: 'Why the moon drifts away',
        framing: null,
        why_interesting: 'angular momentum moves outward',
        thoughts: '潮汐摩擦 slows the earth',
        notes: null,
        source_title: null,
        source_excerpt: null,
        tags: ['astronomy'],
      }),
    );
    // The vector is not stored by the Worker (only the stub above wrote one).
    const [stored] = await admin`SELECT embedding_model FROM idea WHERE id = ${r.idea_id}`;
    expect(stored.embedding_model).toBeNull();
  });

  it('returns at most 5 candidates, syntheses included', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await seedIdea(`Neighbour ${i}`));
    const s = await ok('create_synthesis', { title: 'A synthesis', intent: 'essay', part_ids: [ids[4], ids[5]] });
    for (let i = 0; i < 6; i++) await setEmbedding(ids[i], mix(0, i + 1, 0.5 + i * 0.01));
    await setEmbedding(s.synthesis_id, mix(0, 9, 0.99));

    stubEmbeddings(axis(0));
    const r = await ok('park_idea', { title: 'Crowded neighbourhood' });
    expect(r.link_candidates).toHaveLength(5);
    expect(r.link_candidates[0]).toMatchObject({ id: s.synthesis_id, kind: 'synthesis', status: 'exploring' });
    expect(r.link_candidates.slice(1).map((c: any) => c.title)).toEqual([
      'Neighbour 5',
      'Neighbour 4',
      'Neighbour 3',
      'Neighbour 2',
    ]);
    // The query vector is not stored: the new row waits for the sweeper.
    const [row] = await admin`
      SELECT embedding IS NULL AS unset, embedding_model, embedded_at FROM idea WHERE id = ${r.idea_id}
    `;
    expect(row).toEqual({ unset: true, embedding_model: null, embedded_at: null });
  });

  it('makes no embedding call when nothing else is embedded', async () => {
    await seedIdea('Unembedded one');
    const composted = await seedIdea('Embedded but composted');
    await ok('update_idea', { id: composted, status: 'composted' });
    await setEmbedding(composted, axis(0));

    const spy = stubEmbeddings(axis(0));
    const r = await ok('park_idea', { title: 'First in its garden' });
    expect(spy).not.toHaveBeenCalled();
    expect(r.link_candidates).toEqual([]);
    expect(r.warnings).toBeUndefined();
    expect(r.note).toMatch(/receipt only/);
  });

  it('still files the idea when the embedding call fails', async () => {
    const other = await seedIdea('Embedded neighbour');
    await setEmbedding(other, axis(0));

    stubEmbeddings('fail');
    const r = await ok('park_idea', { title: 'Filed despite an OpenAI outage', thoughts: 'keep me' });
    expect(r.deduplicated).toBe(false);
    expect(r.link_candidates).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Link candidates unavailable \(OpenAI embeddings 500/);
    expect(r.note).toMatch(/receipt only/);
    const rows = await admin`SELECT thoughts FROM idea WHERE id = ${r.idea_id}`;
    expect(rows).toEqual([{ thoughts: 'keep me' }]);
  });

  it('gives up on a stalled embedding call after the timeout and still files the idea', async () => {
    const other = await seedIdea('Embedded neighbour');
    await setEmbedding(other, axis(0));

    // OpenAI never answers. The timer park_idea arms right after the call
    // starts is the next setTimeout: hold it, so the test fires it instead
    // of waiting. (A fake clock would also stall postgres-js, which opens
    // each connection with setTimeout.)
    let timer: { fire: () => void; ms: number | undefined } | undefined;
    let fetched!: () => void;
    const started = new Promise<void>((resolve) => (fetched = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(((fn: () => void, ms?: number) => {
          timer = { fire: fn, ms };
          return 0;
        }) as unknown as typeof setTimeout);
        fetched();
        return new Promise<Response>(() => {});
      }),
    );

    let settled = false;
    const call = callTool('park_idea', { title: 'Filed despite a stalled OpenAI call' }).finally(() => {
      settled = true;
    });
    await started;
    vi.mocked(globalThis.setTimeout).mockRestore();
    expect(timer?.ms).toBe(CANDIDATE_EMBED_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false); // still waiting on OpenAI

    timer!.fire();
    const r = await call;
    expect(r.isError).toBe(false);
    expect(r.json.deduplicated).toBe(false);
    expect(r.json.link_candidates).toEqual([]);
    expect(r.json.warnings).toEqual([
      `Link candidates unavailable (embedding timed out after ${CANDIDATE_EMBED_TIMEOUT_MS} ms); the idea is filed.`,
    ]);
    expect(r.json.note).toMatch(/receipt only/);
    expect(await admin`SELECT title FROM idea WHERE id = ${r.json.idea_id}`).toEqual([
      { title: 'Filed despite a stalled OpenAI call' },
    ]);
  });

  it('still files the idea when the candidate query fails', async () => {
    const other = await seedIdea('Embedded neighbour');
    await setEmbedding(other, axis(0));

    // A value pgvector refuses (out of range for its float4 elements): the
    // kNN query errors after a successful embedding call.
    const bad = axis(0);
    bad[1] = 1e39;
    const spy = stubEmbeddings(bad);
    const r = await ok('park_idea', { title: 'Filed despite a failing kNN query' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.deduplicated).toBe(false);
    expect(r.link_candidates).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^Link candidates unavailable \(.*vector.*\); the idea is filed\.$/);
    expect(await admin`SELECT 1 FROM idea WHERE id = ${r.idea_id}`).toHaveLength(1);
  });

  it('takes the fail-fast default when a test stubs nothing', async () => {
    const other = await seedIdea('Embedded neighbour');
    await setEmbedding(other, axis(0));

    const before = blockedFetches.length;
    const r = await ok('park_idea', { title: 'No network here' });
    expect(r.link_candidates).toEqual([]);
    expect(r.warnings[0]).toMatch(/Network access is disabled in tests/);
    expect(blockedFetches.slice(before)).toEqual(['https://api.openai.com/v1/embeddings']);
  });

  it('returns no candidates on a deduplicated retry, and says so', async () => {
    const other = await seedIdea('Embedded neighbour');
    await setEmbedding(other, axis(0));

    const spy = stubEmbeddings(axis(0));
    const first = await ok('park_idea', { title: 'Retried capture', idempotency_key: 'retry-1' });
    expect(first.link_candidates.map((c: any) => c.id)).toEqual([other]);
    const again = await ok('park_idea', { title: 'Retried capture', idempotency_key: 'retry-1' });
    expect(again).toMatchObject({ idea_id: first.idea_id, deduplicated: true, link_candidates: [] });
    expect(again.note).toMatch(/A retry returns no link_candidates/);
    const sameContent = await ok('park_idea', { title: 'retried capture' });
    expect(sameContent).toMatchObject({ idea_id: first.idea_id, deduplicated: true, link_candidates: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!TEST_DB)("propose_idea_links origin 'capture'", () => {
  let fresh: string;
  let a: string;
  let b: string;
  let c: string;
  let d: string;
  beforeEach(async () => {
    await resetAuthData();
    await resetIdeaData();
    a = await seedIdea('Older idea A');
    b = await seedIdea('Older idea B');
    c = await seedIdea('Older idea C');
    d = await seedIdea('Older idea D');
    fresh = await seedIdea('The newly parked idea');
  });

  const link = (source: string, target: string, type = 'builds_on') => ({
    source_idea_id: source,
    target_idea_id: target,
    link_type: type,
    rationale: 'a one-line gloss naming the connection',
  });

  it('refuses more than 3 links, nothing written', async () => {
    const r = await callTool('propose_idea_links', {
      origin: 'capture',
      links: [link(fresh, a), link(fresh, b), link(c, fresh), link(fresh, d)],
    });
    expect(r.isError).toBe(true);
    expect(r.texts[0]).toMatch(/at most 3 links/);
    expect(await admin`SELECT 1 FROM idea_link`).toHaveLength(0);
  });

  it('refuses links that do not all share the new idea', async () => {
    const r = await callTool('propose_idea_links', {
      origin: 'capture',
      links: [link(fresh, a), link(b, c)],
    });
    expect(r.isError).toBe(true);
    expect(r.texts[0]).toMatch(/newly parked idea as an endpoint/);
    expect(await admin`SELECT 1 FROM idea_link`).toHaveLength(0);
  });

  it('refuses became and revisits links', async () => {
    const x = await seedArtifact('Episode X', null);
    for (const type of ['became', 'revisits']) {
      const r = await callTool('propose_idea_links', {
        origin: 'capture',
        links: [
          link(fresh, a),
          { source_idea_id: fresh, target_artifact_id: x, link_type: type, rationale: 'the idea became this episode' },
        ],
      });
      expect(r.isError).toBe(true);
      expect(r.texts[0]).toMatch(/idea-to-idea links only/);
    }
    expect(await admin`SELECT 1 FROM idea_link`).toHaveLength(0);
  });

  it('refuses a composted endpoint for every origin, until the idea is revived', async () => {
    await ok('update_idea', { id: a, status: 'composted' });
    for (const origin of ['capture', 'gardening']) {
      const r = await ok('propose_idea_links', { origin, links: [link(fresh, a), link(fresh, b)] });
      expect(r.results.map((x: any) => x.result)).toEqual(['error', 'proposed']);
      expect(r.results[0].error).toMatch(/is composted/);
      await admin`DELETE FROM idea_link`;
    }
    await ok('update_idea', { id: a, status: 'parked' });
    const again = await ok('propose_idea_links', { origin: 'capture', links: [link(fresh, a)] });
    expect(again.results[0].result).toBe('proposed');
  });

  it('waits for a compost in flight, then refuses: no proposal lands on a composted idea', async () => {
    // A compost holds the idea row (update_idea locks it FOR UPDATE) while
    // the proposal runs. The proposal must wait and see the new status, not
    // pass its check on the old one and insert after the compost commits.
    let lockedIt!: () => void;
    let finish!: () => void;
    const locked = new Promise<void>((r) => (lockedIt = r));
    const go = new Promise<void>((r) => (finish = r));
    const compost = admin.begin(async (tx) => {
      await tx`SELECT 1 AS found FROM idea WHERE id = ${a} FOR UPDATE`;
      lockedIt();
      await go;
      await tx`UPDATE idea SET status = 'composted' WHERE id = ${a}`;
    });
    await locked;
    const proposing = callTool('propose_idea_links', { origin: 'capture', links: [link(fresh, a)] });
    // Commit only once the proposal is blocked on the idea row.
    const deadline = Date.now() + 5000;
    for (;;) {
      const [w] = await admin<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
      `;
      if (w.n > 0) break;
      if (Date.now() > deadline) throw new Error('the proposal never waited on the idea row');
      await new Promise((r) => setTimeout(r, 20));
    }
    finish();
    await compost;
    const r = await proposing;
    expect(r.isError).toBe(false);
    expect(r.json.results[0].result).toBe('error');
    expect(r.json.results[0].error).toMatch(/is composted/);
    expect(await admin`SELECT 1 FROM idea_link`).toHaveLength(0);
  });

  it('proposes part_of only to a synthesis candidate', async () => {
    const s = await ok('create_synthesis', { title: 'A synthesis', intent: 'essay', part_ids: [a, b] });
    const r = await ok('propose_idea_links', {
      origin: 'capture',
      links: [link(fresh, s.synthesis_id, 'part_of'), link(fresh, c, 'part_of')],
    });
    expect(r.results.map((x: any) => x.result)).toEqual(['proposed', 'error']);
    expect(r.results[1].error).toMatch(/part_of must target a synthesis/);
  });

  it('stores capture proposals canonically, filters and decides them, stamping the credential', async () => {
    const pat = await seedPat('Meta Muse');
    const [lo, hi] = [fresh, a].sort();
    const r = await callTool(
      'propose_idea_links',
      {
        origin: 'capture',
        proposed_via: { client: 'muse' },
        links: [
          link(hi, lo, 'inverts'), // symmetric: stored smaller id first
          link(fresh, b, 'mechanism_for'),
          link(c, fresh, 'tension_with'),
        ],
      },
      { token: pat.token },
    );
    expect(r.isError).toBe(false);
    expect(r.json.counts.proposed).toBe(3);
    expect(r.json.note).toMatch(/after the capture receipt/);
    const [inv, mech, ten] = r.json.results.map((x: any) => x.link_id);

    const rows = await admin`
      SELECT id, source_idea_id, target_idea_id, link_type, proposed_by, proposed_via, status
        FROM idea_link ORDER BY link_type
    `;
    expect(rows.every((l) => l.proposed_by === 'capture' && l.status === 'proposed')).toBe(true);
    expect(rows.every((l) => l.proposed_via.credential === 'Meta Muse' && l.proposed_via.client === 'muse')).toBe(true);
    const stored = rows.find((l) => l.id === inv)!;
    expect([stored.source_idea_id, stored.target_idea_id]).toEqual([lo, hi]);
    expect(rows.find((l) => l.id === mech)).toMatchObject({ source_idea_id: fresh, target_idea_id: b });

    // The garden review finds them by origin.
    const capture = await ok('list_idea_links', { proposed_by: 'capture' });
    expect(capture.total).toBe(3);
    expect(capture.links.find((l: any) => l.link_id === inv)).toMatchObject({
      link_type: 'inverts',
      label: 'inverts',
      directed: false,
      proposed_by: 'capture',
    });
    expect((await ok('list_idea_links', { proposed_by: 'gardening' })).total).toBe(0);
    expect((await ok('list_idea_links', { idea_id: fresh })).total).toBe(3);

    // Re-proposing the same pair and type is a duplicate, as for any origin.
    const dup = await ok('propose_idea_links', { origin: 'capture', links: [link(lo, hi, 'inverts')] });
    expect(dup.results[0]).toMatchObject({ result: 'skipped_duplicate', link_id: inv, existing_status: 'proposed' });

    const decided = await callTool(
      'decide_idea_links',
      {
        decisions: [
          { link_id: inv, decision: 'accept' },
          { link_id: mech, decision: 'reject' },
        ],
      },
      { token: pat.token },
    );
    expect(decided.isError).toBe(false);
    expect(decided.json.counts).toEqual({ accepted: 1, rejected: 1 });
    const [acc] = await admin`SELECT status, proposed_by, decided_via FROM idea_link WHERE id = ${inv}`;
    expect(acc).toMatchObject({ status: 'accepted', proposed_by: 'capture', decided_via: { credential: 'Meta Muse' } });

    // A rejected pair is remembered for capture proposals too.
    const again = await ok('propose_idea_links', { origin: 'capture', links: [link(fresh, b, 'builds_on')] });
    expect(again.results[0]).toMatchObject({ result: 'skipped_rejected', existing_status: 'rejected' });
    // The untouched proposal is still waiting for the garden review.
    expect((await ok('list_idea_links', { proposed_by: 'capture' })).links.map((l: any) => l.link_id)).toEqual([ten]);
  });

  it('reopens a withdrawn proposal as a capture proposal', async () => {
    const g = await ok('propose_idea_links', { origin: 'gardening', links: [link(fresh, a, 'example_of')] });
    const id = g.results[0].link_id;
    await ok('decide_idea_links', { decisions: [{ link_id: id, decision: 'withdraw' }] });
    const r = await ok('propose_idea_links', { origin: 'capture', links: [link(fresh, a, 'example_of')] });
    expect(r.results[0]).toMatchObject({ result: 'reopened', link_id: id, existing_status: 'withdrawn' });
    const [row] = await admin`SELECT status, proposed_by FROM idea_link WHERE id = ${id}`;
    expect(row).toEqual({ status: 'proposed', proposed_by: 'capture' });
  });
});

describe.skipIf(!TEST_DB)('link display labels', () => {
  beforeEach(resetIdeaData);

  it('shows tension_with as contradicts in get_idea and list_idea_links', async () => {
    const a = await seedIdea('Markets clear');
    const b = await seedIdea('Markets do not clear');
    const c = await seedIdea('Sticky prices');
    const p = await ok('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: a, target_idea_id: b, link_type: 'tension_with', rationale: 'one denies what the other assumes' },
        { source_idea_id: c, target_idea_id: b, link_type: 'mechanism_for', rationale: 'sticky prices explain why markets fail to clear' },
      ],
    });
    await ok('decide_idea_links', { decisions: [{ link_id: p.results[0].link_id, decision: 'accept' }] });

    const g = await ok('get_idea', { id: b, include_pending: true });
    expect(g.links).toHaveLength(1);
    expect(g.links[0]).toMatchObject({ link_type: 'tension_with', label: 'contradicts', direction: 'both' });
    expect(g.pending[0]).toMatchObject({ link_type: 'mechanism_for', label: 'mechanism-for', direction: 'in' });

    const accepted = await ok('list_idea_links', { statuses: ['accepted'] });
    expect(accepted.links[0]).toMatchObject({ link_type: 'tension_with', label: 'contradicts' });
    const pending = await ok('list_idea_links', {});
    expect(pending.links[0]).toMatchObject({ link_type: 'mechanism_for', label: 'mechanism-for', directed: true });
  });
});

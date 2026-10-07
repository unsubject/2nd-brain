// Idea Garden v2 (refocus Phase 4): the inbox (reviewed_at), review
// marking, the garden-review queue, promotion records (D1, D15) and
// composting withdrawing pending proposals. Synthetic data only.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, axis, callTool, mix, ok, resetAuthData, resetIdeaData, seedIdea, setEmbedding, TEST_DB, USER } from './helpers';
import { hashToken, newToken } from '../../src/auth/tokens';

afterAll(() => admin.end({ timeout: 5 }));

async function seedPat(label: string): Promise<string> {
  const token = newToken('pat');
  const [cred] = await admin<Array<{ id: string }>>`
    INSERT INTO mcp_credential (user_id, label, kind, scope, token_hint)
    VALUES (${USER}, ${label}, 'pat', 'all', ${token.slice(-4)}) RETURNING id
  `;
  await admin`INSERT INTO mcp_token (token_hash, credential_id, kind) VALUES (${await hashToken(token)}, ${cred.id}, 'pat')`;
  return token;
}

const as = (token: string) => async (name: string, args: unknown) => {
  const r = await callTool(name, args, { token });
  if (r.isError) throw new Error(`${name}: ${r.texts.join(' ')}`);
  return r.json;
};

// A pending proposal written straight into the table (as a capture-time
// proposal would be), directed so no canonical ordering applies.
async function seedProposal(source: string, target: string, by = 'capture', type = 'builds_on'): Promise<string> {
  const [row] = await admin<Array<{ id: string }>>`
    INSERT INTO idea_link (user_id, source_idea_id, target_idea_id, link_type, rationale, proposed_by, proposed_via)
    VALUES (${USER}, ${source}, ${target}, ${type}, 'A synthetic one-line gloss', ${by}, ${admin.json({ credential: 'master' })})
    RETURNING id
  `;
  return row.id;
}

const ideaOf = async (id: string) => (await ok('get_idea', { id })).idea;

describe.skipIf(!TEST_DB)('inbox and review marking', () => {
  beforeEach(async () => {
    await resetAuthData();
    await resetIdeaData();
  });

  it('a new idea waits in the inbox; a composted one never does', async () => {
    const id = await seedIdea('Fresh idea');
    const idea = await ideaOf(id);
    expect(idea).toMatchObject({ inbox: true, reviewed_at: null, promoted: null });

    await ok('update_idea', { id, status: 'composted' });
    const composted = await ideaOf(id);
    expect(composted.inbox).toBe(false);
    expect(composted.reviewed_at).toBeNull();
    // Back in the garden, it was never reviewed, so it waits again.
    await ok('update_idea', { id, status: 'parked' });
    expect((await ideaOf(id)).inbox).toBe(true);
  });

  it('list_ideas filters on inbox and promoted and reports both per row', async () => {
    const a = await seedIdea('Inbox idea');
    const b = await seedIdea('Reviewed idea');
    const c = await seedIdea('Promoted idea');
    const d = await seedIdea('Composted idea');
    await ok('update_idea', { id: b, reviewed: true });
    await ok('update_idea', { id: c, promoted: { title: 'Episode: promoted idea', at: '2026-09-01T10:00:00+08:00' } });
    await ok('update_idea', { id: d, status: 'composted' });

    const all = await ok('list_ideas', {});
    const byTitle = new Map(all.ideas.map((i: any) => [i.title, i]));
    expect(byTitle.get('Inbox idea')).toMatchObject({ inbox: true, promoted: null });
    expect(byTitle.get('Reviewed idea')).toMatchObject({ inbox: false, promoted: null });
    expect(byTitle.get('Promoted idea')).toMatchObject({
      inbox: false,
      promoted: { at: '2026-09-01T02:00:00.000Z', title: 'Episode: promoted idea' },
    });

    const titles = async (args: Record<string, unknown>) =>
      (await ok('list_ideas', args)).ideas.map((i: any) => i.title).sort();
    expect(await titles({ inbox: true })).toEqual(['Inbox idea']);
    expect(await titles({ inbox: false })).toEqual(['Promoted idea', 'Reviewed idea']);
    expect(await titles({ inbox: false, statuses: ['composted'] })).toEqual(['Composted idea']);
    expect(await titles({ inbox: true, statuses: ['composted'] })).toEqual([]);
    expect(await titles({ promoted: true })).toEqual(['Promoted idea']);
    expect(await titles({ promoted: false })).toEqual(['Inbox idea', 'Reviewed idea']);
    expect((await ok('list_ideas', { inbox: true })).ideas.map((i: any) => i.id)).toEqual([a]);
  });

  it('update_idea reviewed: true takes an idea out of the inbox, false puts it back, both logged', async () => {
    const token = await seedPat('Reviewer');
    const r = as(token);
    const id = await seedIdea('Review me');
    await setEmbedding(id, axis(0));

    const on = await r('update_idea', { id, reviewed: true });
    expect(on).toMatchObject({ changed: ['reviewed'], embedding: 'unchanged' });
    let idea = await ideaOf(id);
    expect(idea.inbox).toBe(false);
    expect(idea.reviewed_at).not.toBeNull();
    expect(idea.notes).toEqual([]);

    await r('update_idea', { id, reviewed: false });
    idea = await ideaOf(id);
    expect(idea.inbox).toBe(true);
    expect(idea.reviewed_at).toBeNull();
    expect(idea.edit_log.map((e: any) => [e.credential, e.tool, e.fields])).toEqual([
      ['Reviewer', 'update_idea', ['reviewed']],
      ['Reviewer', 'update_idea', ['reviewed']],
    ]);
    expect(idea.embedding_status).toBe('embedded');
  });

  it('decide_idea_links mark_reviewed stamps ideas in one step without touching updated_at', async () => {
    const token = await seedPat('Gardener');
    const g = as(token);
    const a = await seedIdea('Reviewed by batch A');
    const b = await seedIdea('Reviewed by batch B');
    const c = await seedIdea('Left in the inbox');
    const [foreign] = await admin<Array<{ id: string }>>`
      INSERT INTO idea (user_id, title) VALUES ('someone-else', 'Not yours') RETURNING id
    `;
    const unknown = '00000000-0000-4000-8000-000000000000';
    await admin`UPDATE idea SET updated_at = '2026-01-01T00:00:00Z' WHERE user_id = ${USER}`;

    const r = await g('decide_idea_links', { mark_reviewed: [a, b.toUpperCase(), foreign.id, unknown] });
    expect(r).toEqual({
      counts: {},
      results: [],
      reviewed: { idea_ids: [a, b], not_found: [foreign.id, unknown] },
    });

    const rows = await admin`
      SELECT id, reviewed_at, updated_at, edit_log FROM idea WHERE id IN (${a}, ${b}, ${c}, ${foreign.id}) ORDER BY title
    `;
    const byId = new Map(rows.map((x) => [x.id, x]));
    for (const id of [a, b]) {
      const row = byId.get(id)!;
      expect(row.reviewed_at).not.toBeNull();
      expect(row.updated_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(row.edit_log).toHaveLength(1);
      expect(row.edit_log[0]).toMatchObject({ credential: 'Gardener', tool: 'decide_idea_links', fields: ['reviewed'] });
    }
    expect(byId.get(c)!.reviewed_at).toBeNull();
    expect(byId.get(foreign.id)!.reviewed_at).toBeNull();
    expect((await ok('list_ideas', { inbox: true })).ideas.map((i: any) => i.id)).toEqual([c]);

    // The call log names the ideas the review took out of the inbox.
    const [log] = await admin`SELECT ok, result_ids FROM mcp_call_log WHERE tool = 'decide_idea_links'`;
    expect(log.ok).toBe(true);
    expect([...log.result_ids].sort()).toEqual([a, b].sort());
  });

  it('a failed mark_reviewed is an error when no decision ran, a partial result when one did', async () => {
    const token = await seedPat('Gardener');
    const x = await seedIdea('[fail-review] Cannot be reviewed');
    const y = await seedIdea('Has a proposal');
    const link = await seedProposal(y, x, 'gardening');
    await admin.unsafe(`
      CREATE FUNCTION test_fail_review() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title LIKE '[fail-review]%' AND NEW.reviewed_at IS NOT NULL THEN
          RAISE EXCEPTION 'synthetic review failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_review BEFORE UPDATE ON idea FOR EACH ROW EXECUTE FUNCTION test_fail_review();
    `);
    try {
      const only = await callTool('decide_idea_links', { mark_reviewed: [x] }, { token });
      expect(only.isError).toBe(true);
      expect(only.texts[0]).toMatch(/^DB error: .*synthetic review failure/);

      const mixed = await callTool(
        'decide_idea_links',
        { decisions: [{ link_id: link, decision: 'accept' }], mark_reviewed: [x] },
        { token },
      );
      expect(mixed.isError).toBe(false);
      expect(mixed.json.counts).toEqual({ accepted: 1 });
      expect(mixed.json.reviewed.error).toMatch(/synthetic review failure/);
    } finally {
      await admin.unsafe('DROP TRIGGER IF EXISTS test_fail_review ON idea; DROP FUNCTION IF EXISTS test_fail_review()');
    }
    expect((await ideaOf(x)).inbox).toBe(true);
    const logs = await admin`SELECT ok, error_code FROM mcp_call_log WHERE tool = 'decide_idea_links' ORDER BY at, id`;
    expect(logs.map((l) => [l.ok, l.error_code])).toEqual([
      [false, 'tool_error'],
      [true, null],
    ]);
  });

  it('decide_idea_links: decisions-only output is unchanged; empty and duplicate inputs are refused', async () => {
    const a = await seedIdea('Decide A');
    const b = await seedIdea('Decide B');
    const c = await seedIdea('Decide C');
    const l1 = await seedProposal(a, b, 'gardening');
    const l2 = await seedProposal(a, c);

    const only = await ok('decide_idea_links', { decisions: [{ link_id: l1, decision: 'accept' }] });
    expect(only).toEqual({ counts: { accepted: 1 }, results: [{ link_id: l1, result: 'accepted', link_type: 'builds_on' }] });
    // Deciding a link is not reviewing its ideas.
    expect((await ideaOf(a)).inbox).toBe(true);

    const both = await ok('decide_idea_links', {
      decisions: [{ link_id: l2, decision: 'reject' }],
      mark_reviewed: [a, c],
    });
    expect(both.counts).toEqual({ rejected: 1 });
    expect(both.reviewed).toEqual({ idea_ids: [a, c], not_found: [] });
    expect((await ok('list_ideas', { inbox: true })).ideas.map((i: any) => i.id)).toEqual([b]);

    for (const args of [{}, { decisions: [] }, { decisions: [], mark_reviewed: [] }, { mark_reviewed: [a, a] }]) {
      const r = await callTool('decide_idea_links', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    const tooMany = await callTool('decide_idea_links', {
      mark_reviewed: Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
    });
    expect(tooMany.isError).toBe(true);
  });

  it('garden_ideas inbox mode: oldest first, neighbours, pending capture proposals, unembedded flagged', async () => {
    const old = await seedIdea('Oldest inbox idea', { captured_at: '2026-01-01T00:00:00Z' });
    const mid = await seedIdea('Middle inbox idea', { captured_at: '2026-02-01T00:00:00Z' });
    const raw = await seedIdea('Unembedded inbox idea', { captured_at: '2026-03-01T00:00:00Z' });
    const done = await seedIdea('Already reviewed', { captured_at: '2025-12-01T00:00:00Z' });
    const gone = await seedIdea('Composted', { captured_at: '2025-11-01T00:00:00Z' });
    await setEmbedding(old, axis(0));
    await setEmbedding(mid, mix(0, 1, 0.8));
    await setEmbedding(done, mix(0, 2, 0.6));
    await setEmbedding(gone, mix(0, 3, 0.9));
    await ok('update_idea', { id: done, reviewed: true });
    await ok('update_idea', { id: gone, status: 'composted' });
    const capture = await seedProposal(raw, old);
    const gardening = await seedProposal(mid, done, 'gardening', 'mechanism_for');

    const r = await ok('garden_ideas', { mode: 'inbox' });
    expect(r.mode).toBe('inbox');
    expect(r.paging).toEqual({ offset: 0, total_inbox: 3, next_offset: null });
    expect(r.reminder).toMatch(/mark_reviewed/);
    expect(r.inbox.map((x: any) => x.idea.title)).toEqual(['Oldest inbox idea', 'Middle inbox idea', 'Unembedded inbox idea']);

    const [o, m, u] = r.inbox;
    expect(o.idea.captured_at).toBe('2026-01-01T00:00:00.000Z');
    expect(o.embedded).toBe(true);
    // Neighbours are live, embedded and not already in a proposal.
    expect(o.neighbours.map((n: any) => n.b.title)).toEqual(['Middle inbox idea', 'Already reviewed']);
    expect(o.pending).toEqual([
      expect.objectContaining({
        link_id: capture,
        link_type: 'builds_on',
        label: 'extends',
        direction: 'in',
        proposed_by: 'capture',
        other: { id: raw, title: 'Unembedded inbox idea', status: 'parked' },
      }),
    ]);
    expect(m.pending).toEqual([
      expect.objectContaining({
        link_id: gardening,
        label: 'mechanism-for',
        direction: 'out',
        proposed_by: 'gardening',
        other: { id: done, title: 'Already reviewed', status: 'parked' },
      }),
    ]);
    expect(m.neighbours.map((n: any) => n.b.title)).toEqual(['Oldest inbox idea']);
    expect(u).toMatchObject({ embedded: false, neighbours: [] });
    expect(u.pending.map((p: any) => [p.link_id, p.direction])).toEqual([[capture, 'out']]);

    const newest = await ok('garden_ideas', { mode: 'inbox', order: 'newest', limit: 1 });
    expect(newest.inbox.map((x: any) => x.idea.title)).toEqual(['Unembedded inbox idea']);
    expect(newest.paging).toEqual({ offset: 0, total_inbox: 3, next_offset: 1 });
    const focused = await ok('garden_ideas', { mode: 'inbox', focus_idea_id: done });
    expect(focused.inbox).toEqual([]);
    // Composted ideas stay out even when the status filter lets them in.
    const all = await ok('garden_ideas', { mode: 'inbox', include_statuses: ['parked', 'exploring', 'used', 'composted'] });
    expect(all.inbox.map((x: any) => x.idea.title)).toEqual(['Oldest inbox idea', 'Middle inbox idea', 'Unembedded inbox idea']);
    expect(all.paging.total_inbox).toBe(3);
    // So do their neighbours: the composted idea sits next to the oldest one.
    expect(all.inbox[0].neighbours.map((n: any) => n.b.title)).toEqual(['Middle inbox idea', 'Already reviewed']);
    const orphans = await ok('garden_ideas', { mode: 'orphans', include_statuses: ['parked', 'composted'], focus_idea_id: old });
    expect(orphans.orphans[0].neighbours.map((n: any) => n.b.title)).toContain('Composted');
    expect((await ok('garden_ideas', { mode: 'inbox', focus_idea_id: gone, include_statuses: ['composted'] })).inbox).toEqual([]);
  });

  it('create_synthesis makes an idea that skips the inbox', async () => {
    const a = await seedIdea('Part one');
    const b = await seedIdea('Part two');
    const s = await ok('create_synthesis', { title: 'Synthesis from a review', intent: 'essay', part_ids: [a, b] });
    const syn = await ideaOf(s.synthesis_id);
    expect(syn.inbox).toBe(false);
    expect(syn.reviewed_at).not.toBeNull();
    expect((await ok('garden_ideas', { mode: 'inbox' })).inbox.map((x: any) => x.idea.id).sort()).toEqual([a, b].sort());
  });
});

describe.skipIf(!TEST_DB)('promotion records', () => {
  beforeEach(async () => {
    await resetAuthData();
    await resetIdeaData();
  });

  it('records a promotion, moves a parked idea to exploring with notes, keeps the embedding and leaves the inbox', async () => {
    const token = await seedPat('Muse');
    const m = as(token);
    const id = await seedIdea('Promote me');
    await setEmbedding(id, axis(0));

    const r = await m('update_idea', { id, promoted: { title: '  Episode: promote me  ' } });
    expect(r.changed).toEqual(['promoted', 'status', 'reviewed']);
    expect(r.embedding).toBe('unchanged');
    const idea = await ideaOf(id);
    expect(idea.status).toBe('exploring');
    expect(idea.inbox).toBe(false);
    expect(idea.reviewed_at).not.toBeNull();
    expect(idea.promoted.title).toBe('Episode: promote me');
    expect(Math.abs(Date.parse(idea.promoted.at) - Date.now())).toBeLessThan(60_000);
    expect(idea.notes.map((n: any) => [n.by, n.text, n.credential])).toEqual([
      ['system', 'promoted to Subjects as "Episode: promote me"', 'Muse'],
      ['system', 'status: parked → exploring', 'Muse'],
    ]);
    expect(idea.edit_log.at(-1)).toMatchObject({ credential: 'Muse', tool: 'update_idea', fields: ['promoted', 'status', 'reviewed'] });
    expect(idea.embedding_status).toBe('embedded');

    // Clearing it removes both fields and says so; the review stays.
    const cleared = await m('update_idea', { id, promoted: null });
    expect(cleared.changed).toEqual(['promoted']);
    const after = await ideaOf(id);
    expect(after.promoted).toBeNull();
    expect(after.status).toBe('exploring');
    expect(after.inbox).toBe(false);
    expect(after.notes.at(-1)).toMatchObject({ by: 'system', text: 'promotion cleared (was "Episode: promote me")' });
    const [row] = await admin`SELECT promoted_at, promoted_title FROM idea WHERE id = ${id}`;
    expect(row).toEqual({ promoted_at: null, promoted_title: null });
    expect(after.embedding_status).toBe('embedded');
  });

  it('composted ideas come back to exploring; used stays used; an explicit status wins', async () => {
    const composted = await seedIdea('Composted, then promoted');
    await ok('update_idea', { id: composted, status: 'composted' });
    await ok('update_idea', { id: composted, promoted: { title: 'Revived', at: '2026-09-30T12:00:00Z' } });
    const c = await ideaOf(composted);
    expect(c).toMatchObject({ status: 'exploring', inbox: false, promoted: { at: '2026-09-30T12:00:00.000Z', title: 'Revived' } });
    expect(c.notes.at(-1).text).toBe('status: composted → exploring');

    const used = await seedIdea('Already used');
    await ok('update_idea', { id: used, status: 'used', reviewed: true });
    const u = await ok('update_idea', { id: used, promoted: { title: 'Follow-up episode' } });
    expect(u.changed).toEqual(['promoted']);
    const ui = await ideaOf(used);
    expect(ui.status).toBe('used');
    expect(ui.notes.map((n: any) => n.text)).toEqual(['status: parked → used', 'promoted to Subjects as "Follow-up episode"']);

    const explicit = await seedIdea('Explicit status');
    const e = await ok('update_idea', { id: explicit, status: 'used', promoted: { title: 'Explicit' } });
    expect(e.changed).toEqual(['status', 'promoted', 'reviewed']);
    expect((await ideaOf(explicit)).status).toBe('used');

    // A promotion keeps an earlier review's time.
    const earlier = await seedIdea('Reviewed before its promotion');
    await admin`UPDATE idea SET reviewed_at = '2026-03-01T00:00:00Z' WHERE id = ${earlier}`;
    const p = await ok('update_idea', { id: earlier, promoted: { title: 'Later episode' } });
    expect(p.changed).toEqual(['promoted', 'status']);
    expect(await ideaOf(earlier)).toMatchObject({ reviewed_at: '2026-03-01T00:00:00.000Z', inbox: false, status: 'exploring' });

    // An explicit reviewed: false wins over the promotion's review too.
    const kept = await seedIdea('Promoted but still in the inbox');
    await ok('update_idea', { id: kept, reviewed: false, promoted: { title: 'Kept' } });
    expect(await ideaOf(kept)).toMatchObject({ inbox: true, status: 'exploring', promoted: { title: 'Kept' } });
  });

  it('refuses a future, blank or over-long promotion', async () => {
    const id = await seedIdea('Validate promotion');
    const future = await callTool('update_idea', {
      id,
      promoted: { title: 'Too early', at: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString() },
    });
    expect(future.isError).toBe(true);
    expect(future.texts[0]).toMatch(/in the future/);
    const halfHour = await callTool('update_idea', {
      id,
      promoted: { title: 'Half an hour early', at: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
    });
    expect(halfHour.isError).toBe(true);
    expect(halfHour.texts[0]).toMatch(/in the future/);
    for (const promoted of [{ title: '   ' }, { title: 'x'.repeat(501) }, { title: 'ok', at: 'yesterday' }, { title: 'ok', extra: 1 }]) {
      const r = await callTool('update_idea', { id, promoted });
      expect(r.isError, JSON.stringify(promoted).slice(0, 60)).toBe(true);
    }
    expect(await ideaOf(id)).toMatchObject({ status: 'parked', promoted: null, inbox: true, notes: [] });

    // A few seconds of clock skew is allowed, but the stored time is never ahead.
    await ok('update_idea', { id, promoted: { title: 'Skewed clock', at: new Date(Date.now() + 20 * 1000).toISOString() } });
    const [row] = await admin`SELECT promoted_at <= now() AS not_ahead FROM idea WHERE id = ${id}`;
    expect(row.not_ahead).toBe(true);
  });
});

describe.skipIf(!TEST_DB)('composting withdraws pending proposals', () => {
  beforeEach(async () => {
    await resetAuthData();
    await resetIdeaData();
  });

  it('withdraws proposals on either end, leaves accepted links and other ideas alone', async () => {
    const token = await seedPat('Composter');
    const c = as(token);
    const x = await seedIdea('To be composted');
    const y = await seedIdea('Neighbour Y');
    const z = await seedIdea('Neighbour Z');
    const out = await seedProposal(x, y);
    const inbound = await seedProposal(z, x, 'gardening', 'mechanism_for');
    const accepted = await seedProposal(y, x, 'gardening', 'example_of');
    const elsewhere = await seedProposal(y, z);
    await ok('decide_idea_links', { decisions: [{ link_id: accepted, decision: 'accept' }] });

    const r = await c('update_idea', { id: x, status: 'composted' });
    expect(r.withdrawn_proposals).toBe(2);

    const rows = await admin`
      SELECT id, status, decided_at, decided_via, decision_note, history FROM idea_link
       WHERE id IN (${out}, ${inbound}, ${accepted}, ${elsewhere})
    `;
    const byId = new Map(rows.map((l) => [l.id, l]));
    for (const id of [out, inbound]) {
      const l = byId.get(id)!;
      expect(l).toMatchObject({ status: 'withdrawn', decided_via: { credential: 'Composter' }, decision_note: 'endpoint composted', history: [] });
      expect(l.decided_at).not.toBeNull();
    }
    expect(byId.get(accepted)!.status).toBe('accepted');
    expect(byId.get(elsewhere)!.status).toBe('proposed');

    // Composting again finds nothing left to withdraw.
    const again = await c('update_idea', { id: x, status: 'composted' });
    expect(again.withdrawn_proposals).toBe(0);
    // Other edits report no withdrawals.
    expect((await ok('update_idea', { id: y, title: 'Neighbour Y, renamed' })).withdrawn_proposals).toBeUndefined();
  });

  it('the review never shows proposals with a composted end; composting again withdraws them', async () => {
    const live = await seedIdea('Inbox idea');
    const gone = await seedIdea('Composted earlier');
    const other = await seedIdea('Live neighbour');
    await ok('update_idea', { id: gone, status: 'composted' });
    // Proposals that reached a composted idea anyway (made before
    // composting withdrew them, or proposed onto it afterwards).
    const out = await seedProposal(live, gone);
    const inbound = await seedProposal(gone, live, 'gardening', 'mechanism_for');
    const kept = await seedProposal(live, other);

    const r = await ok('garden_ideas', { mode: 'inbox', include_statuses: ['parked', 'exploring', 'used', 'composted'] });
    const byTitle = new Map<string, any>(r.inbox.map((x: any) => [x.idea.title, x]));
    expect([...byTitle.keys()].sort()).toEqual(['Inbox idea', 'Live neighbour']);
    expect(byTitle.get('Inbox idea').pending.map((p: any) => p.link_id)).toEqual([kept]);

    const again = await ok('update_idea', { id: gone, status: 'composted' });
    expect(again.withdrawn_proposals).toBe(2);
    const rows = await admin`SELECT id, status, decision_note FROM idea_link WHERE id IN (${out}, ${inbound}, ${kept})`;
    expect(new Map(rows.map((l) => [l.id, [l.status, l.decision_note]]))).toEqual(
      new Map([
        [out, ['withdrawn', 'endpoint composted']],
        [inbound, ['withdrawn', 'endpoint composted']],
        [kept, ['proposed', null]],
      ]),
    );
    const [gi] = await admin`SELECT notes FROM idea WHERE id = ${gone}`;
    expect(gi.notes.map((n: any) => n.text)).toEqual(['status: parked → composted']);
  });
});

// jsonb written by the goal/editorial tools must be real JSON values, and
// readers must tolerate rows an older writer stored as JSON strings.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { admin, ok, resetGoalData, seedUndertaking, TEST_DB, USER } from './helpers';

const REPAIR_SQL = readFileSync(
  fileURLToPath(new URL('../../../migrations/021_repair_double_encoded_jsonb.sql', import.meta.url).href),
  'utf8',
);

afterAll(() => admin.end({ timeout: 5 }));

// One and two levels of string wrapping, as `${JSON.stringify(x)}::jsonb`
// produced (a JSON string whose text is JSON).
const wrap1 = (json: string) => admin`to_jsonb(${json}::text)`;
const wrap2 = (json: string) => admin`to_jsonb((to_jsonb(${json}::text))::text)`;

describe.skipIf(!TEST_DB)('goal-system jsonb', () => {
  beforeEach(resetGoalData);

  it('close_cycle stores streak_summary as an object', async () => {
    const { undertakingId, cycleId } = await seedUndertaking();
    await ok('close_cycle', { cycle_id: cycleId, streak_summary: { done: 5, missed: [1, 2] } });
    const [row] = await admin`SELECT jsonb_typeof(streak_summary) AS t FROM undertaking_cycles WHERE id = ${cycleId}`;
    expect(row.t).toBe('object');
    const u = await ok('get_undertaking', { id: undertakingId });
    expect(u.past_cycles[0].streak_summary).toEqual({ done: 5, missed: [1, 2] });
    expect(u.undertaking).not.toHaveProperty('as_of');
    expect(u.past_cycles[0]).not.toHaveProperty('as_of');
  });

  it('record_pick stores keywords/tags/urls as arrays', async () => {
    const r = await ok('record_pick', {
      candidate: { headline: 'Synthetic headline', keywords: [], tags: ['x'] },
      decision: 'pick',
    });
    const [row] = await admin`
      SELECT jsonb_typeof(keywords) AS k, jsonb_typeof(tags) AS t, urls, keywords, tags
        FROM editorial_pick WHERE id = ${r.pick_id}
    `;
    expect(row).toMatchObject({ k: 'array', t: 'array', urls: null, keywords: [], tags: ['x'] });
  });

  it('unwraps legacy string-wrapped rows on read', async () => {
    const { undertakingId, cycleId } = await seedUndertaking();
    await admin`
      UPDATE undertaking_cycles SET status = 'closed', closed_at = now(), streak_summary = ${wrap1('{"done":3}')}
       WHERE id = ${cycleId}
    `;
    await admin`
      INSERT INTO undertaking_cycles (undertaking_id, cycle_number, start_date, end_date, streak_summary)
      VALUES (${undertakingId}, 2, '2026-02-01', '2026-02-28', ${wrap2('{"done":4}')})
    `;
    const u = await ok('get_undertaking', { id: undertakingId });
    expect(u.current_cycle.streak_summary).toEqual({ done: 4 });
    expect(u.past_cycles[0].streak_summary).toEqual({ done: 3 });

    await admin`
      INSERT INTO goal_amendments (user_id, kind, proposed_payload, rationale)
      VALUES (${USER}, 'new', ${wrap2('{"statement":"Synthetic"}')}, 'r'),
             (${USER}, 'new', ${wrap1('not json at all')}, 'r2')
    `;
    const g = await ok('list_pending_goal_amendments', {});
    const payloads = g.amendments.map((a: any) => a.proposed_payload);
    expect(payloads).toContainEqual({ statement: 'Synthetic' });
    expect(payloads).toContain('not json at all');

    await admin`
      INSERT INTO constitution_amendments (user_id, kind, proposed_payload, rationale, crisis_justification)
      VALUES (${USER}, 'new', ${wrap1('{"label":"Domain"}')}, 'r', 'c')
    `;
    const c = await ok('list_pending_constitution_amendments', {});
    expect(c.amendments[0].proposed_payload).toEqual({ label: 'Domain' });
  });
});

describe.skipIf(!TEST_DB)('migration 021: repair string-wrapped jsonb', () => {
  beforeEach(resetGoalData);

  it('unwraps objects and arrays, leaves everything else, and is idempotent', async () => {
    const { undertakingId, cycleId } = await seedUndertaking();
    await admin`
      UPDATE undertaking_cycles SET status = 'closed', closed_at = now(), streak_summary = ${wrap2('{"done":3}')}
       WHERE id = ${cycleId}
    `;
    const [clean] = await admin<Array<{ id: string }>>`
      INSERT INTO undertaking_cycles (undertaking_id, cycle_number, start_date, end_date, streak_summary)
      VALUES (${undertakingId}, 2, '2026-02-01', '2026-02-28', '{"done":1}'::jsonb) RETURNING id
    `;
    const [pick] = await admin<Array<{ id: string }>>`
      INSERT INTO editorial_pick (decision, headline, keywords, tags, urls)
      VALUES ('pick', 'Synthetic', ${wrap1('[]')}, ${wrap2('["a","b"]')}, ${wrap1('5')})
      RETURNING id
    `;
    const amendments = await admin<Array<{ id: string; proposed_at: Date; cooldown_until: Date }>>`
      INSERT INTO goal_amendments (user_id, kind, proposed_payload, rationale)
      VALUES (${USER}, 'new', ${wrap1('{"statement":"S"}')}, 'r'),
             (${USER}, 'new', ${wrap1('not json at all')}, 'r2')
      RETURNING id, proposed_at, cooldown_until
    `;
    const [ca] = await admin<Array<{ id: string; proposed_at: Date; cooldown_until: Date }>>`
      INSERT INTO constitution_amendments (user_id, kind, proposed_payload, rationale, crisis_justification, status)
      VALUES (${USER}, 'new', ${wrap2('{"label":"D"}')}, 'r', 'c', 'committed')
      RETURNING id, proposed_at, cooldown_until
    `;

    const snapshot = async () => ({
      cycles: await admin`SELECT id, streak_summary, jsonb_typeof(streak_summary) AS t FROM undertaking_cycles ORDER BY cycle_number`,
      pick: await admin`SELECT keywords, tags, urls, jsonb_typeof(urls) AS ut FROM editorial_pick WHERE id = ${pick.id}`,
      goals: await admin`SELECT id, proposed_payload, proposed_at, cooldown_until FROM goal_amendments ORDER BY rationale`,
      cons: await admin`SELECT proposed_payload, proposed_at, cooldown_until FROM constitution_amendments WHERE id = ${ca.id}`,
    });

    await admin.unsafe(REPAIR_SQL).simple();
    const after = await snapshot();
    expect(after.cycles.map((c) => c.streak_summary)).toEqual([{ done: 3 }, { done: 1 }]);
    expect(after.cycles.find((c) => c.id === clean.id)!.t).toBe('object');
    expect(after.pick[0]).toMatchObject({ keywords: [], tags: ['a', 'b'], ut: 'string' }); // "5" stays a string
    expect(after.goals[0].proposed_payload).toEqual({ statement: 'S' });
    expect(after.goals[1].proposed_payload).toBe('not json at all');
    expect(after.cons[0].proposed_payload).toEqual({ label: 'D' });
    // Cooldown triggers pin the timestamps on UPDATE.
    expect(after.goals[0].proposed_at).toEqual(amendments[0].proposed_at);
    expect(after.goals[0].cooldown_until).toEqual(amendments[0].cooldown_until);
    expect(after.cons[0].cooldown_until).toEqual(ca.cooldown_until);

    await admin.unsafe(REPAIR_SQL).simple();
    expect(await snapshot()).toEqual(after);
  });

  it('is a no-op on empty tables', async () => {
    await admin.unsafe(REPAIR_SQL).simple();
    expect(await admin`SELECT 1 FROM goal_amendments`).toHaveLength(0);
  });
});

// jsonb written by the goal/editorial tools must be real JSON values, and
// readers must tolerate rows an older writer stored as JSON strings.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, ok, resetGoalData, seedUndertaking, TEST_DB, USER } from './helpers';

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

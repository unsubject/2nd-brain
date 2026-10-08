// jsonb written by the goal/editorial tools must be real JSON values, and
// readers must tolerate rows an older writer stored as JSON strings.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { admin, callTool, ok, resetGoalData, seedUndertaking, TEST_DB, USER } from './helpers';

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

describe.skipIf(!TEST_DB)('goal amendments: parent domain', () => {
  beforeEach(resetGoalData);

  const smart = {
    statement: 'Synthetic merged goal',
    specific: 'sss',
    measurable: 'mmm',
    achievable: 'aaa',
    relevant: 'rrr',
    time_bound: 'ttt',
    outcome_metric: 'ooo',
  };

  it('refuses to synthesize goals under a retired domain', async () => {
    const { domainId, goalId } = await seedUndertaking();
    const [second] = await admin<Array<{ id: string }>>`
      INSERT INTO goals (user_id, constitution_domain_id, statement, specific, measurable, achievable, relevant, time_bound, outcome_metric)
      VALUES (${USER}, ${domainId}, 'Second goal', 's', 'm', 'a', 'r', 't', 'metric') RETURNING id
    `;
    const args = {
      kind: 'synthesize',
      source_goal_ids: [goalId, second.id],
      payload: { ...smart, constitution_domain_id: domainId },
      rationale: 'These two goals reinforce each other',
    };
    // Retiring a domain leaves its goals active.
    await admin`UPDATE constitution_domains SET status = 'retired' WHERE id = ${domainId}`;
    const refused = await callTool('propose_goal_amendment', args);
    expect(refused.isError).toBe(true);
    expect(refused.texts[0]).toMatch(/is retired; cannot add goals under it/);
    expect(await admin`SELECT 1 FROM goal_amendments`).toHaveLength(0);

    await admin`UPDATE constitution_domains SET status = 'active' WHERE id = ${domainId}`;
    const staged = await ok('propose_goal_amendment', args);
    expect(staged.amendment_id).toBeTruthy();
  });

  it('re-checks the domain and the sources at commit, after the cooldown', async () => {
    const { domainId, goalId } = await seedUndertaking();
    const [second] = await admin<Array<{ id: string }>>`
      INSERT INTO goals (user_id, constitution_domain_id, statement, specific, measurable, achievable, relevant, time_bound, outcome_metric)
      VALUES (${USER}, ${domainId}, 'Second goal', 's', 'm', 'a', 'r', 't', 'metric') RETURNING id
    `;
    // Proposed while everything was active; the 72h cooldown has elapsed.
    const stage = async (kind: 'new' | 'synthesize', sources: string[]) => {
      const [row] = await admin<Array<{ id: string }>>`
        INSERT INTO goal_amendments (user_id, kind, source_goal_ids, proposed_payload, rationale, proposed_at)
        VALUES (${USER}, ${kind}, ${`{${sources.join(',')}}`}::uuid[],
                ${admin.json({ ...smart, constitution_domain_id: domainId })}, 'r', now() - interval '4 days')
        RETURNING id
      `;
      return row.id;
    };
    const synth = await stage('synthesize', [goalId, second.id]);
    const fresh = await stage('new', []);
    const goals = () => admin`SELECT id, status FROM goals ORDER BY statement`;
    const before = await goals();

    // A domain retire committed during the cooldown.
    await admin`UPDATE constitution_domains SET status = 'retired' WHERE id = ${domainId}`;
    for (const amendment_id of [synth, fresh]) {
      const refused = await callTool('commit_goal_amendment', { amendment_id });
      expect(refused.isError).toBe(true);
      expect(refused.texts[0]).toMatch(/^invalid_state: Domain .* is retired; cannot add goals under it/);
    }
    expect(await goals()).toEqual(before);

    // A source goal that ended during the cooldown is not relabelled 'merged'.
    await admin`UPDATE constitution_domains SET status = 'active' WHERE id = ${domainId}`;
    await admin`UPDATE goals SET status = 'achieved' WHERE id = ${second.id}`;
    const ended = await callTool('commit_goal_amendment', { amendment_id: synth });
    expect(ended.isError).toBe(true);
    expect(ended.texts[0]).toMatch(/^invalid_state: Source goals are no longer all active/);
    expect((await goals()).find((g) => g.id === second.id)!.status).toBe('achieved');

    await admin`UPDATE goals SET status = 'active' WHERE id = ${second.id}`;
    const committed = await ok('commit_goal_amendment', { amendment_id: synth });
    const after = await admin`SELECT id, status, merged_into_id FROM goals WHERE id IN ${admin([goalId, second.id])}`;
    expect(after.map((g) => [g.status, g.merged_into_id])).toEqual([
      ['merged', committed.goal_id],
      ['merged', committed.goal_id],
    ]);
    const statuses = await admin`SELECT status FROM goal_amendments ORDER BY kind`;
    expect(statuses.map((r) => r.status)).toEqual(['proposed', 'committed']);
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

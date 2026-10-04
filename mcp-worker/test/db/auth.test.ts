// /mcp authentication with per-client credentials, and attribution:
// captured_via.credential on idea writes plus the call log.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { admin, callTool, env, resetAuthData, resetIdeaData, rpcRaw, TEST_DB, USER } from './helpers';
import { hashToken, newToken } from '../../src/auth/tokens';

afterAll(() => admin.end({ timeout: 5 }));

async function seedPat(label: string, scope = 'all'): Promise<{ token: string; id: string }> {
  const token = newToken('pat');
  const [cred] = await admin<Array<{ id: string }>>`
    INSERT INTO mcp_credential (user_id, label, kind, scope, token_hint)
    VALUES (${USER}, ${label}, 'pat', ${scope}, ${token.slice(-4)}) RETURNING id
  `;
  await admin`INSERT INTO mcp_token (token_hash, credential_id, kind) VALUES (${await hashToken(token)}, ${cred.id}, 'pat')`;
  return { token, id: cred.id };
}

describe.skipIf(!TEST_DB)('/mcp per-client credentials', () => {
  beforeEach(async () => {
    await resetAuthData();
    await resetIdeaData();
  });

  it('accepts a PAT and stamps its label on idea writes and the call log', async () => {
    const pat = await seedPat('Meta Muse');
    const r = await callTool('park_idea', { title: 'Why is the moon drifting away?', captured_via: { client: 'muse' } }, { token: pat.token });
    expect(r.isError).toBe(false);
    const ideaId = r.json.idea_id as string;
    const [idea] = await admin`SELECT captured_via FROM idea WHERE id = ${ideaId}`;
    expect(idea.captured_via).toEqual({ client: 'muse', role: 'librarian', credential: 'Meta Muse' });

    const log = await admin`SELECT credential_id, label, method, tool, is_write, ok, result_ids FROM mcp_call_log`;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ credential_id: pat.id, label: 'Meta Muse', method: 'tools/call', tool: 'park_idea', is_write: true, ok: true });
    expect(log[0].result_ids).toContain(ideaId);

    const [cred] = await admin`SELECT last_used_at FROM mcp_credential WHERE id = ${pat.id}`;
    expect(cred.last_used_at).not.toBeNull();
  });

  it('refuses a client-supplied credential label', async () => {
    const pat = await seedPat('Cursor');
    const r = await callTool('park_idea', { title: 'Spoof', captured_via: { credential: 'master' } }, { token: pat.token });
    expect(r.isError).toBe(true);
    expect(await admin`SELECT 1 FROM idea`).toHaveLength(0);
    const [log] = await admin`SELECT ok, error_code, is_write FROM mcp_call_log`;
    expect(log).toEqual({ ok: false, error_code: 'tool_error', is_write: true });
  });

  it('records the client from initialize and logs reads as reads', async () => {
    const pat = await seedPat('Gemini CLI');
    const init = await rpcRaw(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gemini-cli-mcp-client', version: '0.9.0' } },
      { token: pat.token },
    );
    expect(init.status).toBe(200);
    await callTool('list_ideas', {}, { token: pat.token });
    const [cred] = await admin`SELECT last_client_info FROM mcp_credential WHERE id = ${pat.id}`;
    expect(cred.last_client_info).toMatchObject({
      clientInfo: { name: 'gemini-cli-mcp-client', version: '0.9.0' },
      protocolVersion: '2025-06-18',
    });
    const log = await admin`SELECT tool, is_write FROM mcp_call_log`;
    expect(log).toEqual([{ tool: 'list_ideas', is_write: false }]);
  });

  it('keeps logging calls when clientInfo is hostile', async () => {
    const pat = await seedPat('Fuzzer');
    const res = await rpcRaw(
      'initialize',
      { protocolVersion: '2025-06-18', clientInfo: { name: 'a\u0000b'.repeat(500), version: 7, extra: 'x'.repeat(100000) } },
      { token: pat.token },
    );
    expect(res.status).toBe(200);
    await callTool('list_ideas', {}, { token: pat.token });
    const [cred] = await admin`SELECT last_client_info FROM mcp_credential WHERE id = ${pat.id}`;
    expect(cred.last_client_info.clientInfo).toEqual({ name: 'ab'.repeat(50) });
    expect(await admin`SELECT tool FROM mcp_call_log`).toEqual([{ tool: 'list_ideas' }]);
  });

  it('records a 2026-07-28 client from _meta, writing the row only when it changes', async () => {
    const pat = await seedPat('Modern client');
    const meta = (name: string) => ({
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name, version: '2.0.0' },
      },
    });
    const headers = (method: string, name?: string) => ({
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
    });
    expect((await rpcRaw('server/discover', meta('sdk'), { token: pat.token, headers: headers('server/discover') })).status).toBe(200);
    const [first] = await admin`SELECT last_client_info FROM mcp_credential WHERE id = ${pat.id}`;
    expect(first.last_client_info).toMatchObject({ clientInfo: { name: 'sdk', version: '2.0.0' }, protocolVersion: '2026-07-28' });

    const call = await rpcRaw(
      'tools/call',
      { name: 'list_ideas', arguments: {}, ...meta('sdk') },
      { token: pat.token, headers: headers('tools/call', 'list_ideas') },
    );
    expect(call.status).toBe(200);
    const [second] = await admin`SELECT last_client_info FROM mcp_credential WHERE id = ${pat.id}`;
    expect(second.last_client_info.at).toBe(first.last_client_info.at); // unchanged → not rewritten
    expect(await admin`SELECT tool FROM mcp_call_log`).toEqual([{ tool: 'list_ideas' }]);

    await rpcRaw('tools/list', meta('sdk-renamed'), { token: pat.token, headers: headers('tools/list') });
    const [third] = await admin`SELECT last_client_info FROM mcp_credential WHERE id = ${pat.id}`;
    expect(third.last_client_info.clientInfo.name).toBe('sdk-renamed');
  });

  it('serves MCP only at exactly /mcp', async () => {
    const { workerFetch } = await import('./helpers');
    const pat = await seedPat('Path');
    const res = await workerFetch('/mcp/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(404);
  });

  it('stops a revoked credential on the very next request', async () => {
    const pat = await seedPat('Scripts');
    expect((await rpcRaw('tools/list', {}, { token: pat.token })).status).toBe(200);
    await admin`UPDATE mcp_credential SET revoked_at = now(), revoked_reason = 'owner' WHERE id = ${pat.id}`;
    const res = await rpcRaw('tools/list', {}, { token: pat.token });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });

  it('rejects well-formed tokens that were never issued, and refresh tokens as bearers', async () => {
    expect((await rpcRaw('tools/list', {}, { token: newToken('pat') })).status).toBe(401);
    expect((await rpcRaw('tools/list', {}, { token: newToken('access') })).status).toBe(401);
    expect((await rpcRaw('tools/list', {}, { token: newToken('refresh') })).status).toBe(401);
    expect((await rpcRaw('tools/list', {}, { token: null })).status).toBe(401);
  });

  it('fails closed on an unknown scope', async () => {
    const pat = await seedPat('Limited', 'read-only-someday');
    const list = (await (await rpcRaw('tools/list', {}, { token: pat.token })).json()) as any;
    expect(list.result.tools).toEqual([]);
    const call = (await (await rpcRaw('tools/call', { name: 'list_ideas', arguments: {} }, { token: pat.token })).json()) as any;
    expect(call.error.code).toBe(-32602);
  });

  it('attributes the master token as "master" and can switch it off', async () => {
    const r = await callTool('park_idea', { title: 'Tides and the calendar' });
    const [idea] = await admin`SELECT captured_via FROM idea WHERE id = ${r.json.idea_id as string}`;
    expect(idea.captured_via.credential).toBe('master');
    const [log] = await admin`SELECT credential_id, label FROM mcp_call_log`;
    expect(log).toEqual({ credential_id: null, label: 'master' });

    const off = { ...env, ALLOW_MASTER_BEARER: 'false' };
    expect((await rpcRaw('tools/list', {}, { env: off })).status).toBe(401);
  });

  it('answers 503, not 401, when the credential store is unreachable', async () => {
    const down = { ...env, HYPERDRIVE: { connectionString: 'postgres://nobody:x@127.0.0.1:1/none_test' } } as typeof env;
    const res = await rpcRaw('tools/list', {}, { token: newToken('pat'), env: down });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
  });
});

describe.skipIf(!TEST_DB)('full attribution on idea writes', () => {
  beforeEach(async () => {
    await resetAuthData();
    await resetIdeaData();
  });

  const as = (token: string) => async (name: string, args: unknown) => {
    const r = await callTool(name, args, { token });
    if (r.isError) throw new Error(`${name}: ${r.texts.join(' ')}`);
    return r.json;
  };
  const master = as('test-token');
  const via = (v: unknown) => (v as { credential?: string } | null)?.credential ?? null;

  it('update_idea stamps its notes and appends to the edit log', async () => {
    const g = as((await seedPat('Gardener')).token);
    const { idea_id: id } = await master('park_idea', { title: 'Tidal locking' });
    await g('update_idea', { id, status: 'exploring', append_note: { text: 'look at Io', by: 'agent' } });
    const idea = (await master('get_idea', { id })).idea;
    expect(idea.notes.map((n: any) => [n.by, n.credential])).toEqual([
      ['system', 'Gardener'],
      ['agent', 'Gardener'],
    ]);
    expect(idea.edit_log).toHaveLength(1);
    expect(idea.edit_log[0]).toMatchObject({ credential: 'Gardener', tool: 'update_idea', fields: ['status', 'append_note'] });
    // Field edits write no note; the log keeps every editor, not just the last.
    await master('update_idea', { id, title: 'Tidal locking, revisited' });
    const log = (await master('get_idea', { id })).idea.edit_log;
    expect(log.map((e: any) => [e.credential, e.fields])).toEqual([
      ['Gardener', ['status', 'append_note']],
      ['master', ['title']],
    ]);
  });

  it('records proposer and decider separately, and keeps both on reopen', async () => {
    const a = as((await seedPat('Proposer')).token);
    const b = as((await seedPat('Decider')).token);
    const { idea_id: x } = await master('park_idea', { title: 'Moons' });
    const { idea_id: y } = await master('park_idea', { title: 'Tides' });
    const link = { source_idea_id: x, target_idea_id: y, link_type: 'related', rationale: 'Both about orbits' };
    const p = await a('propose_idea_links', { origin: 'gardening', links: [link] });
    const linkId = p.results[0].link_id;
    await b('decide_idea_links', { decisions: [{ link_id: linkId, decision: 'accept' }] });

    const listed = (await master('list_idea_links', { idea_id: x, statuses: ['accepted'] })).links[0];
    expect([via(listed.proposed_via), via(listed.decided_via)]).toEqual(['Proposer', 'Decider']);
    const shown = (await master('get_idea', { id: x })).links[0];
    expect([via(shown.proposed_via), via(shown.decided_via)]).toEqual(['Proposer', 'Decider']);

    // A different connection retracts it: the accept (and who made it) is
    // kept in history.
    const r = as((await seedPat('Retractor')).token);
    await r('decide_idea_links', { decisions: [{ link_id: linkId, decision: 'retract', note: 'not really' }] });
    const [retracted] = await admin`SELECT decided_via, history FROM idea_link WHERE id = ${linkId}`;
    expect(via(retracted.decided_via)).toBe('Retractor');
    expect(retracted.history.map((h: any) => [h.status, via(h.decided_via)])).toEqual([['accepted', 'Decider']]);

    // Then another connection re-proposes it: the decider is cleared and
    // every earlier stamp survives in history.
    const c = as((await seedPat('Second proposer')).token);
    await c('propose_idea_links', { origin: 'gardening', reconsider_rejected: true, links: [link] });
    const [row] = await admin`SELECT status, decided_via, proposed_via, history FROM idea_link WHERE id = ${linkId}`;
    expect(row.status).toBe('proposed');
    expect(row.decided_via).toBeNull();
    expect(via(row.proposed_via)).toBe('Second proposer');
    expect(row.history.map((h: any) => [via(h.proposed_via), via(h.decided_via)])).toEqual([
      [null, 'Decider'],
      ['Proposer', 'Retractor'],
    ]);
  });

  it('a revived link takes over the accepted proposal and its proposer', async () => {
    const a = as((await seedPat('A')).token);
    const b = as((await seedPat('B')).token);
    const c = as((await seedPat('C')).token);
    const d = as((await seedPat('D')).token);
    const { idea_id: x } = await master('park_idea', { title: 'Orbital resonance' });
    const { idea_id: y } = await master('park_idea', { title: 'Kirkwood gaps' });
    const p1 = await a('propose_idea_links', {
      origin: 'gardening',
      links: [{ source_idea_id: x, target_idea_id: y, link_type: 'builds_on', rationale: 'X extends Y somehow', similarity: 0.91 }],
    });
    const builds = p1.results[0].link_id;
    await b('decide_idea_links', { decisions: [{ link_id: builds, decision: 'reject' }] });
    // The pair was rejected once, so a new proposal must ask to reconsider.
    const p2 = await c('propose_idea_links', {
      origin: 'gardening',
      reconsider_rejected: true,
      links: [{ source_idea_id: x, target_idea_id: y, link_type: 'related', rationale: 'X and Y are related', similarity: 0.42 }],
    });
    const related = p2.results[0].link_id;
    await admin`UPDATE idea_link SET proposed_at = '2026-01-01T00:00:00Z' WHERE id = ${builds}`;
    const [{ proposed_at: relatedAt }] = await admin`SELECT proposed_at FROM idea_link WHERE id = ${related}`;
    const r = await d('decide_idea_links', { decisions: [{ link_id: related, decision: 'accept', link_type: 'builds_on' }] });
    expect(r.results[0]).toMatchObject({ link_id: builds, superseded: related });

    const [revived] = await admin`
      SELECT proposed_via, decided_via, rationale, history, proposed_at, similarity FROM idea_link WHERE id = ${builds}
    `;
    expect([via(revived.proposed_via), via(revived.decided_via)]).toEqual(['C', 'D']);
    // Proposer, time, score and rationale all come from the accepted proposal.
    expect(revived.rationale).toBe('X and Y are related');
    expect(revived.similarity).toBeCloseTo(0.42);
    expect(revived.proposed_at).toEqual(relatedAt);
    const before = revived.history[revived.history.length - 1];
    expect([via(before.proposed_via), via(before.decided_via), before.similarity]).toEqual(['A', 'B', 0.91]);
    expect(new Date(before.proposed_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const [withdrawn] = await admin`SELECT status, decided_via FROM idea_link WHERE id = ${related}`;
    expect([withdrawn.status, via(withdrawn.decided_via)]).toEqual(['withdrawn', 'D']);
  });

  it('stamps synthesis part_of links and import merges', async () => {
    const s = as((await seedPat('Synthesist')).token);
    const { idea_id: x } = await master('park_idea', { title: 'Moons' });
    const { idea_id: y } = await master('park_idea', { title: 'Tides' });
    await s('create_synthesis', { title: 'Episode on tides', intent: 'episode', part_ids: [x, y] });
    const links = await admin`SELECT proposed_via, decided_via FROM idea_link WHERE link_type = 'part_of'`;
    expect(links).toHaveLength(2);
    for (const l of links) expect([via(l.proposed_via), via(l.decided_via)]).toEqual(['Synthesist', 'Synthesist']);

    const imp = as((await seedPat('Importer')).token);
    await imp('import_ideas', {
      source_system: 'notion',
      items: [{ source_external_id: 'n-1', import_payload: {}, merge_into_idea_id: x, thoughts: 'merged text' }],
    });
    const idea = (await master('get_idea', { id: x })).idea;
    expect(idea.notes.at(-1).credential).toBe('Importer');
    expect(idea.edit_log.at(-1)).toMatchObject({ credential: 'Importer', tool: 'import_ideas' });
  });

  it('keeps the proposed type and direction when an accept changes them', async () => {
    const a = as((await seedPat('Proposer')).token);
    const d = as((await seedPat('Decider')).token);
    const { idea_id: x } = await master('park_idea', { title: 'Orbital resonance' });
    const { idea_id: y } = await master('park_idea', { title: 'Kirkwood gaps' });
    const { idea_id: z } = await master('park_idea', { title: 'Lagrange points' });
    const p = await a('propose_idea_links', {
      origin: 'gardening',
      links: [
        { source_idea_id: x, target_idea_id: y, link_type: 'related', rationale: 'Both about resonance', similarity: 0.77 },
        { source_idea_id: x, target_idea_id: z, link_type: 'related', rationale: 'Both about orbits' },
      ],
    });
    const [retyped, plain] = p.results.map((r: any) => r.link_id);
    // `related` is symmetric, so the proposal is stored in canonical order.
    const [proposed] = await admin`SELECT source_idea_id, target_idea_id FROM idea_link WHERE id = ${retyped}`;
    await d('decide_idea_links', {
      decisions: [
        { link_id: retyped, decision: 'accept', link_type: 'builds_on', reverse: true },
        { link_id: plain, decision: 'accept', link_type: 'related' },
      ],
    });

    const [row] = await admin`SELECT link_type, source_idea_id, proposed_via, decided_via, history FROM idea_link WHERE id = ${retyped}`;
    expect([row.link_type, row.source_idea_id, via(row.proposed_via), via(row.decided_via)]).toEqual([
      'builds_on',
      proposed.target_idea_id,
      'Proposer',
      'Decider',
    ]);
    expect(row.history).toHaveLength(1);
    expect(row.history[0]).toMatchObject({
      status: 'proposed',
      link_type: 'related',
      source_idea_id: proposed.source_idea_id,
      target_idea_id: proposed.target_idea_id,
      rationale: 'Both about resonance',
      similarity: 0.77,
      proposed_via: { credential: 'Proposer' },
    });
    expect(row.history[0].retyped_at).toBeTruthy();
    // Accepting as proposed (even naming the same type) leaves no snapshot.
    const [unchanged] = await admin`SELECT history FROM idea_link WHERE id = ${plain}`;
    expect(unchanged.history).toEqual([]);
  });

  it('decided_via must be an object, but an older Worker can still reopen a link', async () => {
    const { idea_id: x } = await master('park_idea', { title: 'Moons' });
    const { idea_id: y } = await master('park_idea', { title: 'Tides' });
    const p = await master('propose_idea_links', {
      origin: 'gardening',
      links: [{ source_idea_id: x, target_idea_id: y, link_type: 'related', rationale: 'Both about orbits' }],
    });
    const id = p.results[0].link_id;
    await master('decide_idea_links', { decisions: [{ link_id: id, decision: 'reject' }] });
    await expect(admin`UPDATE idea_link SET decided_via = '"x"'::jsonb WHERE id = ${id}`).rejects.toMatchObject({
      code: '23514',
    });
    // A Worker that predates migration 022 reopens by clearing decided_at
    // only; rolling back to one must not trip a CHECK.
    await admin`UPDATE idea_link SET status = 'proposed', decided_at = NULL, decision_note = NULL WHERE id = ${id}`;
    const [row] = await admin`SELECT status, decided_via FROM idea_link WHERE id = ${id}`;
    expect([row.status, via(row.decided_via)]).toEqual(['proposed', 'master']);
  });
});

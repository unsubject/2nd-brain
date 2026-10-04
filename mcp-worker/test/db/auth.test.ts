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

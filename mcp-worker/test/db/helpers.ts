// Helpers for DB-backed handler tests. Real Postgres (TEST_DATABASE_URL),
// no DB mocks — per docs/mcp-behavior-and-dev-norms.md. Calls go through
// handleMcpRequest so the JSON-RPC layer is exercised end to end.

import postgres from 'postgres';
import { handleMcpRequest } from '../../src/mcp';
import type { Env } from '../../src/env';

export const TEST_DB = process.env.TEST_DATABASE_URL;
export const USER = 'test-user';
export const TOKEN = 'test-token';

export const env = {
  HYPERDRIVE: { connectionString: TEST_DB ?? 'postgres://unused' },
  BRAIN_MCP_TOKEN: TOKEN,
  BRAIN_USER_ID: USER,
  OPENAI_API_KEY: 'sk-test',
} as unknown as Env;

// Direct connection for seeding and assertions.
export const admin = postgres(TEST_DB ?? 'postgres://unused', { max: 2, onnotice: () => {} });

export type CallResult = { isError: boolean; texts: string[]; json: any };

let rpcId = 0;

// An ExecutionContext whose waitUntil work can be awaited (background
// writes such as the call log must land before assertions).
export function testCtx(): { ctx: ExecutionContext; settle: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    settle: async () => {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
}

export type RpcOptions = { token?: string | null; env?: Env; headers?: Record<string, string> };

// Raw JSON-RPC POST to /mcp; returns the HTTP response (body unread).
export async function rpcRaw(method: string, params: unknown, opts: RpcOptions = {}): Promise<Response> {
  const { ctx, settle } = testCtx();
  const token = opts.token === undefined ? TOKEN : opts.token;
  const req = new Request('https://test.example/mcp', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const res = await handleMcpRequest(req, opts.env ?? env, ctx);
  await settle();
  return res;
}

export async function callTool(name: string, args: unknown, opts: RpcOptions = {}): Promise<CallResult> {
  const res = await rpcRaw('tools/call', { name, arguments: args }, opts);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from /mcp`);
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  const texts = (body.result.content as Array<{ text: string }>).map((c) => c.text);
  let json: any = null;
  try {
    json = JSON.parse(texts[0]);
  } catch {
    json = null;
  }
  return { isError: !!body.result.isError, texts, json };
}

// Call and assert success; returns parsed JSON of the first text block.
export async function ok(name: string, args: unknown): Promise<any> {
  const r = await callTool(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.texts.join('\n')}`);
  return r.json;
}

export async function resetAuthData(): Promise<void> {
  await admin`TRUNCATE mcp_call_log, mcp_token, mcp_auth_code, mcp_credential, mcp_client CASCADE`;
}

export async function resetJournalData(): Promise<void> {
  await admin`TRUNCATE journal_entry CASCADE`;
}

// A journal entry with synthetic text: processed and embedded unless a
// status / null vector says otherwise.
export async function seedJournalEntry(o: {
  vector: number[] | null;
  tags?: string[];
  scope?: 'personal' | 'family';
  primaryType?: string;
  status?: string;
  summary?: string;
  fullText?: string;
  createdAt?: string;
}): Promise<string> {
  const rows = await admin<Array<{ id: string }>>`
    INSERT INTO journal_entry (
      user_id, channel, created_at, updated_at, stitch_window_start, stitch_window_end,
      full_text, processing_status, clean_text, summary, tags, primary_type, embedding, scope
    ) VALUES (
      ${USER}, 'test', COALESCE(${o.createdAt ?? null}::timestamptz, now()), now(), now(), now(),
      ${o.fullText ?? 'synthetic entry'}, ${o.status ?? 'processed'},
      ${o.status && o.status !== 'processed' ? null : (o.fullText ?? 'synthetic entry')},
      ${o.status && o.status !== 'processed' ? null : (o.summary ?? 'synthetic')},
      ${o.tags ?? null}, ${o.primaryType ?? null}, ${o.vector ? vecLiteral(o.vector) : null}::vector, ${o.scope ?? 'personal'}
    )
    RETURNING id
  `;
  return rows[0].id;
}

export async function resetGoalData(): Promise<void> {
  await admin`
    TRUNCATE editorial_pick, undertaking_cycles, undertakings, goal_amendments, goals,
             constitution_amendments, constitution_domains CASCADE
  `;
}

// Synthetic constitution domain → goal → undertaking → active cycle.
export async function seedUndertaking(): Promise<{ domainId: string; goalId: string; undertakingId: string; cycleId: string }> {
  const [d] = await admin<Array<{ id: string }>>`
    INSERT INTO constitution_domains (user_id, label, statement, crisis_origin)
    VALUES (${USER}, 'Domain', 'Synthetic statement', 'Synthetic origin') RETURNING id
  `;
  const [g] = await admin<Array<{ id: string }>>`
    INSERT INTO goals (user_id, constitution_domain_id, statement, specific, measurable, achievable, relevant, time_bound, outcome_metric)
    VALUES (${USER}, ${d.id}, 'Goal', 's', 'm', 'a', 'r', 't', 'metric') RETURNING id
  `;
  const [u] = await admin<Array<{ id: string }>>`
    INSERT INTO undertakings (user_id, name, purpose, output_target, test_criteria, primary_goal_id, kind)
    VALUES (${USER}, 'Undertaking', 'p', 'o', 'c', ${g.id}, 'habit_forming') RETURNING id
  `;
  const [c] = await admin<Array<{ id: string }>>`
    INSERT INTO undertaking_cycles (undertaking_id, cycle_number, start_date, end_date)
    VALUES (${u.id}, 1, '2026-01-01', '2026-01-31') RETURNING id
  `;
  return { domainId: d.id, goalId: g.id, undertakingId: u.id, cycleId: c.id };
}

export async function resetIdeaData(): Promise<void> {
  await admin`TRUNCATE idea, idea_source, idea_link, public_artifact, task_ref, project_ref CASCADE`;
}

// ── vectors with a controlled cosine ─────────────────────────────────

const DIM = 1536;

export function axis(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[i] = 1;
  return v;
}

// Unit vector whose cosine with axis(i) is `cos` (and with axis(j) is sqrt(1-cos²)).
export function mix(i: number, j: number, cos: number): number[] {
  const v = new Array(DIM).fill(0);
  v[i] = cos;
  v[j] = Math.sqrt(1 - cos * cos);
  return v;
}

export const vecLiteral = (v: number[]) => `[${v.join(',')}]`;

export async function setEmbedding(ideaId: string, v: number[]): Promise<void> {
  await admin`
    UPDATE idea SET embedding = ${vecLiteral(v)}::vector,
                    embedding_model = 'test', embedded_at = now()
     WHERE id = ${ideaId}
  `;
}

export async function seedIdea(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await ok('park_idea', { title, ...extra });
  return r.idea_id as string;
}

export async function seedArtifact(title: string, v: number[] | null, publishedAt = '2026-06-01T00:00:00Z'): Promise<string> {
  const rows = await admin<Array<{ id: string }>>`
    INSERT INTO public_artifact (
      user_id, type, title, status, raw_source, source_system, source_external_id,
      processing_status, published_at, canonical_url, embedding
    ) VALUES (
      'default', 'transcript', ${title}, 'published', 'raw', 'youtube', ${title},
      'processed', ${publishedAt}, ${`https://example.com/${encodeURIComponent(title)}`},
      ${v ? vecLiteral(v) : null}::vector
    )
    RETURNING id
  `;
  return rows[0].id;
}

export async function seedSubjects(
  tasks: Array<{ id: string; title: string; notes?: string; status?: string; parent?: string; scope?: string }>,
): Promise<void> {
  const list = await admin<Array<{ id: string }>>`
    INSERT INTO project_ref (user_id, external_list_id, name, list_type)
    VALUES ('default', 'list-subjects', 'Subjects', 'subjects')
    ON CONFLICT (external_system, external_list_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const other = await admin<Array<{ id: string }>>`
    INSERT INTO project_ref (user_id, external_list_id, name, list_type)
    VALUES ('default', 'list-do', 'Do', 'do')
    ON CONFLICT (external_system, external_list_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  for (const t of tasks) {
    await admin`
      INSERT INTO task_ref (
        user_id, external_task_id, external_list_id, project_ref_id, title, notes, status,
        parent_external_task_id, scope
      ) VALUES (
        'default', ${t.id}, 'list-subjects', ${list[0].id}, ${t.title}, ${t.notes ?? null},
        ${t.status ?? 'needsAction'}, ${t.parent ?? null}, ${t.scope ?? 'personal'}
      )
    `;
  }
  // A task on another list must never show up.
  await admin`
    INSERT INTO task_ref (user_id, external_task_id, external_list_id, project_ref_id, title)
    VALUES ('default', ${`do-${tasks.length}-${Date.now()}`}, 'list-do', ${other[0].id}, 'Buy milk')
  `;
}

// ── whole-Worker requests (OAuth, console) ────────────────────────────

export const BASE = 'https://test.example';

export async function workerFetch(
  path: string,
  init: RequestInit = {},
  opts: { env?: Env } = {},
): Promise<Response> {
  const { default: worker } = await import('../../src/index');
  const { ctx, settle } = testCtx();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), opts.env ?? env, ctx);
  await settle();
  return res;
}

export function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: new URLSearchParams(fields).toString(),
  };
}

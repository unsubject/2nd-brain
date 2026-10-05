// DB-backed test for the MCP auth-data retention job (src/mcp/retention.ts).
// Gated on TEST_DATABASE_URL: a local *_test database with all migrations
// applied (run the mcp-worker vitest suite once, or `npm run migrate`).
// Truncates only the mcp_* tables: root test files run in parallel.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { callLogRetentionDays, pruneMcpAuthData } from "../src/mcp/retention";

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "TEST_DATABASE_URL not set" : false;

let db: Pool;

before(async () => {
  if (!url) return;
  db = new Pool({ connectionString: url, max: 2 });
  const { rows } = await db.query("SELECT current_database() AS db, host(inet_server_addr()) AS addr");
  const addr: string | null = rows[0].addr;
  const local =
    addr === null ||
    /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(addr) ||
    addr === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(addr);
  if (!String(rows[0].db).endsWith("_test") || !local) {
    await db.end();
    throw new Error(`Refusing to run against ${rows[0].db}@${addr}: needs a local *_test database`);
  }
});

after(async () => {
  await db?.end();
});

beforeEach(async () => {
  if (!url) return;
  await db.query("TRUNCATE mcp_call_log, mcp_token, mcp_auth_code, mcp_credential, mcp_client CASCADE");
});

let n = 0;
const hash = () => createHash("sha256").update(`token-${++n}`).digest("hex");

async function credential(label: string, revokedAgo: string | null): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO mcp_credential (user_id, label, kind, revoked_at, revoked_reason)
     VALUES ('test-user', $1, 'pat', now() - $2::interval, CASE WHEN $2::interval IS NULL THEN NULL ELSE 'owner' END)
     RETURNING id`,
    [label, revokedAgo],
  );
  return rows[0].id;
}

async function token(credentialId: string, kind: string, extra: { expiresIn?: string; rotatedAgo?: string } = {}): Promise<string> {
  const h = hash();
  await db.query(
    `INSERT INTO mcp_token (token_hash, credential_id, kind, expires_at, rotated_at)
     VALUES ($1, $2, $3, now() + $4::interval, now() - $5::interval)`,
    [h, credentialId, kind, extra.expiresIn ?? (kind === "pat" ? null : "1 hour"), extra.rotatedAgo ?? null],
  );
  return h;
}

test("retention days: default 90, floor at 7", () => {
  assert.equal(callLogRetentionDays(undefined), 90);
  assert.equal(callLogRetentionDays(""), 90);
  assert.equal(callLogRetentionDays("30"), 30);
  assert.equal(callLogRetentionDays("45.7"), 45);
  assert.equal(callLogRetentionDays("3"), 7);
  assert.equal(callLogRetentionDays("0"), 7);
  assert.equal(callLogRetentionDays("-5"), 7);
  assert.equal(callLogRetentionDays("abc"), 90);
});

test("prunes old call log and stale auth rows, keeps live ones", { skip }, async () => {
  const live = await credential("Live", null);
  const oldRevoked = await credential("Old revoked", "2 days");
  const newRevoked = await credential("New revoked", "1 hour");
  const livePat = await token(live, "pat");
  await token(oldRevoked, "pat");
  const newRevokedPat = await token(newRevoked, "pat");
  await token(live, "access", { expiresIn: "-2 days" });
  const liveAccess = await token(live, "access");
  await token(live, "refresh", { expiresIn: "80 days", rotatedAgo: "2 days" });
  const recentlyRotated = await token(live, "refresh", { expiresIn: "80 days", rotatedAgo: "1 hour" });
  const liveRefresh = await token(live, "refresh", { expiresIn: "90 days" });

  await db.query(`
    INSERT INTO mcp_client (client_id, created_at, last_authorized_at) VALUES
      ('stale', now() - interval '8 days', NULL),
      ('fresh', now() - interval '1 day', NULL),
      ('used', now() - interval '30 days', now())`);
  await db.query(`
    INSERT INTO mcp_auth_code (code_hash, client_id, redirect_uri, code_challenge, scope, label, expires_at) VALUES
      ($1, 'used', 'http://127.0.0.1/cb', $3, 'mcp', 'x', now() - interval '2 days'),
      ($2, 'used', 'http://127.0.0.1/cb', $3, 'mcp', 'x', now() + interval '5 minutes')`,
    [hash(), hash(), "a".repeat(43)]);
  await db.query(`
    INSERT INTO mcp_call_log (credential_id, label, method, ok, at)
    SELECT $1::uuid, 'Live', 'tools/call', true, now() - interval '100 days' FROM generate_series(1, 7)
    UNION ALL
    SELECT $1::uuid, 'Live', 'tools/call', true, now() - interval '10 days' FROM generate_series(1, 3)`,
    [live]);

  const r = await pruneMcpAuthData({ db, callLogDays: 90, batchSize: 2 });
  assert.deepEqual(r, { callLog: 7, expiredTokens: 1, rotatedTokens: 1, revokedTokens: 1, authCodes: 1, clients: 1 });

  const tokens = (await db.query("SELECT token_hash FROM mcp_token")).rows.map((x) => x.token_hash).sort();
  assert.deepEqual(tokens, [livePat, newRevokedPat, liveAccess, recentlyRotated, liveRefresh].sort());
  assert.equal((await db.query("SELECT 1 FROM mcp_credential")).rowCount, 3);
  assert.deepEqual((await db.query("SELECT client_id FROM mcp_client ORDER BY 1")).rows.map((x) => x.client_id), ["fresh", "used"]);
  assert.equal((await db.query("SELECT 1 FROM mcp_call_log")).rowCount, 3);
  assert.equal((await db.query("SELECT 1 FROM mcp_auth_code")).rowCount, 1);

  // Idempotent.
  assert.deepEqual(await pruneMcpAuthData({ db, callLogDays: 90 }), {
    callLog: 0, expiredTokens: 0, rotatedTokens: 0, revokedTokens: 0, authCodes: 0, clients: 0,
  });
});

test("never prunes the call log below 7 days", { skip }, async () => {
  const live = await credential("Live", null);
  await db.query(
    `INSERT INTO mcp_call_log (credential_id, label, method, ok, at) VALUES ($1, 'Live', 'tools/call', true, now() - interval '5 days')`,
    [live],
  );
  const r = await pruneMcpAuthData({ db, callLogDays: 1 });
  assert.equal(r.callLog, 0);
  assert.equal((await db.query("SELECT 1 FROM mcp_call_log")).rowCount, 1);
});

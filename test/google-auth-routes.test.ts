// /auth/google: only the owner (OWNER_SECRET) can start a Google connection,
// and the callback only accepts the signed, short-lived state it issued.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { STATE_TTL_MS, googleAuthRoutes, secretMatches, signState, verifyState } from "../src/google/routes";

const SECRET = "test-owner-secret-0123456789abcdef";

test("secretMatches", () => {
  assert.equal(secretMatches(SECRET, SECRET), true);
  assert.equal(secretMatches(SECRET + "x", SECRET), false);
  assert.equal(secretMatches("", SECRET), false);
  assert.equal(secretMatches(undefined, SECRET), false);
  assert.equal(secretMatches(["a"], SECRET), false);
  assert.equal(secretMatches(SECRET, undefined), false);
  assert.equal(secretMatches(SECRET, ""), false);
});

test("signState / verifyState", () => {
  const t = 1_800_000_000_000;
  const state = signState(SECRET, t);
  assert.equal(verifyState(state, SECRET, t), true);
  assert.equal(verifyState(state, SECRET, t + STATE_TTL_MS), true);
  assert.equal(verifyState(state, SECRET, t + STATE_TTL_MS + 1), false, "expired");
  assert.equal(verifyState(state, SECRET, t - 1), false, "issued in the future");
  assert.equal(verifyState(state, "another-secret", t), false, "wrong secret");
  const [issued, nonce, sig] = state.split(".");
  assert.equal(verifyState(`${Number(issued) + 1}.${nonce}.${sig}`, SECRET, t + 5), false, "tampered time");
  assert.equal(verifyState(`${issued}.${nonce}x.${sig}`, SECRET, t), false, "tampered nonce");
  assert.equal(verifyState(`${issued}.${nonce}.${sig.slice(0, -1)}`, SECRET, t), false, "short signature");
  for (const bad of [undefined, "", "a.b", "a.b.c.d", ["x"], `${issued}.${nonce}.${sig}`.repeat(4)]) {
    assert.equal(verifyState(bad, SECRET, t), false);
  }
  assert.notEqual(signState(SECRET, t), signState(SECRET, t), "nonce differs per call");
});

type Started = { base: string; server: Server; codes: string[]; clock: { now: number } };

async function start(secret: string | undefined, handleCallback?: (code: string) => Promise<void>): Promise<Started> {
  const codes: string[] = [];
  const clock = { now: 1_800_000_000_000 };
  const app = express();
  app.use(
    googleAuthRoutes({
      secret,
      getAuthUrl: (state) => `https://accounts.example.test/o/oauth2/auth?state=${encodeURIComponent(state)}`,
      handleCallback: handleCallback ?? (async (code) => void codes.push(code)),
      now: () => clock.now,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server, codes, clock };
}

const post = (url: string, secret: string) =>
  fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret }).toString(),
  });

let configured: Started;
let unconfigured: Started;
let failing: Started;

before(async () => {
  configured = await start(SECRET);
  unconfigured = await start(undefined);
  failing = await start(SECRET, async () => {
    const err = new Error("invalid_grant") as Error & Record<string, unknown>;
    err.config = { data: { refresh_token: "1//must-not-be-logged" } };
    err.response = { status: 400, data: { error: "invalid_grant" } };
    throw err;
  });
});

after(() => {
  for (const s of [configured, unconfigured, failing]) s?.server.close();
});

test("without OWNER_SECRET every route refuses with 503", async () => {
  const get = await fetch(`${unconfigured.base}/auth/google`);
  assert.equal(get.status, 503);
  assert.match(await get.text(), /OWNER_SECRET/);
  assert.equal((await post(`${unconfigured.base}/auth/google`, "anything")).status, 503);
  const cb = await fetch(`${unconfigured.base}/auth/google/callback?code=c&state=s`);
  assert.equal(cb.status, 503);
});

test("GET shows the owner form, never cached or framed", async () => {
  const res = await fetch(`${configured.base}/auth/google`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const html = await res.text();
  assert.match(html, /<form method="post" action="\/auth\/google">/);
  assert.match(html, /type="password" name="secret"/);
});

test("a wrong secret is refused and does not redirect", async () => {
  const res = await post(`${configured.base}/auth/google`, "wrong");
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("location"), null);
  assert.match(await res.text(), /not right/);
});

test("the right secret redirects to Google with a state the callback accepts", async () => {
  const res = await post(`${configured.base}/auth/google`, SECRET);
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin, "https://accounts.example.test");
  const state = location.searchParams.get("state")!;
  assert.equal(verifyState(state, SECRET, configured.clock.now), true);

  const cb = await fetch(`${configured.base}/auth/google/callback?code=the-code&state=${encodeURIComponent(state)}`);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /connected/);
  assert.deepEqual(configured.codes, ["the-code"]);
});

test("the callback rejects missing, forged and expired state, and Google errors", async () => {
  const valid = signState(SECRET, configured.clock.now);
  const forged = signState("attacker-guess", configured.clock.now);
  const expired = signState(SECRET, configured.clock.now - STATE_TTL_MS - 1);
  const cases: Array<[string, number]> = [
    ["code=c", 400],
    [`code=c&state=${encodeURIComponent(forged)}`, 400],
    [`code=c&state=${encodeURIComponent(expired)}`, 400],
    [`state=${encodeURIComponent(valid)}`, 400],
    [`error=access_denied&state=${encodeURIComponent(valid)}`, 400],
  ];
  const before = configured.codes.length;
  for (const [query, status] of cases) {
    const res = await fetch(`${configured.base}/auth/google/callback?${query}`);
    assert.equal(res.status, status, query);
  }
  assert.equal(configured.codes.length, before, "handleCallback never ran");
});

test("a failing token exchange answers 500 and logs no request data", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  const state = signState(SECRET, failing.clock.now);
  const res = await fetch(`${failing.base}/auth/google/callback?code=c&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 500);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /invalid_grant \(HTTP 400: invalid_grant\)/);
  assert.ok(!logged[0].includes("must-not-be-logged"));
});

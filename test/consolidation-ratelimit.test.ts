// Pacing and quota retries for the archive collectors' Google API calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, isRateLimitError, unlimited } from "../src/archive/consolidation/ratelimit";

// The error the first Gmail run hit, shaped like a GaxiosError.
const quota = () =>
  Object.assign(
    new Error(
      "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'"
    ),
    { code: 403, status: 403, response: { status: 403 } }
  );

function fakeTime() {
  const clock = { t: 0 };
  const sleeps: number[] = [];
  return {
    clock,
    sleeps,
    // Yield first, as a real timer would, so other workers' pending
    // callbacks run before the clock moves on.
    sleep: async (ms: number) => {
      await new Promise((resolve) => setImmediate(resolve));
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
  };
}

test("isRateLimitError recognises quota and rate errors only", () => {
  assert.equal(isRateLimitError(quota()), true);
  assert.equal(isRateLimitError({ code: 429, message: "Too many concurrent requests for user" }), true);
  assert.equal(isRateLimitError({ code: 403, errors: [{ reason: "userRateLimitExceeded" }], message: "x" }), true);
  assert.equal(isRateLimitError({ code: "403", errors: [{ reason: "rateLimitExceeded" }] }), true);
  // A missing scope is a 403 too, but retrying can't fix it.
  assert.equal(
    isRateLimitError({
      code: 403,
      errors: [{ reason: "insufficientPermissions" }],
      message: "Request had insufficient authentication scopes.",
    }),
    false
  );
  assert.equal(isRateLimitError({ code: 500, message: "Backend Error" }), false);
  assert.equal(isRateLimitError(new Error("Quota exceeded")), false);
  assert.equal(isRateLimitError(null), false);
});

test("RateLimiter pauses, slows down and retries after a quota error", async () => {
  const time = fakeTime();
  const pauses: number[] = [];
  const limiter = new RateLimiter({
    minIntervalMs: 100,
    maxIntervalMs: 400,
    retries: 3,
    basePauseMs: 1000,
    maxPauseMs: 3000,
    onLimited: (ms) => pauses.push(ms),
    sleep: time.sleep,
    now: time.now,
  });
  let calls = 0;
  const result = await limiter.run(async () => {
    calls += 1;
    if (calls <= 2) throw quota();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [1000, 2000]);
  assert.deepEqual(time.sleeps, [1000, 2000]);
  assert.equal(limiter.currentIntervalMs, 400);

  // Later calls keep the slower pace.
  await limiter.run(async () => "next");
  assert.deepEqual(time.sleeps, [1000, 2000, 400]);
});

test("RateLimiter gives up after its retries and passes other errors straight through", async () => {
  const time = fakeTime();
  const pauses: number[] = [];
  const limiter = new RateLimiter({
    minIntervalMs: 0,
    maxIntervalMs: 50,
    retries: 3,
    basePauseMs: 1000,
    maxPauseMs: 3000,
    onLimited: (ms) => pauses.push(ms),
    sleep: time.sleep,
    now: time.now,
  });
  let calls = 0;
  await assert.rejects(
    limiter.run(async () => {
      calls += 1;
      throw quota();
    }),
    /Quota exceeded/
  );
  assert.equal(calls, 4);
  assert.deepEqual(pauses, [1000, 2000, 3000]);

  calls = 0;
  await assert.rejects(
    limiter.run(async () => {
      calls += 1;
      throw new Error("Request had insufficient authentication scopes.");
    }),
    /insufficient/
  );
  assert.equal(calls, 1);
  assert.equal(pauses.length, 3);
});

test("RateLimiter counts one pause when several in-flight calls hit the same limit", async () => {
  const time = fakeTime();
  const pauses: number[] = [];
  const limiter = new RateLimiter({
    minIntervalMs: 100,
    maxIntervalMs: 10_000,
    retries: 3,
    basePauseMs: 1000,
    maxPauseMs: 3000,
    onLimited: (ms) => pauses.push(ms),
    sleep: time.sleep,
    now: time.now,
  });
  let limited = true;
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let bothWaiting!: () => void;
  const ready = new Promise<void>((resolve) => (bothWaiting = resolve));
  const call = async () => {
    if (!limited) return "ok";
    if (++waiting === 2) bothWaiting();
    await gate;
    throw quota();
  };
  const a = limiter.run(call);
  const b = limiter.run(call);
  await ready;
  limited = false;
  release();
  assert.deepEqual(await Promise.all([a, b]), ["ok", "ok"]);
  assert.deepEqual(pauses, [1000]);
  assert.equal(limiter.currentIntervalMs, 200);
});

test("unlimited runs the call as is", async () => {
  assert.equal(await unlimited.run(async () => 42), 42);
});

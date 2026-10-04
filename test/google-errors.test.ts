// describeGoogleError must never let the token request inside a GaxiosError
// (config.data / config.body carry the refresh token) reach the logs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeGoogleError } from "../src/google/errors";

const FAKE_REFRESH = "1//fake-refresh-token-for-tests";
const FAKE_CLIENT = "000000000000-fake.apps.googleusercontent.com";

function gaxiosLike(): Error & Record<string, unknown> {
  const params = new URLSearchParams({ refresh_token: FAKE_REFRESH, client_id: FAKE_CLIENT, grant_type: "refresh_token" });
  const err = new Error("deleted_client") as Error & Record<string, unknown>;
  err.config = { method: "POST", url: new URL("https://oauth2.googleapis.com/token"), data: params, body: params, headers: { "x-test": "1" } };
  err.response = {
    status: 401,
    statusText: "Unauthorized",
    config: err.config,
    data: { error: "deleted_client", error_description: "The OAuth client was deleted." },
  };
  err.status = 401;
  return err;
}

test("keeps the message, status and Google's error, drops the request", () => {
  const out = describeGoogleError(gaxiosLike());
  assert.equal(out, "deleted_client (HTTP 401: deleted_client — The OAuth client was deleted.)");
  assert.ok(!out.includes(FAKE_REFRESH));
  assert.ok(!out.includes(FAKE_CLIENT));
  assert.ok(!out.includes("oauth2.googleapis.com"));
});

test("handles Google API errors in the nested {error: {status, message}} form", () => {
  const err = new Error("Request failed") as Error & Record<string, unknown>;
  err.config = { data: { refresh_token: FAKE_REFRESH } };
  err.response = { status: 403, data: { error: { code: 403, status: "PERMISSION_DENIED", message: "Insufficient scopes" } } };
  const out = describeGoogleError(err);
  assert.equal(out, "Request failed (HTTP 403: PERMISSION_DENIED — Insufficient scopes)");
  assert.ok(!out.includes(FAKE_REFRESH));
});

test("an error with a config but no response still omits the config", () => {
  const err = new Error("socket hang up") as Error & Record<string, unknown>;
  err.config = { data: { refresh_token: FAKE_REFRESH } };
  err.code = "ECONNRESET";
  assert.equal(describeGoogleError(err), "socket hang up (HTTP ECONNRESET)");
});

test("plain errors keep their stack; other values are stringified", () => {
  const plain = new Error("Not authenticated");
  assert.equal(describeGoogleError(plain), plain.stack);
  assert.equal(describeGoogleError("boom"), "boom");
  assert.equal(describeGoogleError(null), "null");
  assert.equal(describeGoogleError(undefined), "undefined");
});

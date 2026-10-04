// Owner-only Google account connection (/auth/google).
//
// Connecting stores a refresh token for user "default" that every Google
// sync then uses, so starting the flow must be restricted to the owner:
// otherwise anyone who knows the URL could link their own Google account
// in place of the owner's. The owner proves who they are with OWNER_SECRET
// (the same value as the MCP Worker's) in a POSTed form — never in the URL,
// which would end up in proxy logs — and the round trip through Google
// carries a signed, short-lived `state` that the callback verifies and that
// can be used once: only states this process issued, and not yet redeemed.

import express, { type Request, type Response, type Router } from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { describeGoogleError } from "./errors";

export const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_CONTEXT = "google-connect";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison; false for empty or missing values. */
export function secretMatches(given: unknown, secret: string | undefined): boolean {
  if (typeof given !== "string" || given === "" || !secret) return false;
  return timingSafeEqual(sha256(given), sha256(secret));
}

const mac = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(`${STATE_CONTEXT}|${payload}`).digest("base64url");

/** `<issued-at ms>.<nonce>.<hmac>`, verifiable without server-side storage. */
export function signState(secret: string, now = Date.now()): string {
  const payload = `${now}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${mac(secret, payload)}`;
}

export function verifyState(state: unknown, secret: string | undefined, now = Date.now()): boolean {
  if (typeof state !== "string" || !secret || state.length > 200) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [issued, nonce, sig] = parts;
  if (!/^\d{1,15}$/.test(issued) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
  const age = now - Number(issued);
  if (age < 0 || age > STATE_TTL_MS) return false;
  const expected = Buffer.from(mac(secret, `${issued}.${nonce}`));
  const actual = Buffer.from(sig);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Chromium applies form-action to every redirect after a form submit, so the
// owner form must also allow Google's origin or the 303 to Google is blocked.
export const GOOGLE_AUTH_ORIGIN = "https://accounts.google.com";

function page(res: Response, status: number, title: string, body: string, formAction = "'self'"): void {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`,
    })
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}` +
        `input,button{font:inherit;padding:.4rem .6rem}input{width:100%;box-sizing:border-box;margin:.5rem 0}</style></head>` +
        `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    );
}

const form = (notice = "") =>
  `${notice ? `<p><strong>${escapeHtml(notice)}</strong></p>` : ""}` +
  `<p>Connecting replaces the Google account that 2nd-brain syncs Tasks, Contacts, Calendar and Gmail from.</p>` +
  `<form method="post" action="/auth/google"><label>Owner secret<input type="password" name="secret" autocomplete="current-password" required autofocus></label>` +
  `<button type="submit">Continue to Google</button></form>`;

export type GoogleAuthRouteOptions = {
  /** OWNER_SECRET; when unset the routes refuse to start a connection. */
  secret: string | undefined;
  getAuthUrl: (state: string) => string;
  handleCallback: (code: string) => Promise<void>;
  now?: () => number;
  /** Origin of the URLs getAuthUrl returns (tests point it elsewhere). */
  authOrigin?: string;
};

export function googleAuthRoutes(opts: GoogleAuthRouteOptions): Router {
  const router = express.Router();
  const now = opts.now ?? Date.now;
  const formAction = `'self' ${new URL(opts.authOrigin ?? GOOGLE_AUTH_ORIGIN).origin}`;
  // nonce → expiry of states this process issued and that are still unused.
  // One Node process serves these routes; a restart mid-flow just means
  // starting again.
  const issued = new Map<string, number>();
  const prune = (t: number) => {
    for (const [nonce, expires] of issued) if (expires < t) issued.delete(nonce);
  };
  const ownerForm = (res: Response, status: number, notice?: string) =>
    page(res, status, "Connect Google", form(notice), formAction);
  const notConfigured = (res: Response) =>
    page(res, 503, "Google connection disabled", "<p>Set <code>OWNER_SECRET</code> on this service to connect a Google account.</p>");

  router.get("/auth/google", (_req: Request, res: Response) => {
    if (!opts.secret) return notConfigured(res);
    ownerForm(res, 200);
  });

  router.post("/auth/google", express.urlencoded({ extended: false, limit: "2kb" }), (req: Request, res: Response) => {
    if (!opts.secret) return notConfigured(res);
    if (!secretMatches(req.body?.secret, opts.secret)) {
      return ownerForm(res, 403, "That secret is not right.");
    }
    const t = now();
    prune(t);
    const state = signState(opts.secret, t);
    issued.set(state.split(".")[1], t + STATE_TTL_MS);
    res.set("Cache-Control", "no-store").redirect(303, opts.getAuthUrl(state));
  });

  router.get("/auth/google/callback", async (req: Request, res: Response) => {
    if (!opts.secret) return notConfigured(res);
    if (typeof req.query.error === "string") {
      return page(res, 400, "Google connection cancelled", "<p>Google did not grant access. Nothing was changed.</p>");
    }
    // Single use: a state is redeemed (deleted) on its first valid callback.
    if (!verifyState(req.query.state, opts.secret, now()) || !issued.delete(String(req.query.state).split(".")[1])) {
      return page(res, 400, "Link expired or invalid", '<p>Start again from <a href="/auth/google">/auth/google</a>.</p>');
    }
    const code = req.query.code;
    if (typeof code !== "string" || code === "") {
      return page(res, 400, "Missing authorization code", '<p>Start again from <a href="/auth/google">/auth/google</a>.</p>');
    }
    try {
      await opts.handleCallback(code);
      page(res, 200, "Google account connected", "<p>You can close this tab. The next sync runs within 30 minutes.</p>");
    } catch (err) {
      console.error("Google OAuth callback error:", describeGoogleError(err));
      page(res, 500, "Google connection failed", "<p>Check the service logs, then start again.</p>");
    }
  });

  // Malformed or oversized form bodies: a plain page, not Express's default
  // error page (which includes a stack trace outside production mode).
  router.use((err: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    const e = err as { type?: unknown; status?: unknown };
    if (typeof e?.type === "string" && typeof e.status === "number" && e.status >= 400 && e.status < 500) {
      return ownerForm(res, e.status, "Request rejected.");
    }
    next(err);
  });

  return router;
}

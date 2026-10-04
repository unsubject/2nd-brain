// HTML for the OAuth consent step. Everything client-supplied is escaped
// and shown as untrusted; the trusted facts (client family, redirect host)
// are derived from the redirect URI on the server.

import { escapeHtml as e, htmlPage, PAGE_STYLE } from '../http';

export type AuthorizeParams = {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string;
};

export function hiddenFields(p: AuthorizeParams): string {
  return (Object.keys(p) as Array<keyof AuthorizeParams>)
    .map((k) => `<input type="hidden" name="${k}" value="${e(p[k])}">`)
    .join('\n  ');
}

export function consentPage(opts: {
  params: AuthorizeParams;
  familyName: string;
  redirectHost: string;
  clientName: string | null;
  label: string;
  replace: boolean;
  error?: string;
  status?: number;
}): Response {
  const { params, familyName, redirectHost, clientName, label } = opts;
  const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to 2nd-brain</title><style>${PAGE_STYLE}</style></head><body>
<h1>Connect ${e(familyName)} to your 2nd-brain?</h1>
<p>After you approve, you'll be sent back to <strong>${e(redirectHost)}</strong>.
${clientName ? `The client calls itself <q>${e(clientName)}</q> (unverified).` : ''}</p>
<div class="warn">Only approve if you just clicked <em>Connect</em> in ${e(familyName)} yourself.
The connected agent gets full access to your journal, goals and Idea Parking Lot.
You can revoke it any time at <code>/tokens</code>.</div>
${opts.error ? `<div class="error">${e(opts.error)}</div>` : ''}
<form method="post" action="/authorize">
  ${hiddenFields(params)}
  <input type="hidden" name="decision" value="approve">
  <label for="label">Name this connection</label>
  <input id="label" type="text" name="label" value="${e(label)}" maxlength="80" required>
  <div class="muted">Shown in /tokens and recorded on everything this agent writes. If the name is already in use, a number is added.</div>
  <label class="check"><input type="checkbox" name="replace" value="on"${opts.replace ? ' checked' : ''}>
    Reconnecting? Replace (revoke) my existing OAuth connection with exactly this name.</label>
  <label for="owner_secret">Owner secret</label>
  <input id="owner_secret" type="password" name="owner_secret" autofocus required autocomplete="off">
  <button type="submit">Approve</button>
</form>
<form method="post" action="/authorize">
  ${hiddenFields(params)}
  <input type="hidden" name="decision" value="deny">
  <button type="submit" class="secondary">Deny</button>
</form>
</body></html>`;
  return htmlPage(body, opts.status ?? 200);
}

export function oauthErrorPage(title: string, detail: string, status = 400): Response {
  const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>2nd-brain — ${e(title)}</title><style>${PAGE_STYLE}</style></head><body>
<h1>${e(title)}</h1>
<div class="error">${e(detail)}</div>
<p class="muted">Nothing was authorized. Close this window and try connecting again from your AI client.</p>
</body></html>`;
  return htmlPage(body, status);
}

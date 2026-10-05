# Connecting AI clients to 2nd-brain

How to connect each AI client Simon uses to the 2nd-brain MCP server, and how to check that it works. Design: [`phase-mcp-multi-client-spec.md`](phase-mcp-multi-client-spec.md).

> Vendor menus and eligibility rules change often. The steps below were written in October 2026. If a menu has moved, the parts that stay fixed are the **server URL**, **OAuth or bearer token**, and the **smoke checklist** at the end.

## The two things you need

| | |
|---|---|
| **Server URL** | `https://2nd-brain-mcp.simon-lee.workers.dev/mcp` |
| **Owner console** | `https://2nd-brain-mcp.simon-lee.workers.dev/tokens` (sign in with the owner secret) |

**Owner secret.** Set a Worker secret `OWNER_SECRET` (`openssl rand -hex 32`) before you connect anything. It approves connections and signs you in to `/tokens`. The only other place that holds it is the Railway service, which uses the same value to let you connect a Google account (`/auth/google`). Until it is set, the owner secret falls back to `BRAIN_MCP_TOKEN`, and the console shows a warning. That fallback is unsafe because OAuth clients connected before October 2026 received `BRAIN_MCP_TOKEN` itself as their access token.

Every client gets **its own credential**. Each one has a name ("label") that appears in the console and on the call log, and each one can be revoked on its own. Captured ideas, imports, syntheses and link proposals also record the name. Never give a vendor `OWNER_SECRET` or `BRAIN_MCP_TOKEN`. Type the owner secret only on the 2nd-brain consent page and the console login, both served from the `workers.dev` address above, and on the 2nd-brain service's own `/auth/google` page on Railway.

There are two ways a client gets a credential:

- **OAuth.** The client opens a 2nd-brain consent page and you approve it there. Used by Claude, ChatGPT, Cursor, Gemini CLI, Claude Code, Gemini Spark and Meta Muse.
  - The page tells you which client family is asking and where you will be sent back to.
  - You name the connection, type the owner secret, and press **Approve**.
  - When reconnecting a client you already had, tick **Replace** (ticked by default for Claude, ChatGPT and Gemini Spark). The old connection with that exact name is revoked and the new one keeps the name. Otherwise it becomes e.g. `Claude (2)`.
  - The client then receives an access token that lasts 1 hour, plus a refresh token that rotates on every use.
  - Removing or disconnecting a connector inside a client may not tell 2nd-brain. Revoke it in `/tokens` too; otherwise its refresh token stays valid until 90 days after it was last used.
- **Personal access token (PAT).** You create it in `/tokens` → **New personal access token**. Used by scripts, clients set up from a config file, and Meta Muse if it asks for a header instead of signing in.
  - The token (`brain_pat_…`) is shown **once**, together with ready-to-paste snippets.
  - Only a hash of it is stored.

The server speaks both the 2025 protocol versions and MCP 2026-07-28: newer clients skip `initialize` and call `server/discover` instead, and `/tokens` then shows their protocol as `2026-07-28`. Every client sees the same 38 tools. Clients that can't read MCP resources should call the `read_protocol` tool before they capture, garden, map or import ideas, or change goals.

## Claude (claude.ai web, Desktop, mobile)

1. Go to **Settings → Connectors → Add custom connector**.
2. Name it `2nd-brain` and paste the server URL. Leave the advanced OAuth fields empty: Claude registers itself.
3. Click **Connect**. On the 2nd-brain consent page, check that it says **Claude** and `claude.ai`, keep the label `Claude`, type the owner secret, and approve.
4. The connector syncs to Claude Desktop and mobile on the same account. You don't need to set them up again.

**Already connected before October 2026?** That connector still holds the master token. It keeps working while `ALLOW_MASTER_BEARER` is `"true"`. Click **Disconnect → Connect** once so it gets its own credential.

## Claude Code

Use OAuth (recommended):

```bash
claude mcp add --transport http 2nd-brain https://2nd-brain-mcp.simon-lee.workers.dev/mcp
```

Then run `/mcp` → `2nd-brain` → **Authenticate**. A browser opens the consent page ("Local app"); label it e.g. `Claude Code (laptop)`.

Or use a PAT: create one in `/tokens` and use the snippet it shows (`--header "Authorization: Bearer brain_pat_…"`).

## ChatGPT

Custom MCP connectors need a paid plan with **developer mode**. Business, Enterprise and Edu workspaces may need an admin to allow custom connectors.

1. Go to **Settings → Apps & Connectors → Advanced settings** and turn on **Developer mode**.
2. Go to **Settings → Apps & Connectors → Create**. Name it `2nd-brain`, paste the server URL, and choose **OAuth** as the authentication method.
3. Approve on the consent page (label `ChatGPT`).
4. In a chat, enable the connector from the tools menu.

ChatGPT asks for confirmation before any tool that isn't marked read-only. That covers every write tool (`park_idea`, `decide_idea_links`, …), which is intended.

## Cursor

Add this to `~/.cursor/mcp.json` (or to `.cursor/mcp.json` in a project):

```json
{ "mcpServers": { "2nd-brain": { "url": "https://2nd-brain-mcp.simon-lee.workers.dev/mcp" } } }
```

Cursor shows **Needs login**. Click it and approve (label `Cursor`). Cursor registers both its app callback and its Cloud Agents callback (`https://www.cursor.com/agents/mcp/oauth/callback`); both are allowed. If OAuth fails, use the PAT snippet from `/tokens`, which adds a `headers` block.

Cursor allows only about 40 tools across all servers. 2nd-brain uses 38, so disable other servers' tools if you hit the limit.

## Gemini CLI

Add this to `~/.gemini/settings.json`:

```json
{ "mcpServers": { "2nd-brain": { "httpUrl": "https://2nd-brain-mcp.simon-lee.workers.dev/mcp" } } }
```

Gemini CLI finds OAuth from the server's 401 response. If it doesn't open a browser by itself, run `/mcp auth 2nd-brain`. Approve the consent page ("Local app"; label `Gemini CLI`). With a PAT, use the snippet from `/tokens` instead (`headers` block, no login needed).

## Gemini Spark (Google's agent)

Spark connects custom apps only through OAuth. Google's rules for **custom apps** are narrower than for Spark itself. As of October 2026 you need **all** of these:

- You are **18 or older and in the US**.
- You use Gemini **in English**; custom apps are available only in English.
- You use a **personal** Google account, not a Workspace or school account.
- **Keep Activity** is on.
- You have **Spark** itself, through a Google AI Pro or Ultra plan. Spark isn't offered at all in the EEA, the UK, Switzerland or Nigeria.

You add the app once in the Gemini **web app** (gemini.google.com); after that it also works in the Gemini mobile app. If any rule above isn't met, Gemini won't offer custom apps; use Gemini CLI instead. Google changes these rules, so check [its help page](https://support.google.com/gemini/answer/17209137).

These notes come from third-party field reports (July–September 2026), not from Google's documentation. No Spark session has been run against this server yet.

1. On a computer, open gemini.google.com and go to **Settings & help → Connected Apps**. Google's help calls it **Settings → Connected Apps**, and the labels vary.
   1. Under **Custom apps**, click **Add a custom app**.
   2. Paste exactly `https://2nd-brain-mcp.simon-lee.workers.dev/mcp`, with `/mcp` and no trailing slash. The bare domain and `/mcp/` both return 404.
   3. Leave **Advanced features** (client ID and secret) empty, and click **Next**. 2nd-brain doesn't advertise client metadata documents (CIMD), so Spark registers itself through dynamic client registration.
2. Approve the consent page. It shows **Google (Gemini Spark)** with a redirect to `oauth-redirect.googleusercontent.com`. Keep the label `Gemini Spark`.
3. Check that the connection survives the first hour.
   - Spark asks for `offline_access`, and the server always issues a refresh token, so Spark should renew its 1-hour access token by itself. Nobody has published a trace of Spark doing that yet.
   - So use Spark again more than an hour after connecting. The `Gemini Spark` row in `/tokens` should then show **last used just now**, and Workers Logs should show a second `POST /token`.
   - If that call fails, see Troubleshooting.

**What to expect:**

- **Confirmations.** Spark asks you to confirm write actions such as `park_idea` and `decide_idea_links`, and it may ask before every call, reads included.
  - Field notes from July 2026 saw a prompt before every call on a server whose tools had no read-only marks.
  - Ours are marked, but it is unverified whether Spark honours that. This is Spark's own setting; the server can't turn it off.
- **Workers Logs.** Spark runs a fresh `initialize` and `tools/list` on every turn and after each tool call. A tokenless `HEAD /mcp` answered with 401 and a `GET /mcp` answered with 405 are both normal.
- **Disconnecting.**
  1. Open Connected Apps → the app → **More details** → **Disconnect** or **Remove app**.
  2. Revoke `Gemini Spark` in `/tokens`. No source shows Spark telling the server when you remove it.

  Reconnecting with **Replace** ticked revokes the old connection automatically.

**If Spark reports that the redirect isn't allowed,** Google has changed its callback form. The built-in rule accepts only `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-…`, Spark's per-user callback.
- **Stopgap:** add `https://oauth-redirect.googleusercontent.com/r/` to `OAUTH_EXTRA_REDIRECT_PREFIXES` (see Troubleshooting).
- **On the consent page:** it then shows **Custom**, the label defaults to the client's own name, and **Replace** isn't ticked. Name the connection `Gemini Spark` and tick **Replace** yourself.

## Meta Muse (Meta's agent)

You set up Muse by asking it in chat to build a **Custom Connector**. Availability depends on your region; it is US-only as of October 2026. Muse connects with OAuth and registers itself, like Claude; its callback is `https://agent.meta.ai/api/hatch/oauth/callback`.

1. Send Muse this prompt:

   > Create a custom connector called "2nd-brain" for the remote MCP server at https://2nd-brain-mcp.simon-lee.workers.dev/mcp. After connecting, list its tools and call `read_protocol` with `{"name": "idea-parking-lot", "section": "§1"}` and show me the first lines.
   > Rules for using it: the tool descriptions are binding. Never call a tool whose description says "ONLY when the user asks…" unless I asked for exactly that. Ideas are pull-only: never surface them unprompted.

2. Approve the consent page. It shows **Meta (Muse)** with a redirect to `agent.meta.ai`. Keep the label `Meta Muse`; **Replace** is ticked by default.
3. Muse may not support MCP resources. The `read_protocol` tool gives it the same protocol text.

**If Muse asks for an API key or header instead of signing in,** give it a PAT:
1. In `/tokens`, create a PAT named `Meta Muse` and copy it.
2. Store it in Muse's **Secure Credentials Store** as `BRAIN_PAT`. Never paste it into the chat itself.
3. Add to the prompt above: "Authenticate every request with the header `Authorization: Bearer <BRAIN_PAT>`, using the credential I stored as BRAIN_PAT."

**"The provider rejected the automatic app registration"** means `/register` refused Muse's callback, for example because Meta changed it. Workers Logs show the refused callback in a `[register] refused` line; see Troubleshooting.

## Scripts and automation (e.g. socialisn2)

Create a PAT per script (e.g. `socialisn2`) and send `Authorization: Bearer brain_pat_…`. Anything still using the master token shows up in the console's **master token** banner. Move each one to a PAT, then set `ALLOW_MASTER_BEARER` to `"false"`.

## Smoke test

From `mcp-worker/`:

```bash
BRAIN_TOKEN=brain_pat_… npm run smoke                  # discovery, initialize, tools/list, read_protocol, list_ideas
BRAIN_TOKEN=brain_pat_… npm run smoke -- --write       # + parks and composts a "[smoke] …" idea
BRAIN_TOKEN=brain_pat_… npm run smoke -- --expect-401  # after revoking: must be refused
npm run smoke -- --oauth --write --revoke              # whole OAuth flow on a loopback redirect
BRAIN_TOKEN=brain_pat_… npm run smoke -- --modern      # + the MCP 2026-07-28 (stateless) path
```

`BRAIN_MCP_URL` overrides the server URL, for example `http://127.0.0.1:8787/mcp` under `wrangler dev`.

### Per-client checklist

After connecting any client, ask it to do these steps in order:

1. *"Call read_protocol for idea-parking-lot section §1 and quote its first line."* This checks that it reaches the server and can read the rules.
2. *"Park an idea titled '[smoke] <client name>' with thoughts 'test'."* Then: *"Set that idea's status to composted."*
3. Open `/tokens`. The client's row should say **last used just now**. Its **activity** link should list `read_protocol`, `park_idea` and `update_idea`, and the idea's `captured_via.credential` should be the client's label.

Gardening leaves composted ideas out by default, so smoke ideas don't get in the way.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Registration fails with `invalid_redirect_uri` (Muse: **The provider rejected the automatic app registration**), or the consent page says **Redirect not allowed** | The client uses a redirect URI outside the built-in list (Claude, ChatGPT, Cursor, Gemini Spark's `oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-…` callback, Meta Muse's `agent.meta.ai/api/hatch/oauth/callback`, `http://localhost` / `127.0.0.1` / `[::1]`). Unknown URIs are dropped at registration, and registration fails only if none is allowed; Workers Logs then show a `[register] refused` line listing the client's redirect URIs. Add the client's `https://` prefix, ending in `/`, to `OAUTH_EXTRA_REDIRECT_PREFIXES` in `mcp-worker/wrangler.jsonc` `vars` (comma-separated) and deploy. |
| Consent page says **Unknown client** | The client's registration was swept: unapproved registrations are deleted after 7 days. Remove the connector and add it again. |
| Client suddenly says it must re-authenticate | Either its credential was revoked, or it presented a refresh token that had already been used more than 5 minutes earlier. Credentials are revoked when you revoke or replace them in `/tokens`, when the client calls `/revoke`, or when an authorization code is redeemed twice (`code_reuse`). A stale refresh token is refused but revokes nothing; this happens with stale copies held by idle processes. Reconnect if it persists. `/tokens` → **Recently revoked** shows the reason. |
| Gemini Spark says **Automatic registration with this server failed. Please enter the OAuth client ID and client secret…** (reported by third parties) | Spark stopped during discovery or `/register`. Don't fill in the fields: 2nd-brain has no static client. In Workers Logs (Cloudflare dashboard → Workers → 2nd-brain-mcp → Logs, or `npx wrangler tail`), check that `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-authorization-server` returned 200 and `POST /register` returned 201. A `400 invalid_redirect_uri` means Google changed its callback (first row); a `429` is the registration cap (last row). Then add the app again. |
| Gemini Spark shows Google's **500. That's an error.** page after the consent page (reported by third parties) | You pressed **Deny**; Spark shows any `access_denied` this way. Nothing was created, so add the app again. A wrong owner secret doesn't cause this, because the consent page just asks again. If it appears without the consent page ever showing, the server probably refused Spark's request (`invalid_target` or `invalid_request`); check Workers Logs. |
| Gemini Spark says **Account linking is required to use this custom app. Try again.** (reported by third parties) | Google didn't finish the server-to-server code exchange. Reports say a retry often works. Keep **Replace** ticked so you don't end up with `Gemini Spark (2)`. If it repeats, check Workers Logs for `POST /token` and its status, and `/tokens` → **Recently revoked** for `code_reuse`. If the logs show `/authorize` but no `POST /token`, Google never redeemed the code; retry. That case has also been reported as **Cannot Complete Request** on `oauth-redirect.googleusercontent.com`. |
| Gemini Spark's tools disappear, or its calls fail, about an hour after connecting | Spark probably isn't renewing its token. In `/tokens`, the `Gemini Spark` row's **last used** stops about an hour after you connected, and nothing appears under **Recently revoked**. Remove the custom app in Spark and add it again (**Replace** is ticked by default). |
| A client can't connect, and Workers Logs show `404` for `POST /` or `POST /mcp/` | The URL was entered without `/mcp`, or with a trailing slash. Only exactly `…/mcp` is served. Remove the app, revoke anything it got in `/tokens`, and add it again with the exact URL. |
| `401` with `error="invalid_token"` | The token is expired, revoked or unknown. OAuth clients refresh automatically. A PAT that fails was revoked. |
| `503` from `/mcp` | The credential store (Postgres via Hyperdrive) is unreachable. Clients should retry, so don't revoke anything. |
| Client lists no tools or rejects the schema | Run `npm run smoke` to confirm the server works, then check the client's tool limit (Cursor allows about 40). The schemas avoid type arrays and `$ref` on purpose (`test/schema-portability.test.ts`). |
| Client ignores the protocol rules | It probably doesn't read MCP resources. Tell it to call `read_protocol` first. |
| Too many registrations (`429`) | More than 10 registrations from one address, or 200 in total, went unapproved in the last hour. Wait an hour. |

## Retiring the master token

1. Reconnect every client as above, and give every script a PAT.
2. Wait until the console's master-token banner has been empty for a week.
3. Commit `"ALLOW_MASTER_BEARER": "false"` in `mcp-worker/wrangler.jsonc` and deploy.
4. Rotate `BRAIN_MCP_TOKEN` (`openssl rand -hex 32`, set as a Worker secret). With `ALLOW_MASTER_BEARER` off and `OWNER_SECRET` set, nothing uses it any more. Existing OAuth and PAT credentials are not affected.
5. Review the agents list in `/tokens` and revoke anything you don't recognise.

**One risk remains.** Someone could add their own Claude or ChatGPT connector pointing at this server and send you the consent link. The page would truthfully say "Claude". Approve only connections you started yourself, seconds earlier.

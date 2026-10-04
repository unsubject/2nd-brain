# Connecting AI clients to 2nd-brain

How to connect each AI client Simon uses to the 2nd-brain MCP server, and how to check that it works. Design: [`phase-mcp-multi-client-spec.md`](phase-mcp-multi-client-spec.md).

> Vendor menus and eligibility rules change often. The steps below were written in October 2026. If a menu has moved, the parts that stay fixed are the **server URL**, **OAuth or bearer token**, and the **smoke checklist** at the end.

## The two things you need

| | |
|---|---|
| **Server URL** | `https://2nd-brain-mcp.simon-lee.workers.dev/mcp` |
| **Owner console** | `https://2nd-brain-mcp.simon-lee.workers.dev/tokens` (sign in with `BRAIN_MCP_TOKEN`) |

Every client gets **its own credential**. Each one has a name ("label") that appears in the console and is recorded on everything that client writes, and each one can be revoked on its own. Never give a vendor the master `BRAIN_MCP_TOKEN`. It is the owner password: you type it only on the 2nd-brain consent page and the console login, both served from the `workers.dev` address above.

There are two ways a client gets a credential:

- **OAuth.** The client opens a 2nd-brain consent page and you approve it there. Used by Claude, ChatGPT, Cursor, Gemini CLI, Claude Code and Gemini Spark.
  - The page tells you which client family is asking and where you will be sent back to.
  - You name the connection, type the owner secret, and press **Approve**.
  - The client then receives an access token that lasts 1 hour, plus a refresh token that rotates on every use.
- **Personal access token (PAT).** You create it in `/tokens` → **New personal access token**. Used by Meta Muse, scripts, and clients set up from a config file.
  - The token (`brain_pat_…`) is shown **once**, together with ready-to-paste snippets.
  - Only a hash of it is stored.

Every client sees the same 38 tools. Clients that can't read MCP resources should call the `read_protocol` tool before they capture, garden, map or import ideas, or change goals.

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

Cursor shows **Needs login**. Click it and approve (label `Cursor`). If OAuth fails, use the PAT snippet from `/tokens`, which adds a `headers` block.

Cursor allows only about 40 tools across all servers. 2nd-brain uses 38, so disable other servers' tools if you hit the limit.

## Gemini CLI

Add this to `~/.gemini/settings.json`:

```json
{ "mcpServers": { "2nd-brain": { "httpUrl": "https://2nd-brain-mcp.simon-lee.workers.dev/mcp" } } }
```

Gemini CLI finds OAuth from the server's 401 response. If it doesn't open a browser by itself, run `/mcp auth 2nd-brain`. Approve the consent page ("Local app"; label `Gemini CLI`). With a PAT, use the snippet from `/tokens` instead (`headers` block, no login needed).

## Gemini Spark (Google's agent)

Spark connects custom apps only through OAuth. Before you start, check you are eligible:

- You live **outside the EEA, UK and Switzerland**.
- You use a **personal** Google account (not Workspace).
- **Keep Activity** is on.

If any of these fails, Spark won't offer custom apps; use Gemini CLI instead.

1. In Spark, add a **custom app / MCP server** with the server URL. The 2nd-brain server deliberately doesn't advertise client metadata documents (CIMD), so Spark falls back to registering itself.
2. Approve the consent page. It shows **Google (Gemini Spark)**, with a redirect to `oauth-redirect.googleusercontent.com`. Label it `Gemini Spark`.
3. Spark keeps the connection alive with refresh tokens (`offline_access`).

If Spark reports that the redirect isn't allowed, it is using a redirect URI the built-in list doesn't know. Add its prefix to `OAUTH_EXTRA_REDIRECT_PREFIXES` (see Troubleshooting).

## Meta Muse (Meta's agent)

You set up Muse by asking it in chat to build a **Custom Connector**. Availability depends on your region; it is US-only as of October 2026. Muse uses a static bearer token, so give it a PAT.

1. In `/tokens`, create a PAT named `Meta Muse` and copy it.
2. Store it in Muse's **Secure Credentials Store** as `BRAIN_PAT`. Never paste it into the chat itself.
3. Send Muse this prompt:

   > Create a custom connector called "2nd-brain". It is a remote MCP server (Streamable HTTP, JSON responses) at https://2nd-brain-mcp.simon-lee.workers.dev/mcp. Authenticate every request with the header `Authorization: Bearer <BRAIN_PAT>`, using the credential I stored as BRAIN_PAT. After connecting, list its tools and call `read_protocol` with `{"name": "idea-parking-lot", "section": "§1"}` and show me the first lines.
   > Rules for using it: the tool descriptions are binding. Never call a tool whose description says "ONLY when the user asks…" unless I asked for exactly that. Ideas are pull-only: never surface them unprompted.

4. Muse may not support MCP resources. The `read_protocol` tool gives it the same protocol text.

## Scripts and automation (e.g. socialisn2)

Create a PAT per script (e.g. `socialisn2`) and send `Authorization: Bearer brain_pat_…`. Anything still using the master token shows up in the console's **master token** banner. Move each one to a PAT, then set `ALLOW_MASTER_BEARER` to `"false"`.

## Smoke test

From `mcp-worker/`:

```bash
BRAIN_TOKEN=brain_pat_… npm run smoke                  # discovery, initialize, tools/list, read_protocol, list_ideas
BRAIN_TOKEN=brain_pat_… npm run smoke -- --write       # + parks and composts a "[smoke] …" idea
BRAIN_TOKEN=brain_pat_… npm run smoke -- --expect-401  # after revoking: must be refused
npm run smoke -- --oauth --write --revoke              # whole OAuth flow on a loopback redirect
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
| Consent page says **Redirect not allowed** | The client uses a redirect URI outside the built-in list (Claude, ChatGPT, Cursor, Google, `http://localhost` / `127.0.0.1` / `[::1]`). Add its `https://` prefix to `OAUTH_EXTRA_REDIRECT_PREFIXES` in `mcp-worker/wrangler.jsonc` `vars` (comma-separated) and deploy. |
| Consent page says **Unknown client** | The client's registration was swept: unapproved registrations are deleted after 7 days. Remove the connector and add it again. |
| Client suddenly says it must re-authenticate | Its credential was revoked. Possible reasons: you revoked it, the client called `/revoke`, a refresh token was replayed more than 60 seconds after rotation (`refresh_reuse`), or an authorization code was replayed (`code_reuse`). Reconnect. `/tokens` → **Recently revoked** shows the reason. |
| `401` with `error="invalid_token"` | The token is expired, revoked or unknown. OAuth clients refresh automatically. A PAT that fails was revoked. |
| `503` from `/mcp` | The credential store (Postgres via Hyperdrive) is unreachable. Clients should retry, so don't revoke anything. |
| Client lists no tools or rejects the schema | Run `npm run smoke` to confirm the server works, then check the client's tool limit (Cursor allows about 40). The schemas avoid type arrays and `$ref` on purpose (`test/schema-portability.test.ts`). |
| Client ignores the protocol rules | It probably doesn't read MCP resources. Tell it to call `read_protocol` first. |
| Too many registrations (`429`) | More than 50 registrations went unapproved in the last hour. Wait, or approve or clear the stuck ones. |

## Retiring the master token

1. Reconnect every client as above, and give every script a PAT.
2. Wait until the console's master-token banner has been empty for a week.
3. Commit `"ALLOW_MASTER_BEARER": "false"` in `mcp-worker/wrangler.jsonc` and deploy.
4. Rotate `BRAIN_MCP_TOKEN`: `openssl rand -hex 32`, then set it as a Worker secret. It is now only the owner password. Rotating it also signs you out of the console. Existing OAuth and PAT credentials are not affected.

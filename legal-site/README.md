# legal-site

The Terms of Service and Privacy Statement for every unsubject.com project, published by Unsubject LLC.

| URL | File |
|---|---|
| `https://unsubject.com/terms` | `public/terms.html` |
| `https://unsubject.com/privacy` | `public/privacy.html` |

`/terms-of-service`, `/terms-of-use`, `/privacy-policy` and `/privacy-statement` redirect (301) to these URLs (`public/_redirects`). Security headers are set in `public/_headers`.

## How it is served

A Cloudflare Worker named `unsubject-legal` serves the files in `public/` as static assets. It has no script. It answers only on the routes `unsubject.com/terms*` and `unsubject.com/privacy*` (`wrangler.jsonc`). Whatever serves the rest of unsubject.com is not affected.

Each page inlines its CSS, so the two routes are all the Worker needs. The three HTML files carry the same `<style>` block, so when you change the CSS, change it in all three.

## Deploying

The **Deploy legal-site** workflow (`.github/workflows/deploy-legal-site.yml`) deploys on every push to `main` that touches `legal-site/`. You can also run it by hand from the Actions tab. CI runs `npm run check` (a wrangler dry run) on pull requests.

Before the first deploy, check these once:

1. **Zone.** The `unsubject.com` zone is in the same Cloudflare account as the `CLOUDFLARE_ACCOUNT_ID` secret.
2. **DNS.** The apex `unsubject.com` has a **proxied** (orange-cloud) DNS record. Worker routes don't run on DNS-only records. If nothing serves the apex yet, add an `AAAA` record for `@` pointing to `100::`, proxied. That is Cloudflare's placeholder for hostnames served only by Workers.
3. **API token.** The `CLOUDFLARE_API_TOKEN` secret includes **Zone → Workers Routes → Edit** for unsubject.com. Tokens made from the "Edit Cloudflare Workers" template include it.

## Editing the text

- When you change either page, update the "Effective" and "Last updated" dates at the top.
- A material change needs advance notice to users: Terms §18 and Privacy §11 promise it.
- Cross-links between the pages are root-relative (`/terms`, `/privacy`), so they work locally and in production.

## Local preview

```bash
cd legal-site
npm install
npm run dev        # http://localhost:8787/terms and /privacy
npm run check      # wrangler dry run, same as CI
```

## Google OAuth consent screen

These URLs are the ones to enter in Google Cloud Console → **Google Auth Platform → Branding**: **Privacy policy link** `https://unsubject.com/privacy`, **Terms of service link** `https://unsubject.com/terms`. Add `unsubject.com` under **Authorized domains**. Privacy §3 holds the Google API Limited Use disclosure that verification asks for.

Google also asks for an **application home page** on the same domain. This Worker doesn't serve one; the home page must come from whatever serves the rest of unsubject.com.

# legal-site

The Terms of Service and Privacy Statement for every unsubject.com project, published by Unsubject LLC at `legal.unsubject.com`.

| URL | File |
|---|---|
| `https://legal.unsubject.com/` | `public/index.html` (links to both documents) |
| `https://legal.unsubject.com/terms` | `public/terms.html` |
| `https://legal.unsubject.com/privacy` | `public/privacy.html` |

`/terms-of-service`, `/terms-of-use`, `/privacy-policy` and `/privacy-statement` redirect (301) to these URLs (`public/_redirects`). Any other path gets `public/404.html`. Security headers are set in `public/_headers`. All pages share `public/legal.css`.

## How it is served

A Cloudflare Worker named `unsubject-legal` serves the files in `public/` as static assets. It has no script. `legal.unsubject.com` is attached to it as a **Custom Domain** (`wrangler.jsonc`), so the Worker is the origin for the whole hostname. On deploy, Cloudflare creates the DNS record and TLS certificate itself. Nothing else on unsubject.com is affected.

## Deploying

The **Deploy legal-site** workflow (`.github/workflows/deploy-legal-site.yml`) deploys on every push to `main` that touches `legal-site/`. You can also run it by hand from the Actions tab. CI runs `npm run check` (a wrangler dry run) on pull requests.

Before the first deploy, check these once:

1. **Zone.** The `unsubject.com` zone is in the same Cloudflare account as the `CLOUDFLARE_ACCOUNT_ID` secret.
2. **DNS.** There is no existing CNAME record for `legal.unsubject.com`. Cloudflare can't attach a Custom Domain to a hostname that has one. Don't create the record yourself: the deploy does it.
3. **API token.** The `CLOUDFLARE_API_TOKEN` secret includes **Zone → Workers Routes → Edit** for unsubject.com. Custom Domains need it as much as routes do. Edit the existing token in Cloudflare (My Profile → API Tokens); its value doesn't change, so the GitHub secret stays as it is.

## Editing the text

- When you change either page, update the "Effective" and "Last updated" dates at the top.
- A material change needs advance notice to users: Terms §18 and Privacy §11 promise it.
- Links between pages are root-relative (`/terms`, `/privacy`), so they work locally and in production.

## Local preview

```bash
cd legal-site
npm install
npm run dev        # http://localhost:8787/, /terms and /privacy
npm run check      # wrangler dry run, same as CI
```

## Google OAuth consent screen

These URLs are the ones to enter in Google Cloud Console → **Google Auth Platform → Branding**: **Privacy policy link** `https://legal.unsubject.com/privacy`, **Terms of service link** `https://legal.unsubject.com/terms`. Add `unsubject.com` under **Authorized domains**; it covers its subdomains. Privacy §3 holds the Google API Limited Use disclosure that verification asks for.

Google also asks for an **application home page** on an authorized domain that describes the app. `legal.unsubject.com/` only links to the legal documents, so it won't do as that page.

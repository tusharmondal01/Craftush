# Craftush v17: GitHub frontend and Cloudflare backend

The GitHub Pages frontend needs a running backend for admin, stored models,
Runware generation and ChatGPT project handoffs. This release supplies that
backend as a Cloudflare Worker and private SQLite-backed Durable Object.
The source stays in `tusharmondal01/Craftush`.

## Deploy in the browser

1. Sign in to Cloudflare and open **Workers & Pages → Create application**.
2. Import **tusharmondal01/Craftush** from GitHub. Select only this repository
   when connecting the Cloudflare GitHub app.
3. Select branch **fix/v17-cloudflare-backend** and name the Worker
   **craftush**. Keep the project root at the repository root.
4. Use build command **npm run build:cloudflare** and deploy command
   **npm run deploy:cloudflare**.
5. In the Worker's **Settings → Variables and Secrets**, add **ADMIN_PASSWORD**
   as a secret. Enter the admin password directly in Cloudflare.
   For generation on the website, add your existing **RUNWARE_API_KEY** as a
   secret there too. Never commit either value or enter it in chat.
6. Deploy again if the secrets were added after the first deployment. The
   `CRAFTUSH_DATA` Durable Object is provisioned by the supplied binding and
   SQLite migration. No database ID, terminal or separate storage setup is needed.
7. Copy the actual `https://…workers.dev` address shown by Cloudflare.
   Its **/api/health** route must return HTTP 200 with `ok: true`,
   `adminConfigured: true`, `storage: "connected"` and `version: "17"`.
   `runwareConfigured: true` confirms a provider key is available without exposing it.

## Connect the GitHub site

1. Open the GitHub repository's **Settings → Secrets and variables → Actions → Variables**.
2. Create **PAGES_API_BASE**, containing only the actual HTTPS backend origin
   copied from Cloudflare. This public URL is a variable, not an API key.
3. Promote this release's `.github/workflows/github-pages.yml` to **main**.
   Its checkout points to the prepared v17 Cloudflare branch. The workflow
   checks the real health endpoint, admin configuration and CORS before it
   publishes the GitHub Pages frontend.
4. Open the existing GitHub site and its **/admin/** page. The password field
   becomes usable when this connected frontend is published. The sign-in API
   continues to verify the real admin password on the server.

The frontend address stays `https://tusharmondal01.github.io/Craftush/`.
Uploaded thumbnails run on the backend and their Dashboard link returns to this
GitHub address. ChatGPT setup displays the deployed Cloudflare MCP endpoint.

## Storage and compatibility

- Settings, usage, workflows and project receipts remain private. The same API
  handlers and Runware payloads are used; only host routing and storage change.
- Large HTML, workflow and script values use atomic SQLite chunks so incomplete
  writes cannot replace saved records. Multibyte Hindi text stays intact.
- Cloudflare bindings and credentials stay inside one request's async context.
  They are never copied into browser JavaScript or shared process globals.
- Requests from the GitHub site use explicit CORS. Credentials are not forwarded
  through redirects, and the frontend cannot route passwords to arbitrary URLs.
- A new backend starts with a new private store. Existing local scripts, images
  and exports stay in the browser. Server settings or receipts from a different
  host are not automatically migrated.
- The Runware connection inside ChatGPT keeps its own credential. Cloudflare
  cannot retrieve that credential; website generation uses its server secret,
  while **Generate through ChatGPT** receives project results through the bridge.
- Vercel Git builds are disabled for this branch. The published Netlify v12
  and the current pinned GitHub Pages release are not changed by preparation.

## Verification

### Rate limits

The Cloudflare backend uses atomic SQLite counters in its existing private
Durable Object binding. Counters are isolated per network address, identified
with a server-keyed HMAC rather than a stored plaintext IP or credential.
People on the same network share an allowance.

| Operation | Default allowance | Runtime variable |
| --- | --- | --- |
| Generated results, including image batches and text tasks | 120 per 60-second window | RATE_LIMIT_AI_MINUTE |
| Generated results across all paid routes | 1,200 per 3,600-second window | RATE_LIMIT_AI_HOUR |
| Result polling and model searches | 300 per 60-second window | RATE_LIMIT_LOOKUP_MINUTE |
| Failed admin password attempts | 10 per 600-second window | RATE_LIMIT_ADMIN_ATTEMPTS |

Positive integer runtime variables can override these defaults. No new
binding or secret is required. Valid admin requests continue to work when the
failed-password allowance is exhausted. Local editing and exports make no
limited generation request.

Rejected requests return HTTP 429, Retry-After, a retryAfter value and a
readable wait message. A batch bigger than the entire allowance returns a
reduce-batch error. Generation is checked after authorization and before
calling Runware; a rejected documentary request creates no submitted receipt
and can safely retry its original UUID. Polling has a separate allowance and
cached completed documentary results do not consume generation quota.
If quota storage fails, the provider is not called.

The public health response reports the effective rate limits. The Pages
release verifier requires rate limiting before publishing this update.

`npm test` checks the original v17 behavior plus the backend and connected Pages
runtime. `npm run test:cloudflare` bundles the actual Worker and runs it in
Cloudflare's local runtime with real SQLite storage and a fixture Runware service.
The fixture creates no real provider jobs or charges. GitHub Actions runs both
checks for this branch. Production sign-in and generation still need verification
after the Cloudflare account, secrets and frontend connection have been configured.

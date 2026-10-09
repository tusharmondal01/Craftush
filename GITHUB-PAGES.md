# Craftush v17 on GitHub Pages

The `github-pages-v17` branch contains the tested v17 frontend for GitHub Pages. The publisher workflow on `main` checks out a pinned release commit, following the repository's existing `main` deployment rule. The Pages site has no Vercel runtime connection. Automatic Vercel deployments are disabled for `main` and `github-pages-v17`; application files on `main` and the Netlify v12 site remain unchanged.

GitHub Pages serves static files. Local script editing, scene import, subtitle/audio timing, Premiere export, and assembling uploaded video clips use the browser. AI generation, admin settings, hosted thumbnail uploads, and ChatGPT project handoff require a separate backend and are unavailable in this Pages-only deployment. The UI shows this state explicitly. It does not send passwords, access codes, or provider credentials to another host.

Build with `npm ci --ignore-scripts`, `npm run build`, `npm test`, and `node scripts/build-github-pages.mjs`. The output is `dist-pages/`; the original `public/` source is not rewritten. `PAGES_BASE_PATH` defaults to `/Craftush`. The build prefixes site links for a project Pages site, retains relative worker/module URLs, includes the prepared FFmpeg assets, and removes the previous Vercel MCP address from the published frontend.

In repository Settings → Pages, select GitHub Actions. The workflow on `main` builds, tests and publishes its pinned v17 release. To publish a subsequent release, test its code and update the workflow's checkout `ref` to that commit. Only `dist-pages/` is uploaded, with no API source or secrets. The existing `github-pages` environment protection is retained.

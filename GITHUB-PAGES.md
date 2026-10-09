# Craftush v17 on GitHub Pages

The `github-pages-v17` branch publishes the v17 frontend through GitHub Actions to GitHub Pages. It has no Vercel runtime connection. This branch disables its automatic Vercel deployments and does not change the existing production branch or Netlify v12 site.

GitHub Pages serves static files. Local script editing, scene import, subtitle/audio timing, Premiere export, and assembling uploaded video clips use the browser. AI generation, admin settings, hosted thumbnail uploads, and ChatGPT project handoff require a separate backend and are unavailable in this Pages-only deployment. The UI shows this state explicitly. It does not send passwords, access codes, or provider credentials to another host.

Build with `npm ci --ignore-scripts`, `npm run build`, `npm test`, and `node scripts/build-github-pages.mjs`. The output is `dist-pages/`; the original `public/` source is not rewritten. `PAGES_BASE_PATH` defaults to `/Craftush`. The build prefixes site links for a project Pages site, retains relative worker/module URLs, includes the prepared FFmpeg assets, and removes the previous Vercel MCP address from the published frontend.

In repository Settings → Pages, select GitHub Actions. Commits to `github-pages-v17` run the build, tests and Pages publish workflow. Only `dist-pages/` is uploaded, with no API source or secrets.

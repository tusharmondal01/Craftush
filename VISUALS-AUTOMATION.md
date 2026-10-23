# Stunning Visuals: one-episode automation

This adds a manual **Start automation** button to the existing Stunning Visuals workflow. One run reads one Google Sheets row, researches the topic, writes a script, creates scenes and contextual prompts, generates images, creates Runware narration, and hands it to the existing narration-sync and Premiere export tools. The original manual workflow remains available.

## Deployment and setup

1. Deploy the updated Cloudflare Worker with the existing `CRAFTUSH_DATA` SQLite Durable Object binding. New tables are created automatically. Keep `ADMIN_PASSWORD`, the existing Runware configuration and origin restrictions in place. No new binding or migration is required.
2. Build GitHub Pages with `PAGES_API_BASE=https://craftush.tushar-mondal.workers.dev` and `PAGES_BASE_PATH=/Craftush`. Publish the matching frontend only after the backend is deployed. Netlify v12 is unrelated to this change.
3. In Admin → Visuals automation, review the script instructions, frame shape, quality, visual direction, image checks, transitions, frame rate, zoom and narration voice. Saving creates a new settings revision. Each run freezes that revision.
4. Connect Google Sheets as described below, then enable automation. Keep the team access code enabled if generation should be limited to the team.
5. In Stunning Visuals, enter the spreadsheet URL, exact tab name and row number. Select the existing text model, split method and image model, then click Start automation. Keep the browser tab open.
6. Preview the completed narration and resolve any highlighted timing matches before confirming the existing timing-review checkbox and downloading the Premiere package.

The new endpoint requires the Cloudflare store. The Netlify/Vercel wrappers return a setup error when persistent automation storage is unavailable; they do not silently use an in-memory queue.

## Private Google Sheet connection

The website cannot reuse the user's ChatGPT Google connection. It needs its own read-only access:

1. In a Google Cloud project, enable the Google Sheets API.
2. Create a service account and download a JSON key for it. Do not grant broad project roles just to read a shared spreadsheet.
3. Upload that JSON through the authenticated Admin → Visuals automation → Google Sheets connection form. Do not paste it in chat, commit it to GitHub or add it to frontend JavaScript.
4. Share only the required spreadsheet with the displayed service-account email as **Viewer**.

The server signs an OAuth assertion with the `spreadsheets.readonly` scope. It calls fixed Google OAuth/Sheets endpoints and reads only spreadsheet tab metadata and the requested C–G row. It never writes cells or changes sharing. The key stays in private backend settings; responses expose only connection status and the service-account email. Disconnecting removes the stored credential; revoke the key in Google Cloud if it should no longer be valid elsewhere.

| Column | Episode field |
| --- | --- |
| C | Track |
| D | Subtrack |
| E | Category |
| F | Sub Category |
| G | Episode Name Hindi |

Empty category fields are allowed. G must contain a title. The exact tab name takes precedence over a different `gid` in the supplied URL. The requested pilot is row 2 of **Rare & Endangered Animals**, whose episode is **Great Indian Bustard**.

## Models and script constraints

- Research uses Runware `openai:gpt@5.4` with native web search. Sources and supported claims are saved separately from narration.
- The creator's selected text model writes the script and continues to drive the existing scene/prompt workflow.
- The existing selected image model is preserved.
- Narration uses Runware `minimax:speech@2.8`, default voice `hindi_male_1_v2`, Hindi language boost and MP3 output. Admin can select another supported Hindi voice or Turbo mode. This release does not expose an unverified speech-speed parameter.
- The default brief adapts to the episode subject, generates its opening line, rotates hook categories and keeps citations/labels out of the spoken script. It targets 420 words, rejects scripts over 450 words and blocks completion if the generated narration reaches 180 seconds.
- Research must contain at least two fresh HTTPS sources and three source-linked facts. Source URLs already committed to another script are rejected. These structural checks do not establish factual correctness independently of the research model; the live pilot must also review the script and sources.

## Recovery and cost accounting

Runs, checkpoints, task IDs, results and source history persist in Cloudflare SQLite. The browser stores only the last run reference and input choices. Repeating Start with the same row content, models, split settings and admin revision resumes the existing run. A different settings revision creates a new run.

Stop prevents later stages from starting. A task already submitted to Runware can still finish and incur cost. Resume retrieves its existing task UUID and cached result. Ambiguous network failures are polled rather than resubmitted. An explicit Resume may retry a known failed task. Provider tasks are claimed atomically, and completed costs are counted once in both the run ledger and admin totals. Resetting admin usage counters does not erase a saved run's cost or research history.

Image/audio URLs are provider-hosted and can expire. Export completed work promptly. Checkpoints store image URLs and scene metadata, not large image binaries. Closing the tab stops browser orchestration; Resume continues from saved work. This is not a scheduled background batch worker.

The existing speech recognition, alignment diagnostics, timing review, transitions and Premiere packaging remain in place. The ZIP additionally includes episode research and settings metadata while the script still matches the automated episode. Uncertain alignment is flagged instead of silently approving the export.

## Validation and remaining live checks

Run `npm test`, `npm run test:cloudflare`, and the GitHub Pages build. Tests include the full mocked stage sequence, Stop during prompts/audio download, failed-image recovery, cached Resume, readonly Sheets OAuth/range selection, duplicate-task prevention, usage accounting, source history and the compiled Worker with real SQLite storage. Browser QA covers the new creator panel and admin form.

The paid live inference attempt on 2026-10-23 was rejected by the connected Runware account's billing gate: it required a paid invoice or at least $5 credit. The website's private Google Sheets credential also needs owner setup. No live generated episode, narration alignment or actual Premiere import has been validated for this feature yet. Complete that pilot before treating the automation as production-tested.

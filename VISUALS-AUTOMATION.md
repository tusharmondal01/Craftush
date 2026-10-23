# Stunning Visuals: one-episode automation

This adds a manual **Start automation** button to the existing Stunning Visuals workflow. One run reads one Google Sheets row, researches the topic, writes a script, creates scenes and contextual prompts, generates images, creates Runware narration, and hands it to the existing narration-sync and Premiere export tools. The original manual workflow remains available.

## Deployment and setup

1. Deploy the updated Cloudflare Worker with the existing `CRAFTUSH_DATA` SQLite Durable Object binding. New tables are created automatically. Keep `ADMIN_PASSWORD`, the existing Runware configuration and origin restrictions in place. No new binding or migration is required.
2. Build GitHub Pages with `PAGES_API_BASE=https://craftush.tushar-mondal.workers.dev` and `PAGES_BASE_PATH=/Craftush`. Publish the matching frontend only after the backend is deployed. Netlify v12 is unrelated to this change.
3. In Admin → Visuals automation, review the script instructions, frame shape, quality, visual direction, image checks, transitions, frame rate, zoom and narration voice. Saving creates a new settings revision. Each run freezes that revision.
4. Automation is available with the approved defaults unless an admin explicitly disables it. Use the connected Google Drive, Runware and Craftush apps in ChatGPT. No new Google service-account key or Runware key is required by the site. Keep the existing team access code if access should be limited to your team.
5. In Stunning Visuals, enter the spreadsheet URL, exact tab name and row number. Select the existing text model, split method and image model, then click Start automation. Copy the private project command into ChatGPT and keep the Craftush tab open. ChatGPT reads the sheet and executes the queued Runware tasks; the website receives results and advances the existing workflow.
6. Preview the completed narration and resolve any highlighted timing matches before confirming the existing timing-review checkbox and downloading the Premiere package.

The new endpoint requires the Cloudflare store. The Netlify/Vercel wrappers return a setup error when persistent automation storage is unavailable; they do not silently use an in-memory queue.

## ChatGPT connections and credentials

The website never retrieves a provider key from ChatGPT. The Runware app authenticates provider calls; the Google Drive app reads the exact requested C–G range. Craftush's existing `craftush_project` tool exchanges a temporary project code, prepared tasks and results. The private project code expires after 24 hours, is hashed in storage, and grants access to that one run. Do not share it publicly. Resume rotates it, invalidating the previous code.

The new automation endpoint rejects provider credential fields. No Runware or Google credential upload is shown in its admin section. Existing manual tools and their backend configuration remain unchanged. Team members operate through the accounts connected in their own ChatGPT sessions.

A website button cannot initiate an unattended ChatGPT session. A person starts the project command in ChatGPT and keeps Craftush open. If either session stops, resume from its saved task IDs. This is an interactive handoff, not a scheduled background worker.

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
- The creator's selected text model writes and reviews the script against the research, then continues to drive the existing scene/prompt workflow. A date check examines the narration itself, not just the model's review notes. One automatic correction is allowed; a failed final validation stops before narration.
- The existing selected image model is preserved.
- Narration uses Runware `minimax:speech@2.8`, default voice `hindi_male_1_v2`, Hindi language boost and MP3 output. Admin can select another supported Hindi voice or Turbo mode. This release does not expose an unverified speech-speed parameter.
- The default brief adapts to the episode subject, generates its opening line, rotates hook categories and keeps citations/labels out of the spoken script. It targets 420 words, rejects scripts over 450 words and blocks completion if the generated narration reaches 180 seconds.
- Research must contain at least two fresh HTTPS sources and three source-linked facts. Source URLs already committed to another script are rejected. These structural checks do not establish factual correctness independently of the research model; the live pilot must also review the script and sources.

## Recovery and cost accounting

Runs, checkpoints, task IDs, results and source history persist in Cloudflare SQLite. The browser stores the last run reference, its temporary project code and input choices. Start creates a new run. Use Resume saved run to reuse work and avoid paying for the same episode again.

Stop prevents later stages from starting. A task already submitted to Runware can still finish and incur cost. Resume retrieves its existing task UUID and cached result. Ambiguous network failures are polled rather than resubmitted. An explicit Resume may retry a known failed task. Provider tasks are claimed atomically, and completed costs are counted once in both the run ledger and admin totals. Truncated text is retained with its actual cost and automatically requested again with a larger output limit, up to 8,000 tokens. The pipeline never parses a known-truncated response as complete. Resetting admin usage counters does not erase a saved run's cost or research history.

Image/audio URLs are provider-hosted and can expire. Export completed work promptly. Checkpoints store image URLs and scene metadata, not large image binaries. Closing the tab stops browser orchestration; Resume continues from saved work. This is not a scheduled background batch worker.

The existing speech recognition, alignment diagnostics, timing review, transitions and Premiere packaging remain in place. The ZIP additionally includes episode research and settings metadata while the script still matches the automated episode. Uncertain alignment is flagged instead of silently approving the export.

## Validation and remaining live checks

Run `npm test`, `npm run test:cloudflare`, and the GitHub Pages build. Tests include the full mocked stage sequence, Stop during prompts/audio download, failed-image recovery, cached Resume, readonly Sheets OAuth/range selection, duplicate-task prevention, usage accounting, source history and the compiled Worker with real SQLite storage. Browser QA covers the new creator panel and admin form.

The replacement Runware connection successfully completed live research, script generation, source review and scene direction on 2026-10-23. The earlier billing rejection no longer applies to that connection. The automated test suites cover the full sequence with fixtures; live media generation, narration alignment and an actual Premiere import must be reported separately from those fixtures.

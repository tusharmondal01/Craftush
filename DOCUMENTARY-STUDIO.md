# Documentary Studio: narration-first workflow

The default `/documentary/` now follows the approved script and the measured voiceover. Existing fixed 13-scene projects remain available at `/documentary/legacy.html`; their data and Runware workflow are preserved. The other dashboard tools retain their routes and settings.

1. Enter the title, detailed idea and approximate target duration. **Write full script** calls Claude Sonnet 4.6 through Runware and stops for review.
2. Edit and **Save text**, download `.txt`, or enter feedback and **Revise with Claude**. Repeat as needed. Previous versions remain available. Every edit clears prior approval and dependent media.
3. Choose Gemini 3.1 Flash TTS or Fish Audio S2.1 Pro in Voiceover. Male narration is the default. **Approve & create documentary** starts production using that exact script. Long scripts split at model limits and join into one saved WAV.
4. On-device speech recognition measures word timestamps from that WAV. A script match below 90% stops the workflow for transcript review. Import an SRT from the exact audio or edit the timings, confirm them, and continue. SRT words inside a cue are interpolated and require review.
5. Claude chooses semantic shot cuts and groups up to six connected shots per video request. The JSON includes shot count, absolute start/end, duration, narration excerpt and visual direction. Validation requires full audio coverage, no gaps or overlaps, at most 15 seconds per request and at most 100 requests. Download or edit the JSON in Shot plan.
6. Only planned slots become active. PixVerse V6 generates silent 720 × 1280 MP4s; each completed clip is cached on the device and has a download button. The remaining slots stay disabled. The default concurrency is three, with one, five or eight available.
7. FFmpeg trims active clips to the planned frame boundaries, concatenates them in order and adds the complete narration. Optional background music and volume controls remain available. Final output must contain video and audio and match the narration duration within codec tolerance before it is saved.

**Stop** prevents new submissions but cannot cancel already-running provider jobs. **Resume / retry current stage** checks the saved UUIDs; an explicitly failed task receives a new UUID only on retry. Keep the tab open while processing. The first transcript analysis downloads a Whisper model and can take several minutes on slower devices. Internal AI-generated shot cuts are requested in prompts but can vary; review the final video and replace a clip if necessary.

## Connections and storage

The narration-first Studio uses the Runware key saved in Admin for scripts, revisions, narration, shot prompts and videos. New and restored projects generate directly on the website; no ChatGPT command is required. The key stays on the backend. Script review and approval remain required before production. Keep the tab open for generation, on-device audio analysis and final assembly. Existing script, media and task UUIDs are preserved. On migration, completed ChatGPT results can be recovered with the locally saved project connection; unresolved submitted tasks are only polled, never automatically regenerated. Classic Studio and other tools retain their settings.

Cloudflare serves `/api/documentary`, `/api/documentary-media`, and `/api/documentary-session`, with existing team access, tool visibility and rate limits. Models: `anthropic:claude@sonnet-4.6`, `google:gemini@3.1-flash-tts`, `fishaudio:s2.1@pro`, and `pixverse:1@8`. The selected model and UUID are preserved throughout each provider task.

Projects, script revisions, WAVs, clips and final MP4s are saved in IndexedDB on this browser/device. Project JSON excludes provider credentials and the private connection token; it contains media references, not embedded media. Download media separately for a portable backup. Reopen JSON on another device, resume available Runware downloads and upload replacement MP4s if a URL expired. Runware-reported costs are counted once per UUID and reset for a new project.

Limits: 20-minute measured narration, 30,000 script characters, 6,000 timestamped words, 100 requests, 160 MB per downloaded clip, 80 MB music and 512 MB total input media for browser assembly. The provider may impose its own credit or request limits. Desktop Chrome or Edge is recommended for local processing. No Runware credits are used for analysis or assembly.

## Validation

Automated checks cover approval, repeated revisions, natural TTS chunking, model/UUID preservation, low-confidence transcript gating, gap/overlap rejection, disabled slots, fractional frame totals, Stop/Resume without duplicate submission, credential rejection, idempotent result recording, and real Cloudflare SQLite/MCP routing. Browser FFmpeg verification joined two real clips with a 3.41-second WAV into a 3.41-second MP4 while ignoring 98 disabled slots. Paid full-film generation is not part of deployment tests.

---

# Classic 13-scene Studio

The fourth Craftush dashboard tool runs your supplied Runware v18 workflow without ComfyUI. The existing three tools retain their own routes and settings.

## Deploy and connect

1. Extract this ZIP and deploy its complete contents to the existing Craftush project. Keep `public/`, `api/`, `netlify/`, `package.json`, `package-lock.json`, `vercel.json` and `netlify.toml` together. Install dependencies with `npm ci` where your host requires it.
2. Keep the existing storage and admin environment configuration described in README.md. The new API routes use the same saved settings and Runware key. No new provider key or media server is required.
3. Open `/admin` and confirm your Runware API key is configured. Under Dashboard cards, Documentary Studio is enabled by default and has editable title, description and visibility.
4. Open `/documentary/legacy.html`. If your admin configured a team access code, enter that code. The browser does not receive or save the Runware API key.

Vercel routes are `/api/documentary` and `/api/documentary-media`. Matching Netlify edge handlers are included. Opening the HTML directly from your filesystem cannot run the generation backend; use the deployed website.

## Create a classic documentary

1. Enter a topic and optional project title. Choose **Generate full documentary** to create the story and scene videos, or **Create story plan only** to review the plan first.
2. Review the glossary, subject sheet and continuity sheet. The master JSON editor and master-script download are available in Story plan. A replacement plan resets its dependent scene prompts and videos.
3. In Scenes, select any of the thirteen tiles to review narration, inspect/edit its video prompt, preview its MP4, download it, rewrite its direction or regenerate only that video. You can also upload a replacement scene MP4. Generation does not invent a fallback plan when a model returns incomplete JSON or an invalid prompt.
4. In Preview & save, upload optional music and adjust levels. Defaults match the supplied workflow: music −18 dB, original generated audio 0 dB, loop enabled, 1-second fade in, 3-second fade out and music start 0.
5. Press **Assemble final video**. After assembly, preview the complete documentary and press **Download final MP4**.

Assembly includes every scene in numeric order and preserves the full clips. Thirteen 12-second clips target 2 minutes 36 seconds. The actual export duration follows the delivered media, including any small codec padding. No API credits are used for assembly.

## Original workflow mapping

| Stage | Preserved behavior |
| --- | --- |
| Master director | `anthropic:claude@fable-5`, original system prompt, 64,000-token limit, high thinking, split thinking, original system-cache settings |
| Master output | Exactly the glossary, subject sheet, continuity sheet and thirteen scene strings |
| Scene directors | `anthropic:claude@sonnet-4.6`, original system prompt, 32,000-token limit, high thinking, original cache settings |
| Director context | The complete raw master output plus `TARGET SCENE: sceneN` |
| Videos | `pixverse:1@8`, 12 seconds, 720 × 1280, seed 42, native audio, multiClip, automatic thinking, MP4, quality 95 |
| Concatenate | All thirteen scene MP4s, scene 1 through scene 13, with their generated audio |
| Music | Original audio retained; optional looping music mixed at the chosen levels with the configured fades |
| Save | Final MP4 preview and browser download |

The original API graph is retained at `references/Runware_v18_API.json`. The exact prompts and settings are in `netlify/lib/documentary-workflow.js`; the public workflow manifest includes prompt hashes. The original graph's music node lacked a class type, so its intended mix is implemented directly with FFmpeg.

The default browser queue processes three scene branches concurrently; one, five or thirteen can be selected. Each branch receives the same complete master plan. This changes dispatch speed without changing prompts or model settings.

## Pause, resume and save

The browser persists a task UUID before submitting it. The backend stores a receipt and caches completed results. Pause or reload recovery retrieves existing task UUIDs before starting unsubmitted work. **Pause generation queue** stops local orchestration; an already submitted Runware job continues at the provider. Resume from Story plan or Scenes to retrieve it.

Keep the tab open during generation and assembly. Closing the tab suspends the browser queue; it does not schedule remaining scene branches in the cloud. No generation starts automatically when you reopen a saved project. Use one generation tab per project.

Drafts, downloaded clips, uploaded music and assembled output use IndexedDB on the current browser/device. **Save project JSON** exports the story, prompts, task IDs, video URLs, music settings and reported costs, without keys or access codes. JSON does not embed MP4s or music. Download your scene MP4s and final MP4 separately for a durable, portable backup. On another device, open the project JSON and upload any scene files whose Runware URLs have expired. Missing local-only media is shown as missing, rather than counted as ready.

The displayed project cost sums costs reported by Runware once per completed task UUID. It is a project-level record, not the legacy admin image/text usage counter; provider invoices remain authoritative. A manual rewrite or regeneration starts a new paid task.

## Video assembly

The pinned single-thread FFmpeg engine is bundled with this project and loaded from the same website; there is no external CDN dependency during assembly. Matching H.264/AAC clips at 720 × 1280 are joined without re-encoding the video. Incompatible clips are converted to a common 720 × 1280, 30 fps, H.264/AAC format before joining. Music mixing re-encodes audio while preserving the joined video stream.

Use a recent desktop browser with sufficient memory. Browser assembly currently limits total input media to 512 MB, each scene to 160 MB, and music to 80 MB. Every scene must contain video and audio; a missing narration track blocks export. Preview and listen to the generated clips before export: independent native-audio generations can vary in voice or pronunciation despite the preserved prompts.

Direct Runware downloads are cached locally. If cross-origin downloading fails, the backend retrieves only approved Runware video URLs in bounded 2 MB ranges, fitting the existing serverless response limits. Both routes enforce the configured team access and tool visibility.

Primary documentation: [Fable 5](https://runware.ai/docs/models/anthropic-claude-fable-5/examples), [Sonnet 4.6](https://runware.ai/docs/models/anthropic-claude-sonnet-4-6/examples), [PixVerse V6](https://runware.ai/docs/models/pixverse-v6), [Runware task polling](https://runware.ai/docs/models-api/task-polling), and [FFmpeg.wasm usage](https://ffmpegwasm.netlify.app/docs/getting-started/usage/). Third-party engine notices and source links are in `public/documentary/vendor/THIRD-PARTY.md`.

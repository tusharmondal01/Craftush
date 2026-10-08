# Documentary Studio

The fourth Craftush dashboard tool runs your supplied Runware v18 workflow without ComfyUI. The existing three tools retain their own routes and settings.

## Deploy and connect

1. Extract this ZIP and deploy its complete contents to the existing Craftush project. Keep `public/`, `api/`, `netlify/`, `package.json`, `package-lock.json`, `vercel.json` and `netlify.toml` together. Install dependencies with `npm ci` where your host requires it.
2. Keep the existing storage and admin environment configuration described in README.md. The new API routes use the same saved settings and Runware key. No new provider key or media server is required.
3. Open `/admin` and confirm your Runware API key is configured. Under Dashboard cards, Documentary Studio is enabled by default and has editable title, description and visibility.
4. Open `/documentary/`. If your admin configured a team access code, enter that code. The browser does not receive or save the Runware API key.

Vercel routes are `/api/documentary` and `/api/documentary-media`. Matching Netlify edge handlers are included. Opening the HTML directly from your filesystem cannot run the generation backend; use the deployed website.

## Create the documentary

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

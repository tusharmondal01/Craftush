# Craftush v16

Four dashboard tools using your Runware account, with a private admin backend. This release adds **Documentary Studio**, a browser workflow for your complete 13-scene Runware documentary, including video previews, concatenation, background music and final MP4 download. The existing Netlify v12 site is separate and must remain untouched.

## New in v16: Documentary Studio

Open `/documentary/` from the fourth dashboard card. It uses the existing admin Runware key and team access code. The supplied v18 master and scene system prompts are preserved byte for byte: Claude Fable 5 writes the complete plan, Claude Sonnet 4.6 directs each scene from that complete plan, and PixVerse V6 generates thirteen 12-second 720 × 1280 videos with native audio. ComfyUI and a desktop video editor are not required for this tool.

Review or edit the master JSON and scene prompts, preview each clip, resume submitted jobs, retry individual failures, or upload replacement scene MP4s. Add optional music, then assemble and download the final video in the browser. The bundled FFmpeg engine keeps video unchanged when clip formats match and normalizes incompatible formats when necessary. It preserves the complete generated narration and ambient sound.

See [DOCUMENTARY-STUDIO.md](DOCUMENTARY-STUDIO.md) for deployment, usage, project backup and workflow details. Deploy the complete project, including `api/`, `netlify/` and the bundled `public/documentary/vendor/` assets. Model availability and final narration quality still depend on your Runware account and the generated results. Live paid Runware generation has not been exercised in this release's local checks.

## Studio and workflow

- The homepage shows every enabled tool in a responsive grid. Tool titles, descriptions, availability and visibility still come from the admin settings. A direct **Start with a script** button opens Stunning Visuals.
- Stunning Visuals has four guided steps: script, prompts, images, and timeline/export. Progress, prerequisite guidance, Back buttons and retry messages make the next action clear. Advanced prompt, image and export settings remain available in expandable sections.
- **One image per complete sentence** is the default split method. A long sentence stays intact; decimals, abbreviations, quotations and paragraph breaks do not create unintended fragments. **Smart scenes (AI)** is available when scene-level segmentation is preferred.
- Script, title and creator notes are saved as a draft on the current device. Draft storage does not include API keys, passwords, access codes, generated images, audio or scene state. **Save script + prompts (.json)** preserves the scenes, prompts and transition settings for later import.
- **Download images + XML (.zip)** packages the generated images, prompts.txt, prompts.json, timeline.xml, timing.json, transitions.json and narration.wav after timing is confirmed. Image-only ZIP and separate XML downloads remain available.
- Admin has section shortcuts, mobile-friendly controls and clearer usage labels. **Text requests** include scene planning, prompt writing, relevance review and optional image quality checks; one image can require several text requests.
- Idea to Video keeps its existing ComfyUI workflow and controls, with connection-first guidance, optional fields tucked away and CORS instructions showing the current site's origin.

## Narration and image timing

Step 4 uses transcript words, not audio length, script length or loudness, to locate each image in the narration. Upload the exact final narration, choose Hindi/Hinglish or English, and press **Align spoken words**. The pinned multilingual Whisper model runs in a browser worker using Transformers.js; audio is not sent to Runware or a speech API, and no second API key is required. The first run downloads a large model and CPU recognition can take time. **Stop alignment**, an exact-audio SRT and manual starts remain available if the device cannot run recognition.

- A global ordered transcript match preserves all scene/image identities, repeated phrases, pauses, opening silence and uneven speaking rates. Hindi/Hinglish phonetic matches are supported and uncertain boundaries are flagged. Short overlapping speech windows are stitched by audio position so repeated text at chunk boundaries is not deleted. Missing lines, extra narration, long word spans across silence, invalid timestamps and unequal one-per-subtitle counts never trigger proportional timing or image truncation.
- Existing SRT timestamps are not stretched or snapped to silence. Only the first word of a cue has an exact cue start; scene boundaries inside a multiword cue are visibly interpolated and require a listening check. A known SRT offset can be entered explicitly.
- Listen beside each scene, edit its start or choose **Use playhead** at its first spoken word. Uncertain/manual starts require **Start checked**. XML export requires final timing confirmation and valid strictly increasing frame starts. Changing narration, scenes, subtitle offset or matching mode clears stale reviews. Frame quantization is at most half a frame; invalid starts never become fabricated one-frame clips.
- The audio/image preview follows the exported frame map. The complete ZIP contains PCM16 **narration.wav**, placed at sequence/source 0:00 by the XML, plus images and timing.json. Mono/stereo samples and full narration duration are preserved; only the speech-recognition input is resampled to 16 kHz. Unzip everything into the same folder and import timeline.xml, relinking narration.wav and 001.jpg there if requested.
- To correct an existing project, load its saved prompts.json, add the final narration and confirm the new starts. **Download timeline + audio (.zip)** exports corrected XML and narration even when no images have been regenerated; keep the original numbered JPGs in that folder. This timing-only repair makes no Runware image request.
- Image-only downloads remain available before confirmation, without an unverified XML. SRT-only exports use the same timestamp origin; add the exact corresponding narration at sequence 0:00. Automatic speech recognition can make mistakes, so the listening preview and editable starts are part of the export workflow. Native Premiere import must be checked in the target editor with the actual project audio; no automatic model guarantees every boundary.

Pinned speech model: [onnx-community/whisper-small_timestamped](https://huggingface.co/onnx-community/whisper-small_timestamped/tree/65caa70f294b46e1c33ff820aae6b16d048ab818), Transformers.js **3.8.1**. Primary timestamp API: [Transformers.js speech pipeline](https://huggingface.co/docs/transformers.js/api/pipelines#module_pipelines.AutomaticSpeechRecognitionPipeline). Runware currently does not offer speech-to-text in its audio-generation API: [Runware audio FAQ](https://runware.ai/audio-generation-api).

## Cinematic transitions

Step 4 defaults to **Auto: Cinematic transitions (28 styles)** with **High energy**. Styles include crash zooms, snap pull-backs, directional whips, diagonal sweeps, spin zooms, camera rolls, spring slides, impact punches, camera-shake punches, orbit sweeps, match moves and quieter dissolves/drifts.

- Scene role, emotion, shot and continuity guide selection. Hooks, actions and results favor energetic moves; connected scenes avoid abrupt whips/spins; close-ups use smaller moves; reflective endings use quieter styles. Calmer intervals break up extended runs of energetic transitions.
- Weighted random selection avoids adjacent repetition of the same preset and penalizes repeated motion families. The script and seed keep repeated exports stable. **Shuffle transitions** changes the mix without changing narration cuts.
- Timing usually varies from approximately 0.26 to 0.82 seconds, rounded to even frames and capped at 30% of the shorter adjacent image. Very short beats keep direct cuts. Transitions stay centered on the narration cuts, with still-image source handles added without changing sequence duration.
- Sampled acceleration, punch, shake and spring curves become editable native **Basic Motion + Cross Dissolve** keyframes. Dynamic overscan and interpolation guards keep translated and rotated images covering the frame while allowing the resting crop to return to normal.
- **Preview transitions** plays actual adjacent generated images locally with the same samples and linear interpolation exported to XML. Select an image pair, see its style and duration, pause, close or shuffle. Previewing does not call Runware or upload images, and reduced-motion settings start the preview paused.
- **Balanced** energy, the original 12-style **Gentle** pack, the supplied **Cross Dissolve reference**, legacy fixed-duration modes and **Off** remain available. Reference mode uses the supplied 14-/16-frame blends at 23.976 fps. The reference is retained at `references/Adjustment_Layer_Reference.xml`.

The new pack uses native camera motion and dissolves. After Effects plug-ins, Adobe Impacts effects, RGB/glitch shaders, 3D transitions and native motion blur are not simulated through invented XML effect names. Legacy named effects still depend on the receiving editor. Native Premiere import/render needs verification in the target editor; preview and XML validation do not verify Adobe's importer.

Primary research:

- [Adobe transition families](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html)
- [After Effects acceleration and bounce](https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/speed-between-keyframes/speed.html)
- [Adobe XML translation limits](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-a-project-as-a-final-cut-pro-xml-file.html)
- [Apple XMEML timing and handles](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Basics/Basics.html)

## Script relevance and models

The selected Runware text model is used consistently for scene splitting, visual planning, prompt writing and relevance review. The Visual Director reads the complete script, its title, neighboring lines and explicit factual constraints. A headline subject is not compulsory in every image: a butterfly story may need eggs, caterpillars, host plants or damaged habitat depending on the narrated line. Hindi/Hinglish narration alone does not force an Indian location or an invented species/life stage.

Prompts are editable and checked for meaning, subject, facts and continuity. An irrelevant batch receives one rewrite and another review. Persistent failures stay visible instead of receiving a generic prompt. Optional image quality checks also consider narration meaning, factual constraints, subject, action, environment and composition; a passing image takes precedence over a higher-scoring image with the wrong subject.

The default Visual Director plans scenes and recurring characters before assembling detailed photographic prompts. The Direct writer and Runware Prompt Enhance remain available in advanced prompt settings. Frame shape, style, strength, character/style bible and creator notes remain adjustable. Generated concepts refresh when their source script or direction changes; creator-edited notes are preserved, with explicit script facts taking precedence.

Text models are configured in `/admin`, including the default. Creators can choose a text model in step 1 and an image model in step 3. Image selection reaches the actual inference request. Unsupported model-specific fields are omitted, including temperature settings for **Claude Sonnet 4.6** (`anthropic:claude@sonnet-4.6`). Async image models submit once and poll the same task through the protected relay.

Recommendations for this workflow, verified against Runware documentation on 2026-10-07:

| Purpose | Model | Runware AIR ID |
| --- | --- | --- |
| Detailed scene planning and prompt writing | Claude Opus 4.8 | `anthropic:claude@opus-4.8` |
| Faster prompt-writing alternative | Claude Sonnet 4.6 | `anthropic:claude@sonnet-4.6` |
| Premium realistic images | GPT-Image-2.5 Sunburst | `openai:gpt-image@2.5-sunburst` |
| Image alternative | Nano Banana Pro | `google:4@2` |
| Existing image default | GPT Image 2 | `openai:gpt-image@2` |

These are workflow recommendations, not comparative benchmarks. Account availability and cost depend on Runware. Every route uses the existing Runware key; no new AI provider key is required. Relevance review and optional quality checks add text requests and can trigger image retries.

Documentation: [Opus 4.8](https://runware.ai/docs/models/anthropic-claude-opus-4-8/examples), [Sonnet 4.6](https://runware.ai/docs/models/anthropic-claude-sonnet-4-6/examples), [Sunburst](https://runware.ai/docs/models/openai-gpt-image-2-5-sunburst), [Nano Banana Pro](https://runware.ai/docs/models/google-nano-banana-pro), [task polling](https://runware.ai/docs/models-api/task-polling).

## Source layout

| Path | Purpose |
| --- | --- |
| `public/index.html` | Studio tool dashboard |
| `public/visuals/` | Script, prompts, images, transitions, preview and Premiere XML export |
| `public/admin/index.html` | Password-protected admin interface |
| `public/comfy/index.html` | ComfyUI front end |
| `public/documentary/` | New Runware documentary studio, local media storage and browser FFmpeg export |
| `netlify/edge-functions/` | Shared admin, Runware, tool and thumbnail handlers |
| `netlify/lib/documentary-*.js` | Fixed original workflow, asynchronous task receipts and bounded video downloads |
| `api/` | Vercel wrappers using the shared handlers |
| `vercel.json` | Public assets, API/thumbnail routing and admin headers |
| `netlify.toml` | Separate Netlify hosting configuration |
| `tests/` | Existing regressions plus documentary workflow, access, resume, media and export checks |

## Existing Vercel deployment

Production project: **craftush-v13-live**, under **tusharmondal-1850s-projects**.

- Website: https://craftush-v13-live.vercel.app/
- Admin: https://craftush-v13-live.vercel.app/admin

This project is connected to **tusharmondal01/Craftush**, with **main** as its production branch. Tested updates on main trigger a Vercel production deployment. Use this existing project; do not create another project or connect/redeploy the Netlify v12 site.

The Git release restores the large Documentary Studio engine during `npm run build` from the locked `@ffmpeg/core` 0.12.10 package. The build checks both engine files against the v16 ZIP's SHA-256 manifest before placing them in `public/documentary/vendor/`. This keeps the published engine identical to the supplied ZIP while avoiding the large Git upload. Run `npm ci` and `npm run build` when deploying a checkout from Git.

Use the project's existing environment variables and storage. Do not copy secret values into source control or deployment ZIPs. For a staged production deployment, use `vercel deploy --prod --skip-domain`, verify that build, then `vercel promote <deployment-url>` to move the production domain to the tested build.

### Backend configuration

- `ADMIN_PASSWORD`: set privately in Vercel environment variables. The admin page uses this password to protect changes.
- `RUNWARE_API_KEY`: existing server key or the key saved through `/admin`. Public clients never receive the key.
- The project's **Private Blob** store uses the `CRAFTUSH` prefix (`CRAFTUSH_STORE_ID`) and Vercel's rotating OIDC credentials. Reads are uncached so settings changes appear immediately. No static Blob token is needed.
- Alternatively, the shared storage adapter supports Upstash Redis using the relevant REST URL/token variables. Provisioning or migration is separate from routine updates.
- Runware key, team access code, approved/default text models, usage settings, tool titles/visibility, thumbnail HTML and ComfyUI workflow are managed in `/admin`. Host-level environment changes require a redeployment; ordinary saved admin settings take effect immediately.
- Each host has separate settings/uploads. Existing Netlify data is not migrated or changed. Vercel functions in this project have a 60-second limit, and uploads must fit Vercel's request-size limit (about 4.5 MB).

### Dashboard tools

For Thumbnail Generator, upload the single HTML tool through `/admin`; it is served at `/thumbnail`. For Idea to Video, export a ComfyUI workflow in API format, upload it through `/admin`, choose the prompt input and editable fields, and set the default ComfyUI address. The receiving ComfyUI must have the workflow's models installed and permit CORS for the exact Craftush origin shown on its connection panel.

## Verification

Run `npm ci` followed by `npm test` from the repository root. The suite has **71 tests**: the original 59 regressions and 12 documentary checks. Documentary checks cover the exact supplied prompts, model settings, master-plan validation, access control, task UUID recovery, provider-response privacy, project import/export, audio-preserving FFmpeg commands and bounded media downloads. Existing checks cover the full-stop splitter, model parameters/relay handling, all 28 styles across vertical/horizontal/square frames, fractional interpolation/crop coverage, preview controls, shuffle timing stability, complete ZIP exports, retry behavior, script-draft privacy and narration alignment. Narration regressions cover variable speaking speed, pauses, repeated phrases, missing/extra passages, Hindi/Hinglish, numbers, SRT cue uncertainty, subtitle replacement races, manual review, cancellation, frame rounding, PCM sample preservation and audio inclusion across all export modes.

Additional local checks exercised full-script context, relevance rewrites/failures, quality-check selection, model routing, async polling, relay authentication/secret handling, private storage behavior and DOM assets with mocked AI responses. All **50 XML cases** parse with valid clip handles, transition boundaries and keyframe ranges. Native Premiere import/render and real-model generations are separate checks; automated local success does not establish those outcomes.

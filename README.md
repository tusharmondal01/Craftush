# Craftush

## October 2026 update: scene relevance and automatic transitions (v13)

Deploy this source through the **existing Netlify project and its repository** using the same method as before. Keep the existing environment variables and saved settings. The ZIP does not contain live API keys, passwords or stored uploads. No new API provider or key is required. The current GPT Image 2 image default and the admin's text-model default remain in place.

### Image prompts

- In step 1, choose a Runware text model. The same choice is used for splitting, scene planning, prompt writing and relevance checking.
- The Visual Director reads the full script, including its ending, and resolves each beat with the preceding and following lines. It plans the literal meaning, visible evidence, focal subject, cause/process/result/context role, continuity and factual constraints.
- A video's title supplies context; it does not require the same animal, person or product in every frame. In a butterfly story, a feeding beat can show a caterpillar and host plant, an egg beat can show eggs, and a habitat-loss beat can show damaged habitat. Butterfly behaviour and wing details still show the butterfly when appropriate.
- Hindi narration does not force an Indian location. Do not invent a species, place or life stage absent from the script.
- Prompts are reviewed for meaning, subject, facts and continuity. A failed batch gets one rewrite and another review. If it still fails, the normal request retry applies; persistently failed lines remain empty with an error rather than receiving a generic scene. Write prompts again after correcting direction or scene notes.
- Prompt length follows the existing strength control. Generated prompts remain editable; imported prompt JSON remains compatible. JSON exports now also retain the relevance review and transition random seed.
- An automatically generated concept refreshes when its script, title or direction changes. Creator-edited concepts are preserved; explicit script facts take precedence over conflicting old notes.
- The optional image quality check now checks narration meaning, factual constraints, subject, action, environment and composition as well as realism. A passing image takes priority over a higher-scoring image with the wrong subject.
- Relevance reviews use additional Runware text calls. Image generation still uses the selected image model. An empty prompt produces an error rather than spending credits on a generic fallback.

### Premiere transitions

Step 4 now defaults to **Auto: XML dissolve + motion tweens**:

- The supplied `Adjustment Layer(1).xml` contains six native Cross Dissolves with 14- or 16-frame durations at 23.976 fps (approximately 0.58-0.67 s). A copy is in `references/Adjustment_Layer_Reference.xml`.
- Automatic timing uses those durations as a reference, normally varying about 0.4-0.85 s, with faster action beats and slower context beats. It shortens blends to at most 30% of the shorter neighbouring image, and skips them on very short beats.
- The 12 presets are Cross Dissolve, Zoom through, Pull back, Glide left/right/up/down, Diagonal up left/down right, Clockwise settle, Counterclockwise settle, and Lift and pull back. They use native Cross Dissolve with sampled smooth scale, center and rotation keyframes. They do not require an external transition plug-in.
- Presets are shuffled without repeats until the bag is exhausted. The same timeline keeps the same plan across repeated downloads; a saved prompt JSON retains its seed.
- Dissolves are centered on the existing narration cuts. Both image handles are included without changing total sequence duration. Fill mode adds a small crop allowance for translation and rotation. Existing slow zoom settings remain available.
- **XML reference: Cross Dissolve only** uses the reference blend with varied timing and the existing slow-zoom setting.
- The original 50-style fixed-duration modes and Off option remain available. Those legacy named effects still depend on the receiving editor's support; the new automatic mode uses native motion and Cross Dissolve.
- Hover over an image in the timeline to see the outgoing preset and duration. Clip comments also record the plan in the exported XML.

This includes a family of native motion tweens; it is not a bundle of third-party Premiere/After Effects transition plug-ins. The source XML supplied here contains Cross Dissolve only.

### Recommended Runware models for this workflow

These are recommendations for this script-to-scenes workflow, not a benchmark claiming one model always wins. All use the existing Runware API key. Verified against Runware documentation on 2026-10-07.

| Purpose | Recommendation | Runware AIR ID |
| --- | --- | --- |
| Detailed scene planning and prompt writing | Claude Opus 4.8 | `anthropic:claude@opus-4.8` |
| Faster prompt-writing alternative | Claude Sonnet 4.6 | `anthropic:claude@sonnet-4.6` |
| Premium realistic image generation | GPT-Image-2.5 Sunburst | `openai:gpt-image@2.5-sunburst` |
| Image generation alternative | Nano Banana Pro | `google:4@2` |
| Existing image default | GPT Image 2 | `openai:gpt-image@2` |

Choose the text model in step 1 and the image model in step 3. The admin's existing list remains available. Image-model selection now reaches the actual inference request; it was previously hard-coded to GPT Image 2. Model-specific dimensions and unsupported negative/step fields are handled for the suggested models. The two new image recommendations use asynchronous submission and poll the same task through the protected relay, so longer generations do not hold a hosting function open. The existing GPT Image 2 route is unchanged.

Documentation:
- https://runware.ai/docs/models/anthropic-claude-opus-4-8/examples
- https://runware.ai/docs/models/anthropic-claude-sonnet-4-6/examples
- https://runware.ai/docs/models/openai-gpt-image-2-5-sunburst
- https://runware.ai/docs/models/google-nano-banana-pro
- https://runware.ai/docs/models-api/task-polling
- https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Basics/Basics.html

### Validation and limits

JavaScript syntax checks, 42 XML export cases, centered cuts and source handles, motion crop coverage, selection/dimensions, full-script context, semantic rewrite/failure, image QC selection, concept refresh, asynchronous submission/polling, and relay authentication/secret handling were checked locally with mocked AI responses. No paid Runware generations were performed. A native Premiere Pro import/render and live Runware model availability on your account still need confirmation. This package has not been deployed to the live Netlify site.

The homepage, admin UI, ComfyUI page, admin/tool/thumbnail handlers, dependency files and host configuration are retained. Backend version is 13; the Runware relay adds protected result polling for the new image recommendations and omits unsupported temperature settings for the two suggested Claude text models.

Script-to-Premiere image tool with a private backend.

- `public/index.html` – dashboard with the three tool cards (craftush.netlify.app)
- `public/visuals/index.html` – Stunning Visuals (craftush.netlify.app/visuals)
- `public/comfy/index.html` – Idea to Video, the ComfyUI front end (craftush.netlify.app/comfy)
- `public/admin/index.html` – admin page (craftush.netlify.app/admin)
- `netlify/edge-functions/runware.js` – relay that adds the secret Runware key
- `netlify/edge-functions/admin.js` – admin API (password protected)
- `netlify/edge-functions/tools.js` – dashboard settings and the ComfyUI workflow for the team
- `netlify/edge-functions/thumbnail.js` – serves the thumbnail generator uploaded in /admin (craftush.netlify.app/thumbnail)
- `api/*.js` + `vercel.json` – the same backend on Vercel (see *Hosting on Vercel*)

## One-time setup

1. **Set the admin password.** In Netlify, open the craftush project, go to
   **Project configuration → Environment variables → Add a variable**.
   Key: `ADMIN_PASSWORD`, value: a long password only you know.
2. **Put these files on GitHub.** Create a free account at github.com, then
   **New repository** (choose *Private*). Click **uploading an existing file** and
   drag in everything from this folder (the `public` and `netlify` folders,
   `netlify.toml`, `package.json` and this README). Commit.
3. **Connect Netlify to GitHub.** In Netlify, go to **Project configuration →
   Build & deploy → Link repository**, choose GitHub and your new repository.
   Leave the build command empty; the publish directory comes from `netlify.toml`.
   Deploy.
4. **Add the Runware key.** Open **craftush.netlify.app/admin**, sign in with
   `ADMIN_PASSWORD`, paste the Runware key and press **Save key**.
5. **(Recommended) Set a team access code** on the same page and share it with
   your creators. Without a code, anyone who finds the link can use your credits.

## Hosting on Vercel (instead of Netlify)

The same code runs on Vercel. `api/*.js` are Vercel functions that reuse the handlers in `netlify/edge-functions/`, and `vercel.json` serves `public/`, maps `/thumbnail` and sets the admin headers. On Vercel, settings are stored in **Upstash Redis** (free) instead of Netlify Blobs.

1. Go to **vercel.com → Add New → Project**, import the GitHub repository and press **Deploy** (leave build settings empty; `vercel.json` sets them).
2. In the project, open **Storage → Marketplace → Upstash (Redis) → Create**, and connect it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. (Or create a database at upstash.com and add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` yourself.)
3. **Settings → Environment Variables**: add `ADMIN_PASSWORD` (a long password only you know).
4. **Deployments → Redeploy** so the new variables are used.
5. Open `your-project.vercel.app/admin`, sign in, paste the Runware key, and set a team code.
6. Your own domain: **Settings → Domains → Add**, then add the DNS record Vercel shows at your domain provider.

Notes: Vercel functions accept uploads up to about 4.5 MB, so a thumbnail HTML or ComfyUI workflow bigger than that must be uploaded on Netlify or made smaller. Requests can run up to 60 seconds (`maxDuration` in `vercel.json`).

## Updating later

Upload the changed files to the GitHub repository (replace the old ones).
Netlify publishes the new version automatically within about a minute.
Drag-and-drop deploys no longer work for this project, because they don't include the backend.

## Changing things

- New admin password: edit `ADMIN_PASSWORD` in Netlify, then redeploy.
- New team code or Runware key: change it on the /admin page. It takes effect immediately.

## Dashboard tools

- **Thumbnail generator:** upload a single HTML file in /admin → Dashboard. It opens at /thumbnail.
- **Idea to Video:** in ComfyUI choose Workflow → Export (API), upload that JSON in /admin, pick which text box receives the idea,
  tick the settings the team may change, and set the default ComfyUI address.
  Each ComfyUI (Desktop or server) must have CORS enabled for https://craftush.netlify.app and the workflow's models installed.

## Image prompt quality (Stunning Visuals)

Every line of the script becomes its own image prompt in step 2. The goal is images that are **relevant** to the line and look like **real, unedited photographs**.

**Relevance**
- The Claude prompt writer (`claudeSystem()` in `public/visuals/index.html`) first works out the meaning of the Hindi/Hinglish line, then picks the scene in this order: a literal scene, then a relatable real-life moment, then a plain real object or place. Glowing lightbulbs, brains, gears, arrows and other stock symbols are banned. A forest or mountain is allowed only when the line is about nature or a journey.
- Each line is sent with the lines before and after it (context only) and the full script, so the image fits its place in the story. Recurring characters are described with identical words (fill in **Characters & look** in step 2).
- Default setting is contemporary India: real faces, clothing, streets, classrooms and homes.

**Realism**
- The old glossy look (volumetric rays, golden light, saturated colour, HDR) was removed. `MASTER_LOOK` is now an unedited, candid, true-to-life photograph with real imperfections. `NATURE_LIGHT` (soft sunlight and light haze) is added only when a line is about the outdoors (`OUTDOOR_RE`).
- **Visual style** defaults to *Real photograph*. *Everyday phone photo* is the most casual and believable option.
- `NEGATIVE_PROMPT` targets the AI look (plastic skin, glow, neon, HDR, staged poses). It is sent to models that honour it (SD/SDXL style checkpoints). FLUX ignores negative prompts, so the same rules are in the positive prompt.
- FLUX Dev defaults: 32 steps and a low guidance option (*Raw natural*, 2.2) for the least AI-looking result.

**No garbled text**
- Certificates, documents, signs and screens are shown small, from behind, or blurred. Every prompt ends with a no-text sentence (`NO_TEXT_TAIL`), added automatically to edited or older prompts at generation time.

**Stunning photoreal look (default)**
- *Visual style → Stunning photoreal* gives the polished premium-stock / National Geographic look: golden-hour light, god rays through mist, rich lush greens, crisp micro-detail, deep atmospheric layers, cosy warm-lamp interiors. The other styles keep the muted "unedited" look.
- With this style the Claude brief allows golden light, volumetric rays and rich colour, the negative prompt stops blocking glow and HDR, and **Look** switches to *Vivid (3.5)*, which gives FLUX its richest colour.

**Models (fixed)**
- Script splitting and prompt writing use only **Claude Sonnet 5** on Runware (`anthropic:claude@sonnet-5`, `TEXT_MODEL`). These requests are sent with `strictModel`, so the relay never switches to another text model; if Runware rejects it, the error is shown.
- Images use only **GPT Image 2** (`openai:gpt-image@2`, `IMAGE_MODEL`).
- Only the Runware key saved in /admin is needed.

**Visual Director pipeline (default prompt writer)** – `public/visuals/director.js`
Built from the "Runware Bulk Image Generation" plan: the pipeline adds a visual-planning layer instead of turning each line straight into a prompt.
1. **Scene segmentation** (step 1, *By scene*): Claude splits where a new meaningful visual idea starts, aiming softly for the image range (default 60 to 70) without forcing it.
2. **Casting**: Claude reads the title and whole script and writes the **Character & style bible** (topic, setting, one profile per recurring person). It is editable; every prompt copies these profiles word for word so people stay consistent. Empty it to recast.
3. **Visual plan**: for every line Claude returns a structured scene (`scene_type`, `visual_concept`, `character_ids`, `main_subject`, `action`, `environment`, `time_of_day`, `lighting`, `emotion`, `shot`, `camera`, `composition`, `key_props`, `same_scene_as_previous`, `text_in_image: false`). Planned 12 lines at a time in order, so shot variety and continuity carry across the video. Shot, emotion, place and characters show as chips under each line.
4. **Prompt engineering (strict format)**: Claude fills only the line-specific parts (subject, action, emotion, environment, details, setting, shot, lens, lighting, position) and `assemblePrompt()` builds every prompt in one fixed order:
   `Photorealistic cinematic scene of <subject> <action>, <emotion>, <environment>, <details>, subtle expression, natural skin texture, authentic Indian <kind> setting, <shot>, shallow depth of field, professional commercial photography, <lens>, <lighting>, realistic shadows, <vertical/horizontal/square> composition, <position> with negative space for video editing, no visible text, no logos, no cartoon, no illustration, no CGI, no 3D render.`
   Any prompt too similar to one of the 6 before it is sent back to Claude once and rewritten to be clearly different. Strict prompts are sent to GPT Image 2 exactly as written. The *Direct* writer uses the same format without the scene plan.
5. **Quality control** (step 3): after each image, Claude looks at it (Runware `inputs.images`) and checks realism, subject, action, place, text, faces and hands, and composition. Images under the pass score are regenerated with a corrected prompt (up to 1 or 2 times); the best attempt is kept and each card shows its score. If the account can't check images, generation continues without checks and says so.
*Direct: one prompt per line* keeps the earlier behaviour.

**How a script becomes prompts**
1. Enter the **Video title** and paste the script (step 1). Claude reads the title and the whole script first.
2. **Split by scene** (default): a new image starts where a line ends or a new situation begins (new place, person, time, action, feeling or idea).
3. Each prompt is written from the title, the full script, the two lines before and the next line, so the images follow the story.
4. Prompts are **Very detailed** (200 to 250 words) by default.

**Hyper-real prompt writing**
- The default prompt writer is now the *Runware AI photographer*. It sends the full photographer brief (`claudeSystem()`) to the text model approved in /admin, so no Anthropic key is needed. *Runware Prompt Enhance* is still there as the fast, short option.
- Every prompt is built as a ten-layer shot description: shot and framing, subject, wardrobe, action and micro-expression, hands and props, setting in three depth layers (foreground, midground, background), time, weather and air, light physics (source, direction, hard or soft, colour temperature, shadows, catchlight, bounce), camera and optics (lens, aperture, distance, focus), and real-photo texture.
- Prompts are composed for the chosen **Frame shape** (16:9, 9:16, 1:1 or 4:3) instead of always assuming vertical.
- "Hyper-real" means more physical facts, not hype words. Words like *8k* or *hyper-realistic* are still banned because they make FLUX images look fake.

**Prompt strength** (step 2): Standard (70 to 100 words), Rich (110 to 150), Maximum (160 to 210, default) or Ultra hyper-real (200 to 250).

**Strengthen before generating** (step 3, on by default): right before images are generated, any weak prompt (empty, template, under about 90 words, or missing light, lens and texture details) is rebuilt by the AI photographer. It keeps the prompt's idea. If the AI isn't available, `boostPrompt()` adds the `REALISM_LAYERS` (composition, skin, materials, light, lens) when the prompt is sent, so a thin prompt never reaches the image model.

To change the look for the whole team, edit `MASTER_LOOK`, `STYLES`, `STYLE_TAGS`, `REALISM_LAYERS` and `claudeSystem()` at the top of the "STEP 2: prompts" section.

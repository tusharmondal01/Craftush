# Narration timestamp recovery update

Prepared on 2026-10-08 against production commit `f0cdffb4678c6837d9b680d19a66ab4d204e8338` and approved for publication by the user. `npm test`: **108 passed, 0 failed**. `npm run build` passed. Ten new regressions cover incomplete word timestamps, bounded recovery, punctuation, overlap boundaries, repeated Hindi/English words, missing starts, review-gated export and original narration preservation.

Real inference with the pinned q8 speech model succeeded on an 11-second official speech fixture and three variants covering truncation, silence, pauses and repeated passages across windows (up to 36 seconds). The actual-page DOM upload/review/export check reported zero page errors; decoding and worker transport were controlled. The user's exact HeyGen recording, browser WASM execution and native Premiere import remain unverified. See `AUDIO-SYNC-FIX.md` for behavior, test scope and limits.

The existing backend, API credentials, Runware routing, ChatGPT integration, other panels and deployment settings remain unchanged. The release checks below are historical evidence for the existing production version.

# Merged v17 production release checks

`npm test`: **98 passed, 0 failed** on 2026-10-08. This includes all 16 existing ChatGPT bridge and MCP protocol checks plus the 11 supplied v17 narration-flow regressions. `npm run build` passed with the exact pinned documentary engine checksums and generated ChatGPT instructions.

All files in `api/` and `netlify/`, the ChatGPT frontend, Documentary Studio, package dependencies, lockfile and Vercel configuration remain identical to the previous production commit `44eaec3203ce3cae1c3876e7112c886c66ca0ae7`. Runware settings, credential selection, model routing and team access rules are preserved. The ZIP update changes Stunning Visuals narration sync and image/export identity tracking. No paid provider generation was performed.

The supplied archive verification follows.

# Craftush v17 verification

`npm test`: **82 passed, 0 failed**. Eleven new regressions exercise automatic upload-to-sync, failure/retry, SRT/worker replacement races, audio decode replacement races, subtitles selected during decoding, language changes, scene/image identity across saved prompts and exports, quality-review winner links, stale generated images, incomplete image batches, and listening through long scenes.

A full DOM check loads every Stunning Visuals page script with actual HTML elements. It checks automatic upload/decode/sync, image changes at the playhead, compact matched cards, expanded recovery placement, final confirmation and matching XML filenames. The check reports zero page script errors. Audio decoding and worker transcription use controlled fixtures in this check; real-model transcription and native Premiere import were not exercised. Browser layout inspection was unavailable because the browser download was blocked in this environment.

All existing alignment and transition regressions continue to pass, including repeated phrases, Hindi/Hinglish, unequal speaking speeds, long pauses, absent/extra narration, invalid starts and original PCM sample preservation. No paid Runware generation was made for this fix.

The previous v16 verification is retained below as historical evidence for Documentary Studio.

# Craftush v16 verification

## Automated regressions

`npm test`: 71 passing tests, zero failures. The original 59 tests are retained. Twelve additional checks cover exact workflow prompts and settings, master-plan validation, team access/tool visibility, task receipts and recovery, provider-response privacy, project files, audio-preserving FFmpeg commands and restricted media range downloads.

## Browser workflow

Chromium 153 was used with mocked Runware responses and actual browser FFmpeg execution. No paid model generation was made.

- One master plan, thirteen scene-director jobs and thirteen video jobs completed through the asynchronous interface.
- Pausing the first master job, reloading and resuming reused its original UUID. Reopening the completed project started no generation automatically.
- Each director received the complete master plan and its correct target scene.
- Scene preview controls, project JSON download, music upload, final-video download and IndexedDB recovery were exercised.
- All four stages fit a 390-pixel mobile viewport without horizontal overflow; desktop and mobile screens were visually inspected.
- Browser JavaScript error count: zero.

The assembled MP4 also loaded into the HTML video player with duration 156.032 seconds and ready state 4, and its playhead advanced during playback. Export-only browser checks passed for joining without music, normalizing thirteen incompatible short clips to 720 × 1280, rejecting invalid media and cancellation.

## Real media export

Thirteen 12-second 720 × 1280 H.264/AAC fixtures with different colors and audio tones were concatenated in the browser. A separate 15-second music fixture was looped and mixed at the default −18 dB setting, while original audio stayed at 0 dB.

Native FFprobe verified the downloaded output independently: H.264 video, 720 × 1280, stereo AAC at 48 kHz, duration **156.032 seconds**. Frame samples verified all thirteen scenes in order. Audio spectrum checks verified each scene's original tone remained dominant and the background music was present throughout the documentary.

Invalid/truncated media was correctly blocked during inspection. The pinned FFprobe core's successful `-1` return sentinel is handled only when a fresh output file contains valid metadata for the exact input being inspected; stale metadata is never reused.

Live Runware responses, account model availability and creative/voice quality require verification with the configured account. Local checks do not establish those provider outcomes. Existing Premiere import/render verification remains separate.

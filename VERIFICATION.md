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

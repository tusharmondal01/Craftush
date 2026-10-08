# Stunning Visuals: incomplete narration timestamps

This update is prepared against production commit `f0cdffb4678c6837d9b680d19a66ab4d204e8338`. The user approved publication to GitHub and the separate Vercel project on 2026-10-08.

## Problem and behavior

After narration upload, speech recognition could return a punctuation token or spoken word with a missing, zero-length or out-of-range timestamp. The old window collector threw immediately, discarding the usable transcription for the entire recording. This produced the error in the supplied HeyGen audio screenshot even though audio decoding had succeeded.

The collector now ignores punctuation-only tokens and preserves valid word timings. An affected section receives one automatic retry with up to 0.75 seconds of recognition-only trailing silence. A retry is accepted only when its normalized transcript is unchanged and fewer timings are unresolved. A failed retry preserves the first result.

A word with an observed start and an incomplete end remains an explicitly uncertain point, without an invented duration. A missing start is not fabricated: the affected section is marked for a listening check. Uncertain scene starts require review before export. The existing SRT and manual-start recovery controls remain available if no usable spoken-word starts can be found. Overlap merging preserves repeated words at distinct audio positions.

The original narration samples, WAV export, scene/image IDs and Premiere filenames remain unchanged. The UI shows recovery progress and requests listening checks for unresolved timings. Updated worker and script versions prevent reuse of the old timestamp collector.

## Verification

- `npm test`: 108 passing tests, zero failures, including 10 new timestamp-recovery regressions.
- `npm run build`: passed, including the pinned engine checksum checks.
- The actual pinned Whisper model and Transformers.js 3.8.1 ran with q8 weights using Node CPU on an official 11-second speech fixture. Additional real inference checks covered a cut-off word, opening silence, a long pause and repeated passages crossing multiple windows (up to 36 seconds). All completed with ordered word timings.
- An actual-page DOM check exercised upload, automatic sync, an intentionally incomplete timestamp, review-gated export, matching scene/image IDs and preserved narration sample count. It reported zero page script errors. Its audio decoder and worker transport were controlled fixtures.
- All 54 protected backend, admin, ChatGPT, Documentary Studio, dependency and deployment-configuration files remain byte-identical to the production snapshot. No provider API calls or credential changes were made.

The user's exact HeyGen recording was not attached. Browser WASM inference, decoding that particular recording and native Premiere import were not exercised in this update's checks. The observed incomplete-timestamp failure was reproduced with controlled regression fixtures.

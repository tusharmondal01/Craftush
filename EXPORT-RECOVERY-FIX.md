# Premiere export recovery

An inference error in one narration section previously stopped the entire recording. The speech adapter now makes one bounded, padded retry for that section, retains usable words, continues later sections, and marks unresolved timing ranges for listening review. It does not invent missing times or alter the exported narration. A healthy speech worker stays loaded for subsequent recordings; request tickets prevent stale results from replacing new narration.

Step 4 now presents audio, cut review and downloads in sequence. The separate XML and complete ZIP buttons are both visible. A checklist explains exactly what blocks them. Users can restore their numbered JPEG, PNG or WebP images without generating them again, use matching SRT timings, or set each unresolved image start at the audio playhead. A complete ZIP requires every image unless users explicitly choose to reuse existing files. Packing disables duplicate exports and cancels an obsolete download if the project changes. JSZip is served with the site and its license is included.

## Verification before publication

- `npm test`: 116 passed, zero failed. Eight new regressions cover section failures, bounded recovery, worker reuse, stale replies, guided cuts, missing-image gating, project changes during packing and atomic local image restoration.
- `npm run build`: passed, including the exact documentary engine checksums.
- The pinned Whisper-small timestamped model on the CPU transcribed a real 11-second audio fixture into 22 words with zero timing issues. Image starts aligned to 0, 3.26 and 7.52 seconds; at 30 fps the exported cuts are 0, 98 and 226 frames and the sequence ends at frame 330.
- An offline JSDOM integration loaded the complete page and its actual scripts, selected full-stop splitting, restored three numbered image fixtures, loaded narration, confirmed cuts and completed both real download handlers. Web Audio, media playback and the Worker were environment adapters; the successful Worker response replayed the separately measured real-model result. Two controlled recognition failures also completed both downloads through exact SRT recovery and guided manual recovery.
- Independent ZIP/XML/image/WAV validation passed for all three flows. Every ZIP contains ten expected files. Separate and packaged XML agree in media, cuts and effects, apart from the independently generated sequence UUID. Image bytes and scene IDs agree across the package, and exported PCM samples equal the decoded source samples after the existing 16-bit WAV encoding.
- Backend, admin, ChatGPT integration, documentary source, model settings, dependency lockfile and deployment configuration remain byte-identical to the current main commit.

## Limits

No GitHub branch or Vercel deployment was changed. Publication requires the user's requested approval. Browser policy blocked opening the unpublished local file, so this revision has not been visually inspected or exercised with browser WASM. Native Premiere import/render is not available here. The user's failing HeyGen recording was not attached this turn; the sample tests do not establish that recording's exact failure or alignment. The three JPEGs are clearly labelled export fixtures, not generated relevance examples.

Base: `0f7dd34c09cd07f72dd5134f9ea7ea7a02a985da`. When releasing, add only the changed/new files over the current Git tree; preserve the existing reference source tarball that was not needed for local checks.

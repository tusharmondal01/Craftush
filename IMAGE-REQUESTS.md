# Craftush Image Generator — full-request delivery

Team members open [Image Generator](https://tusharmondal01.github.io/Craftush/images/), sign in with the studio team code, and submit one image or a bulk request. No ChatGPT account is needed for team submission or downloads.

## Current delivery setting

Generate the entire request first, then send its saved images to Craftush in one final delivery phase. A 132-image request is processed as 132 images; ten is only the maximum native dispatch group, not a request limit. No image bytes are uploaded between generation groups.

The page updates during final delivery, and Download all (.zip) saves delivered originals together. Final transport sends files separately to respect existing size limits, so visibility is not an atomic all-at-once switch. No speedup is guaranteed. Stop request prevents later generation groups and preserves finished results and attempt receipts. Calls already dispatched to the native service may finish.

## Owner's computer

The existing Codex chat uses the built-in ImageGen skill only. No Runware, generation API key or separately billed generation API is used for these requests. Keep the computer awake, online and Codex running. Normal account limits apply.

The five-minute automation checks only while this chat has no pending owner work. It processes one oldest waiting request and preserves that target across groups and safe interruptions. An owner-stopped run stays stopped until explicitly resumed. The private optional owner code is a chat command, never website authentication, and is excluded from public source and packages.

## Native transport

The helper transports queue data and saved original bytes; it does not generate images. Windows pairing credentials stay in their existing protected local connection. Never read, print, package or publish those private files. Do not alter their permissions.

1. Verify authenticated status, heartbeat, status with normal network permission and the configured runner. The first genuinely scheduled verification for a runner records proof and ends without processing.
2. Prepare at most ten items of the same pinned request. Save all prompts and inspect unique references before start.
3. Start the exact batch once. Only a fresh complete acknowledgement authorizes one native call per started job; duplicate or uncertain starts never authorize another generation.
4. Dispatch independent built-in calls together. Keep the exact tool-returned output paths. After all settle, save/fingerprint their original bytes with stage-batch. Its backend acknowledgement contains metadata only, never image bytes.
5. Repeat preparation and generation for the same request, including a final short group. Saved groups survive interruption. Do not use per-group uploads.
6. Once every remaining item has a saved accepted original, request-status reports ready_to_upload. flush-request verifies remote coverage and starts final delivery for all saved groups. Upload failures preserve receipts and resume identical bytes later; never regenerate.

Backend enforcement requires all request items to be staged or already completed before delivery begins. Uploaded bytes must match the saved fingerprint, MIME, name and size. New bulk claims always use after_request, including older clients. Existing legacy receipts remain recoverable by adopting saved groups into the request spool.

Commands for the owner computer:
    node scripts/imagegen-bridge.mjs prepare-batch --request <pinned-request-id> --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs start-batch --batch <exact-batch-id> --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs stage-batch --manifest <exact-path-manifest> --result-dir <workspace-originals> --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs request-status --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs defer-batch --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs flush-request --request <pinned-request-id> --state-dir <private-directory>

The older single-job and flush-batch commands are for old receipt recovery; they must not bypass full-request coverage. Never guess a newest generated file, change original pixels, reset attempts or create automatic replacements.

## Limits and recovery

Up to 200 images and one reference per request. Each PNG, JPEG or WebP is at most 5 MiB. Existing queue storage limits remain: 400 results and 512 MiB per request, 1,000 requests and 2 GiB total. The current team code shares all requests and results with studio members.

Unstarted claims expire after ten minutes. Started native jobs without an outcome require attention after thirty minutes; staged originals do not expire as uncertain native work while later groups generate. Cancellation stops later groups and never resets an uncertain native attempt. Existing originals and delivered files are preserved.

## Validation

Full-request coverage, 132-image local transport, final short groups, no early uploads, exact-byte retry, cancellation, pinned request isolation, duplicate/lost starts and saved-image integrity are covered by focused tests. SQLite runtime checks exercise the compiled backend. Website tests retain Stop controls and ZIP downloads. Publishing this setting does not invoke native ImageGen or claim a real queue request.

# Craftush Image Generator — project folders in the owner's chat

Team members open [Image Generator](https://tusharmondal01.github.io/Craftush/images/), sign in with the studio team code, and submit one thumbnail or a bulk brief. Keep the track or project name, individual track titles, shared prompt, style notes, requested dimensions and optional reference together in one request.

## Current setting

Generate every image in one request **one at a time**, then give the owner a folder in the existing Codex chat. New thumbnail files are not uploaded to Craftush. A 132-image request still means all 132 images. The internal ten-item preparation window is a receipt boundary, not native concurrency or a request limit: generationConcurrency 1, generationBatchSize 10, uploadPolicy local_folder.

The folder uses the exact project name, and image filenames use the exact track titles with the actual raster extension. Only characters or names Windows cannot use are mapped; the local manifest records that mapping. Duplicate track names or conflicting existing files require attention instead of silently overwriting a different result. Native size requests remain guidance; the original image bytes are preserved.

Team members receive a brief accepted acknowledgement. While that submission remains in memory on the page, they can Stop it. There is no team request history, thumbnail preview, download list or background history polling. Reloading or locking the page clears the acknowledgement; it does not cancel an accepted request. Stop prevents later generation; a native call already running may finish and its saved original is kept.

## Owner archive and privacy

The owner signs in with the existing admin password to review the private request archive. All prior request records, notes, references and previously uploaded thumbnails remain available to the owner, including their existing preview and ZIP download controls. New local-folder completions show the folder name and completion status instead of missing-image warnings. The folder link is provided in the owner's chat; it is not automatically sent to team members.

Team API access returns only access confirmation, create acknowledgement and Stop acknowledgement. Team list responses are empty; detail and asset access require owner authentication. Hiding team history does not delete the owner's underlying records or stored image bytes. Credentials and the current team acknowledgement stay in page memory; locking the page clears private owner details and authenticated preview URLs.

## Owner's computer

The existing Codex chat uses built-in ImageGen through the imagegen skill. No Runware, generation API key, generation CLI or separately configured paid image API is used. Keep the computer awake, online and Codex running. Normal account and native generation limits still apply; this delivery change does not guarantee a speed or token reduction.

The five-minute automation checks only when trusted prior chat context proves no owner work is pending. It pins one oldest waiting request and preserves that target through preparation windows and safe interruptions. An owner-stopped run remains stopped until explicitly resumed. The optional private owner code is a chat command, never website authentication, and stays out of public source and packages.

## Queue transport and saved originals

The existing Windows helper transports request data and receipt metadata. It does not generate images or upload new thumbnail bytes. Read scoped credentials only through that helper; never inspect, print, package or publish credential containers or token files, and never weaken their permissions.

1. Acquire the exact shared operation lease with the local preflight. Active or unknown prior work skips before queue contact. No time-based lease takeover is allowed.
2. With actual normal network permission, verify authenticated status, heartbeat, status for the configured runner. The first genuine scheduled verification records matching proof and ends without processing; later runs require that existing proof.
3. Prepare up to ten items of the same pinned request. Save the exact prompts and inspect unique references before starting.
4. Call start-batch once for that exact window. Only a fresh complete acknowledgement permits one native call per acknowledged job. Duplicate, uncertain or lost start responses never authorize another call.
5. Await each built-in native call before invoking the next. No parallel generation or extra shell, queue, save, upload, test or inspection commands run between native calls. Keep the exact tool-returned output paths and timestamps, display the results, and preserve returned outputs before handling new owner work. Never revise or automatically generate replacements.
6. Save the exact output manifest and receipts. stage-batch copies and fingerprints unchanged originals; only staging metadata is acknowledged by Craftush. Continue the same request, including a final short window.
7. request-status must confirm full local coverage and ready_to_finalize. finalize-folder copies exact originals into the request-title folder, then sends finishLocalRequest with names, sizes, MIME types and fingerprints only. No image bytes or private filesystem paths are sent.
8. Persist progress and release only this invocation's exact lease. A lost completion acknowledgement resumes the same saved folder idempotently; it never regenerates images. Give the owner the completed folder link in chat.

Commands for the owner computer, using its configured Node executable and fixed working directory:
    node scripts/imagegen-bridge.mjs prepare-batch --request <pinned-request-id> --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs start-batch --batch <exact-batch-id> --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs stage-batch --manifest <exact-path-manifest> --result-dir <workspace-originals> --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs request-status --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs defer-batch --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs adopt-local-request --request <pinned-request-id> --state-dir <private-directory>
    node scripts/imagegen-bridge.mjs finalize-folder --request <pinned-request-id> --output-root <absolute-owner-output-directory> --state-dir <private-directory>

Legacy after_request receipts can be adopted into local delivery without another native attempt. Previously delivered originals count once and stay in the owner archive. Do not call flush-request, flush-batch, legacy next, start or complete: their image upload/recovery paths are disabled. Never guess a newest generated file, alter pixels, reset attempts or replace an uncertain outcome.

## Limits and recovery

Each request accepts up to 200 images and one reference. PNG, JPEG and WebP references and accepted saved originals are limited to 5 MiB each. Existing backend archive limits remain 400 stored results and 512 MiB per request, 1,000 requests and 2 GiB total; new local folders do not add thumbnail bytes to that archive.

Unstarted claims expire after ten minutes. Started native jobs without an outcome require attention after thirty minutes. Exact saved receipts can acknowledge originals, while staged originals remain available through later windows. Cancellation and local delivery preserve previous originals and attempt receipts. Missing or changed originals, filename collisions and uncertain native outcomes require attention; they are never repaired with automatic regeneration.

## Validation

Focused tests cover sequential local policy, full request coverage, exact-byte folder copies, filename safety and collision rejection, idempotent metadata completion, migration of saved legacy originals, cancellation, pinned requests, duplicate/lost starts and receipt integrity. Backend tests verify empty team history and denied team detail/asset access while owner history remains intact. Website tests verify acknowledgement and Stop without history polling, owner archive previews/ZIP downloads, local-folder completion and cleared private state on lock. Publishing this setting does not invoke ImageGen or claim a live queue request.

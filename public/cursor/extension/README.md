# Cursor Studio Companion

An optional Chrome / Microsoft Edge extension for cursor-aware browser recordings in Cursor Studio. It records cursor positions and clicks from **one browser tab you explicitly select**, and sends them to the open recorder. It does not capture video, audio, keystrokes, page body text or passwords. It contains no network requests and does not send your cursor data to a cloud service.

## Install

1. Extract `cursor-studio-extension.zip` to a folder you will keep.
2. In Chrome, open `chrome://extensions`. In Edge, open `edge://extensions`.
3. Turn on **Developer mode**, click **Load unpacked**, and select the extracted folder containing `manifest.json`.
4. Pin **Cursor Studio Companion** from your browser's Extensions menu.
5. Reload Cursor Studio and the browser page you want to record if they were already open when you installed the extension.

## Record with cursor tracking

1. Open `https://tusharmondal01.github.io/Craftush/cursor/` in Chrome or Edge, or launch the desktop ZIP at `http://127.0.0.1:4173/`.
2. Start a recording and choose a **browser tab** in your browser's share dialog.
3. Switch to that same tab, open the companion extension, then click **Track this tab**. The extension cannot verify which tab you chose in the browser's share dialog, so select the same one.
4. Move and click normally. The popup shows the selected tab. Clicking **Clear selected tab** pauses cursor telemetry while leaving your recording running.
5. Stop in Cursor Studio. Tracking stops and your selection is cleared. Closing or reloading the recorder also ends the tracking session.

When recording a new tab, repeat the selection. Navigating within the selected tab retains selection. Choose a different tab using the popup if needed.

## Scope and privacy

- Supports ordinary HTTP/HTTPS web pages in Chrome and Edge. Browser settings pages, extension pages, Chrome Web Store, browser toolbars, other desktop applications, and embedded frames are not tracked.
- Coordinates are relative to the top-level page's visible viewport. Select **a browser tab**, not an entire desktop or a window, for alignment with your recording.
- Cursor movement is limited to 30 samples per second; clicks are sent immediately.
- Cursor samples include the selected page's URL, title, viewport dimensions, timestamp and pointer coordinates. Samples are relayed, not stored by the extension. The active session and selected-tab metadata are temporarily held in browser session storage and cleared on stop or browser restart.
- Broad web-site access allows tracking on whichever web tab you select. Pointer listeners are attached only after your allowlisted recorder starts a session and you select a tab; other tabs are ignored.
- Only `https://tusharmondal01.github.io/Craftush/cursor/` and local development origins `http://localhost:4173` / `http://127.0.0.1:4173` can start a session. Other paths on the GitHub site cannot activate the tracker.
- Extension installation is optional. Cursor Studio can still capture video without it; this companion supplies real cursor telemetry for the selected web tab.

## Recorder integration

The recorder posts messages to its own window origin. Use a fresh random nonce of at least 24 characters per recording:

```js
window.postMessage({ type: 'CURSOR_STUDIO_EXTENSION_PING' }, location.origin);
window.postMessage({ type: 'CURSOR_STUDIO_START_TRACKING', nonce }, location.origin);
// On stop:
window.postMessage({ type: 'CURSOR_STUDIO_STOP_TRACKING', nonce }, location.origin);
```

Listen for `CURSOR_STUDIO_EXTENSION_READY` (version), `CURSOR_STUDIO_TRACKER_STATUS` (nonce, active, targetTabId, targetTitle, targetUrl), and `CURSOR_STUDIO_POINTER` (nonce, normalized x/y, click, timestamp, viewportWidth/Height, screenX/Y, url, title). Validate `event.source === window`, `event.origin === location.origin`, and the current nonce before accepting data. Coordinates are viewport normalized from 0 to 1. Timestamps are Unix milliseconds, so the recorder can map them to recording elapsed time.

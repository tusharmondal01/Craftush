// Range-limited media fallback: avoids cross-origin download and function body limits.
import { storageErrorResponse } from './storage-errors.js';
export const MEDIA_CHUNK_BYTES = 2 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 160 * 1024 * 1024;

export function validateMediaURL(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Invalid video URL.'); }
  if (u.protocol !== 'https:' || u.hostname !== 'vm.runware.ai' || u.port || u.username || u.password || !u.pathname.startsWith('/video/')) throw new Error('Only Runware-generated video URLs can be downloaded.');
  return u.href;
}

export function createMediaHandler(deps) {
  const { openStore, readSettings, teamCodeOk, dashboardView, fail, fetch: request } = deps;
  return async req => {
    try {
      if (req.method !== 'POST') return fail('Method not allowed', 405);
      const settings = await readSettings(openStore());
      if (!(await teamCodeOk(req, settings))) return fail('Wrong team access code.', 401);
      if (dashboardView(settings).cards.documentary.enabled === false) return fail('Documentary Studio is turned off.', 403);
      const raw = await req.text(); if (raw.length > 8192) return fail('Invalid video request.', 400);
      let body, url;
      try { body = JSON.parse(raw); url = validateMediaURL(body.url); } catch (e) { return fail(e.message || 'Invalid video request.', 400); }
      const start = body.start ?? 0;
      if (!Number.isInteger(start) || start < 0 || start >= MEDIA_MAX_BYTES) return fail('Invalid download offset.', 400);
      const end = Math.min(start + MEDIA_CHUNK_BYTES - 1, MEDIA_MAX_BYTES - 1);
      const response = await request(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'manual', signal: AbortSignal.timeout(45000) });
      if (response.status >= 300 && response.status < 400) return fail('Runware redirected this video. Refresh its result URL before downloading.', 502);
      if (!response.ok) return fail(response.status === 404 || response.status === 403 ? 'This video URL expired. Upload a previously downloaded scene or retrieve its result again.' : 'Runware could not deliver this video.', 502);
      const length = Number(response.headers.get('content-length'));
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (response.status === 206 && (!contentRange || +contentRange[1] !== start || +contentRange[2] > end || +contentRange[3] > MEDIA_MAX_BYTES)) {
        await response.body?.cancel(); return fail('Runware returned an invalid video range.', 502);
      }
      if (response.status === 200 && (start !== 0 || !Number.isFinite(length) || length <= 0 || length > MEDIA_CHUNK_BYTES)) {
        await response.body?.cancel(); return fail('This host does not support partial downloads. Download the scene from its preview and upload that MP4 here.', 502);
      }
      const reader = response.body.getReader(), pieces = []; let bytes = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > MEDIA_CHUNK_BYTES) { await reader.cancel(); return fail('Video chunk exceeds the download limit.', 502); }
        pieces.push(value);
      }
      if (!bytes || (contentRange && bytes !== +contentRange[2] - start + 1)) return fail('The video download was interrupted. Retry downloading the scene.', 502);
      const merged = new Uint8Array(bytes); let pos = 0;
      for (const piece of pieces) { merged.set(piece, pos); pos += piece.length; }
      return new Response(merged, { status: 200, headers: { 'content-type': 'video/mp4', 'cache-control': 'no-store',
        'x-media-total': String(contentRange ? +contentRange[3] : bytes), 'x-media-next': String(start + bytes) } });
    } catch (error) { return storageErrorResponse(error) || fail('The scene could not be downloaded. Retry or upload the scene MP4.', 502); }
  };
}

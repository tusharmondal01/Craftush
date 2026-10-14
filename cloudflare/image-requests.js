// Native ChatGPT generation runs in a paired local Codex session. This backend
// coordinates work and stores images; it has no AI/provider client or credential.
export const IMAGE_REQUEST_LIMITS = Object.freeze({
  items: 200, assetBytes: 5 * 1024 * 1024, deliveryImages: 1,
  briefBytes: 1024 * 1024, requestAssetBytes: 512 * 1024 * 1024,
  queueAssetBytes: 2 * 1024 * 1024 * 1024, requests: 1000, results: 400,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['queued', 'in_progress', 'completed', 'cancelled']);
const encoder = new TextEncoder();
export const IMAGE_RUNNER_LIMITS = Object.freeze({ heartbeatMs: 10 * 60 * 1000, claimMs: 10 * 60 * 1000, startedMs: 30 * 60 * 1000 });
const issue = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const text = (value, limit, label, required = false) => {
  if (value !== undefined && typeof value !== 'string') throw issue(`${label} must be text.`);
  const result = (value || '').trim();
  if (result.length > limit) throw issue(`${label} is too long (maximum ${limit} characters).`);
  if (required && !result) throw issue(`${label} is required.`);
  return result;
};
const id = value => {
  if (!UUID.test(String(value || ''))) throw issue('A valid request ID is required.');
  return value.toLowerCase();
};
export function imageFilename(value, fallback = 'image.png') {
  const cleaned = String(value || '').replace(/[/\\<>:"|?*\x00-\x1f\x7f]/g, '-').replace(/[^\x20-\x7e]/g, '-').replace(/\s+/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 150);
  return cleaned || fallback;
}
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value)), b => b.toString(16).padStart(2, '0')).join('');
const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
const ascii = (bytes, offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));

// Verify raster container signatures and dimensions rather than trusting a file extension.
function rasterMime(bytes) {
  if (bytes.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) {
    let cursor = 8, imageData = false, ended = false, dimensions;
    while (cursor + 12 <= bytes.length) {
      const length = u32(bytes, cursor), kind = ascii(bytes, cursor + 4, 4);
      if (cursor + length + 12 > bytes.length) throw issue('The PNG reference or result is incomplete.');
      if (cursor === 8) {
        if (kind !== 'IHDR' || length !== 13) throw issue('The PNG header is invalid.');
        dimensions = [u32(bytes, cursor + 8), u32(bytes, cursor + 12)];
      }
      if (kind === 'IDAT' && length) imageData = true;
      cursor += length + 12;
      if (kind === 'IEND') { ended = length === 0 && cursor === bytes.length; break; }
    }
    if (!imageData || !ended) throw issue('The PNG reference or result is incomplete.');
    checkDimensions(dimensions);
    return 'image/png';
  }
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let cursor = 2, dimensions;
    while (cursor + 4 <= bytes.length) {
      if (bytes[cursor++] !== 255) break;
      while (bytes[cursor] === 255) cursor++;
      const marker = bytes[cursor++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = (bytes[cursor] << 8) | bytes[cursor + 1];
      if (length < 2 || cursor + length > bytes.length) throw issue('The JPG reference or result is incomplete.');
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) throw issue('The JPG header is invalid.');
        dimensions = [(bytes[cursor + 5] << 8) | bytes[cursor + 6], (bytes[cursor + 3] << 8) | bytes[cursor + 4]];
      }
      cursor += length;
    }
    if (!dimensions) throw issue('The JPG reference or result has no valid image header.');
    checkDimensions(dimensions);
    return 'image/jpeg';
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.length) throw issue('The WebP reference or result is incomplete.');
    const kind = ascii(bytes, 12, 4), length = view.getUint32(16, true);
    if (length + 20 > bytes.length) throw issue('The WebP header is invalid.');
    let dimensions;
    if (kind === 'VP8X' && length === 10) dimensions = [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
    else if (kind === 'VP8 ' && length >= 10 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) dimensions = [view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383];
    else if (kind === 'VP8L' && length >= 5 && bytes[20] === 47) dimensions = [1 + bytes[21] + ((bytes[22] & 63) << 8), 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10)];
    if (!dimensions) throw issue('The WebP reference or result has no valid image header.');
    checkDimensions(dimensions);
    return 'image/webp';
  }
  throw issue('Upload a valid PNG, JPG or WebP image.');
}
function checkDimensions([width, height]) {
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64000000) throw issue('The image dimensions are too large or invalid.');
}

export async function normalizeImageAsset(input, assetId, kind, itemId = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw issue('An image upload is required.');
  const base64 = input.base64;
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(IMAGE_REQUEST_LIMITS.assetBytes / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw issue('The image must be valid base64 and no larger than 5 MB.', 413, 'ASSET_TOO_LARGE');
  let bytes;
  try { bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); } catch { throw issue('The image upload is invalid.'); }
  if (!bytes.length || bytes.length > IMAGE_REQUEST_LIMITS.assetBytes) throw issue('Each image must be no larger than 5 MB.', 413, 'ASSET_TOO_LARGE');
  const mime = rasterMime(bytes);
  if (input.mime !== mime) throw issue('The image type does not match its file contents.');
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const name = imageFilename(input.name, `image.${extension}`).replace(/\.[^.]*$/, '') + '.' + extension;
  return { assetId: id(assetId), kind, itemId, name, mime, bytes: bytes.length, base64, fingerprint: await hash(bytes) };
}

async function readBody(request) {
  const max = Math.ceil(IMAGE_REQUEST_LIMITS.assetBytes / 3) * 4 * IMAGE_REQUEST_LIMITS.deliveryImages + IMAGE_REQUEST_LIMITS.briefBytes + 65536;
  const length = Number(request.headers.get('content-length'));
  if (length > max) throw issue('This upload is too large. Deliver one image at a time.', 413, 'BODY_TOO_LARGE');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw issue('Send the request as JSON.', 415);
  if (!request.body) throw issue('A request body is required.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw issue('This upload is too large. Deliver one image at a time.', 413, 'BODY_TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw issue('The request contains invalid JSON.'); }
}

function normalizeBrief(body) {
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > IMAGE_REQUEST_LIMITS.items) throw issue('Include between 1 and 200 thumbnail briefs.');
  const requestId = id(body.submissionId);
  const dimension = (value, label) => {
    if (!Number.isInteger(value) || value < 64 || value > 8192) throw issue(`${label} must be between 64 and 8192 pixels.`);
    return value;
  };
  const request = {
    id: requestId, name: text(body.name, 100, 'Your name', true), title: text(body.title, 200, 'Batch title', true),
    styleNotes: text(body.styleNotes, 4000, 'Style notes'), width: dimension(body.width, 'Width'), height: dimension(body.height, 'Height'),
    items: body.items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw issue('Each thumbnail needs a title and prompt.');
      const title = text(item.title, 200, 'Thumbnail title', true), prompt = text(item.prompt, 20000, 'Thumbnail prompt', true);
      return { id: String(index + 1), title, prompt, filename: imageFilename(item.filename, `${String(index + 1).padStart(3, '0')}-${title.slice(0, 50)}.png`) };
    }),
  };
  if (encoder.encode(JSON.stringify(request)).length > IMAGE_REQUEST_LIMITS.briefBytes) throw issue('The batch brief is too large. Keep the total text below 1 MB.', 413, 'BRIEF_TOO_LARGE');
  return request;
}
function updateFields(body) {
  const result = { id: id(body.id) };
  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) throw issue('Choose queued, in_progress, completed or cancelled.');
    result.status = body.status;
  }
  if (body.notes !== undefined) result.notes = text(body.notes, 4000, 'Owner notes');
  return result;
}

export function createImageRequestsHandler({ openStore, readSettings, env, safeEqual, json, now = () => new Date().toISOString() }) {
  return async request => {
    try {
      const store = openStore(), settings = await readSettings(store), url = new URL(request.url);
      const enabled = settings.dashboard?.cards?.images?.enabled !== false;
      const teamCode = typeof settings.teamCode === 'string' ? settings.teamCode : '';
      const password = env('ADMIN_PASSWORD');
      const admin = !!password && safeEqual(request.headers.get('x-admin-password') || '', password);
      const method = request.method;
      if (method === 'GET' && url.searchParams.get('action') === 'meta') {
        const { generator } = await store.imageRequests('generator-meta', { now: now() });
        return json({ enabled, codeRequired: true, teamConfigured: !!teamCode, limits: IMAGE_REQUEST_LIMITS,
          generator, generatorConnected: generator.connected, generatorHeartbeatAt: generator.lastSeenAt });
      }
      if (!['GET', 'POST'].includes(method)) throw issue('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
      if (request.headers.has('x-image-runner')) {
        const token = request.headers.get('x-image-runner');
        if (!/^ir_[0-9a-f]{64}$/.test(token || '')) throw issue('The image generator connection is invalid. Pair this computer again.', 401, 'RUNNER_ACCESS_REQUIRED');
        if (!enabled) throw issue('Image generation is turned off by the owner.', 403, 'TOOL_DISABLED');
        const tokenDigest = await hash(token), stamp = now();
        const runnerPayload = { tokenDigest, now: stamp };
        if (method === 'GET') {
          const action = url.searchParams.get('action');
          if (action === 'runnerMeta') return json(await store.imageRequests('runner-meta', runnerPayload));
          if (action === 'runnerJob') return json(await store.imageRequests('runner-job', { ...runnerPayload, jobId: id(url.searchParams.get('jobId')) }));
          if (action === 'runnerAsset') {
            const jobId = id(url.searchParams.get('jobId')), assetId = id(url.searchParams.get('assetId'));
            const { job } = await store.imageRequests('runner-job', { ...runnerPayload, jobId });
            if (!job.references.some(asset => asset.assetId === assetId)) throw issue('This reference does not belong to the claimed image job.', 403, 'RUNNER_SCOPE_DENIED');
            return await store.imageRequestAsset(job.requestId, assetId);
          }
          throw issue('This connection can only access image generation jobs.', 403, 'RUNNER_SCOPE_DENIED');
        }
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw issue('A request object is required.');
        if (body.action === 'runnerHeartbeat') return json(await store.imageRequests('runner-heartbeat', runnerPayload));
        if (body.action === 'claim') return json(await store.imageRequests('runner-claim', { ...runnerPayload, claimId: id(body.claimId) }));
        if (!['start', 'report', 'complete'].includes(body.action)) throw issue('This connection can only claim, start, finish or report image jobs.', 403, 'RUNNER_SCOPE_DENIED');
        const jobId = id(body.jobId);
        if (body.action === 'start') return json(await store.imageRequests('runner-start', { ...runnerPayload, jobId }));
        if (body.action === 'report') {
          if (!['failed', 'needs_attention'].includes(body.state)) throw issue('Report a confirmed failure or an uncertain generation.');
          return json(await store.imageRequests('runner-report', { ...runnerPayload, jobId, state: body.state, message: text(body.message, 1000, 'Generation message', true) }));
        }
        if (body.action === 'complete') {
          const { job } = await store.imageRequests('runner-job', { ...runnerPayload, jobId });
          const asset = await normalizeImageAsset({ ...body.image, name: body.image?.name || job.filename }, jobId, 'result', job.itemId);
          return json(await store.imageRequests('runner-complete', { ...runnerPayload, jobId, asset }));
        }
        throw issue('This connection can only claim, start, finish or report image jobs.', 403, 'RUNNER_SCOPE_DENIED');
      }
      if (!admin && (!teamCode || !safeEqual(request.headers.get('x-team-code') || '', teamCode))) throw issue(teamCode ? 'Enter the current team access code.' : 'The owner must set a team access code before the team can use image requests.', 401, 'TEAM_ACCESS_REQUIRED');
      if (!enabled && !admin) throw issue('Image requests are turned off by the owner.', 403, 'TOOL_DISABLED');
      if (typeof store.imageRequests !== 'function') throw issue('Image requests need the connected Cloudflare backend.', 503, 'QUEUE_UNAVAILABLE');
      if (method === 'GET') {
        const action = url.searchParams.get('action') || 'list';
        if (action === 'list') {
          const requestedLimit = Number(url.searchParams.get('limit')), requestedOffset = Number(url.searchParams.get('offset'));
          const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit || 50)) : 50;
          const offset = Number.isFinite(requestedOffset) ? Math.min(1000000, Math.max(0, requestedOffset)) : 0;
          return json(await store.imageRequests('list', { limit: Math.floor(limit), offset: Math.floor(offset) }));
        }
        const requestId = id(url.searchParams.get('id'));
        if (action === 'detail') return json(await store.imageRequests('detail', { id: requestId }));
        if (action === 'asset') return await store.imageRequestAsset(requestId, id(url.searchParams.get('assetId')));
        throw issue('Unknown image request action.');
      }
      const body = await readBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw issue('A request object is required.');
      if (body.action === 'create') {
        const brief = normalizeBrief(body);
        // Reference identities are server-generated. A team-selected submission
        // UUID must never reserve another job's idempotent result asset ID.
        const reference = body.reference ? await normalizeImageAsset(body.reference, crypto.randomUUID(), 'reference') : null;
        const fingerprint = await hash(JSON.stringify({ brief, reference: reference ? { name: reference.name, mime: reference.mime, fingerprint: reference.fingerprint } : null }));
        return json(await store.imageRequests('create', { request: { ...brief, status: 'queued', notes: '', createdAt: now(), updatedAt: now() }, fingerprint, assets: reference ? [reference] : [] }), 201);
      }
      if (!admin) throw issue('Owner sign-in is required to update or deliver images.', 401, 'ADMIN_REQUIRED');
      if (body.action === 'pair') {
        const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
        const runnerToken = 'ir_' + Array.from(tokenBytes, byte => byte.toString(16).padStart(2, '0')).join('');
        const runnerId = crypto.randomUUID();
        const result = await store.imageRequests('runner-pair', { tokenDigest: await hash(runnerToken), runnerId,
          name: text(body.name, 100, 'Computer name') || 'Craftush desktop', now: now() });
        return json({ runnerToken, runnerId, backendURL: url.origin, apiPath: '/api/image-requests', ...result });
      }
      if (body.action === 'revoke') return json(await store.imageRequests('runner-revoke', { now: now() }));
      if (body.action === 'status') {
        const fields = updateFields(body);
        if (fields.status === undefined && fields.notes === undefined) throw issue('Choose a status or enter owner notes.');
        return json(await store.imageRequests('status', { ...fields, updatedAt: now() }));
      }
      if (body.action === 'deliver') {
        const fields = updateFields(body);
        if (!Array.isArray(body.images) || body.images.length !== IMAGE_REQUEST_LIMITS.deliveryImages) throw issue('Deliver one image at a time.');
        const assets = [];
        for (const input of body.images) {
          const itemId = text(input?.itemId, 4, 'Thumbnail item ID', true);
          if (!/^\d{1,3}$/.test(itemId)) throw issue('Choose the thumbnail item for this result.');
          assets.push(await normalizeImageAsset(input, input?.assetId, 'result', itemId));
        }
        if (new Set(assets.map(a => a.assetId)).size !== assets.length) throw issue('Each uploaded result needs its own image ID.');
        return json(await store.imageRequests('deliver', { ...fields, assets, updatedAt: now() }));
      }
      throw issue('Unknown image request action.');
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      return json({ errors: [{ code: error.code || 'QUEUE_UNAVAILABLE', message: error.status ? error.message : 'Image request storage is unavailable. Your previous request and images remain saved; retry with the same IDs.' }] }, status);
    }
  };
}

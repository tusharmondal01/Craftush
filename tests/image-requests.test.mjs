import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { crc32 } from 'node:zlib';
import { CraftushStorage, cloudflareStore } from '../cloudflare/storage.js';
import { createImageRequestsHandler, IMAGE_REQUEST_LIMITS } from '../cloudflare/image-requests.js';
import worker from '../cloudflare/worker.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUq7jEwMDAxAAGABBWAWw4iy1UAAAAAElFTkSuQmCC';
const JPG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDGooor7U+RP//Z';
const WEBP = 'UklGRjoAAABXRUJQVlA4IC4AAAAQAgCdASoCAAIAAUAmJaACdLoB+AH4AAPIAP7tBy/9WfTQi/vX//Rg3+UXyxgA';
const TEAM = { 'x-team-code': 'fixture-team' }, OWNER = { 'x-admin-password': 'fixture-owner' };
const upload = (base64 = PNG, mime = 'image/png', name = 'example.png') => ({ base64, mime, name });
function largePNG() {
  const small = Buffer.from(PNG, 'base64'), text = Buffer.concat([Buffer.from('description\0'), Buffer.alloc(600000, 97)]);
  const kindAndData = Buffer.concat([Buffer.from('tEXt'), text]), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(text.length); checksum.writeUInt32BE(crc32(kindAndData));
  return Buffer.concat([small.subarray(0, -12), header, kindAndData, checksum, small.subarray(-12)]);
}
const brief = (extra = {}) => ({ action: 'create', submissionId: crypto.randomUUID(), name: 'Editor', title: 'Solar system', width: 1280, height: 720, styleNotes: 'Consistent cinematic style', items: [{ title: 'Earth', prompt: 'A detailed photorealistic Earth, no text', filename: 'earth.png' }], ...extra });

function fixture(settings = { teamCode: 'fixture-team' }) {
  const database = new DatabaseSync(':memory:'), f = { database, failImageWrite: false, now: '2026-10-14T10:00:00.000Z' };
  const state = { storage: {
    sql: { exec(query, ...args) {
      if ((f.failImageWrite || f.failImageWriteAt === args[1]) && query.startsWith('INSERT INTO image_request_asset_chunks')) throw new Error('Fixture disk failure');
      const statement = database.prepare(query);
      const rows = query.startsWith('SELECT') ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  } };
  const object = new CraftushStorage(state);
  const namespace = { idFromName: value => value, get: () => object };
  f.namespace = namespace; f.store = cloudflareStore(namespace); f.close = () => database.close();
  f.handler = createImageRequestsHandler({ openStore: () => f.store, readSettings: async () => settings,
    env: key => key === 'ADMIN_PASSWORD' ? 'fixture-owner' : '', safeEqual: (a, b) => a === b,
    json: (data, status = 200) => Response.json(data, { status }), now: () => f.now });
  f.call = (body, headers = TEAM, query = '') => f.handler(new Request('https://craftush.example/api/image-requests' + query, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  f.create = async extra => { const body = brief(extra), response = await f.call(body, OWNER); assert.equal(response.status, 201); return { body, ...(await response.json()) }; };
  f.detail = async id => (await (await f.call(undefined, OWNER, '?action=detail&id=' + id)).json()).request;
  return f;
}

test('staged request originals remain safe beyond the native-start timeout while later groups are generated', async () => {
  const f = fixture();
  try {
    const { request } = await f.create({ items: Array.from({ length: 13 }, (_, index) => ({ title: 'Episode ' + (index + 1), prompt: 'Fixture art' })) });
    const runner = await pairRunner(f), batchId = crypto.randomUUID();
    const claimed = await runner.call({ action: 'claimBatch', batchId, requestId: request.id });assert.equal(claimed.status, 200);
    const group = await claimed.json();await runner.call({ action: 'startBatch', batchId });
    const bytes = Buffer.from(PNG, 'base64'), fingerprint = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    const staged = await runner.call({ action: 'stageBatch', batchId, images: group.jobs.map(job => ({ jobId: job.jobId, fingerprint, mime: 'image/png', name: 'example.png', bytes: bytes.length })) });assert.equal(staged.status, 200);
    f.now = '2026-10-14T12:00:00.000Z';
    const heartbeat = await runner.call({ action: 'runnerHeartbeat' });assert.equal(heartbeat.status, 200);assert.equal((await heartbeat.json()).generator.needsAttention, 0);
    const stored = f.database.prepare("SELECT state FROM image_request_generation WHERE request_id = ? AND state != 'pending'").all(request.id);assert.equal(stored.length, 10);assert(stored.every(job => job.state === 'staged'));
    const last = await runner.call({ action: 'claimBatch', batchId: crypto.randomUUID(), requestId: request.id });assert.equal(last.status, 200);assert.equal((await last.json()).jobs.length, 3);
    assert.equal((await f.detail(request.id)).results.length, 0);
  } finally { f.close(); }
});

test('authenticated team cancellation is scoped, idempotent and preserves finished images and owner notes', async () => {
  const f = fixture();
  try {
    const { request } = await f.create({ items: [{ title: 'Earth', prompt: 'Earth' }, { title: 'Mars', prompt: 'Mars' }] });
    await f.call({ action: 'deliver', id: request.id, notes: 'Keep this note', images: [{ ...upload(), assetId: crypto.randomUUID(), itemId: '1' }] }, OWNER);
    assert.equal((await f.call({ action: 'cancel', id: request.id }, {})).status, 401);
    const response = await f.call({ action: 'cancel', id: request.id, status: 'completed', notes: 'Cannot replace owner note' });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).acknowledgement, { id: request.id, stopped: true });
    const stopped = await f.detail(request.id);
    assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.notes, 'Keep this note');
    assert.equal(stopped.results.length, 1);
    assert.equal((await f.call({ action: 'cancel', id: request.id })).status, 200);
    assert.equal((await f.call({ action: 'status', id: request.id, status: 'queued' })).status, 401);
    const completed = await f.create();
    await f.call({ action: 'deliver', id: completed.request.id, status: 'completed', images: [{ ...upload(), assetId: crypto.randomUUID(), itemId: '1' }] }, OWNER);
    assert.equal((await f.call({ action: 'cancel', id: completed.request.id })).status, 409);
    assert.equal((await f.detail(completed.request.id)).status, 'completed');
  } finally { f.close(); }
});

test('stopping a claimed bulk request prevents its acknowledged group from starting', async () => {
  const f = fixture();
  try {
    const { request } = await f.create();
    const runner = await pairRunner(f), batchId = crypto.randomUUID();
    const response = await runner.call({ action: 'claimBatch', batchId, requestId: request.id });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).jobs.length, 1);
    assert.equal((await f.call({ action: 'cancel', id: request.id })).status, 200);
    const start = await runner.call({ action: 'startBatch', batchId });
    assert.equal(start.status, 409);
    assert.equal((await start.json()).errors[0].code, 'REQUEST_CANCELLED');
    const saved = f.database.prepare('SELECT state FROM image_request_generation WHERE request_id = ?').get(request.id);
    assert.equal(saved.state, 'claimed', 'stop preserves attempt receipts without authorizing a native call');
  } finally { f.close(); }
});

test('an image already started cannot upload after local-folder policy or restart a cancelled request', async () => {
  const f = fixture();
  try {
    const { request } = await f.create();
    const runner = await pairRunner(f), { job } = await claim(runner);
    assert.equal((await runner.call({ action: 'start', jobId: job.jobId })).status, 200);
    assert.equal((await f.call({ action: 'cancel', id: request.id })).status, 200);
    const finished = await runner.call({ action: 'complete', jobId: job.jobId, image: upload() });
    assert.equal(finished.status, 409);
    const saved = await f.detail(request.id);
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.results.length, 0);
  } finally { f.close(); }
});

test('public metadata has no credentials and team access requires a configured code', async () => {
  const f = fixture({});
  const originalFetch = globalThis.fetch; let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('No provider may be called'); };
  try {
    const meta = await (await f.call(undefined, {}, '?action=meta')).json();
    assert.equal(meta.teamConfigured, false); assert.equal(meta.codeRequired, true); assert.equal(meta.limits.items, 200);
    assert(!JSON.stringify(meta).includes('fixture-owner'));
    assert.equal((await f.call(undefined, {}, '?action=list')).status, 401);
    assert.equal((await f.call(brief(), {})).status, 401);
    assert.equal((await f.call(undefined, OWNER, '?action=list')).status, 200);
    const created = await f.call(brief(), OWNER); assert.equal(created.status, 201);
    const { request } = await created.json();
    const delivered = await f.call({ action: 'deliver', id: request.id, images: [{ ...upload(), assetId: crypto.randomUUID(), itemId: '1' }], status: 'completed' }, OWNER);
    assert.equal(delivered.status, 200);
    assert.equal(providerCalls, 0);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('team cannot see briefs/assets or modify statuses without authorization', async () => {
  const f = fixture();
  try {
    const { request } = await f.create({ reference: upload() });
    for (const query of ['?action=list', '?action=detail&id=' + request.id, '?action=asset&id=' + request.id + '&assetId=' + request.references[0].assetId]) assert.equal((await f.call(undefined, {}, query)).status, 401);
    assert.equal((await f.call({ action: 'status', id: request.id, status: 'in_progress' })).status, 401);
    assert.equal((await f.call({ action: 'deliver', id: request.id, images: [{ ...upload(), assetId: crypto.randomUUID(), itemId: '1' }] })).status, 401);
    assert.equal((await f.call(undefined, { 'x-team-code': 'wrong' }, '?action=list')).status, 401);
  } finally { f.close(); }
});

test('simultaneous 200-item submissions are retained, metadata lists omit briefs and image bytes', async () => {
  const f = fixture();
  try {
    const bodies = Array.from({ length: 12 }, (_, index) => brief({ title: 'Batch ' + index, items: Array.from({ length: 200 }, (_, item) => ({ title: 'Planet ' + item, prompt: 'हिन्दी scene 🪐 ' + item })), reference: upload() }));
    const responses = await Promise.all(bodies.map(body => f.call(body)));
    assert(responses.every(response => response.status === 201));
    const listing = await (await f.call(undefined, OWNER, '?action=list&limit=5&offset=5')).json();
    assert.equal(listing.total, 12); assert.equal(listing.requests.length, 5); assert.equal(listing.requests[0].itemCount, 200);
    assert(!JSON.stringify(listing).includes('हिन्दी')); assert(!JSON.stringify(listing).includes(PNG));
    const detail = await f.detail(bodies[0].submissionId);
    assert.equal(detail.items.length, 200); assert.equal(detail.items[199].id, '200'); assert.match(detail.items[0].prompt, /हिन्दी/);
    assert.equal(detail.references.length, 1); assert.equal(detail.references[0].base64, undefined);
  } finally { f.close(); }
});

test('a lost submission response can be retried once without duplicate jobs or reference images', async () => {
  const f = fixture();
  try {
    const body = brief({ reference: upload() });
    const responses = await Promise.all([f.call(body), f.call(body)]), data = await Promise.all(responses.map(response => response.json()));
    assert(responses.every(response => response.status === 201)); assert.equal(data.filter(result => result.duplicate).length, 1);
    assert.equal((await (await f.call(undefined, OWNER, '?action=list')).json()).total, 1);
    assert.equal((await f.detail(body.submissionId)).references.length, 1);
    const conflict = await f.call({ ...body, title: 'Changed brief' });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).errors[0].code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await f.detail(body.submissionId)).title, body.title);
  } finally { f.close(); }
});

test('only supported raster images are accepted, including real JPG and WebP files', async () => {
  const f = fixture();
  try {
    for (const reference of [upload(PNG), upload(JPG, 'image/jpeg', 'photo.jpg'), upload(WEBP, 'image/webp', 'photo.webp')]) {
      const { request } = await f.create({ reference });
      const response = await f.call(undefined, OWNER, '?action=asset&id=' + request.id + '&assetId=' + request.references[0].assetId);
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), reference.mime);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(reference.base64, 'base64'));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const reference of [upload(Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')), upload(PNG, 'image/jpeg'), upload(PNG.slice(0, -8)), upload('@@@@')]) assert.equal((await f.call(brief({ reference }))).status >= 400, true);
    const oversized = Buffer.alloc(IMAGE_REQUEST_LIMITS.assetBytes + 1).toString('base64');
    assert.equal((await f.call(brief({ reference: upload(oversized) }))).status, 413);
    const listing = await (await f.call(undefined, OWNER, '?action=list')).json(); assert.equal(listing.total, 3);
  } finally { f.close(); }
});

test('owner delivers incrementally; completion requires results for every item', async () => {
  const f = fixture();
  try {
    const { request } = await f.create({ items: [{ title: 'Earth', prompt: 'Earth' }, { title: 'Mars', prompt: 'Mars' }] });
    assert.equal((await f.call({ action: 'status', id: request.id, status: 'completed' }, OWNER)).status, 409);
    assert.equal((await f.call({ action: 'status', id: request.id, status: 'in_progress', notes: 'Working on this batch' }, OWNER)).status, 200);
    const first = { ...upload(), assetId: crypto.randomUUID(), itemId: '1' };
    assert.equal((await f.call({ action: 'deliver', id: request.id, images: [first] }, OWNER)).status, 200);
    const partial = await f.detail(request.id); assert.equal(partial.results.length, 1); assert.equal(partial.status, 'in_progress'); assert.equal(partial.notes, 'Working on this batch');
    const second = { ...upload(JPG, 'image/jpeg', 'mars.jpg'), assetId: crypto.randomUUID(), itemId: '2' };
    assert.equal((await f.call({ action: 'deliver', id: request.id, images: [second], status: 'completed', notes: 'Ready to download' }, OWNER)).status, 200);
    const complete = await f.detail(request.id); assert.equal(complete.results.length, 2); assert.equal(complete.status, 'completed'); assert.equal(complete.notes, 'Ready to download');
    const listing = await (await f.call(undefined, OWNER, '?action=list')).json(); assert.equal(listing.requests[0].resultCount, 2);
  } finally { f.close(); }
});

test('parallel deliveries preserve both results and duplicate upload retries do not add results', async () => {
  const f = fixture();
  try {
    const { request } = await f.create();
    const images = [1, 2].map(index => ({ ...upload(PNG, 'image/png', 'variant' + index + '.png'), assetId: crypto.randomUUID(), itemId: '1' }));
    const responses = await Promise.all(images.map(image => f.call({ action: 'deliver', id: request.id, images: [image] }, OWNER)));
    assert(responses.every(response => response.status === 200)); assert.equal((await f.detail(request.id)).results.length, 2);
    const repeated = await f.call({ action: 'deliver', id: request.id, images: [images[0]] }, OWNER);
    assert.equal((await repeated.json()).duplicate, true); assert.equal((await f.detail(request.id)).results.length, 2);
    const collision = await f.call({ action: 'deliver', id: request.id, images: [{ ...images[0], ...upload(JPG, 'image/jpeg', 'different.jpg') }] }, OWNER);
    assert.equal(collision.status, 409);
    const saved = await f.call(undefined, OWNER, '?action=asset&id=' + request.id + '&assetId=' + images[0].assetId);
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), Buffer.from(PNG, 'base64'));
    assert.equal((await f.call(undefined, OWNER, '?action=asset&id=' + crypto.randomUUID() + '&assetId=' + images[0].assetId)).status, 404);
  } finally { f.close(); }
});

test('failed image writes roll back an entire delivery and preserve saved briefs and results', async () => {
  const f = fixture();
  try {
    const { request } = await f.create({ reference: upload() });
    const first = { ...upload(), assetId: crypto.randomUUID(), itemId: '1' };
    await f.call({ action: 'deliver', id: request.id, images: [first] }, OWNER);
    const next = { ...upload(JPG, 'image/jpeg', 'next.jpg'), assetId: crypto.randomUUID(), itemId: '1' };
    f.failImageWrite = true;
    assert.equal((await f.call({ action: 'deliver', id: request.id, images: [next], status: 'completed' }, OWNER)).status, 503);
    assert.equal((await f.call(brief({ reference: upload() }))).status, 503);
    f.failImageWrite = false;
    const preserved = await f.detail(request.id); assert.equal(preserved.results.length, 1); assert.equal(preserved.references.length, 1); assert.equal(preserved.status, 'queued');
    assert.equal((await (await f.call(undefined, OWNER, '?action=list')).json()).total, 1);
    assert.equal((await f.call({ action: 'deliver', id: request.id, images: [next] }, OWNER)).status, 200);
    assert.equal((await f.detail(request.id)).results.length, 2);
  } finally { f.close(); }
});

test('large raster assets round-trip across rows and a second-chunk failure leaves no partial request', async () => {
  const f = fixture();
  try {
    const bytes = largePNG(), reference = upload(bytes.toString('base64'), 'image/png', 'large.png');
    const body = brief({ reference });
    f.failImageWriteAt = 1;
    assert.equal((await f.call(body)).status, 503);
    assert.equal((await (await f.call(undefined, OWNER, '?action=list')).json()).total, 0);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS total FROM image_request_asset_chunks').get().total, 0);
    f.failImageWriteAt = undefined;
    assert.equal((await f.call(body)).status, 201);
    const detail = await f.detail(body.submissionId);
    const saved = await f.call(undefined, OWNER, '?action=asset&id=' + detail.id + '&assetId=' + detail.references[0].assetId);
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bytes);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS total FROM image_request_asset_chunks').get().total, 2);
  } finally { f.close(); }
});

test('asset bounds reject additions atomically and keep retryable existing results', async () => {
  const f = fixture();
  try {
    const { request } = await f.create();
    const image = { ...upload(), assetId: crypto.randomUUID(), itemId: '1' };
    f.database.prepare('UPDATE image_request_records SET asset_bytes = ? WHERE id = ?').run(IMAGE_REQUEST_LIMITS.requestAssetBytes, request.id);
    const response = await f.call({ action: 'deliver', id: request.id, images: [image] }, OWNER);
    assert.equal(response.status, 413); assert.equal((await response.json()).errors[0].code, 'REQUEST_STORAGE_FULL');
    assert.equal((await f.detail(request.id)).results.length, 0);
    f.database.prepare('UPDATE image_request_records SET asset_bytes = 0 WHERE id = ?').run(request.id);
    assert.equal((await f.call({ action: 'deliver', id: request.id, images: [image] }, OWNER)).status, 200);
    const { request: blocker } = await f.create();
    f.database.prepare('UPDATE image_request_records SET asset_bytes = ? WHERE id = ?').run(IMAGE_REQUEST_LIMITS.queueAssetBytes, blocker.id);
    const blocked = await f.call({ action: 'deliver', id: request.id, images: [{ ...image, assetId: crypto.randomUUID() }] }, OWNER);
    assert.equal(blocked.status, 413); assert.equal((await blocked.json()).errors[0].code, 'QUEUE_STORAGE_FULL');
    assert.equal((await f.detail(request.id)).results.length, 1);
  } finally { f.close(); }
});

test('invalid IDs, batches, item mappings, and unsupported status changes fail without mutation', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call(brief({ submissionId: 'not-an-id' }))).status, 400);
    assert.equal((await f.call(brief({ items: Array.from({ length: 201 }, () => ({ title: 'A', prompt: 'A' })) }))).status, 400);
    assert.equal((await f.call(brief({ width: 0 }))).status, 400);
    const { request } = await f.create();
    assert.equal((await f.call({ action: 'status', id: request.id, status: 'unknown' }, OWNER)).status, 400);
    assert.equal((await f.call({ action: 'deliver', id: request.id, images: [{ ...upload(), assetId: crypto.randomUUID(), itemId: '2' }] }, OWNER)).status, 400);
    assert.equal((await f.detail(request.id)).results.length, 0);
    assert.equal((await f.call(undefined, OWNER, '?action=detail&id=' + crypto.randomUUID())).status, 404);
  } finally { f.close(); }
});

test('disabled requests deny team actions while owner can finish existing requests', async () => {
  const settings = { teamCode: 'fixture-team' }, f = fixture(settings);
  try {
    const { request } = await f.create();
    settings.dashboard = { cards: { images: { enabled: false } } };
    assert.equal((await (await f.call(undefined, {}, '?action=meta')).json()).enabled, false);
    assert.equal((await f.call(undefined, TEAM, '?action=list')).status, 403);
    assert.equal((await f.call({ action: 'status', id: request.id, status: 'cancelled' }, OWNER)).status, 200);
    assert.equal((await f.call(undefined, OWNER, '?action=detail&id=' + request.id)).status, 200);
  } finally { f.close(); }
});

const SITE = 'https://tusharmondal01.github.io';
function workerEnvironment(f, extra = {}) {
  return { CRAFTUSH_DATA: f.namespace, ADMIN_PASSWORD: 'fixture-owner', ALLOWED_ORIGINS: SITE,
    PUBLIC_SITE_URL: SITE + '/Craftush', ...extra };
}
function routeRequest(body, headers = TEAM, query = '') {
  return new Request('https://fixture-worker.example/api/image-requests' + query, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: SITE, 'cf-connecting-ip': '192.0.2.4', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('actual Worker route persists a team brief and keeps archived delivery and downloads owner-only without a provider', async () => {
  const f = fixture(), environment = workerEnvironment(f), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw new Error('No outside service should be called'); };
  const call = (body, headers = TEAM, query = '') => worker.fetch(routeRequest(body, headers, query), environment);
  try {
    await f.store.setJSON('settings', { teamCode: 'fixture-team', runwareKey: 'never-send-this-provider-key' });
    const meta = await call(undefined, {}, '?action=meta');
    assert.equal(meta.status, 200); assert.equal(meta.headers.get('access-control-allow-origin'), SITE);
    const metaText = await meta.text(); assert(!metaText.includes('fixture-team')); assert(!metaText.includes('never-send-this-provider-key'));
    const body = brief({ reference: upload() }), created = await call(body);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).acknowledgement.id, body.submissionId);
    const request = (await (await call(undefined, OWNER, '?action=detail&id=' + body.submissionId)).json()).request;
    assert.equal((await call({ action: 'status', id: request.id, status: 'in_progress' }, OWNER)).status, 200);
    const image = { ...upload(JPG, 'image/jpeg', 'finished.jpg'), assetId: crypto.randomUUID(), itemId: '1' };
    const delivered = await call({ action: 'deliver', id: request.id, images: [image], status: 'completed', notes: 'Ready' }, OWNER);
    assert.equal(delivered.status, 200); assert.equal((await delivered.json()).request.status, 'completed');
    assert.equal((await (await call(undefined, TEAM, '?action=list')).json()).total, 0);
    const listing = await (await call(undefined, OWNER, '?action=list')).json();
    assert.equal(listing.requests.length, 1); assert.equal(listing.requests[0].resultCount, 1);
    assert.equal((await call(undefined, TEAM, '?action=detail&id=' + request.id)).status, 403);
    const detail = await (await call(undefined, OWNER, '?action=detail&id=' + request.id)).json();
    assert.equal(detail.request.results[0].assetId, image.assetId);
    assert.equal((await call(undefined, TEAM, '?action=asset&id=' + request.id + '&assetId=' + image.assetId)).status, 403);
    const result = await call(undefined, OWNER, '?action=asset&id=' + request.id + '&assetId=' + image.assetId);
    assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/jpeg');
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('access-control-allow-origin'), SITE);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from(JPG, 'base64'));
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('actual queue route enforces CORS and limits wrong owner password guesses while valid owner access remains available', async () => {
  const f = fixture(), environment = workerEnvironment(f, { RATE_LIMIT_ADMIN_ATTEMPTS: '2' });
  try {
    await f.store.setJSON('settings', { teamCode: 'fixture-team' });
    const preflight = await worker.fetch(new Request('https://fixture-worker.example/api/image-requests', {
      method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-admin-password,x-team-code' },
    }), environment);
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), SITE);
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-Admin-Password/); assert.match(preflight.headers.get('access-control-allow-headers'), /X-Team-Code/);
    const deniedOrigin = await worker.fetch(routeRequest(undefined, { ...OWNER, origin: 'https://untrusted.example' }, '?action=list'), {});
    assert.equal(deniedOrigin.status, 403); assert.equal(deniedOrigin.headers.get('access-control-allow-origin'), null);
    for (let guess = 0; guess < 2; guess++) assert.equal((await worker.fetch(routeRequest(undefined, { 'x-admin-password': 'incorrect-' + guess }, '?action=list'), environment)).status, 401);
    const limited = await worker.fetch(routeRequest(undefined, { 'x-admin-password': 'another-incorrect-guess' }, '?action=list'), environment);
    assert.equal(limited.status, 429); assert.equal((await limited.json()).errors[0].code, 'RATE_LIMITED');
    assert(Number(limited.headers.get('retry-after')) > 0);
    const owner = await worker.fetch(routeRequest(undefined, OWNER, '?action=list'), environment);
    assert.equal(owner.status, 200); assert.equal((await owner.json()).total, 0);
    const team = await worker.fetch(routeRequest(undefined, TEAM, '?action=list'), environment);
    assert.equal(team.status, 200);
  } finally { f.close(); }
});

async function pairRunner(f) {
  const response = await f.call({ action: 'pair', name: 'Fixture native generator' }, OWNER);
  assert.equal(response.status, 200);
  const config = await response.json();
  return { config, headers: { 'x-image-runner': config.runnerToken },
    call: (body, query = '') => f.call(body, { 'x-image-runner': config.runnerToken }, query) };
}
async function claim(runner, claimId = crypto.randomUUID()) {
  const response = await runner.call({ action: 'claim', claimId });
  assert.equal(response.status, 200);
  return { claimId, ...(await response.json()) };
}

test('owner pairs a scoped runner; only its digest is stored and public metadata never reveals its token', async () => {
  const f = fixture();
  try {
    assert.equal((await f.call({ action: 'pair' }, TEAM)).status, 401);
    const runner = await pairRunner(f);
    assert.match(runner.config.runnerToken, /^ir_[0-9a-f]{64}$/);
    assert.equal(runner.config.backendURL, 'https://craftush.example'); assert.equal(runner.config.apiPath, '/api/image-requests');
    const stored = f.database.prepare('SELECT * FROM image_request_runner').get();
    assert.match(stored.token_digest, /^[0-9a-f]{64}$/); assert(!JSON.stringify(stored).includes(runner.config.runnerToken));
    const before = await (await f.call(undefined, {}, '?action=meta')).json();
    assert.equal(before.generator.paired, true); assert.equal(before.generatorConnected, false);
    const heartbeat = await runner.call({ action: 'runnerHeartbeat' }); assert.equal(heartbeat.status, 200);
    const after = await (await f.call(undefined, {}, '?action=meta')).json();
    assert.equal(after.generatorConnected, true); assert.equal(after.generator.state, 'connected');
    assert(!JSON.stringify(after).includes(runner.config.runnerToken)); assert(!JSON.stringify(after).includes(stored.token_digest));
    assert.equal((await runner.call(undefined, '?action=list')).status, 403);
    assert.equal((await runner.call(brief())).status, 403);
    assert.equal((await runner.call({ action: 'pair' })).status, 403);
    assert.equal((await f.call(undefined, { 'x-image-runner': 'ir_' + '0'.repeat(64) }, '?action=runnerMeta')).status, 401);
  } finally { f.close(); }
});

test('claim serializes native jobs and a lost acknowledgement reuses the same stable job UUID', async () => {
  const f = fixture();
  try {
    const { request } = await f.create({ items: [{ title: 'Earth', prompt: 'Earth' }, { title: 'Mars', prompt: 'Mars' }] });
    const runner = await pairRunner(f), claimIds = [crypto.randomUUID(), crypto.randomUUID()];
    const responses = await Promise.all(claimIds.map(claimId => runner.call({ action: 'claim', claimId })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = responses.findIndex(response => response.status === 200);
    const first = await responses[winner].json();
    assert.equal(first.job.requestId, request.id); assert.equal(first.job.itemId, '1'); assert.equal(first.job.state, 'claimed');
    const repeat = await runner.call({ action: 'claim', claimId: claimIds[winner] });
    assert.equal(repeat.status, 200); const retried = await repeat.json();
    assert.equal(retried.duplicate, true); assert.equal(retried.job.jobId, first.job.jobId);
    const detail = await f.detail(request.id);
    assert.equal(detail.items[0].generation.state, 'claimed'); assert.equal(detail.items[1].generation.state, 'pending');
    assert.equal(detail.status, 'in_progress');
  } finally { f.close(); }
});

test('only the first durable start permits ImageGen, and interrupted started jobs never return to pending', async () => {
  const f = fixture();
  try {
    await f.create(); const runner = await pairRunner(f), { job } = await claim(runner);
    assert.equal((await runner.call({ action: 'complete', jobId: job.jobId, image: upload() })).status, 409);
    const started = await (await runner.call({ action: 'start', jobId: job.jobId })).json();
    assert.equal(started.canGenerate, true); assert.equal(started.duplicate, false); assert.equal(started.job.state, 'started');
    const repeated = await (await runner.call({ action: 'start', jobId: job.jobId })).json();
    assert.equal(repeated.canGenerate, false); assert.equal(repeated.duplicate, true);
    f.now = '2026-10-14T10:31:00.000Z';
    const meta = await (await f.call(undefined, {}, '?action=meta')).json(); assert.equal(meta.generator.state, 'needs_attention');
    const blocked = await claim(runner); assert.equal(blocked.job, null); assert.equal(blocked.blocked, 'needs_attention');
    const saved = f.database.prepare('SELECT * FROM image_request_generation WHERE job_id = ?').get(job.jobId);
    assert.equal(saved.state, 'needs_attention'); assert.equal(saved.started_at, '2026-10-14T10:00:00.000Z');
    const cannotRestart = await (await runner.call({ action: 'start', jobId: job.jobId })).json(); assert.equal(cannotRestart.canGenerate, false);
    const completed = await runner.call({ action: 'complete', jobId: job.jobId, image: upload() });
    assert.equal(completed.status, 409); assert.equal((await f.detail(job.requestId)).status, 'in_progress');
  } finally { f.close(); }
});

test('an expired unstarted claim is safely reclaimed with its original job UUID', async () => {
  const f = fixture();
  try {
    await f.create(); const runner = await pairRunner(f), first = await claim(runner);
    f.now = '2026-10-14T10:11:00.000Z';
    const second = await claim(runner);
    assert.equal(second.job.jobId, first.job.jobId); assert.equal(second.duplicate, false); assert.equal(second.job.state, 'claimed');
    assert.notEqual(second.claimId, first.claimId);
    assert.equal((await (await runner.call({ action: 'start', jobId: second.job.jobId })).json()).canGenerate, true);
  } finally { f.close(); }
});

test('the retired runner upload endpoint cannot write or replace an image under local-folder delivery', async () => {
  const f = fixture();
  try {
    await f.create({ items: [{ title: 'Earth', prompt: 'Earth' }, { title: 'Mars', prompt: 'Mars' }] });
    const runner = await pairRunner(f), first = await claim(runner), image = upload(largePNG().toString('base64'), 'image/png', first.job.filename);
    await runner.call({ action: 'start', jobId: first.job.jobId });
    f.failImageWriteAt = 1;
    assert.equal((await runner.call({ action: 'complete', jobId: first.job.jobId, image })).status, 409);
    assert.equal(f.database.prepare('SELECT state FROM image_request_generation WHERE job_id = ?').get(first.job.jobId).state, 'started');
    assert.equal((await f.detail(first.job.requestId)).results.length, 0);
    f.failImageWriteAt = undefined;
    const completed = await runner.call({ action: 'complete', jobId: first.job.jobId, image });
    assert.equal(completed.status, 409); assert.equal((await completed.json()).errors[0].code, 'LOCAL_FOLDER_ONLY');
    assert.equal((await runner.call({ action: 'complete', jobId: first.job.jobId, image })).status, 409);
    assert.equal((await runner.call({ action: 'complete', jobId: first.job.jobId, image: upload(JPG, 'image/jpeg', 'different.jpg') })).status, 409);
    assert.equal((await f.detail(first.job.requestId)).results.length, 0);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS total FROM image_request_asset_chunks').get().total, 0);
    assert.equal((await runner.call({ action: 'claim', claimId: crypto.randomUUID() })).status, 409);
  } finally { f.close(); }
});

test('runner downloads references only for its claimed job and cannot read other requests or result assets', async () => {
  const f = fixture();
  try {
    const first = await f.create({ reference: upload() }), second = await f.create({ reference: upload(JPG, 'image/jpeg', 'other.jpg') });
    const runner = await pairRunner(f), { job } = await claim(runner);
    const own = job.requestId === first.request.id ? first.request : second.request;
    const other = job.requestId === first.request.id ? second.request : first.request;
    const response = await runner.call(undefined, '?action=runnerAsset&jobId=' + job.jobId + '&assetId=' + own.references[0].assetId);
    assert.equal(response.status, 200);
    assert.equal((await runner.call(undefined, '?action=runnerAsset&jobId=' + job.jobId + '&assetId=' + other.references[0].assetId)).status, 403);
    assert.equal((await runner.call(undefined, '?action=detail&id=' + other.id)).status, 403);
    assert.equal((await runner.call(undefined, '?action=asset&id=' + own.id + '&assetId=' + own.references[0].assetId)).status, 403);
  } finally { f.close(); }
});

test('confirmed failure is terminal, while an uncertain report blocks further native generation', async () => {
  const f = fixture();
  try {
    await f.create({ items: [{ title: 'Earth', prompt: 'Earth' }, { title: 'Mars', prompt: 'Mars' }] });
    const runner = await pairRunner(f), first = await claim(runner);
    await runner.call({ action: 'start', jobId: first.job.jobId });
    assert.equal((await runner.call({ action: 'report', jobId: first.job.jobId, state: 'failed', message: 'The tool explicitly rejected this prompt.' })).status, 200);
    const second = await claim(runner); assert.equal(second.job.itemId, '2');
    await runner.call({ action: 'start', jobId: second.job.jobId });
    assert.equal((await runner.call({ action: 'report', jobId: second.job.jobId, state: 'needs_attention', message: 'The image tool response was interrupted.' })).status, 200);
    assert.equal((await claim(runner)).blocked, 'needs_attention');
    f.now = '2026-10-15T10:00:00.000Z';
    assert.equal((await claim(runner)).job, null);
    const states = (await f.detail(first.job.requestId)).items.map(item => item.generation.state);
    assert.deepEqual(states, ['failed', 'needs_attention']);
  } finally { f.close(); }
});

test('re-pairing revokes the old token without retrying started work; cancelling the uncertain request releases the queue', async () => {
  const f = fixture();
  try {
    await f.create(); const old = await pairRunner(f), first = await claim(old);
    await old.call({ action: 'start', jobId: first.job.jobId });
    const current = await pairRunner(f);
    assert.equal((await old.call({ action: 'runnerHeartbeat' })).status, 401);
    assert.equal((await claim(current)).blocked, 'needs_attention');
    await f.call({ action: 'status', id: first.job.requestId, status: 'cancelled' }, OWNER);
    const nextRequest = await f.create({ title: 'Another batch' });
    const next = await claim(current);
    assert.equal(next.job.requestId, nextRequest.request.id);
    assert.equal(f.database.prepare('SELECT state FROM image_request_generation WHERE job_id = ?').get(first.job.jobId).state, 'needs_attention');
    assert.equal((await f.call({ action: 'revoke' }, OWNER)).status, 200);
    assert.equal((await current.call({ action: 'runnerHeartbeat' })).status, 401);
    const meta = await (await f.call(undefined, {}, '?action=meta')).json(); assert.equal(meta.generator.paired, false); assert.equal(meta.generatorConnected, false);
  } finally { f.close(); }
});

test('team-selected submission and reference IDs cannot reserve a native job result identity', async () => {
  const f = fixture();
  try {
    const original = await f.create(), runner = await pairRunner(f), { job } = await claim(runner);
    const unrelated = await f.create({ submissionId: job.jobId, title: 'Different batch', reference: { ...upload(), assetId: job.jobId } });
    assert.notEqual(unrelated.request.references[0].assetId, job.jobId);
    await runner.call({ action: 'start', jobId: job.jobId });
    const completed = await runner.call({ action: 'complete', jobId: job.jobId, image: upload() });
    assert.equal(completed.status, 409);
    assert.equal((await f.detail(original.request.id)).results.length, 0);
    const recovered = await runner.call(undefined, '?action=runnerJob&jobId=' + job.jobId);
    assert.equal(recovered.status, 200);
    const saved = await recovered.json(); assert.equal(saved.job.state, 'started'); assert.equal(saved.job.requestStatus, 'in_progress');
    const otherJob = (await f.detail(unrelated.request.id)).items[0].generation.jobId;
    assert.equal((await runner.call(undefined, '?action=runnerJob&jobId=' + otherJob)).status, 403);
  } finally { f.close(); }
});

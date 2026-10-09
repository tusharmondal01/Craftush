import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import worker from '../cloudflare/worker.js';
import { CraftushStorage, cloudflareStore, CHUNK_BYTES } from '../cloudflare/storage.js';
import { normalizeBackendURL, pagesRuntime } from '../scripts/pages-runtime.mjs';
import { buildPages } from '../scripts/build-github-pages.mjs';
import { publicRateLimits } from '../cloudflare/rate-limit.js';

const SITE = 'https://tusharmondal01.github.io';
const BACKEND = 'https://fixture-api.example';

function storageFixture() {
  const database = new DatabaseSync(':memory:');
  const fixture = { failWrite: false };
  const state = { storage: {
    sql: { exec(query, ...args) {
      if (fixture.failWrite && query.startsWith('INSERT INTO chunks')) throw new Error('Fixture storage failure');
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
  fixture.namespace = { idFromName: value => value, get: () => object };
  fixture.store = cloudflareStore(fixture.namespace);
  fixture.close = () => database.close();
  return fixture;
}

function environment(fixture, extra = {}) {
  return { CRAFTUSH_DATA: fixture.namespace, ADMIN_PASSWORD: 'fixture-admin-only', RUNWARE_API_KEY: 'fixture-provider-only-9911',
    ALLOWED_ORIGINS: SITE, PUBLIC_SITE_URL: SITE + '/Craftush', ...extra };
}
const request = (path, body, headers = {}) => new Request(BACKEND + path, {
  method: body === undefined ? 'GET' : 'POST', headers: { origin: SITE, 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('Cloudflare health reads real private storage and public metadata never returns the provider key', async () => {
  const f = storageFixture();
  try {
    const response = await worker.fetch(request('/api/health'), environment(f));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, version: '17', storage: 'connected', adminConfigured: true, runwareConfigured: true, rateLimiting: publicRateLimits({}) });
    assert.equal(response.headers.get('access-control-allow-origin'), SITE);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const metadata = await worker.fetch(request('/api/documentary'), environment(f));
    const text = await metadata.text();
    assert.equal(JSON.parse(text).configured, true); assert.equal(JSON.parse(text).version, '17');
    assert(!text.includes('fixture-provider-only')); assert(!text.includes('fixture-admin-only'));
  } finally { f.close(); }
});

test('the uploaded thumbnail dashboard link returns to the GitHub frontend', async () => {
  const f = storageFixture();
  try {
    const response = await worker.fetch(new Request(BACKEND + '/'), environment(f));
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), SITE + '/Craftush/');
  } finally { f.close(); }
});

test('admin authentication is still enforced on the Cloudflare endpoint', async () => {
  const f = storageFixture();
  try {
    const denied = await worker.fetch(request('/api/admin', { action: 'get' }, { 'x-admin-password': 'wrong-fixture' }), environment(f));
    assert.equal(denied.status, 401);
    assert.match((await denied.json()).errors[0].message, /Wrong password/);
    const accepted = await worker.fetch(request('/api/admin', { action: 'get' }, { 'x-admin-password': 'fixture-admin-only' }), environment(f));
    assert.equal(accepted.status, 200);
    const view = await accepted.json();
    assert.equal(view.version, '17'); assert.equal(view.key.source, 'environment'); assert.equal(view.key.last4, '9911');
    assert(!JSON.stringify(view).includes('fixture-provider-only'));
  } finally { f.close(); }
});

test('saving an admin model changes the next Runware metadata request without a stale cache', async () => {
  const f = storageFixture();
  try {
    const list = [{ id: 'anthropic:claude@sonnet-4.6', name: 'Claude Sonnet 4.6' }];
    const saved = await worker.fetch(request('/api/admin', { action: 'saveTextList', list }, { 'x-admin-password': 'fixture-admin-only' }), environment(f));
    assert.equal(saved.status, 200);
    const next = await worker.fetch(request('/api/runware'), environment(f));
    assert.equal(next.status, 200); assert.deepEqual((await next.json()).textModels, list);
  } finally { f.close(); }
});

test('GitHub CORS preflight accepts the admin header and denies other website origins before storage access', async () => {
  const f = storageFixture();
  try {
    const response = await worker.fetch(new Request(BACKEND + '/api/admin', { method: 'OPTIONS', headers: { origin: SITE,
      'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-admin-password' } }), environment(f));
    assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), SITE);
    assert.match(response.headers.get('access-control-allow-headers'), /X-Admin-Password/);
    assert.match(response.headers.get('access-control-expose-headers'), /X-Media-Total/);
    const denied = await worker.fetch(request('/api/admin', { action: 'get' }, { origin: 'https://untrusted.example', 'x-admin-password': 'fixture-admin-only' }), {});
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally { f.close(); }
});

test('a missing binding or administrator secret fails closed without returning raw exceptions', async () => {
  const f = storageFixture();
  try {
    const noBinding = await worker.fetch(request('/api/health'), { ADMIN_PASSWORD: 'do-not-return-this' });
    assert.equal(noBinding.status, 503); assert(!(await noBinding.text()).includes('do-not-return-this'));
    const noPassword = await worker.fetch(request('/api/health'), environment(f, { ADMIN_PASSWORD: '' }));
    assert.equal(noPassword.status, 503); assert.equal((await noPassword.json()).adminConfigured, false);
    const corrupted = new Request('https://private-storage.invalid/?key=settings', { method: 'PUT', body: '[]' });
    await f.namespace.get().fetch(corrupted);
    const failed = await worker.fetch(request('/api/runware'), environment(f));
    assert.equal(failed.status, 503); assert.match((await failed.json()).errors[0].code, /STORAGE_UNAVAILABLE/);
  } finally { f.close(); }
});

test('large multibyte uploads round-trip across SQLite rows and replacement removes obsolete chunks', async () => {
  const f = storageFixture();
  try {
    const text = 'हिन्दी butterfly 🦋 '.repeat(Math.ceil(CHUNK_BYTES / 9));
    await f.store.set('thumbnail-html', text);
    assert.equal(await f.store.get('thumbnail-html'), text);
    await f.store.set('thumbnail-html', 'new small thumbnail');
    assert.equal(await f.store.get('thumbnail-html'), 'new small thumbnail');
    await f.store.setJSON('project', { text, scenes: [1, 2, 3] });
    assert.deepEqual(await f.store.get('project', { type: 'json' }), { text, scenes: [1, 2, 3] });
  } finally { f.close(); }
});

test('an interrupted private upload rolls back and preserves the prior settings', async () => {
  const f = storageFixture();
  try {
    await f.store.setJSON('settings', { teamCode: 'saved-team-code' });
    f.failWrite = true;
    await assert.rejects(f.store.setJSON('settings', { teamCode: 'unsaved-team-code' }));
    f.failWrite = false;
    assert.deepEqual(await f.store.get('settings', { type: 'json' }), { teamCode: 'saved-team-code' });
  } finally { f.close(); }
});

test('simultaneous Worker requests never mix credentials or private storage bindings', async () => {
  const first = storageFixture(), second = storageFixture();
  try {
    await first.store.setJSON('settings', { textList: [{ id: 'anthropic:claude@sonnet-4.6' }] });
    await second.store.setJSON('settings', { textList: [{ id: 'deepseek:v4@flash' }] });
    const responses = await Promise.all([
      worker.fetch(request('/api/admin', { action: 'get' }, { 'x-admin-password': 'first-password' }), environment(first, { ADMIN_PASSWORD: 'first-password', RUNWARE_API_KEY: 'first-provider-1111' })),
      worker.fetch(request('/api/admin', { action: 'get' }, { 'x-admin-password': 'second-password' }), environment(second, { ADMIN_PASSWORD: 'second-password', RUNWARE_API_KEY: 'second-provider-2222' })),
    ]);
    const [one, two] = await Promise.all(responses.map(response => response.json()));
    assert.equal(one.key.last4, '1111'); assert.equal(two.key.last4, '2222');
    assert.equal(one.textList[0].id, 'anthropic:claude@sonnet-4.6'); assert.equal(two.textList[0].id, 'deepseek:v4@flash');
  } finally { first.close(); second.close(); }
});

test('the Cloudflare relay checks the team code before calling Runware', async () => {
  const f = storageFixture();
  const originalFetch = globalThis.fetch;
  let reached = false;
  globalThis.fetch = async () => { reached = true; throw new Error('Provider must not be called'); };
  try {
    await f.store.setJSON('settings', { teamCode: 'fixture-team' });
    const result = await worker.fetch(request('/api/runware', { taskType: 'imageInference', taskUUID: crypto.randomUUID() }, { 'x-team-code': 'wrong-team' }), environment(f));
    assert.equal(result.status, 401); assert.equal(reached, false);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

function runtimeFixture(backendURL = '') {
  let ready;
  const controls = [{ disabled: false }, { disabled: false }], status = { textContent: '' };
  const result = { calls: [], controls, status, notice: null };
  const context = vm.createContext({ window: {}, Response, AbortSignal,
    document: { addEventListener: (_, callback) => { ready = callback; }, createElement: () => ({ style: {}, setAttribute() {} }),
      body: { prepend: value => { result.notice = value; } }, querySelector: selector => selector === '#loginView' ? {} : status,
      querySelectorAll: () => controls },
    fetch: async (url, options) => { result.calls.push({ url, options }); return Response.json({ ok: true, runwareConfigured: true }); },
  });
  vm.runInContext(pagesRuntime({ backendURL }), context);
  result.api = context.window.craftushAPI; result.ready = () => ready(); result.hosting = context.window.craftushHosting;
  return result;
}

test('a connected Pages build enables the password box and only reports connection success after a health response', async () => {
  const f = runtimeFixture(BACKEND);
  assert.equal(f.hosting.connected, false);
  await f.ready();
  assert(f.controls.every(control => !control.disabled)); assert.equal(f.hosting.connected, true);
  assert.equal(f.calls[0].url, BACKEND + '/api/health'); assert.match(f.notice.textContent, /Cloudflare backend connected/);
});

test('Pages forwards exact API payloads and headers only to its configured HTTPS backend, without redirects or cookies', async () => {
  const f = runtimeFixture(BACKEND);
  const body = JSON.stringify({ action: 'get' });
  await f.api('/api/admin', { method: 'POST', body, headers: { 'x-admin-password': 'fixture-admin' }, credentials: 'include', redirect: 'follow' });
  const [{ url, options }] = f.calls;
  assert.equal(url, BACKEND + '/api/admin'); assert.equal(options.body, body);
  assert.equal(options.headers['x-admin-password'], 'fixture-admin'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
  for (const path of ['https://untrusted.example/api/admin', '//untrusted.example/api/admin', '/api/../admin', '/api/admin#secret']) {
    assert.equal((await f.api(path, { headers: { 'x-admin-password': 'fixture-admin' } })).status, 400);
  }
  assert.equal(f.calls.length, 1);
});

test('without a configured backend, Pages sends no passwords and explains why admin is disabled', async () => {
  const f = runtimeFixture();
  await f.ready();
  assert(f.controls.every(control => control.disabled)); assert.match(f.status.textContent, /password has not been sent/);
  const response = await f.api('/api/admin', { headers: { 'x-admin-password': 'fixture-admin' } });
  assert.equal(response.status, 503); assert.equal(f.calls.length, 0);
});

test('frontend backend configuration cannot contain credentials, a downgrade, query parameters or a path', () => {
  assert.equal(normalizeBackendURL(BACKEND + '/'), BACKEND);
  for (const url of ['http://fixture.example', 'https://user:password@fixture.example', BACKEND + '/api', BACKEND + '?key=secret', BACKEND + '#secret']) {
    assert.throws(() => normalizeBackendURL(url));
  }
});

test('a connected Pages release advertises the Cloudflare MCP and thumbnail endpoints and preserves the editor', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'craftush-connected-pages-'));
  try {
    await buildPages({ destination, backendURL: BACKEND });
    const metadata = JSON.parse(await readFile(join(destination, 'hosting.json'), 'utf8'));
    assert.equal(metadata.backendConnected, true); assert.equal(metadata.backendURL, BACKEND);
    const setup = await readFile(join(destination, 'chatgpt/index.html'), 'utf8');
    assert.match(setup, /https:\/\/fixture-api\.example\/api\/chatgpt-mcp/); assert(!setup.includes('.vercel.app'));
    const thumbnail = await readFile(join(destination, 'thumbnail/index.html'), 'utf8');
    assert.match(thumbnail, /location\.replace\("https:\/\/fixture-api\.example\/thumbnail"\)/);
    const visuals = await readFile(join(destination, 'visuals/index.html'), 'utf8');
    assert.match(visuals, /window\.craftushAPI\('\/api\/runware'/); assert.match(visuals, /One image per complete sentence/);
  } finally { await rm(destination, { recursive: true, force: true }); }
});

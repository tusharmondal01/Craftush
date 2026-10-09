import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PrivateStorageError, withStorageErrors } from '../netlify/lib/storage-errors.js';
import { createDocumentaryHandler } from '../netlify/lib/documentary-api.js';
import { createChatGPTBridge } from '../netlify/lib/chatgpt-bridge.js';
import { createMediaHandler } from '../netlify/lib/documentary-media.js';
import { createChatGPTMCP } from '../netlify/lib/chatgpt-mcp.js';

const source = fs.readFileSync(new URL('../netlify/lib/blob-store.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/m, '').replace(/let sdkPromise;\nconst sdk = .*;\n/, 'const sdk = async () => blobSDK;\n')
  .replace('export function privateBlobStore', 'function privateBlobStore');

function fixture() {
  let now = 1000;
  const files = new Map([['craftush/settings.txt', JSON.stringify({ teamCode: 'team-code', runwareKey: 'fake-private-key' })], ['craftush/usage.txt', '{"images":0}']]);
  const reads = [], writes = [];
  const f = { files, reads, writes, advance: ms => { now += ms; }, error: null, putError: null, readGate: null };
  const blobSDK = {
    async get(path, options) {
      reads.push({ path, options });
      const text = files.get(path);
      if (f.readGate) await f.readGate;
      if (f.error) throw f.error;
      return text === undefined ? null : { statusCode: 200, stream: new Response(text).body };
    },
    async put(path, text, options) {
      writes.push({ path, text, options });
      if (f.putError) throw f.putError;
      files.set(path, text); return { pathname: path };
    },
  };
  const context = vm.createContext({ Response, PrivateStorageError, blobSDK, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(source, context);
  f.open = id => context.privateBlobStore(id);
  f.store = f.open('connected-private-store');
  return f;
}

function endpoint(name, store, fetch = async () => { throw new Error('Runware must not be called'); }) {
  const context = vm.createContext({ Request, Response, crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    setTimeout: fn => fn(), AbortSignal, fetch, withStorageErrors,
    limitRunwareTasks: async () => null,
    openStore: () => store, readSettings: store => store.get('settings', { type: 'json' }), readUsage: store => store.get('usage', { type: 'json' }),
    activeKey: settings => settings.runwareKey || '', env: name => name === 'ADMIN_PASSWORD' ? 'fixture-admin-password' : '',
    safeEqual: (a, b) => a === b, json: (data, status = 200) => new Response(JSON.stringify(data), { status }),
    fail: (message, status) => new Response(JSON.stringify({ errors: [{ message }] }), { status }),
    textModel: settings => settings.textModel || 'anthropic:claude@sonnet-4.6', textList: () => [], textModels: () => [], BUILTIN_TEXT_MODELS: [],
    cleanMessage: value => String(value || ''), VERSION: 'fixture', MODEL_ID: /^[\w.-]+:[\w.-]+@[\w.-]+$/, RUNWARE_URL: 'https://api.runware.ai/v1',
  });
  const raw = fs.readFileSync(new URL(`../netlify/edge-functions/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\n/gm, '')
    .replace('export default async (req) =>', 'globalThis.rawHandler = async (req) =>').replace('export const config =', 'const config =');
  const wrapper = fs.readFileSync(new URL(`../api/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export const (\w+) =/g, 'globalThis.$1 =');
  vm.runInContext(raw, context); vm.runInContext(wrapper, context);
  return context;
}

test('40 concurrent settings reads share one private fetch and cached JSON cannot be mutated in place', async () => {
  const f = fixture();
  const values = await Promise.all(Array.from({ length: 40 }, () => f.open('connected-private-store').get('settings', { type: 'json' })));
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].options.access, 'private');
  assert.equal(f.reads[0].options.storeId, 'connected-private-store');
  assert.equal(f.reads[0].options.useCache, false);
  values[0].teamCode = '';
  assert.equal((await f.store.get('settings', { type: 'json' })).teamCode, 'team-code');
  f.advance(30001);
  f.files.set('craftush/settings.txt', '{"teamCode":"rotated-code"}');
  assert.equal((await f.store.get('settings', { type: 'json' })).teamCode, 'rotated-code');
  assert.equal(f.reads.length, 2);
});

test('saved keys and team-code changes appear immediately on this instance after a successful write', async () => {
  const f = fixture();
  await f.store.get('settings', { type: 'json' });
  await f.store.setJSON('settings', { teamCode: 'new-code', runwareKey: 'replacement-test-key' });
  const result = await f.open('connected-private-store').get('settings', { type: 'json' });
  assert.equal(result.teamCode, 'new-code'); assert.equal(result.runwareKey, 'replacement-test-key');
  assert.equal(f.reads.length, 1); assert.equal(f.writes[0].options.access, 'private');
  assert.equal(f.writes[0].options.storeId, 'connected-private-store');
});

test('a settings read started before an admin save cannot overwrite the new cached settings', async () => {
  const f = fixture();
  let release; f.readGate = new Promise(resolve => { release = resolve; });
  const pending = f.store.get('settings', { type: 'json' });
  await Promise.resolve();
  await f.store.setJSON('settings', { teamCode: 'saved-during-read' });
  release(); await pending;
  assert.equal((await f.store.get('settings', { type: 'json' })).teamCode, 'saved-during-read');
  assert.equal(f.reads.length, 1);
});

test('a failed admin save never becomes a successful cached key or code change', async () => {
  const f = fixture(); await f.store.get('settings', { type: 'json' });
  f.putError = new Error('403 Forbidden');
  await assert.rejects(f.store.setJSON('settings', { teamCode: '', runwareKey: 'unsaved' }), PrivateStorageError);
  assert.equal((await f.store.get('settings', { type: 'json' })).teamCode, 'team-code');
  assert.equal(f.reads.length, 2);
});

test('store IDs stay isolated, usage expires quickly, and dynamic project records always refresh', async () => {
  const f = fixture();
  await f.store.get('settings'); await f.open('other-private-store').get('settings');
  assert.equal(f.reads.length, 2); assert.equal(f.reads[1].options.storeId, 'other-private-store');
  await f.store.get('usage'); await f.store.get('usage'); assert.equal(f.reads.length, 3);
  f.advance(5001); await f.store.get('usage'); assert.equal(f.reads.length, 4);
  f.files.set('craftush/project.txt', 'revision-1'); assert.equal(await f.store.get('project'), 'revision-1');
  f.files.set('craftush/project.txt', 'revision-2'); assert.equal(await f.store.get('project'), 'revision-2');
  assert.equal(f.reads.length, 6);
});

test('denied reads return a safe JSON failure and cannot silently remove the team-code check', async () => {
  const f = fixture(); f.error = new Error('403 Forbidden fake-private-key');
  let reachedRunware = false;
  const handler = withStorageErrors(async () => {
    await f.store.get('settings', { type: 'json' }); reachedRunware = true; return new Response('should not run');
  });
  const response = await handler();
  assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.equal(body.errors[0].code, 'STORAGE_ACCESS_DENIED');
  assert.match(body.errors[0].message, /Storage usage limits/);
  assert.equal(reachedRunware, false); assert(!JSON.stringify(body).includes('fake-private-key'));
  f.error = null; assert.equal((await f.store.get('settings', { type: 'json' })).teamCode, 'team-code');
  assert.equal(f.reads.length, 2, 'failed reads are not cached');
});

test('expired settings are not reused after forbidden access, and malformed settings fail closed', async () => {
  const f = fixture(); await f.store.get('settings', { type: 'json' });
  f.advance(30001); f.error = new Error('403 Forbidden');
  await assert.rejects(f.store.get('settings', { type: 'json' }), PrivateStorageError);
  f.error = null;
  for (const text of ['{broken', 'null', '[]', '"invalid"']) {
    f.files.set('craftush/settings.txt', text);
    await assert.rejects(f.store.get('settings', { type: 'json' }), PrivateStorageError);
  }
});

test('the storage wrapper preserves ordinary HTTP/authentication responses and exposes no raw exceptions', async () => {
  const response = new Response('Wrong team code', { status: 401 });
  assert.equal(await withStorageErrors(async () => response)(), response);
  const error = new Error('An unrelated programming error');
  await assert.rejects(withStorageErrors(async () => { throw error; })(), error);
});

test('the real Vercel Runware and admin endpoints return JSON for the observed Blob 403', async () => {
  const f = fixture(); f.error = new Error('Vercel Blob: Failed to fetch blob: 403 Forbidden');
  for (const name of ['runware', 'admin']) {
    const api = endpoint(name, f.store);
    const req = new Request(`https://test/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-password': 'fixture-admin-password' }, body: JSON.stringify({ action: 'get' }) });
    const response = await api.POST(req);
    assert.equal(response.status, 503, name);
    const body = await response.json(); assert.equal(body.errors[0].code, 'STORAGE_ACCESS_DENIED', name);
    assert(!JSON.stringify(body).includes('fake-private-key'));
  }
});

test('cached settings still enforce the team code and retain the same Runware key and selected model', async () => {
  const f = fixture(), upstream = [];
  const api = endpoint('runware', f.store, async (_, options) => {
    upstream.push(JSON.parse(options.body)); return new Response('{"data":[]}');
  });
  const request = code => new Request('https://test/api/runware', { method: 'POST', headers: { 'content-type': 'application/json', 'x-team-code': code },
    body: JSON.stringify([{ taskType: 'textInference', taskUUID: '11111111-1111-4111-8111-111111111111', model: 'anthropic:claude@opus-4.8' }]) });
  const denied = await Promise.all(Array.from({ length: 40 }, () => api.POST(request('wrong-code'))));
  assert(denied.every(response => response.status === 401)); assert.equal(upstream.length, 0); assert.equal(f.reads.length, 1);
  const response = await api.POST(request('team-code')); assert.equal(response.status, 200);
  assert.equal(upstream[0][0].apiKey, 'fake-private-key'); assert.equal(upstream[0][1].model, 'anthropic:claude@opus-4.8');
  assert.equal(f.reads.length, 1); assert(!(await response.text()).includes('fake-private-key'));
});

function unavailableDeps(store) {
  return {
    openStore: () => store, readSettings: s => s.get('settings', { type: 'json' }),
    activeKey: s => s.runwareKey, teamCodeOk: () => { throw new Error('Authorization must not proceed'); },
    dashboardView: () => ({ cards: { documentary: { enabled: true } } }),
    json: (data, status = 200) => Response.json(data, { status }),
    fail: (message, status) => Response.json({ errors: [{ message }] }, { status }),
    fetch: () => { throw new Error('No provider request should be sent'); }, runwareURL: 'https://api.runware.ai/v1',
  };
}

test('Documentary, media and ChatGPT handoff surface the storage block without creating new jobs', async () => {
  const f = fixture(); f.error = new Error('403 Forbidden fake-private-key');
  const deps = unavailableDeps(f.store);
  for (const [name, handler, method] of [
    ['documentary', createDocumentaryHandler(deps), 'GET'],
    ['documentary', createDocumentaryHandler(deps), 'POST'],
    ['documentary-media', createMediaHandler(deps), 'POST'],
    ['chatgpt-bridge', createChatGPTBridge(deps), 'GET'],
    ['chatgpt-bridge', createChatGPTBridge(deps), 'POST'],
  ]) {
    const response = await handler(new Request(`https://test/api/${name}`, {
      method, ...(method === 'POST' ? { body: JSON.stringify({ action: 'create', idea: 'A documentary.' }) } : {}),
    }));
    assert.equal(response.status, 503, name);
    const body = await response.json(); assert.equal(body.errors[0].code, 'STORAGE_ACCESS_DENIED', name);
    assert.match(body.errors[0].message, /existing project and task IDs/);
    assert(!JSON.stringify(body).includes('fake-private-key'));
  }
  assert.equal(f.writes.length, 0);
});

test('the MCP workflow tool reports the denied connection as an error with the same safe message', async () => {
  const f = fixture(); f.error = new Error('403 Forbidden');
  const mcp = createChatGPTMCP(createChatGPTBridge(unavailableDeps(f.store)));
  const response = await mcp(new Request('https://test/api/chatgpt-mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'craftush_workflow', arguments: {} } }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.connection.errors[0].code, 'STORAGE_ACCESS_DENIED');
  assert.equal(f.writes.length, 0);
});


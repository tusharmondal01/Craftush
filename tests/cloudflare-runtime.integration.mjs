import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('compiled v17 Worker runs with actual Cloudflare SQLite storage and preserves the API contract', { timeout: 45000 }, async t => {
  const origin = 'https://tusharmondal01.github.io';
  const providerCalls = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: fileURLToPath(new URL('../dist-worker/worker.js', import.meta.url)),
    compatibilityDate: '2026-10-09', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CRAFTUSH_DATA: { className: 'CraftushStorage', useSQLite: true } },
    bindings: { ADMIN_PASSWORD: 'runtime-fixture-admin', RUNWARE_API_KEY: 'runtime-fixture-provider-8811',
      ALLOWED_ORIGINS: origin, PUBLIC_SITE_URL: origin + '/Craftush' },
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'api.runware.ai', 'the fixture must never contact another provider');
      const tasks = await request.json();
      providerCalls.push(tasks);
      assert.equal(tasks[0].taskType, 'authentication'); assert.equal(tasks[0].apiKey, 'runtime-fixture-provider-8811');
      return Response.json({ data: tasks.filter(task => task.taskType !== 'authentication').map(task => ({
        taskType: task.taskType, taskUUID: task.taskUUID, text: 'A complete script-relevant prompt.', cost: 0.001,
      })) });
    },
  }));
  const call = (path, body, headers = {}) => runtime.dispatchFetch('https://worker.example' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const admin = body => call('/api/admin', body, { 'x-admin-password': 'runtime-fixture-admin' });
  try {
    await t.test('health and CORS are served by the compiled Worker', async () => {
      const response = await call('/api/health');
      assert.equal(response.status, 200); assert.equal((await response.json()).storage, 'connected');
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    });
    await t.test('a wrong password is rejected and the real admin handler accepts a correct one', async () => {
      const wrong = await call('/api/admin', { action: 'get' }, { 'x-admin-password': 'wrong' });
      assert.equal(wrong.status, 401);
      const response = await admin({ action: 'get' });
      assert.equal(response.status, 200); const value = await response.json();
      assert.equal(value.key.last4, '8811'); assert.equal(value.version, '17');
      assert(!JSON.stringify(value).includes('runtime-fixture-provider'));
    });
    await t.test('admin model edits persist in actual SQLite storage', async () => {
      const list = [{ id: 'anthropic:claude@sonnet-4.6', name: 'Claude Sonnet 4.6' }];
      assert.equal((await admin({ action: 'saveTextList', list })).status, 200);
      const metadata = await call('/api/runware');
      assert.deepEqual((await metadata.json()).textModels, list);
    });
    await t.test('the Runware relay forwards the original task and updates usage with a fixture provider', async () => {
      const taskUUID = crypto.randomUUID();
      const response = await call('/api/runware', [{ taskType: 'textInference', taskUUID, model: 'anthropic:claude@sonnet-4.6',
        messages: [{ role: 'user', content: 'Describe the river in this scene.' }], settings: { maxTokens: 200 } }]);
      assert.equal(response.status, 200);
      const value = await response.json(); assert.equal(value.data[0].taskUUID, taskUUID);
      assert(!JSON.stringify(value).includes('runtime-fixture-provider'));
      assert.equal(providerCalls.length, 1); assert.equal(providerCalls[0][1].taskUUID, taskUUID);
      assert.equal((await (await admin({ action: 'get' })).json()).usage.prompts, 1);
    });
    await t.test('team access code prevents unauthorized generation before a provider call', async () => {
      assert.equal((await admin({ action: 'saveCode', code: 'runtime-fixture-team' })).status, 200);
      const response = await call('/api/runware', [{ taskType: 'textInference', taskUUID: crypto.randomUUID() }]);
      assert.equal(response.status, 401); assert.equal(providerCalls.length, 1);
    });
    await t.test('large uploaded thumbnail HTML survives chunked SQLite storage', async () => {
      const html = '<!doctype html><html><head><title>Fixture thumbnail</title></head><body>' + 'हिन्दी 🦋'.repeat(80000) + '</body></html>';
      const uploaded = await admin({ action: 'uploadThumb', name: 'fixture.html', html });
      assert.equal(uploaded.status, 200);
      const result = await call('/thumbnail');
      assert.equal(result.status, 200); assert.match(await result.text(), /हिन्दी 🦋/);
    });
  } finally { await runtime.dispose(); }
});

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
    await t.test('automation settings persist and the new route enforces team access without exposing credentials', async () => {
      const saved = await admin({ action: 'saveVisualsAutomation', settings: { enabled: true, voice: 'hindi_male_1_v2', fps: '25' } });
      assert.equal(saved.status, 200);
      const value = await saved.json();
      assert.equal(value.visualsAutomation.fps, '25');
      assert.equal(value.visualsAutomationUsage.cost, 0);
      const config = await (await call('/api/visuals-automation')).json();
      assert.equal(config.config.voice, 'hindi_male_1_v2');
      assert.equal(config.connection, 'chatgpt');assert.equal(config.keyRequired,false);
      assert(!JSON.stringify(config).includes('runtime-fixture'));
      assert.equal((await call('/api/visuals-automation', { action: 'speech' })).status, 401);
      const start = await call('/api/visuals-automation', { action: 'start', sheetURL: 'https://docs.google.com/spreadsheets/d/example', tab: 'Rare & Endangered Animals', row: 2 }, { 'x-team-code': 'runtime-fixture-team' });
      assert.equal(start.status, 200);
      const queued=await start.json();assert.equal(queued.job.selection.row,2);assert.equal(queued.projectToken.length,64);assert(!queued.job.tokenHash);
      const mcp=async args=>{
        const response=await runtime.dispatchFetch('https://worker.example/api/chatgpt-mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'craftush_project',arguments:{projectToken:queued.projectToken,...args}}})});
        assert.equal(response.status,200);const envelope=await response.json();assert(!envelope.result.isError,JSON.stringify(envelope));return envelope.result.structuredContent;
      };
      const sheet=await mcp({action:'prepare'});assert.equal(sheet.kind,'sheetRead');assert.equal(sheet.selection.range,"'Rare & Endangered Animals'!C2:G2");
      const delivered=await mcp({action:'record',taskUUID:sheet.taskUUID,result:{taskUUID:sheet.taskUUID,text:JSON.stringify({values:[['Wildlife','India','','','Great Indian Bustard']]})}});
      assert.equal(delivered.recorded,true);assert.equal((await mcp({action:'read'})).title,'Great Indian Bustard');
      assert.equal(providerCalls.length, 1);
    });
    await t.test('narration-first approval and native MCP queue work through the real Worker', async () => {
      const team = { 'x-team-code': 'runtime-fixture-team' };
      const metadata = await (await call('/api/documentary')).json();
      assert.equal(metadata.workflow.narrationFirst.maxRequests,100);
      assert.equal((await call('/api/documentary-session',{action:'start'})).status,401);
      const before=providerCalls.length;
      assert.equal((await call('/api/documentary',{action:'narration-voice',taskUUID:crypto.randomUUID(),script:'A full script',approvedScript:'stale',audioModel:'google:gemini@3.1-flash-tts',chunk:0},team)).status,400);
      const start=await call('/api/documentary-session',{action:'start',title:'Narration test'},team);
      assert.equal(start.status,200);const {projectToken}=await start.json();
      const request={action:'narration-script',taskUUID:crypto.randomUUID(),idea:'A forest at dawn'};
      assert.equal((await call('/api/documentary-session',{action:'task',projectToken,request},team)).status,200);
      const mcp=async args=>{
        const response=await runtime.dispatchFetch('https://worker.example/api/chatgpt-mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'craftush_project',arguments:{projectToken,...args}}})});
        const envelope=await response.json();assert(!envelope.result.isError,JSON.stringify(envelope));return envelope.result.structuredContent;
      };
      assert.equal((await mcp({action:'read'})).projectType,'documentary-narration');
      const prepared=await mcp({action:'prepare'});assert.equal(prepared.request[0].model,'anthropic:claude@sonnet-4.6');assert.equal(prepared.taskUUID,request.taskUUID);
      const result={taskUUID:request.taskUUID,text:JSON.stringify({script:'A complete forest narration.'}),cost:.01};
      await mcp({action:'record',taskUUID:request.taskUUID,result});
      const completed=await (await call('/api/documentary-session',{action:'task',projectToken,request},team)).json();assert.equal(completed.data[0].text,result.text);
      assert.equal(providerCalls.length,before,'Keyless handoff never uses the server provider credential');
    });
    await t.test('large uploaded thumbnail HTML survives chunked SQLite storage', async () => {
      const html = '<!doctype html><html><head><title>Fixture thumbnail</title></head><body>' + 'हिन्दी 🦋'.repeat(80000) + '</body></html>';
      const uploaded = await admin({ action: 'uploadThumb', name: 'fixture.html', html });
      assert.equal(uploaded.status, 200);
      const result = await call('/thumbnail');
      assert.equal(result.status, 200); assert.match(await result.text(), /हिन्दी 🦋/);
    });
    await t.test('the owner archive retains a saved raster while team history stays inaccessible through real Durable Objects', async () => {
      const team = { 'x-team-code': 'runtime-fixture-team' }, owner = { 'x-admin-password': 'runtime-fixture-admin' };
      const id = crypto.randomUUID(), assetId = crypto.randomUUID();
      const image = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUq7jEwMDAxAAGABBWAWw4iy1UAAAAAElFTkSuQmCC';
      const before = providerCalls.length;
      const create = { action: 'create', submissionId: id, name: 'Editor', title: 'Solar thumbnails', width: 1080, height: 864,
        items: [{ title: 'Earth', prompt: 'Blue space scene with Earth', filename: 'earth.png' }] };
      assert.equal((await call('/api/image-requests', create)).status, 401);
      const saved = await call('/api/image-requests', create, team);
      assert.equal(saved.status, 201); assert.equal((await saved.json()).acknowledgement.id, id);
      assert.equal((await call('/api/image-requests', { action: 'status', id, status: 'completed' }, owner)).status, 409);
      const deliver = { action: 'deliver', id, images: [{ assetId, itemId: '1', name: 'earth.png', mime: 'image/png', base64: image }] };
      assert.equal((await call('/api/image-requests', deliver, team)).status, 401);
      assert.equal((await call('/api/image-requests', deliver, owner)).status, 200);
      assert.equal((await call('/api/image-requests', { action: 'status', id, status: 'completed' }, owner)).status, 200);
      assert.equal((await call('/api/image-requests?action=detail&id=' + id, undefined, team)).status, 403);
      const detail = await call('/api/image-requests?action=detail&id=' + id, undefined, owner);
      assert.equal((await detail.json()).request.status, 'completed');
      assert.equal((await call('/api/image-requests?action=asset&id=' + id + '&assetId=' + assetId, undefined, team)).status, 403);
      const asset = await call('/api/image-requests?action=asset&id=' + id + '&assetId=' + assetId, undefined, owner);
      assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), Buffer.from(image, 'base64'));
      assert.equal(providerCalls.length, before);
    });
  } finally { await runtime.dispose(); }
});

test('compiled Worker enforces burst and sign-in limits in actual SQLite Durable Objects', { timeout: 45000 }, async t => {
  const origin = 'https://tusharmondal01.github.io';
  const providerCalls = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: fileURLToPath(new URL('../dist-worker/worker.js', import.meta.url)),
    compatibilityDate: '2026-10-09', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CRAFTUSH_DATA: { className: 'CraftushStorage', useSQLite: true } },
    bindings: { ADMIN_PASSWORD: 'quota-fixture-admin', RUNWARE_API_KEY: 'quota-fixture-provider',
      ALLOWED_ORIGINS: origin, RATE_LIMIT_AI_MINUTE: '2', RATE_LIMIT_AI_HOUR: '4',
      RATE_LIMIT_LOOKUP_MINUTE: '2', RATE_LIMIT_ADMIN_ATTEMPTS: '2' },
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'api.runware.ai');
      const tasks = await request.json();
      providerCalls.push(tasks);
      return Response.json({ data: tasks.filter(task => task.taskType !== 'authentication').map(task => ({
        taskType: task.taskType, taskUUID: task.taskUUID, text: 'A scene-specific fixture prompt.', cost: 0,
      })) });
    },
  }));
  const call = (path, body, headers = {}) => runtime.dispatchFetch('https://worker.example' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    await t.test('concurrent generation is atomic and rejected calls do not reach the provider', async () => {
      const responses = await Promise.all(Array.from({ length: 12 }, () => call('/api/runware', [{
        taskType: 'textInference', taskUUID: crypto.randomUUID(), model: 'anthropic:claude@sonnet-4.6',
        messages: [{ role: 'user', content: 'Describe this scene.' }], settings: { maxTokens: 200 },
      }])));
      assert.equal(responses.filter(response => response.status === 200).length, 2);
      const blocked = responses.filter(response => response.status === 429);
      assert.equal(blocked.length, 10); assert.equal(providerCalls.length, 2);
      for (const response of blocked) {
        assert.match(response.headers.get('retry-after'), /^[1-9]\d*$/);
        assert.equal(response.headers.get('access-control-allow-origin'), origin);
        assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
        const value = await response.json();
        assert.equal(value.errors[0].code, 'RATE_LIMITED');
        assert.equal(value.retryAfter, Number(response.headers.get('retry-after')));
      }
    });
    await t.test('polling has its own allowance after generation fills up', async () => {
      const task = () => [{ taskType: 'getResponse', taskUUID: crypto.randomUUID() }];
      assert.equal((await call('/api/runware', task())).status, 200);
      assert.equal((await call('/api/runware', task())).status, 200);
      assert.equal((await call('/api/runware', task())).status, 429);
      assert.equal(providerCalls.length, 4);
      const health = await call('/api/health');
      assert.equal(health.status, 200);
      assert.equal((await health.json()).rateLimiting.generationPerMinute, 2);
    });
    await t.test('failed sign-in throttling preserves legitimate admin access', async () => {
      assert.equal((await call('/api/admin', { action: 'get' })).status, 401);
      assert.equal((await call('/api/admin', { action: 'get' })).status, 401);
      const blocked = await call('/api/admin', { action: 'get' });
      assert.equal(blocked.status, 429);
      assert.equal((await blocked.json()).errors[0].code, 'RATE_LIMITED');
      const admin = await call('/api/admin', { action: 'get' }, { 'x-admin-password': 'quota-fixture-admin' });
      assert.equal(admin.status, 200); assert.equal(providerCalls.length, 4);
    });
  } finally { await runtime.dispose(); }
});

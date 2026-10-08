import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createChatGPTBridge } from '../netlify/lib/chatgpt-bridge.js';
import { WORKFLOW } from '../netlify/lib/documentary-workflow.js';
import { restoreProject } from '../public/documentary/core.js';

const ID = 'e065e439-1259-4389-a48a-af6458893c67';
const plan = { glossary: 'पानी: consistent pronunciation.', subject_sheet: 'Mountain stream, no presenter.', continuity_sheet: 'Dawn, restrained green palette.',
  ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => ['scene' + (i + 1), 'Narration: यह पानी यहाँ तक कैसे पहुँचा? Shot: A mountain stream. Sound: Running water.'])) };
const master = JSON.stringify(plan);
const prompt = 'Voiceover: consistent documentary narration. A mountain stream at dawn. Voiceover narration says: यह पानी यहाँ तक कैसे पहुँचा? Avoid: captions, background music.';
function fixture(settings = {}) {
  let clock = Date.parse('2026-10-08T06:00:00Z'); const records = new Map();
  const store = { get: async k => structuredClone(records.get(k) ?? null), setJSON: async (k, v) => { records.set(k, structuredClone(v)); } };
  const handler = createChatGPTBridge({ openStore: () => store, readSettings: async () => ({ runwareKey: 'must-never-be-used-or-returned', ...settings }),
    teamCodeOk: async req => !settings.teamCode || req.headers.get('x-team-code') === settings.teamCode,
    dashboardView: () => ({ cards: { documentary: { enabled: settings.enabled !== false } } }),
    json: (data, status = 200) => Response.json(data, { status }), fail: (message, status) => Response.json({ errors: [{ message }] }, { status }), now: () => clock });
  const post = async (body, headers = {}) => {
    const response = await handler(new Request('https://craftush.test/api/chatgpt-bridge', { method: 'POST', headers: { origin: 'https://craftush.test', ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const connect = async headers => { const r = await post({ action: 'create', idea: 'Explore mountain streams.', title: 'Water at dawn' }, headers); assert.equal(r.status, 201); return r.body.projectToken; };
  return { handler, post, connect, records, advance: ms => { clock += ms; } };
}
const prepare = (f, token, fields = {}) => f.post({ action: 'prepare', projectToken: token, ...fields });
const record = (f, token, task, result) => f.post({ action: 'record', projectToken: token, taskUUID: task.taskUUID, result: { taskUUID: task.taskUUID, ...result } });
async function completeMaster(f, token) { const p = await prepare(f, token); assert.equal((await record(f, token, p.body, { text: master, cost: .5 })).status, 200); return p.body; }

test('ChatGPT metadata and project creation need no Runware key and cannot reveal the saved server key', async () => {
  const f = fixture(), metadata = await (await f.handler(new Request('https://craftush.test/api/chatgpt-bridge'))).json();
  assert.equal(metadata.keyRequired, false); assert.equal(metadata.enabled, true); assert(!JSON.stringify(metadata).includes('must-never'));
  const token = await f.connect(); assert.match(token, /^[0-9a-f]{64}$/);
  assert([...f.records.keys()].every(k => !k.includes(token)));
  assert(!JSON.stringify([...f.records]).includes(token)); assert(!JSON.stringify([...f.records]).includes('must-never'));
});
test('creation respects team access, same origin, tool visibility and a bounded hourly limit', async () => {
  const f = fixture({ teamCode: 'team-code' });
  assert.equal((await f.post({ action: 'create', idea: 'Nature' })).status, 401);
  assert.equal((await f.post({ action: 'create', idea: 'Nature' }, { 'x-team-code': 'team-code', origin: 'https://foreign.test' })).status, 403);
  await f.connect({ 'x-team-code': 'team-code' });
  assert.equal((await fixture({ enabled: false }).post({ action: 'create', idea: 'Nature' })).status, 403);
  const rate = fixture(); for (let i = 0; i < 20; i++) await rate.connect();
  assert.equal((await rate.post({ action: 'create', idea: 'Nature' })).status, 429);
  rate.advance(3600000); await rate.connect();
});
test('provider credentials are rejected from headers, nested body fields and media URLs before storage', async () => {
  const f = fixture(), token = await f.connect(), originalSize = f.records.size;
  for (const name of ['apiKey', 'api_key', 'runwareKey', 'authorization', 'authentication', 'connectionSessionUUID', 'secret']) {
    const r = await f.post({ action: 'read', projectToken: token, nested: { [name]: 'sensitive-value' } }); assert.equal(r.status, 400);
  }
  assert.equal((await f.post({ action: 'read', projectToken: token }, { authorization: 'Bearer sensitive-value' })).status, 400);
  assert.equal(f.records.size, originalSize); assert(!JSON.stringify([...f.records]).includes('sensitive-value'));
  await completeMaster(f, token);
  const direction = await prepare(f, token); await record(f, token, direction.body, { text: prompt });
  const video = await prepare(f, token);
  assert.equal((await record(f, token, video.body, { videoURL: 'https://vm.runware.ai/video/example.mp4?apiKey=sensitive-value' })).status, 400);
});
test('temporary codes isolate projects and expire or revoke without cancelling provider jobs', async () => {
  const f = fixture(), first = await f.connect(), second = await f.connect();
  assert.notEqual(first, second);
  const task = (await prepare(f, first)).body;
  assert.equal((await record(f, second, task, { text: master })).status, 404);
  assert.equal((await f.post({ action: 'read', projectToken: 'invalid' })).status, 401);
  assert.equal((await f.post({ action: 'read', projectToken: '0'.repeat(64) })).status, 410);
  assert.equal((await f.post({ action: 'revoke', projectToken: first })).status, 200);
  assert.equal((await prepare(f, first)).status, 410);
  f.advance(24 * 3600000); assert.equal((await f.post({ action: 'read', projectToken: second })).status, 410);
});
test('prepared requests preserve the exact workflow and repeated prepare returns only the original poll UUID', async () => {
  const f = fixture(), token = await f.connect(), task = (await prepare(f, token, { kind: 'master', scene: 9 })).body;
  assert.equal(task.submissionRequired, true); assert.equal(task.kind, 'master'); assert.equal(task.scene, undefined);
  assert.deepEqual(task.request[0].settings, WORKFLOW.master.settings); assert.equal(task.request[0].model, WORKFLOW.master.model);
  assert.equal(task.request[0].deliveryMethod, 'async'); assert.equal(task.request[0].messages[0].content, 'Explore mountain streams.');
  assert(JSON.stringify(task).length < 90000); assert(!JSON.stringify(task).includes('apiKey'));
  const again = (await prepare(f, token, { kind: 'master' })).body;
  assert.equal(again.taskUUID, task.taskUUID); assert.equal(again.submissionRequired, false); assert.equal(again.request, undefined);
  assert.deepEqual(again.pollRequest, [{ taskType: 'getResponse', taskUUID: task.taskUUID }]);
  assert.equal((await prepare(f, token, { kind: 'master', retry: true })).status, 409);
});
test('pending acknowledgements never count as completed outputs or create another paid request', async () => {
  const f = fixture(), token = await f.connect(), task = (await prepare(f, token)).body;
  assert.equal((await record(f, token, task, { status: 'processing' })).status, 200);
  const state = (await f.post({ action: 'read', projectToken: token })).body;
  assert.equal(state.masterReady, false); assert.equal(state.readyScenes, 0);
  assert.equal((await prepare(f, token)).body.taskUUID, task.taskUUID);
  assert.equal((await record(f, token, task, { status: 'success' })).status, 400);
});
test('malformed, truncated and mismatched text cannot advance dependent generation', async () => {
  const f = fixture(), token = await f.connect(), task = (await prepare(f, token)).body;
  assert.equal((await record(f, token, task, { text: '{"scene1":"partial"}' })).status, 400);
  assert.equal((await prepare(f, token, { kind: 'director', scene: 1 })).status, 409);
  assert.equal((await f.post({ action: 'record', projectToken: token, taskUUID: task.taskUUID, result: { taskUUID: ID, text: master } })).status, 400);
  const truncated = await record(f, token, task, { text: master, finishReason: 'length' }); assert.equal(truncated.body.taskStatus, 'error');
  assert.equal((await f.post({ action: 'read', projectToken: token })).body.masterReady, false);
  const retry = (await prepare(f, token, { kind: 'master', retry: true })).body; assert.notEqual(retry.taskUUID, task.taskUUID);
  assert.equal((await record(f, token, retry, { text: master })).status, 200);
});
test('completed results are idempotent and conflicting or stale outputs cannot replace them', async () => {
  const f = fixture(), token = await f.connect(), task = await completeMaster(f, token);
  assert.equal((await record(f, token, task, { text: master, cost: .5 })).body.recorded, false);
  assert.equal((await record(f, token, task, { text: master, cost: .9 })).status, 409);
  assert.equal((await record(f, token, task, { status: 'processing' })).body.taskStatus, 'complete');
  assert.equal((await prepare(f, token, { kind: 'master' })).body.complete, true);
  const saved = (await f.post({ action: 'project', projectToken: token })).body.project;
  assert.equal(saved.ledger[task.taskUUID].cost, .5); assert.equal(saved.master.text, master); assert.equal(saved.generationSource, 'chatgpt');
});
test('all thirteen branches keep complete context, native audio, numeric order and portable key-free exports', async () => {
  const f = fixture(), token = await f.connect(); await completeMaster(f, token);
  for (let scene = 1; scene <= 13; scene++) {
    const direction = (await prepare(f, token)).body;
    assert.equal(direction.kind, 'director'); assert.equal(direction.scene, scene); assert.equal(direction.request[0].model, WORKFLOW.director.model);
    assert.deepEqual(direction.request[0].settings, WORKFLOW.director.settings); assert.equal(direction.request[0].messages[0].content, master + '\n\nTARGET SCENE: scene' + scene);
    assert.equal((await record(f, token, direction, { text: prompt, cost: .1 })).status, 200);
    const video = (await prepare(f, token)).body; assert.equal(video.kind, 'video'); assert.equal(video.scene, scene);
    for (const [key, value] of Object.entries(WORKFLOW.video)) assert.deepEqual(video.request[0][key], value);
    assert.equal((await record(f, token, video, { videoURL: 'https://vm.runware.ai/video/test/scene-' + scene + '.mp4', cost: 1 })).status, 200);
  }
  const state = (await f.post({ action: 'project', projectToken: token })).body;
  assert.equal(state.readyScenes, 13); assert.equal(state.next, null); assert.equal((await prepare(f, token)).body.complete, true);
  const exported = restoreProject(state.project); assert.equal(exported.generationSource, 'chatgpt'); assert.deepEqual(exported.scenes.map(s => s.index), Array.from({ length: 13 }, (_, i) => i + 1));
  assert.equal(Object.keys(exported.ledger).length, 27); assert.equal(exported.scenes[12].videoURL, 'https://vm.runware.ai/video/test/scene-13.mp4');
  assert(!JSON.stringify(exported).includes(token)); assert(!JSON.stringify(exported).includes('must-never'));
});
test('invalid dimensions of the handoff, unsafe URLs and payload overruns are rejected', async () => {
  const f = fixture(), token = await f.connect(); await completeMaster(f, token);
  for (const scene of [0, 14, '1']) assert.equal((await prepare(f, token, { kind: 'director', scene })).status, 400);
  const direction = (await prepare(f, token)).body;
  assert.equal((await record(f, token, direction, { text: 'Unstructured scene description.' })).status, 400);
  await record(f, token, direction, { text: prompt }); const video = (await prepare(f, token)).body;
  for (const videoURL of ['http://vm.runware.ai/video/file.mp4', 'https://foreign.test/video/file.mp4', 'https://user:pass@vm.runware.ai/video/file.mp4', 'javascript:alert(1)']) {
    assert.equal((await record(f, token, video, { videoURL })).status, 400);
  }
  assert.equal((await f.post({ action: 'read', projectToken: token, padding: 'x'.repeat(90000) })).status, 413);
  const longPlan = { ...plan, glossary: 'x'.repeat(65000) }, other = fixture(), code = await other.connect(), masterTask = (await prepare(other, code)).body;
  assert.equal((await record(other, code, masterTask, { text: JSON.stringify(longPlan) })).status, 200);
  assert.equal((await prepare(other, code)).status, 413);
});
test('public MCP instructions preserve the provider boundary and safe continuation rules', async () => {
  const instructions = await readFile(new URL('../public/chatgpt/workflow-instructions.txt', import.meta.url), 'utf8');
  assert(instructions.length < 8000); assert(instructions.includes('https://mcp.runware.ai'));
  assert(instructions.includes('request[0]')); assert(instructions.includes('get_task_details'));
  assert(instructions.includes('Never resubmit a task whose submission is uncertain'));
  assert(instructions.includes('Craftush must never receive either credential'));
});

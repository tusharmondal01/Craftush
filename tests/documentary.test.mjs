import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildDocumentaryTask, createDocumentaryHandler, publicWorkflow } from '../netlify/lib/documentary-api.js';
import { createMediaHandler, MEDIA_CHUNK_BYTES, validateMediaURL } from '../netlify/lib/documentary-media.js';
import { WORKFLOW } from '../netlify/lib/documentary-workflow.js';
import { newProject, restoreProject, parseMaster, MASTER_KEYS, sceneNarration, projectCost, normalizedCommand, concatenateCommand, musicCommand, compatibleMedia, assertMedia } from '../public/documentary/core.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const plan = Object.fromEntries(MASTER_KEYS.map(k => [k, k.startsWith('scene') ? 'Role: explanation. Shot note: a stream; wide. Narration: यह पानी यहाँ तक कैसे पहुँचा? Shot note: flowing water; close-up. Narration: चलिए यह बात आज समझते हैं। Sound: water. Continuity: same valley.' : 'A consistent film plan.']));
const master = JSON.stringify(plan);
const prompt = 'Voiceover: a calm Indian documentary narrator. Shot one: a mountain stream. Voiceover narration says: यह पानी यहाँ तक कैसे पहुँचा? Avoid: captions, background music.';
const videoURL = 'https://vm.runware.ai/video/os/test/ws/1/vi/output.mp4';
function fixture({ key = 'server-secret', settings = {}, reply, failTransport = false } = {}) {
  const records = new Map(), calls = [];
  const store = { get: async k => records.get(k) || null, setJSON: async (k, v) => { records.set(k, structuredClone(v)); } };
  const deps = {
    openStore: () => store, readSettings: async () => settings, activeKey: () => key,
    teamCodeOk: async req => !settings.teamCode || req.headers.get('x-team-code') === settings.teamCode,
    dashboardView: () => ({ cards: { documentary: { enabled: settings.enabled !== false } } }),
    json: (data, status = 200) => Response.json(data, { status }), fail: (message, status) => Response.json({ errors: [{ message }] }, { status }),
    runwareURL: 'https://api.runware.ai/v1', fetch: async (url, options) => {
      const tasks = JSON.parse(options.body); calls.push(tasks);
      if (failTransport) throw new Error('Network interrupted');
      const response = reply ? reply(tasks[1], calls.length) : { data: [{ taskType: tasks[1].taskType, taskUUID: tasks[1].taskUUID, status: 'processing' }] };
      return Response.json(response.body || response, { status: response.status || 200 });
    },
  };
  const handler = createDocumentaryHandler(deps);
  const post = (body, code = '') => handler(new Request('https://craftush.test/api/documentary', { method: 'POST', headers: { 'x-team-code': code }, body: JSON.stringify(body) }));
  return { handler, deps, records, calls, post };
}

test('the supplied master and scene system prompts are preserved byte for byte', async () => {
  const source = JSON.parse(await readFile(new URL('../references/Runware_v18_API.json', import.meta.url), 'utf8'));
  assert.equal(WORKFLOW.master.settings.systemPrompt, source['1002'].inputs['settings.systemPrompt']);
  for (let i = 0; i < 13; i++) assert.equal(WORKFLOW.director.settings.systemPrompt, source[String(1335 + i * 3)].inputs['settings.systemPrompt']);
  assert.equal(createHash('sha256').update(WORKFLOW.master.settings.systemPrompt).digest('hex'), WORKFLOW.sourceHashes.masterPrompt);
  assert.equal(createHash('sha256').update(WORKFLOW.director.settings.systemPrompt).digest('hex'), WORKFLOW.sourceHashes.directorPrompt);
});
test('Runware translation preserves models, full token budgets, native audio and clip settings', () => {
  const m = buildDocumentaryTask({ action: 'master', idea: 'Explore monsoon insects.', taskUUID: ID, model: 'untrusted:model@1', settings: { maxTokens: 2 } });
  assert.equal(m.model, 'anthropic:claude@fable-5'); assert.equal(m.deliveryMethod, 'async'); assert.equal(m.outputFormat, 'TEXT');
  assert.equal(m.settings.maxTokens, 64000); assert.equal(m.settings.splitThinking, true); assert.equal(m.settings.thinkingLevel, 'high');
  for (let i = 1; i <= 13; i++) {
    const d = buildDocumentaryTask({ action: 'director', master, scene: i, taskUUID: ID });
    assert.equal(d.messages[0].content, master + '\n\nTARGET SCENE: scene' + i); assert.equal(d.model, 'anthropic:claude@sonnet-4.6'); assert.equal(d.settings.maxTokens, 32000);
  }
  const v = buildDocumentaryTask({ action: 'video', prompt, taskUUID: ID, duration: 3, width: 1 });
  assert.equal(v.duration, 12); assert.equal(v.width, 720); assert.equal(v.height, 1280); assert.equal(v.model, 'pixverse:1@8');
  assert.equal(v.seed, 42); assert.equal(v.numberResults, 1); assert.equal(v.settings.audio, true); assert.equal(v.settings.multiClip, true); assert.equal(v.outputQuality, 95);
});
test('invalid or incomplete master scripts never produce scene requests', () => {
  assert.throws(() => parseMaster('{"scene1":"partial"}'), /all 13 scenes/);
  assert.throws(() => parseMaster(master.slice(0, -10)), /invalid JSON/);
  assert.throws(() => buildDocumentaryTask({ action: 'director', master, scene: 14, taskUUID: ID }), /1 to 13/);
  assert.throws(() => buildDocumentaryTask({ action: 'video', prompt: prompt.repeat(60), taskUUID: ID }), /at most 5000/);
  assert.deepEqual(parseMaster('```json\n' + master + '\n```'), plan);
  assert.equal(sceneNarration(plan.scene1), 'यह पानी यहाँ तक कैसे पहुँचा? चलिए यह बात आज समझते हैं।');
});
test('generation is gated by team access, tool visibility and the existing server key', async () => {
  const body = { action: 'master', idea: 'A documentary.', taskUUID: ID };
  const protectedSite = fixture({ settings: { teamCode: 'team-code' } }); assert.equal((await protectedSite.post(body, 'wrong')).status, 401); assert.equal(protectedSite.calls.length, 0);
  const disabled = fixture({ settings: { enabled: false } }); assert.equal((await disabled.post(body)).status, 403); assert.equal(disabled.calls.length, 0);
  const missing = fixture({ key: '' }); assert.equal((await missing.post(body)).status, 503); assert.equal(missing.calls.length, 0);
  const normal = fixture(); assert.equal((await normal.post({ ...body, taskUUID: 'invalid' })).status, 400); assert.equal((await normal.post(null)).status, 400);
  assert.equal((await normal.post(body)).status, 200); assert.equal(normal.calls[0][0].apiKey, 'server-secret');
  const metadata = await (await normal.handler(new Request('https://craftush.test/api/documentary'))).json(); assert.equal(metadata.configured, true); assert(!JSON.stringify(metadata).includes('server-secret'));
});
test('repeated submissions and lost acknowledgements poll the original UUID without another paid request', async () => {
  const f = fixture(); const body = { action: 'master', idea: 'A documentary.', taskUUID: ID };
  await f.post(body); await f.post(body); await f.post({ action: 'poll', taskUUID: ID });
  assert.deepEqual(f.calls.map(c => c[1].taskType), ['textInference', 'getResponse', 'getResponse']);
  assert(f.calls.every(c => c[1].taskUUID === ID));
  assert.equal((await f.post({ ...body, idea: 'Different documentary.' })).status, 409);
  const lost = fixture({ failTransport: true }); assert.equal((await lost.post(body)).status, 502); assert(lost.records.has('documentary-task-' + ID));
  await lost.post(body); assert.equal(lost.calls[1][1].taskType, 'getResponse');
});
test('completed results are cached and sensitive provider fields never reach the page', async () => {
  const f = fixture({ reply: task => ({ data: [{ taskType: 'authentication', connectionSessionUUID: 'secret-session' }, { taskType: 'textInference', taskUUID: task.taskUUID, text: master, reasoningContent: 'private reasoning', apiKey: 'server-secret', cost: 0.5 }] }) });
  const body = { action: 'master', idea: 'A documentary.', taskUUID: ID, apiKey: 'browser-key' };
  const data = await (await f.post(body)).json(); assert.equal(data.data.length, 1);
  for (const value of ['server-secret', 'browser-key', 'secret-session', 'private reasoning']) assert(!JSON.stringify(data).includes(value));
  const cached = await (await f.post({ action: 'poll', taskUUID: ID })).json(); assert.equal(cached.data[0].text, master); assert.equal(f.calls.length, 1);
  assert.equal((await f.post({ action: 'poll', taskUUID: ID2 })).status, 404);
});
test('project import/export preserves scene order and costs while excluding keys and executable URLs', () => {
  const p = newProject(ID); p.idea = 'Nature'; p.master.text = master; p.master.idea = p.idea;
  p.scenes[0].prompt = prompt; p.scenes[0].videoURL = videoURL; p.ledger[ID] = { kind: 'video', cost: 0.72 };
  p.apiKey = 'should-never-export'; p.master.reasoningContent = 'private'; p.teamCode = 'team-secret';
  const restored = restoreProject(p); assert.equal(projectCost(restored), 0.72); assert.deepEqual(restored.scenes.map(s => s.index), Array.from({ length: 13 }, (_, i) => i + 1));
  assert(!JSON.stringify(restored).includes('should-never-export')); assert(!JSON.stringify(restored).includes('team-secret')); assert(!JSON.stringify(restored).includes('private'));
  p.scenes[0].videoURL = 'javascript:alert(1)'; assert.equal(restoreProject(p).scenes[0].videoURL, '');
  p.scenes[1].index = 1; assert.throws(() => restoreProject(p), /unique/);
});
test('MP4 concatenation maps original video and audio, and music never normalizes away narration volume', () => {
  const join = concatenateCommand('list.txt', 'out.mp4'); assert(join.includes('0:v:0')); assert(join.includes('0:a:0')); assert.equal(join[join.indexOf('-c') + 1], 'copy');
  const mix = musicCommand('in.mp4', 'music.mp3', 'out.mp4', 156, {});
  const filter = mix[mix.indexOf('-filter_complex') + 1]; assert(filter.includes('volume=-18dB')); assert(filter.includes('volume=0dB')); assert(filter.includes('normalize=0')); assert(filter.includes('st=153:d=3')); assert(mix.includes('-stream_loop')); assert.equal(mix[mix.indexOf('-c:v') + 1], 'copy');
  assert(!musicCommand('in.mp4', 'bg.mp3', 'out.mp4', 156, { fadeIn: 0, fadeOut: 0 })[8]?.includes('d=0'));
  const normalize = normalizedCommand('input.mp4', 'output.mp4'); assert(normalize.includes('0:a:0')); assert(normalize.includes('720:1280') === false); assert(!normalize.includes('-an')); assert(!normalize.includes('-t'));
  assert.throws(() => assertMedia({ streams: [{ codec_type: 'video' }], format: { duration: '12' } }), /narration audio/);
});
test('format compatibility considers audio sample rate as well as video dimensions', () => {
  const info = { video: { codec_name: 'h264', width: 720, height: 1280, time_base: '1/15360' }, audio: { codec_name: 'aac', sample_rate: '48000', channels: 2 }, duration: 12 };
  assert.equal(compatibleMedia([info, structuredClone(info)]), true);
  const different = structuredClone(info); different.audio.sample_rate = '44100'; assert.equal(compatibleMedia([info, different]), false);
});
test('media downloader rejects SSRF and caps every response at a function-safe chunk size', async () => {
  for (const url of ['http://127.0.0.1/video/test', 'https://vm.runware.ai.evil.test/video/x', 'https://vm.runware.ai:8443/video/x', 'https://vm.runware.ai@evil.test/video/x', 'https://api.runware.ai/v1']) assert.throws(() => validateMediaURL(url));
  assert.equal(validateMediaURL(videoURL), videoURL);
  const f = fixture(); let calls = 0;
  const handler = createMediaHandler({ ...f.deps, fetch: async (_, options) => { calls++; assert.equal(options.headers.Range, `bytes=0-${MEDIA_CHUNK_BYTES - 1}`); return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'content-range': 'bytes 0-2/3', 'content-length': '3' } }); } });
  const request = (url, start = 0) => handler(new Request('https://test/api/documentary-media', { method: 'POST', body: JSON.stringify({ url, start }) }));
  assert.equal((await request('http://localhost/video/')).status, 400); assert.equal(calls, 0);
  const result = await request(videoURL); assert.equal(result.status, 200); assert.equal(result.headers.get('x-media-total'), '3'); assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [1, 2, 3]);
  assert.equal((await request(videoURL, -1)).status, 400);
});
test('large non-range media responses and redirects are rejected before buffering', async () => {
  const f = fixture();
  for (const reply of [() => new Response('x', { headers: { 'content-length': String(MEDIA_CHUNK_BYTES + 1) } }), () => new Response(null, { status: 302, headers: { location: 'http://localhost/private' } })]) {
    const handler = createMediaHandler({ ...f.deps, fetch: async () => reply() });
    const response = await handler(new Request('https://test/api/documentary-media', { method: 'POST', body: JSON.stringify({ url: videoURL }) })); assert.equal(response.status, 502);
  }
});
test('dashboard defaults preserve all three existing tools and add the fourth', async () => {
  const { dashboardView } = await import('../netlify/lib/shared.js');
  const view = dashboardView({ dashboard: { cards: { visuals: { title: 'My visuals' }, documentary: { enabled: false } } } });
  assert.deepEqual(Object.keys(view.cards), ['thumbnail', 'visuals', 'comfy', 'documentary']); assert.equal(view.cards.visuals.title, 'My visuals'); assert.equal(view.cards.documentary.enabled, false); assert.equal(view.available.documentary, true);
  assert.equal(publicWorkflow().totalSeconds, 156);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../netlify/edge-functions/runware.js'), 'utf8').replace(/^import .*;\n/m, '').replace('export default async (req) =>', 'globalThis.handler = async (req) =>').replace('export const config =', 'const config =');
const SONNET = 'anthropic:claude@sonnet-4.6';
const GEMINI = 'google:gemini@3.5-flash';
const UUID = '11111111-1111-4111-8111-111111111111';
const textTask = (model = SONNET) => ({ taskType: 'textInference', taskUUID: UUID, model, settings: { maxTokens: 3000, temperature: 0.4 }, messages: [{ role: 'user', content: 'Keep the whole script context.' }] });
function fixture({ settings = {}, key = 'mock-secret', reply } = {}) {
  const calls = [], writes = [];
  const store = { setJSON: async (...args) => writes.push(args) };
  const usage = { images: 0, prompts: 0, cost: 0 };
  const context = vm.createContext({ Request, Response, AbortSignal, crypto: webcrypto, console,
    setTimeout: fn => { fn(); return 0; },
    openStore: () => store, readSettings: async () => settings, activeKey: () => key,
    json: (o, status = 200) => new Response(JSON.stringify(o), { status }),
    fail: (message, status) => new Response(JSON.stringify({ errors: [{ message }] }), { status }),
    safeEqual: (a, b) => a === b, readUsage: async () => usage,
    textModel: () => SONNET, textModels: () => [SONNET, GEMINI], textList: () => [{ id: SONNET }],
    cleanMessage: value => String(value || '').replace(/<[^>]*>/g, '').slice(0, 220),
    MODEL_ID: /^[\w.-]+:[\w.-]+@[\w.-]+$/, BUILTIN_TEXT_MODELS: [], VERSION: '13', RUNWARE_URL: 'https://api.runware.ai/v1',
    fetch: async (url, options) => {
      const tasks = JSON.parse(options.body); calls.push(tasks);
      const r = reply ? reply(tasks, calls.length) : { data: [{ taskType: 'textInference', taskUUID: UUID, text: 'OK', cost: 0.001 }] };
      return new Response(JSON.stringify(r.body || r), { status: r.status || 200 });
    }
  });
  vm.runInContext(source, context);
  const post = (tasks, code = '') => context.handler(new Request('https://test/api/runware', { method: 'POST', headers: { 'content-type': 'application/json', 'x-team-code': code }, body: JSON.stringify(tasks) }));
  return { context, calls, writes, usage, post };
}
test('Sonnet text and vision requests omit unsupported temperature without mutating input', async () => {
  const f = fixture();
  const task = { ...textTask(), inputs: { images: ['mock-image'] }, tools: [{ name: 'ignored' }], webhookURL: 'https://ignored', strictModel: true };
  const result = await f.post([task]); assert.equal(result.status, 200);
  const sent = f.calls[0][1];
  assert.equal(sent.model, SONNET); assert.equal(sent.deliveryMethod, 'sync');
  assert.deepEqual(sent.settings, { maxTokens: 3000 });
  assert.deepEqual(sent.inputs, task.inputs); assert.deepEqual(sent.messages, task.messages);
  assert.equal(task.settings.temperature, 0.4);
  for (const property of ['tools', 'webhookURL', 'strictModel', '_strict']) assert.equal(sent[property], undefined);
});
test('mixed text and image batches sanitize text settings and preserve image parameters', async () => {
  const f = fixture();
  const image = { taskType: 'imageInference', taskUUID: '22222222-2222-4222-8222-222222222222', model: 'openai:gpt-image@2', positivePrompt: 'Relevant photograph', settings: { temperature: 0.8 }, deliveryMethod: 'async' };
  await f.post([{ ...textTask(), strictModel: true }, image]);
  assert.equal(f.calls[0][1].settings.temperature, undefined);
  assert.equal(f.calls[0][1]._strict, undefined);
  assert.deepEqual(f.calls[0][2], image);
});
test('outage fallback uses Gemini without restoring temperature', async () => {
  const f = fixture({ reply: (tasks, n) => n <= 2 ? { status: 503, body: { errors: [{ message: 'temporarily unavailable' }] } } : { data: [{ taskType: 'textInference', text: 'OK' }] } });
  const result = await f.post([textTask()]);
  assert.equal(result.status, 200); assert.equal((await result.json()).model, GEMINI);
  assert.deepEqual(f.calls.map(tasks => tasks[1].model), [SONNET, SONNET, GEMINI]);
  for (const tasks of f.calls) assert.equal(tasks[1].settings.temperature, undefined);
  assert.notEqual(f.calls[0][1].taskUUID, f.calls[1][1].taskUUID);
});
test('a rejected model falls back; strict mode never switches', async () => {
  const rejected = 'missing:model@1';
  const make = () => fixture({ reply: tasks => tasks[1].model === rejected ? { status: 400, body: { errors: [{ message: 'Unknown model' }] } } : { data: [{ taskType: 'textInference', text: 'OK' }] } });
  const f = make(); assert.equal((await f.post([textTask(rejected)])).status, 200);
  assert.deepEqual(f.calls.map(tasks => tasks[1].model), [rejected, SONNET]);
  const strict = make(); assert.equal((await strict.post([{ ...textTask(rejected), strictModel: true }])).status, 503);
  assert.deepEqual(strict.calls.map(tasks => tasks[1].model), [rejected]);
});
test('token limits stay valid for malformed and oversized settings', async () => {
  for (const [input, expected] of [[-20, 1], [100000, 8000], [2.7, 3], ['bad', 4000]]) {
    const f = fixture(); const task = textTask(); task.settings.maxTokens = input;
    await f.post([task]); assert.equal(f.calls[0][1].settings.maxTokens, expected);
  }
});
test('team code, missing key and task validation stop unauthorized upstream requests', async () => {
  const f = fixture({ settings: { teamCode: 'required' } });
  assert.equal((await f.post([textTask()], 'wrong')).status, 401); assert.equal(f.calls.length, 0);
  const noKey = fixture({ key: '' }); assert.equal((await noKey.post([textTask()])).status, 503); assert.equal(noKey.calls.length, 0);
  const invalid = fixture(); assert.equal((await invalid.post([{ taskType: 'getResponse', taskUUID: 'invalid' }])).status, 400); assert.equal(invalid.calls.length, 0);
});
test('polling and authentication result filtering preserve image usage accounting', async () => {
  const f = fixture({ reply: () => ({ data: [{ taskType: 'authentication', connectionSessionUUID: 'private' }, { taskType: 'imageInference', imageBase64Data: 'image', cost: 0.05 }] }) });
  const response = await f.post([{ taskType: 'getResponse', taskUUID: UUID, apiKey: 'untrusted', model: 'ignored', webhookURL: 'https://ignored' }]);
  assert.deepEqual(f.calls[0][1], { taskType: 'getResponse', taskUUID: UUID });
  const data = await response.json(); assert.equal(data.data.length, 1);
  assert.equal(f.usage.images, 1); assert.equal(f.usage.cost, 0.05);
  assert(!JSON.stringify(data).includes('mock-secret')); assert(!JSON.stringify(data).includes('private'));
});
test('browser relay removes temperature before sending to older backends', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/visuals/index.html'), 'utf8');
  const relay = html.slice(html.indexOf('async function relay(tasks){'), html.indexOf('/* Scene-aware light:'));
  let body;
  const c = vm.createContext({ TEXT_MODEL: 'default', teamCode: () => '', fetch: async (url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ data: [], model: SONNET })); } });
  vm.runInContext(relay, c);
  const task = textTask(); await c.relay([task]);
  assert.equal(body[0].settings.temperature, undefined); assert.equal(body[0].model, SONNET);
  assert.equal(body[0].settings.maxTokens, 3000); assert.equal(task.settings.temperature, 0.4);
  assert.equal(c.TEXT_MODEL, SONNET);
});

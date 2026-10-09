import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.js';
import { CraftushStorage, cloudflareStore } from '../cloudflare/storage.js';
import { consumeQuota, initializeRateLimits, publicRateLimits, requestRateLimiter } from '../cloudflare/rate-limit.js';

function sqlite() {
  const database = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(query, ...args) {
      const statement = database.prepare(query);
      const rows = query.startsWith('SELECT') ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      database.exec('BEGIN');
      try { const result = callback(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  initializeRateLimits(storage.sql);
  return { storage, close: () => database.close() };
}

function fixture(overrides = {}) {
  const objects = new Map(), databases = [];
  const namespace = { idFromName: name => name, get(name) {
    if (!objects.has(name)) {
      const db = sqlite(); databases.push(db);
      objects.set(name, new CraftushStorage({ storage: db.storage }));
    }
    return objects.get(name);
  } };
  const environment = { CRAFTUSH_DATA: namespace, ADMIN_PASSWORD: 'quota-fixture-admin',
    RUNWARE_API_KEY: 'quota-fixture-provider', ALLOWED_ORIGINS: 'https://tusharmondal01.github.io', ...overrides };
  return { environment, namespace, objects, store: cloudflareStore(namespace), close: () => databases.forEach(db => db.close()) };
}

const req = (path, body, headers = {}) => new Request('https://quota-fixture.example' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { origin: 'https://tusharmondal01.github.io', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.12', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const textTask = () => ({ taskType: 'textInference', taskUUID: crypto.randomUUID(),
  model: 'anthropic:claude@sonnet-4.6', messages: [{ role: 'user', content: 'A scene prompt.' }] });
async function mockedProvider(callback) {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.runware.ai/v1');
    const tasks = JSON.parse(options.body); calls.push(tasks);
    return Response.json({ data: tasks.slice(1).map(task => ({ taskType: task.taskType, taskUUID: task.taskUUID, text: 'Fixture result.', cost: 0 })) });
  };
  try { await callback(calls); } finally { globalThis.fetch = previous; }
}
const rule = (name, limit, periodMs, weight = 1) => ({ name, limit, periodMs, weight });

test('SQLite quotas survive object reconstruction, expire and do not extend a blocked window', () => {
  const db = sqlite(), rules = [rule('generation-minute', 2, 60000)];
  try {
    assert.equal(consumeQuota(db.storage, rules, 1000).allowed, true);
    initializeRateLimits(db.storage.sql);
    assert.equal(consumeQuota(db.storage, rules, 1100).allowed, true);
    assert.equal(consumeQuota(db.storage, rules, 2000).retryAfter, 59);
    assert.equal(consumeQuota(db.storage, rules, 60000).retryAfter, 1);
    assert.equal(consumeQuota(db.storage, rules, 61000).allowed, true);
  } finally { db.close(); }
});

test('an hourly rejection or oversized batch never charges other windows', () => {
  const db = sqlite();
  try {
    const rules = [rule('generation-minute', 3, 60000, 2), rule('generation-hour', 2, 3600000, 2)];
    assert.equal(consumeQuota(db.storage, rules, 1000).allowed, true);
    const before = db.storage.sql.exec('SELECT name, used, reset_at FROM rate_limits ORDER BY name').toArray();
    assert.equal(consumeQuota(db.storage, rules.map(r => ({ ...r, weight: 1 })), 61000).allowed, false);
    assert.deepEqual(db.storage.sql.exec('SELECT name, used, reset_at FROM rate_limits ORDER BY name').toArray(), before);
    assert.equal(consumeQuota(db.storage, [rule('generation-minute', 3, 60000, 4)], 62000).oversized, true);
    assert.deepEqual(db.storage.sql.exec('SELECT name, used, reset_at FROM rate_limits ORDER BY name').toArray(), before);
  } finally { db.close(); }
});

test('concurrent requests cannot overspend quota and denied calls never reach Runware', async () => {
  const f = fixture({ RATE_LIMIT_AI_MINUTE: '2' });
  try {
    await mockedProvider(async calls => {
      const results = await Promise.all(Array.from({ length: 12 }, () => worker.fetch(req('/api/runware', [textTask()]), f.environment)));
      assert.equal(results.filter(r => r.status === 200).length, 2);
      const rejected = results.filter(r => r.status === 429);
      assert.equal(rejected.length, 10); assert.equal(calls.length, 2);
      assert.match(rejected[0].headers.get('access-control-expose-headers'), /Retry-After/);
      assert(Number(rejected[0].headers.get('retry-after')) >= 1);
      const body = await rejected[0].json();
      assert.equal(body.errors[0].code, 'RATE_LIMITED'); assert(body.retryAfter >= 1);
      assert.match(body.errors[0].message, /Please wait/);
    });
  } finally { f.close(); }
});

test('image result counts share the generation budget with text and admin model tests', async () => {
  const f = fixture({ RATE_LIMIT_AI_MINUTE: '4' });
  try {
    await mockedProvider(async calls => {
      const task = { taskType: 'imageInference', taskUUID: crypto.randomUUID(), numberResults: 4, positivePrompt: 'A river.' };
      assert.equal((await worker.fetch(req('/api/runware', [task]), f.environment)).status, 200);
      assert.equal((await worker.fetch(req('/api/runware', [textTask()]), f.environment)).status, 429);
      assert.equal((await worker.fetch(req('/api/admin', { action: 'testTextModel', model: 'anthropic:claude@sonnet-4.6' },
        { 'x-admin-password': 'quota-fixture-admin' }), f.environment)).status, 429);
      assert.equal(calls.length, 1);
      assert.equal((await worker.fetch(req('/api/admin', { action: 'get' }, { 'x-admin-password': 'quota-fixture-admin' }), f.environment)).status, 200);
    });
  } finally { f.close(); }
});

test('polling and model search have a separate quota while health and preflight remain available', async () => {
  const f = fixture({ RATE_LIMIT_AI_MINUTE: '1', RATE_LIMIT_LOOKUP_MINUTE: '2' });
  try {
    await mockedProvider(async calls => {
      assert.equal((await worker.fetch(req('/api/runware', [textTask()]), f.environment)).status, 200);
      const poll = { taskType: 'getResponse', taskUUID: crypto.randomUUID() };
      assert.equal((await worker.fetch(req('/api/runware', [poll]), f.environment)).status, 200);
      assert.equal((await worker.fetch(req('/api/runware', [{ taskType: 'modelSearch' }]), f.environment)).status, 200);
      assert.equal((await worker.fetch(req('/api/runware', [poll]), f.environment)).status, 429);
      assert.equal(calls.length, 3);
      assert.equal((await worker.fetch(req('/api/health'), f.environment)).status, 200);
      assert.equal((await worker.fetch(req('/api/runware'), f.environment)).status, 200);
      assert.equal((await worker.fetch(new Request('https://quota-fixture.example/api/runware', {
        method: 'OPTIONS', headers: { origin: 'https://tusharmondal01.github.io' } }), f.environment)).status, 204);
    });
  } finally { f.close(); }
});

test('failed admin guesses share a quota, but a correct password still opens admin', async () => {
  const f = fixture({ RATE_LIMIT_ADMIN_ATTEMPTS: '2' });
  try {
    for (const guess of ['guess-a', 'guess-b']) {
      assert.equal((await worker.fetch(req('/api/admin', { action: 'get' }, { 'x-admin-password': guess }), f.environment)).status, 401);
    }
    const denied = await worker.fetch(req('/api/admin', { action: 'get' }, { 'x-admin-password': 'different-guess' }), f.environment);
    assert.equal(denied.status, 429); assert(Number(denied.headers.get('retry-after')) <= 600);
    assert.equal((await worker.fetch(req('/api/admin', { action: 'get' }, { 'x-admin-password': 'quota-fixture-admin' }), f.environment)).status, 200);
    assert.equal((await worker.fetch(req('/api/admin', { action: 'get' }, { 'x-admin-password': 'guess-c', 'cf-connecting-ip': '192.0.2.13' }), f.environment)).status, 401);
  } finally { f.close(); }
});

test('counter identities contain no plaintext address or credential and forwarded headers cannot evade limits', async () => {
  const f = fixture({ RATE_LIMIT_ADMIN_ATTEMPTS: '1' });
  try {
    assert.equal(await requestRateLimiter(req('/api/admin', {}, { 'x-forwarded-for': '198.51.100.1' }), f.environment).admin(), null);
    const blocked = await requestRateLimiter(req('/api/admin', {}, { 'x-forwarded-for': '198.51.100.2' }), f.environment).admin();
    assert.equal(blocked.status, 429);
    const names = [...f.objects.keys()].filter(name => name.startsWith('rate-v17-'));
    assert.equal(names.length, 1);
    const name = names[0];
    assert.match(name, /^rate-v17-[0-9a-f]{64}$/);
    assert(!name.includes('192.0.2.12')); assert(!name.includes('quota-fixture'));
    assert.equal(await requestRateLimiter(req('/api/admin', {}, { 'cf-connecting-ip': '192.0.2.13' }), f.environment).admin(), null);
  } finally { f.close(); }
});

test('wrong team access consumes no generation quota and an unavailable limiter prevents billing', async () => {
  const f = fixture({ RATE_LIMIT_AI_MINUTE: '1' });
  try {
    await f.store.setJSON('settings', { teamCode: 'quota-team' });
    await mockedProvider(async calls => {
      assert.equal((await worker.fetch(req('/api/runware', [textTask()], { 'x-team-code': 'wrong' }), f.environment)).status, 401);
      assert.equal((await worker.fetch(req('/api/runware', [textTask()], { 'x-team-code': 'quota-team' }), f.environment)).status, 200);
      assert.equal(calls.length, 1);
      const unavailable = { ...f.environment, CRAFTUSH_DATA: {
        idFromName: name => name,
        get: name => name.startsWith('rate-v17-') ? { fetch: async () => { throw new Error('private fixture failure'); } } : f.namespace.get(name),
      } };
      const result = await worker.fetch(req('/api/runware', [textTask()], { 'x-team-code': 'quota-team' }), unavailable);
      assert.equal(result.status, 503); assert.equal((await result.json()).errors[0].code, 'RATE_LIMIT_UNAVAILABLE');
      assert.equal(calls.length, 1);
    });
  } finally { f.close(); }
});

test('a throttled documentary task creates no submitted receipt and can be retried with its original UUID', async () => {
  const f = fixture({ RATE_LIMIT_AI_MINUTE: '1' });
  try {
    await mockedProvider(async calls => {
      assert.equal((await worker.fetch(req('/api/runware', [textTask()]), f.environment)).status, 200);
      const body = { action: 'master', taskUUID: crypto.randomUUID(), idea: 'How butterflies migrate.' };
      assert.equal((await worker.fetch(req('/api/documentary', body), f.environment)).status, 429);
      assert.equal(await f.store.get('documentary-task-' + body.taskUUID), null);
      assert.equal(calls.length, 1);
      assert.equal((await worker.fetch(req('/api/documentary', body), { ...f.environment, RATE_LIMIT_AI_MINUTE: '2' })).status, 200);
      assert.equal(calls.length, 2);
      assert.equal((await worker.fetch(req('/api/documentary', body), f.environment)).status, 200);
      assert.equal(calls.length, 2, 'resuming a completed task must never generate or charge twice');
    });
  } finally { f.close(); }
});

test('unsafe limit settings retain defaults and the private quota endpoint is not public', async () => {
  const limits = publicRateLimits({ RATE_LIMIT_AI_MINUTE: '0', RATE_LIMIT_AI_HOUR: 'NaN', RATE_LIMIT_ADMIN_ATTEMPTS: '-1' });
  assert.equal(limits.generationPerMinute, 120); assert.equal(limits.generationPerHour, 1200); assert.equal(limits.adminAttemptsPer10Minutes, 10);
  assert.equal((await worker.fetch(req('/rate-limit', { rules: [] }), {})).status, 404);
});

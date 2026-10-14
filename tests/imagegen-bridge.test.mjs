import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { connection, ImageQueue } from '../scripts/imagegen-queue.mjs';

const config = {
  version: 1, backendURL: 'https://backend.craftush.test', apiPath: '/api/image-requests',
  runnerId: randomUUID(), runnerToken: 'ir_' + 'a'.repeat(64),
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const fixedNow = Date.parse('2026-10-14T12:00:00Z');

function job(overrides = {}) {
  return {
    jobId: randomUUID(), requestId: randomUUID(), itemId: '1', state: 'claimed',
    title: 'A quiet forest', prompt: 'A misty forest at sunrise.', styleNotes: 'Soft green.',
    width: 1080, height: 864, filename: '001-quiet-forest.png', references: [], ...overrides,
  };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'craftush-imagegen-bridge-'));
  t.after(async () => {
    const absolute = resolve(directory), base = resolve(tmpdir());
    assert.ok(absolute.startsWith(base + sep) && basename(absolute).startsWith('craftush-imagegen-bridge-'), 'cleanup remains within the test temporary directory');
    await rm(absolute, { recursive: true, force: true });
  });
  return directory;
}
function transport(handler) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, config.backendURL, 'all requests remain on the configured queue backend');
      assert.equal(parsed.pathname, config.apiPath);
      assert.equal(options.headers['X-Image-Runner'], config.runnerToken);
      assert.equal(options.redirect, 'error', 'the scoped runner token never follows redirects');
      assert.equal(options.headers['X-Admin-Password'], undefined);
      assert.equal(options.headers['X-Team-Code'], undefined);
      const body = options.body ? JSON.parse(options.body) : null;
      const action = body?.action ?? parsed.searchParams.get('action');
      const call = { action, body, url: parsed, options };
      calls.push(call);
      return handler(call);
    },
  };
}

test('connection validation accepts secure origins and loopback only, with scoped token and exact route', () => {
  assert.deepEqual(connection({ ...config, ignoredAPIKey: 'never-used' }), config);
  assert.equal(connection({ ...config, backendURL: 'http://127.0.0.1:8787' }).backendURL, 'http://127.0.0.1:8787');
  assert.equal(connection({ ...config, backendURL: 'http://localhost:8787' }).backendURL, 'http://localhost:8787');
  assert.equal(connection({ ...config, backendURL: 'http://[::1]:8787' }).backendURL, 'http://[::1]:8787');
  for (const backendURL of ['http://remote.example', 'ftp://backend.example', 'https://user:secret@backend.example', 'https://backend.example/api', 'https://backend.example/?token=secret', 'https://backend.example/#token']) {
    assert.throws(() => connection({ ...config, backendURL }), /secure backend origin/);
  }
  for (const override of [{ version: 2 }, { apiPath: '/api/admin' }, { runnerId: '../outside' }, { runnerToken: 'sk-paid-provider-key' }, { runnerToken: 'ir_short' }]) {
    assert.throws(() => connection({ ...config, ...override }), /Invalid Craftush connection/);
  }
});

test('a lost claim response is recovered using the same persisted claim ID', async t => {
  const directory = await temporary(t), claimed = job();
  let lost = true;
  const api = transport(({ action, body }) => {
    if (action === 'runnerHeartbeat') return json({ generator: {}, job: lost ? null : claimed });
    if (action === 'claim') {
      assert.match(body.claimId, /^[a-f0-9-]{36}$/);
      if (lost) { lost = false; throw new Error('Claim response lost'); }
      return json({ job: claimed });
    }
    assert.fail('Unexpected bridge action ' + action);
  });
  let queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
  await assert.rejects(queue.next(), /Claim response lost/);
  const uncertain = await queue.state();
  assert.ok(uncertain.claimId); assert.equal(uncertain.active, null);
  queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
  const recovered = await queue.next();
  const claims = api.calls.filter(call => call.action === 'claim');
  assert.equal(claims.length, 2);
  assert.equal(claims[0].body.claimId, claims[1].body.claimId);
  assert.equal(claims[1].body.claimId, uncertain.claimId);
  assert.equal(recovered.state, 'claimed'); assert.equal(recovered.canGenerate, false);
  assert.equal(recovered.nextAction, 'start');
});

test('only a fresh acknowledged start grants native generation, and repeated starts never do', async t => {
  const directory = await temporary(t), claimed = job();
  let serverJob = null;
  const api = transport(({ action, url }) => {
    if (action === 'runnerHeartbeat') return json({ generator: {}, job: serverJob });
    if (action === 'claim') { serverJob = claimed; return json({ job: claimed }); }
    if (action === 'start') { serverJob = { ...claimed, state: 'started' }; return json({ canGenerate: true, duplicate: false, job: serverJob }); }
    if (action === 'runnerJob') { assert.equal(url.searchParams.get('jobId'), claimed.jobId); return json({ job: serverJob }); }
    assert.fail('Unexpected bridge action ' + action);
  });
  const queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
  await queue.next();
  const first = await queue.start(claimed.jobId);
  assert.equal(first.canGenerate, true); assert.equal(first.state, 'generating');
  assert.equal((await queue.start(claimed.jobId)).canGenerate, false);
  const restarted = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
  assert.equal((await restarted.next()).canGenerate, false);
  assert.equal((await restarted.start(claimed.jobId)).canGenerate, false);
  assert.equal(api.calls.filter(call => call.action === 'start').length, 1);
  assert.equal(api.calls.filter(call => call.action === 'claim').length, 1);
});

test('duplicate and uncertain starts are held for attention rather than granting another generation', async t => {
  for (const outcome of ['duplicate', 'lost']) {
    await t.test(outcome, async t => {
      const directory = await temporary(t), claimed = job();
      let serverJob = null;
      const api = transport(({ action, url }) => {
        if (action === 'runnerHeartbeat') return json({ generator: {}, job: serverJob });
        if (action === 'claim') { serverJob = claimed; return json({ job: claimed }); }
        if (action === 'start') {
          serverJob = { ...claimed, state: 'started' };
          if (outcome === 'lost') throw new Error('Start response lost');
          return json({ canGenerate: true, duplicate: true, job: serverJob });
        }
        if (action === 'runnerJob') { assert.equal(url.searchParams.get('jobId'), claimed.jobId); return json({ job: serverJob }); }
        assert.fail('Unexpected bridge action ' + action);
      });
      let queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
      await queue.next();
      if (outcome === 'lost') await assert.rejects(queue.start(claimed.jobId), /Start response lost/);
      else assert.equal((await queue.start(claimed.jobId)).canGenerate, false);
      assert.equal((await queue.state()).active.phase, outcome === 'lost' ? 'start_requested' : 'needs_attention');
      queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
      assert.equal((await queue.start(claimed.jobId)).canGenerate, false);
      assert.equal((await queue.next()).canGenerate, false);
      assert.equal(api.calls.filter(call => call.action === 'start').length, 1);
      assert.equal(api.calls.filter(call => call.action === 'claim').length, 1);
    });
  }
});

test('a saved image survives an uncertain upload and retries identical bytes without restarting generation', async t => {
  const directory = await temporary(t), claimed = job();
  let serverJob = null, loseUpload = true;
  const api = transport(({ action, url }) => {
    if (action === 'runnerHeartbeat') return json({ generator: {}, job: serverJob });
    if (action === 'claim') { serverJob = claimed; return json({ job: claimed }); }
    if (action === 'start') { serverJob = { ...claimed, state: 'started' }; return json({ canGenerate: true, job: serverJob }); }
    if (action === 'runnerJob') { assert.equal(url.searchParams.get('jobId'), claimed.jobId); return json({ job: serverJob }); }
    if (action === 'complete') {
      if (loseUpload) { loseUpload = false; throw new Error('Completed upload response lost'); }
      serverJob = { ...claimed, state: 'completed' };
      return json({ duplicate: true, job: serverJob });
    }
    assert.fail('Unexpected bridge action ' + action);
  });
  let queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
  await queue.next(); assert.equal((await queue.start(claimed.jobId)).canGenerate, true);
  const original = join(directory, 'native-result.png'); await writeFile(original, png);
  await assert.rejects(queue.complete(claimed.jobId, original), /upload response lost/);
  const saved = (await queue.state()).active;
  assert.equal(saved.phase, 'result_saved');
  assert.equal(saved.result.fingerprint, createHash('sha256').update(png).digest('hex'));
  await rm(original);
  queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
  const completed = await queue.next();
  assert.equal(completed.state, 'completed'); assert.equal(completed.duplicate, true);
  const uploads = api.calls.filter(call => call.action === 'complete');
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[0].body, uploads[1].body, 'retry sends the saved image, same job ID and same filename');
  assert.equal(uploads[0].body.image.name, claimed.filename, 'a filename already ending in .png is not extended twice');
  assert.equal(Buffer.from(uploads[1].body.image.base64, 'base64').equals(png), true);
  assert.equal(api.calls.filter(call => call.action === 'start').length, 1);
  assert.equal(api.calls.filter(call => call.action === 'claim').length, 1);
  const history = JSON.parse(await readFile(join(directory, 'history', claimed.jobId + '.json'), 'utf8'));
  assert.equal(history.fingerprint, saved.result.fingerprint);
  assert.equal((await queue.complete(claimed.jobId)).duplicate, true);
});

test('a backend cancellation releases the local job without starting or uploading it', async t => {
  const directory = await temporary(t), claimed = job();
  let cancelled = false;
  const api = transport(({ action, url }) => {
    if (action === 'runnerHeartbeat') return json({ generator: {} });
    if (action === 'claim') return json({ job: claimed });
    if (action === 'runnerJob') {
      assert.equal(url.searchParams.get('jobId'), claimed.jobId);
      return json({ job: { ...claimed, requestStatus: cancelled ? 'cancelled' : 'queued' } });
    }
    assert.fail('Cancelled jobs must not be started or uploaded: ' + action);
  });
  const queue = new ImageQueue(config, directory, { fetchImpl: api.fetch });
  await queue.next(); cancelled = true;
  const result = await queue.next();
  assert.equal(result.state, 'cancelled');
  assert.equal((await queue.state()).active, null);
  assert.equal((await queue.state()).claimId, null);
  assert.equal((await queue.start(claimed.jobId)).canGenerate, false);
  assert.equal(api.calls.filter(call => call.action === 'claim').length, 1);
});

test('an expired unstarted claim can be released but denied scope never releases a started attempt', async t => {
  for (const phase of ['claimed', 'generating']) {
    await t.test(phase, async t => {
      const directory = await temporary(t), claimed = job();
      const api = transport(({ action }) => {
        if (action === 'runnerHeartbeat') return json({ generator: {} });
        if (action === 'claim') return json({ job: claimed });
        if (action === 'start') return json({ canGenerate: true, job: { ...claimed, state: 'started' } });
        if (action === 'runnerJob') return json({ errors: [{ code: 'RUNNER_SCOPE_DENIED', message: 'Claim scope expired.' }] }, 403);
        assert.fail('Unexpected bridge action ' + action);
      });
      const queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
      await queue.next();
      if (phase === 'generating') await queue.start(claimed.jobId);
      if (phase === 'claimed') {
        assert.equal((await queue.next()).state, 'claim_expired');
        assert.equal((await queue.state()).active, null);
        assert.equal((await queue.state()).claimId, null);
      } else {
        await assert.rejects(queue.next(), error => error.code === 'RUNNER_SCOPE_DENIED' && error.status === 403);
        assert.equal((await queue.state()).active.phase, 'generating', 'preserve the prior native attempt even if server scope is unavailable');
      }
      assert.equal((await queue.start(claimed.jobId)).canGenerate, false);
      assert.equal(api.calls.filter(call => call.action === 'claim').length, 1);
      assert.equal(api.calls.filter(call => call.action === 'start').length, phase === 'generating' ? 1 : 0);
    });
  }
});

test('replacing or tampering with a locally saved image cannot repair an upload by changing the result', async t => {
  const directory = await temporary(t), claimed = job();
  const api = transport(({ action }) => {
    if (action === 'runnerHeartbeat') return json({ generator: {} });
    if (action === 'claim') return json({ job: claimed });
    if (action === 'start') return json({ canGenerate: true, job: { ...claimed, state: 'started' } });
    if (action === 'complete') throw new Error('Upload not confirmed');
    assert.fail('Unexpected bridge action ' + action);
  });
  const queue = new ImageQueue(config, directory, { fetchImpl: api.fetch, now: () => fixedNow });
  await queue.next(); await queue.start(claimed.jobId);
  const first = join(directory, 'first.png'); await writeFile(first, png);
  await assert.rejects(queue.complete(claimed.jobId, first), /Upload not confirmed/);
  const other = join(directory, 'other.png'); await writeFile(other, Buffer.concat([png, Buffer.from('different')]));
  await assert.rejects(queue.complete(claimed.jobId, other), /different result is already saved/);
  const saved = (await queue.state()).active.result;
  await writeFile(saved.path, Buffer.concat([png, Buffer.from('tampered')]));
  await assert.rejects(queue.complete(claimed.jobId), /saved image changed/);
  assert.equal(api.calls.filter(call => call.action === 'complete').length, 1);
  assert.equal(api.calls.filter(call => call.action === 'start').length, 1);
});

test('references use authenticated job scope, ignore external URLs, and save validated raster bytes', async t => {
  const directory = await temporary(t), referenceId = randomUUID();
  const claimed = job({ references: [{ assetId: referenceId, name: '../../wrong.png', url: 'https://unrelated.example/secret' }] });
  const api = transport(({ action, url }) => {
    assert.equal(action, 'runnerAsset');
    assert.equal(url.searchParams.get('jobId'), claimed.jobId);
    assert.equal(url.searchParams.get('assetId'), referenceId);
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
  });
  const queue = new ImageQueue(config, directory, { fetchImpl: api.fetch });
  const paths = await queue.references(claimed);
  assert.deepEqual(paths, [join(directory, 'references', claimed.jobId, referenceId + '.png')]);
  assert.equal((await readFile(paths[0])).equals(png), true);
  assert.equal((await stat(paths[0])).size, png.length);
  assert.equal(api.calls.length, 1);
});

test('malformed job IDs and oversized or non-raster references are rejected before unsafe writes', async t => {
  const directory = await temporary(t), referenceId = randomUUID();
  let calls = 0;
  const queue = new ImageQueue(config, directory, { fetchImpl: async () => { calls++; assert.fail('Malformed references must not be fetched'); } });
  await assert.rejects(queue.references(job({ jobId: '../outside', references: [{ assetId: referenceId }] })), /job|identifier/i);
  await assert.rejects(queue.references(job({ references: [{ assetId: '../outside' }] })), /reference identifier/i);
  assert.equal(calls, 0);
  const declared = new ImageQueue(config, directory, { fetchImpl: async () => new Response(png, { headers: { 'Content-Length': String(5 * 1024 * 1024 + 1) } }) });
  await assert.rejects(declared.references(job({ references: [{ assetId: referenceId }] })), /reference is too large/);
  const actual = new ImageQueue(config, directory, { fetchImpl: async () => new Response(Buffer.alloc(5 * 1024 * 1024 + 1)) });
  await assert.rejects(actual.references(job({ references: [{ assetId: referenceId }] })), /reference is too large/);
  const invalid = new ImageQueue(config, directory, { fetchImpl: async () => new Response('<svg onload="alert(1)"></svg>', { headers: { 'Content-Type': 'image/png' } }) });
  await assert.rejects(invalid.references(job({ references: [{ assetId: referenceId }] })), /PNG, JPG or WebP/);
});

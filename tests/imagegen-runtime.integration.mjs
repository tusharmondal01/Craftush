import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUq7jEwMDAxAAGABBWAWw4iy1UAAAAAElFTkSuQmCC';
const image = { name: 'earth.png', mime: 'image/png', base64: PNG };

test('compiled native-image queue authorizes, coordinates and recovers through actual SQLite without provider calls', { timeout: 45000 }, async t => {
  const origin = 'https://tusharmondal01.github.io';
  const owner = { 'x-admin-password': 'native-runtime-fixture-owner' };
  const team = { 'x-team-code': 'native-runtime-fixture-team' };
  const outbound = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: fileURLToPath(new URL('../dist-worker/worker.js', import.meta.url)),
    compatibilityDate: '2026-10-09', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CRAFTUSH_DATA: { className: 'CraftushStorage', useSQLite: true } },
    bindings: { ADMIN_PASSWORD: owner['x-admin-password'], ALLOWED_ORIGINS: origin,
      PUBLIC_SITE_URL: origin + '/Craftush', RATE_LIMIT_REQUESTS_MINUTE: '1000' },
    outboundService: async request => {
      outbound.push(request.url);
      throw new Error('Native image coordination must never contact a provider.');
    },
  }));
  const call = (body, headers = {}, query = '') => runtime.dispatchFetch('https://worker.example/api/image-requests' + query, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = async (body, headers, query, expected = 200) => {
    const response = await call(body, headers, query);
    assert.equal(response.status, expected);
    return response.json();
  };
  const brief = title => ({ action: 'create', submissionId: crypto.randomUUID(), name: 'Fixture editor', title,
    width: 1080, height: 864, styleNotes: 'Cinematic green and blue',
    items: [{ title, prompt: 'An original Earth illustration without text', filename: 'earth.png' }] });
  let runner, firstRequest, firstJob, interruptedRequest, interruptedJob;
  try {
    const settings = await runtime.dispatchFetch('https://worker.example/api/admin', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...owner },
      body: JSON.stringify({ action: 'saveCode', code: team['x-team-code'] }),
    });
    assert.equal(settings.status, 200);

    await t.test('pairing requires owner access and public metadata contains no credentials', async () => {
      assert.equal((await call({ action: 'pair', name: 'Fixture desktop' }, team)).status, 401);
      const paired = await value({ action: 'pair', name: 'Fixture desktop' }, owner);
      assert.match(paired.runnerToken, /^ir_[a-f0-9]{64}$/);
      runner = { 'x-image-runner': paired.runnerToken };
      const metadata = await value(undefined, {}, '?action=meta');
      assert.equal(metadata.teamConfigured, true);
      assert.equal(metadata.generator.paired, true);
      const serialized = JSON.stringify(metadata);
      for (const secret of [paired.runnerToken, owner['x-admin-password'], team['x-team-code']]) assert(!serialized.includes(secret));
      assert(!serialized.includes('tokenDigest'));
      assert.equal((await call(undefined, runner, '?action=list')).status, 403);
      assert.equal((await call({ ...brief('Unauthorized runner request'), jobId: crypto.randomUUID() }, runner)).status, 403);
    });

    await t.test('runner header has permitted CORS while unrelated origins cannot access the queue', async () => {
      const preflight = await runtime.dispatchFetch('https://worker.example/api/image-requests', {
        method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-Image-Runner' },
      });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get('access-control-allow-headers'), /X-Image-Runner/i);
      const blocked = await runtime.dispatchFetch('https://worker.example/api/image-requests?action=runnerMeta', {
        headers: { origin: 'https://unrelated.example', ...runner },
      });
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).errors[0].code, 'ORIGIN_NOT_ALLOWED');
    });

    await t.test('claim and start retries never authorize a second generation, and references stay scoped', async () => {
      const body = { ...brief('First Earth image'), reference: { ...image, name: 'benchmark.png' } };
      firstRequest = (await value(body, team, '', 201)).request;
      const claimId = crypto.randomUUID();
      const claimed = await value({ action: 'claim', claimId }, runner);
      firstJob = claimed.job;
      assert.equal(firstJob.requestId, firstRequest.id);
      const repeated = await value({ action: 'claim', claimId }, runner);
      assert.equal(repeated.duplicate, true); assert.equal(repeated.job.jobId, firstJob.jobId);
      assert.equal((await call({ action: 'claim', claimId: crypto.randomUUID() }, runner)).status, 409);
      const reference = await call(undefined, runner, '?action=runnerAsset&jobId=' + firstJob.jobId + '&assetId=' + firstRequest.references[0].assetId);
      assert.equal(reference.status, 200);
      assert.deepEqual(Buffer.from(await reference.arrayBuffer()), Buffer.from(PNG, 'base64'));
      assert.equal((await call(undefined, runner, '?action=runnerAsset&jobId=' + crypto.randomUUID() + '&assetId=' + firstRequest.references[0].assetId)).status, 403);
      assert.equal((await call({ action: 'complete', jobId: firstJob.jobId, image }, runner)).status, 409);
      const started = await value({ action: 'start', jobId: firstJob.jobId }, runner);
      assert.equal(started.canGenerate, true); assert.equal(started.duplicate, false);
      const again = await value({ action: 'start', jobId: firstJob.jobId }, runner);
      assert.equal(again.canGenerate, false); assert.equal(again.duplicate, true);
    });

    await t.test('team-controlled request UUIDs cannot reserve an existing native result UUID', async () => {
      const collision = { ...brief('Separate reference request'), submissionId: firstJob.jobId,
        reference: { ...image, assetId: firstJob.jobId } };
      const saved = (await value(collision, team, '', 201)).request;
      assert.notEqual(saved.references[0].assetId, firstJob.jobId);
      await value({ action: 'status', id: saved.id, status: 'cancelled' }, owner);
    });

    await t.test('completion retries save one result and team downloads the original raster', async () => {
      const complete = { action: 'complete', jobId: firstJob.jobId, image };
      const saved = await value(complete, runner);
      assert.equal(saved.duplicate, false); assert.equal(saved.request.status, 'completed');
      const retry = await value(complete, runner);
      assert.equal(retry.duplicate, true); assert.equal(retry.request.results.length, 1);
      const terminal = await value(undefined, runner, '?action=runnerJob&jobId=' + firstJob.jobId);
      assert.equal(terminal.job.state, 'completed'); assert.equal(terminal.job.requestStatus, 'completed');
      const query = '?action=asset&id=' + firstRequest.id + '&assetId=' + firstJob.jobId;
      assert.equal((await call(undefined, {}, query)).status, 401);
      assert.equal((await call(undefined, runner, query)).status, 403);
      const asset = await call(undefined, team, query);
      assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/png');
      assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), Buffer.from(PNG, 'base64'));
    });

    await t.test('uncertain outcomes survive pairing rotation and owner cancellation releases other work', async () => {
      interruptedRequest = (await value(brief('Interrupted image'), team, '', 201)).request;
      interruptedJob = (await value({ action: 'claim', claimId: crypto.randomUUID() }, runner)).job;
      assert.equal(interruptedJob.requestId, interruptedRequest.id);
      assert.equal((await value({ action: 'start', jobId: interruptedJob.jobId }, runner)).canGenerate, true);
      await value({ action: 'report', jobId: interruptedJob.jobId, state: 'needs_attention', message: 'Fixture lost native result; do not regenerate.' }, runner);
      const previousRunner = runner;
      const paired = await value({ action: 'pair', name: 'Replacement fixture desktop' }, owner);
      runner = { 'x-image-runner': paired.runnerToken };
      assert.equal((await call({ action: 'runnerHeartbeat' }, previousRunner)).status, 401);
      assert.equal((await call(undefined, runner, '?action=runnerJob&jobId=' + interruptedJob.jobId)).status, 403);
      const blocked = await value({ action: 'claim', claimId: crypto.randomUUID() }, runner);
      assert.equal(blocked.job, null); assert.equal(blocked.blocked, 'needs_attention');
      const nextRequest = (await value(brief('Next queued image'), team, '', 201)).request;
      await value({ action: 'status', id: interruptedRequest.id, status: 'cancelled' }, owner);
      const detail = (await value(undefined, team, '?action=detail&id=' + interruptedRequest.id)).request;
      assert.equal(detail.items[0].generation.state, 'needs_attention');
      const next = await value({ action: 'claim', claimId: crypto.randomUUID() }, runner);
      assert.equal(next.job.requestId, nextRequest.id);
      assert.notEqual(next.job.jobId, interruptedJob.jobId);
      await value({ action: 'revoke' }, owner);
      assert.equal((await call({ action: 'runnerHeartbeat' }, runner)).status, 401);
    });

    assert.deepEqual(outbound, [], 'queue operations must never initiate an AI/provider request');
  } finally { await runtime.dispose(); }
});

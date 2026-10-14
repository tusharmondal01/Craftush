import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { adaptPagesText } from '../scripts/build-github-pages.mjs';

const html = await readFile(new URL('../public/images/index.html', import.meta.url), 'utf8');
const client = await readFile(new URL('../public/images/app.js', import.meta.url), 'utf8');

function browser(fetch) {
  const { document, window } = parseHTML(html);
  const $ = id => document.getElementById(id);
  // linkedom supplies DOM and event dispatch, but lacks native select setters,
  // scrolling, file selection, clipboard and FileReader implementations.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return this.testSelectedValue ?? this.querySelector('option')?.value ?? ''; },
    set(value) { this.testSelectedValue = String(value); },
  });
  for (const node of document.querySelectorAll('*')) {
    node.scrollIntoView = () => {};
    node.focus = () => {};
  }
  for (const node of document.querySelectorAll('input[type=file]')) node.files = [];
  const initialValues = [...document.querySelectorAll('input,textarea')].map(node => [node, node.value]);
  let mode = 'single';
  $('requestForm').reset = () => {
    for (const [node, value] of initialValues) node.value = value;
    for (const node of document.querySelectorAll('input[type=file]')) node.files = [];
    mode = 'single';
  };
  const nativeQuery = document.querySelector.bind(document);
  document.querySelector = selector => selector === 'input[name="requestMode"]:checked'
    ? nativeQuery('input[name="requestMode"][value="' + mode + '"]') : nativeQuery(selector);
  const copied = [];
  const revoked = [];
  const blobDownloads = [];
  const objectURLs = new Map();
  const timers = new Map();
  let timerID = 0;
  class LocalURL extends URL {}
  LocalURL.createObjectURL = blob => { const url = 'blob:test-' + webcrypto.randomUUID(); objectURLs.set(url, blob); return url; };
  LocalURL.revokeObjectURL = url => revoked.push(url);
  window.HTMLAnchorElement.prototype.click = function () { blobDownloads.push({ name: this.download, blob: objectURLs.get(this.href) }); };
  class FileReader {
    readAsDataURL(file) {
      this.result = 'data:' + file.type + ';base64,iVBORw==';
      queueMicrotask(() => this.onload());
    }
  }
  runInNewContext(client, {
    document, window, fetch, URL: LocalURL, URLSearchParams, AbortSignal,
    crypto: webcrypto, TextEncoder, FileReader, Blob,
    setTimeout: (callback, delay) => { const id = ++timerID; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    navigator: { clipboard: { writeText: async text => copied.push(text) } },
  });
  return {
    $, document, copied, revoked, blobDownloads,
    async poll() {
      const entry = [...timers].find(([, timer]) => timer.delay >= 15000);
      assert.ok(entry, 'workspace schedules automatic refresh');
      assert.ok(entry[1].delay >= 15000, 'queue polling is bounded');
      timers.delete(entry[0]);
      await entry[1].callback();
    },
    event(id, type = 'submit') { $(id).dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); },
    click(node) { node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); },
    batch() {
      mode = 'batch';
      nativeQuery('input[name="requestMode"][value="batch"]').dispatchEvent(new window.Event('change', { bubbles: true }));
    },
  };
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for ' + description);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

test('automatic generator workflow pairs once, refreshes jobs, preserves uncertain IDs and downloads results', async () => {
  const calls = [], creates = [], delivers = [];
  let saved = null;
  let failCreate = true;
  let failSecondDelivery = true;
  const token = 'ir_' + 'a'.repeat(64);
  let generator = { paired: false, connected: false, lastSeenAt: null, state: 'offline', needsAttention: 0 };
  const app = browser(async (path, options) => {
    assert.ok(path.startsWith('/api/image-requests'), 'frontend only calls its request backend');
    const body = options.body ? JSON.parse(options.body) : null;
    const action = body?.action ?? new URL('https://craftush.test' + path).searchParams.get('action');
    calls.push({ path, options, action });
    if (action === 'meta') {
      if (calls.length === 1) assert.deepEqual(Object.keys(options.headers), [], 'initial readiness does not send a credential');
      return json({ enabled: true, teamConfigured: true, generator });
    }
    const teamCode = options.headers['X-Team-Code'];
    const adminPassword = options.headers['X-Admin-Password'];
    if (teamCode === 'wrong') return json({ errors: [{ message: 'Wrong team code.' }] }, 403);
    assert.ok(teamCode === 'team-secret' || adminPassword === 'owner-secret');
    assert.equal(options.redirect, 'error', 'credentials cannot follow redirects');
    if (action === 'list') return json({ requests: saved ? [{
      id: saved.id, title: saved.title, name: saved.name, status: saved.status,
      itemCount: saved.items.length, resultCount: saved.results.length, createdAt: saved.createdAt,
    }] : [], total: saved ? 1 : 0 });
    if (action === 'create') {
      creates.push(body);
      if (failCreate) { failCreate = false; throw new Error('Connection lost after sending'); }
      saved = {
        ...body, id: body.submissionId,
        items: body.items.map((item, index) => ({ ...item, id: String(index + 1), generation: { state: 'pending' } })),
        status: 'queued', notes: '', createdAt: '2026-10-14T10:00:00Z',
        references: [{ assetId: webcrypto.randomUUID(), name: body.reference.name, mime: 'image/png', bytes: 8 }],
        results: [],
      };
      return json({ request: saved });
    }
    if (action === 'detail') return json({ request: saved });
    if (action === 'pair') {
      assert.equal(adminPassword, 'owner-secret');
      generator = { ...generator, paired: true };
      return json({ runnerToken: token, runnerId: webcrypto.randomUUID(), backendURL: 'https://backend.craftush.test', apiPath: '/api/image-requests', generator });
    }
    if (action === 'status') {
      assert.equal(adminPassword, 'owner-secret');
      saved.status = body.status; saved.notes = body.notes;
      return json({ request: saved });
    }
    if (action === 'deliver') {
      assert.equal(adminPassword, 'owner-secret');
      assert.equal(body.images.length, 1, 'upload one image per call to bound memory');
      delivers.push(body);
      if (body.images[0].itemId === '2' && failSecondDelivery) {
        failSecondDelivery = false;
        throw new Error('Delivery connection lost');
      }
      saved.results.push({ ...body.images[0], bytes: 8, createdAt: '2026-10-14T10:30:00Z' });
      return json({ request: saved });
    }
    if (action === 'asset') return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
    assert.fail('Unexpected request action: ' + action);
  });
  const { $, event, click } = app;
  await until(() => !$('accessButton').disabled, 'backend metadata');
  $('credential').value = 'wrong'; event('accessForm');
  await until(() => $('accessMessage').textContent === 'Wrong team code.', 'visible login error');
  assert.equal($('workspace').hidden, true);
  $('credential').value = 'team-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'team workspace');
  assert.equal($('credential').value, '', 'credential input is cleared after access');
  assert.equal($('generatorBadge').textContent, 'Not connected');
  assert.equal($('pairingSection').hidden, true, 'only the owner can pair the generator');

  $('requesterName').value = 'Riya';
  $('projectTitle').value = '<img src=x onerror=alert(1)>';
  app.batch();
  $('batchTitles').value = 'Forest at dawn\n<svg onload=alert(1)>';
  $('imagePrompt').value = 'Create an atmospheric documentary thumbnail for each title.';
  $('styleNotes').value = 'Muted green, clear negative space.';
  $('referenceFile').files = [{ name: 'benchmark.png', type: 'image/png', size: 8 }];
  event('requestForm');
  await until(() => !$('pendingSubmission').hidden && !$('retrySubmission').disabled, 'uncertain submission controls');
  assert.equal(creates.length, 1, 'failed submissions do not retry automatically');
  assert.equal($('projectTitle').disabled, true, 'freeze the request snapshot until resolved');
  event('retrySubmission', 'click');
  await until(() => !$('detailSection').hidden && $('pendingSubmission').hidden, 'saved request details');
  assert.equal(creates[0].submissionId, creates[1].submissionId);
  assert.equal(saved.items.length, 2);
  assert.equal(saved.width, 1080); assert.equal(saved.height, 864);
  assert.equal(saved.reference.base64, 'iVBORw==');
  assert.equal($('detailHeading').textContent, '<img src=x onerror=alert(1)>');
  assert.equal($('detailHeading').querySelector('img'), null);
  assert.equal($('detailItems').querySelector('svg'), null);
  assert.equal($('queueList').querySelector('img'), null);
  assert.equal($('ownerControls').hidden, true);
  assert.match($('requestMessage').textContent, /generated automatically/);
  assert.ok($('detailItems').textContent.includes('Queued'));
  click($('copyBrief'));
  await until(() => app.copied.length === 1, 'complete generation brief');
  assert.match(app.copied[0], /1080 × 864/);
  assert.match(app.copied[0], /Forest at dawn/);
  assert.match(app.copied[0], /benchmark\.png/);
  assert.match(app.copied[0], /background generator processes this brief automatically/);
  await until(() => !$('submitRequest').disabled, 'submission save to finish before polling');

  generator = { paired: true, connected: true, lastSeenAt: '2026-10-14T10:10:00Z', state: 'busy', needsAttention: 0 };
  saved.status = 'in_progress';
  saved.items[0].generation = { state: 'started' };
  saved.updatedAt = '2026-10-14T10:10:00Z';
  await app.poll();
  assert.equal($('generatorBadge').textContent, 'Online');
  assert.match($('generatorStatus').textContent, /creating images/);
  assert.match($('generatorHeartbeat').textContent, /Last connected/);
  assert.match($('detailMeta').textContent, /Generating/);
  assert.ok($('detailItems').textContent.includes('Generating'));
  generator = { ...generator, connected: false, state: 'needs_attention', needsAttention: 1 };
  saved.status = 'needs_attention';
  saved.items[0].generation = { state: 'needs_attention', message: '<img src=x onerror=alert(1)>' };
  saved.updatedAt = '2026-10-14T10:20:00Z';
  await app.poll();
  assert.equal($('generatorBadge').textContent, 'Needs attention');
  assert.match($('generatorStatus').textContent, /offline/);
  assert.match($('detailMeta').textContent, /Needs attention/);
  assert.equal($('detailItems').querySelector('img'), null, 'job messages are plain text');

  event('lockButton', 'click');
  assert.equal($('workspace').hidden, true);
  $('accessRole').value = 'owner'; event('accessRole', 'change');
  $('credential').value = 'owner-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'owner workspace');
  assert.equal($('pairingSection').hidden, false);
  // Re-pairing is a deliberate owner action. Existing active tokens are replaced.
  app.document.defaultView.confirm = () => true;
  event('pairGenerator', 'click');
  await until(() => !$('downloadPairing').hidden, 'one-time connection file');
  assert.equal(app.document.body.textContent.includes(token), false, 'the runner token is not displayed');
  event('downloadPairing', 'click');
  const downloaded = app.blobDownloads.find(item => item.name === 'craftush-generator-connection.json');
  assert.ok(downloaded);
  const config = JSON.parse(await downloaded.blob.text());
  assert.equal(config.runnerToken, token);
  assert.equal(config.backendURL, 'https://backend.craftush.test');
  assert.equal(config.apiPath, '/api/image-requests');
  assert.equal(config.version, 1);
  click($('queueList').querySelector('button'));
  await until(() => !$('ownerControls').hidden, 'owner request controls');
  assert.equal($('ownerControls').tagName, 'DETAILS');
  assert.equal($('ownerControls').hasAttribute('open'), false, 'recovery is not the normal generation flow');
  $('ownerStatus').value = 'in_progress'; $('ownerNotes').value = 'Generating in ChatGPT';
  event('statusForm');
  await until(() => !$('saveStatus').disabled && saved.status === 'in_progress', 'owner status update');
  $('deliveryFiles').files = saved.items.map(item => ({ name: item.filename, type: 'image/png', size: 8 }));
  event('deliveryFiles', 'change');
  assert.equal($('deliverButton').disabled, false);
  event('deliveryForm');
  await until(() => !$('deliverButton').disabled && $('deliveryMessage').textContent.includes('same image IDs'), 'partial delivery failure');
  assert.equal(saved.results.length, 1, 'the successful first result remains delivered');
  assert.equal(delivers.length, 2, 'failed deliveries do not retry automatically');
  const failedAssetId = delivers[1].images[0].assetId;
  event('deliveryForm');
  await until(() => saved.results.length === 2 && $('deliveryMessage').classList.contains('success'), 'delivery retry');
  assert.equal(delivers.length, 3, 'the successful first image is not uploaded again');
  assert.equal(delivers[2].images[0].assetId, failedAssetId);
  assert.equal($('deliverButton').disabled, true);
  const resultCallsBeforeClick = calls.filter(call => call.action === 'asset').length;
  click($('detailResults').querySelector('button'));
  await until(() => $('detailResults').querySelector('a'), 'authenticated result download');
  assert.equal(calls.filter(call => call.action === 'asset').length, resultCallsBeforeClick + 1, 'results load on demand');
  assert.equal($('detailResults').querySelector('a').download, saved.results[0].name);
  assert.ok($('detailResults').querySelector('a').href.startsWith('blob:'));
  event('lockButton', 'click');
  assert.ok(app.revoked.length > 0, 'locking releases authenticated image previews');
  assert.equal($('credential').value, '');
  assert.equal($('downloadPairing').hidden, true, 'the in-memory connection file is cleared when locked');
  assert.doesNotMatch(client, /localStorage|sessionStorage|innerHTML/, 'credentials stay in memory and untrusted text stays text');
});

test('an undeployed backend disables access and explains why the queue is unavailable', async () => {
  const app = browser(async () => json({ errors: [{ code: 'BACKEND_NOT_HOSTED', message: 'Backend unavailable.' }] }, 503));
  await until(() => app.$('connectionNotice').textContent.includes('deployed Craftush backend'), 'deployment notice');
  assert.equal(app.$('accessButton').disabled, true);
  assert.match(app.$('connectionNotice').textContent, /deployment settings/);
});

test('every image UI control exists and GitHub Pages adapts both authenticated API calls', () => {
  const { document } = parseHTML(html);
  const referencedIDs = [...new Set([...client.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]))];
  assert.deepEqual(referencedIDs.filter(id => !document.getElementById(id)), []);
  const output = adaptPagesText(client, '/Craftush', 'js', 'https://backend.example');
  assert.equal((output.match(/window\.craftushAPI\('/g) || []).length, 2);
  assert.doesNotMatch(output, /fetch\(['"]\/api\//);
  const page = adaptPagesText(html, '/Craftush', 'html', 'https://backend.example');
  assert.match(page, /src="\/Craftush\/images\/app\.js"/);
  assert.match(page, /href="\/Craftush\/images\/style\.css"/);
});

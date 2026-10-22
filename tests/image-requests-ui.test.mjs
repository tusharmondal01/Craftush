import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { adaptPagesText } from '../scripts/build-github-pages.mjs';

const html = await readFile(new URL('../public/images/index.html', import.meta.url), 'utf8');
const client = await readFile(new URL('../public/images/app.js', import.meta.url), 'utf8');

function browser(fetch, { checkMode } = {}) {
  const { document, window } = parseHTML(html);
  if (checkMode) document.body.dataset.checkMode = checkMode;
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
    cleanupDownloads() {
      for (const [id, timer] of timers) if (timer.delay === 1000) { timers.delete(id); timer.callback(); }
    },
    async poll() {
      const entry = [...timers].find(([, timer]) => timer.delay >= 15000);
      assert.ok(entry, 'workspace schedules automatic refresh');
      assert.ok(entry[1].delay >= 15000, 'queue polling is bounded');
      timers.delete(entry[0]);
      await entry[1].callback();
    },
    scheduledPolls() { return [...timers.values()].filter(timer => timer.delay >= 15000).length; },
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

test('manual checks show standby honestly and archive refresh never contacts the runner', async () => {
  const actions = [];
  const generator = { paired: true, connected: false, lastSeenAt: '2026-10-16T07:03:00Z', state: 'offline', needsAttention: 0 };
  const app = browser(async (path, options) => {
    const action = options.body ? JSON.parse(options.body).action : new URL('https://craftush.test' + path).searchParams.get('action');
    actions.push(action);
    if (action === 'meta') return json({ enabled: true, teamConfigured: true, generator });
    if (action === 'list') return json({ requests: [], total: 0 });
    assert.fail('Manual standby must not contact the generator: ' + action);
  });
  const { $, event } = app;
  await until(() => !$('accessButton').disabled, 'manual standby metadata');
  assert.equal(app.document.body.dataset.checkMode, 'manual', 'the site explicitly configures manual checks');
  assert.equal($('generatorHeading').textContent, 'Thumbnail generator');
  assert.equal($('generatorBadge').textContent, 'Manual checks');
  assert.match($('generatorStatus').textContent, /wait until the owner starts a manual check in chat/);
  assert.match($('generatorStatus').textContent, /Checking every five minutes is off/);
  assert.doesNotMatch($('generatorStatus').textContent, /offline|Generator online/);
  assert.match($('generatorHeartbeat').textContent, /^Last checked: /);
  assert.doesNotMatch($('generatorHeartbeat').textContent, /updates automatically/);
  assert.match($('connectionNotice').textContent, /Requests wait until the owner starts a manual check/);
  assert.equal(generator.connected, false, 'manual standby never changes actual heartbeat freshness');
  $('accessRole').value = 'owner'; event('accessRole', 'change');
  $('credential').value = 'owner-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'owner archive access');
  await app.poll();
  assert.equal($('generatorBadge').textContent, 'Manual checks');
  assert.deepEqual(actions, ['meta', 'list', 'meta', 'list']);
  assert.ok(actions.every(action => !/runner|claim|start|pair/i.test(action)), 'archive refresh cannot heartbeat, claim, start or pair');
});

for (const scenario of [
  { name: 'unpaired setup', generator: { paired: false, connected: false, state: 'offline', lastSeenAt: null }, badge: 'Not connected', status: /connect the generator computer once/ },
  { name: 'earlier interrupted request', generator: { paired: true, connected: false, state: 'needs_attention', needsAttention: 1 }, badge: 'Needs attention', status: /owner’s review before generation can continue/ },
  { name: 'busy request with a fresh heartbeat', generator: { paired: true, connected: true, state: 'busy', needsAttention: 0 }, badge: 'Generating', status: /creating images one by one/ },
  { name: 'busy receipt with a stale heartbeat', generator: { paired: true, connected: false, state: 'busy', needsAttention: 0 }, badge: 'Manual checks', status: /wait until the owner starts a manual check/ },
  { name: 'idle request with a fresh heartbeat', generator: { paired: true, connected: true, state: 'connected', needsAttention: 0 }, badge: 'Manual checks', status: /wait until the owner starts a manual check/ },
]) {
  test('manual status preserves ' + scenario.name, async () => {
    const app = browser(async (path, options) => {
      assert.equal(options.body, undefined);
      assert.equal(new URL('https://craftush.test' + path).searchParams.get('action'), 'meta');
      return json({ enabled: true, teamConfigured: true, generator: scenario.generator });
    });
    await until(() => !app.$('accessButton').disabled, scenario.name);
    assert.equal(app.$('generatorBadge').textContent, scenario.badge);
    assert.match(app.$('generatorStatus').textContent, scenario.status);
  });
}

test('server manual check metadata is explicit even on a legacy automatic page', async () => {
  const app = browser(async () => json({ enabled: true, teamConfigured: true, checkMode: 'manual', generator: { paired: true, connected: false } }), { checkMode: 'automatic' });
  await until(() => !app.$('accessButton').disabled, 'server manual mode');
  assert.equal(app.$('generatorBadge').textContent, 'Manual checks');
  assert.match(app.$('generatorStatus').textContent, /owner starts a manual check/);
});

test('owner archive pairs once, refreshes jobs, preserves uncertain IDs and downloads prior results', async () => {
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
    if (teamCode === 'wrong' || adminPassword === 'wrong') return json({ errors: [{ message: 'Wrong password.' }] }, 403);
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
  }, { checkMode: 'automatic' });
  const { $, event, click } = app;
  await until(() => !$('accessButton').disabled, 'backend metadata');
  $('accessRole').value = 'owner'; event('accessRole', 'change');
  $('credential').value = 'wrong'; event('accessForm');
  await until(() => $('accessMessage').textContent === 'Wrong password.', 'visible login error');
  assert.equal($('workspace').hidden, true);
  $('credential').value = 'owner-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'owner workspace');
  assert.equal($('credential').value, '', 'credential input is cleared after access');
  assert.equal($('generatorBadge').textContent, 'Not connected');
  assert.equal($('pairingSection').hidden, false, 'the owner can pair the generator');

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
  assert.equal($('ownerControls').hidden, false);
  assert.match($('requestMessage').textContent, /generated one by one/);
  assert.match($('requestMessage').textContent, /folder named after your project in chat/);
  assert.ok($('detailItems').textContent.includes('Queued'));
  click($('copyBrief'));
  await until(() => app.copied.length === 1, 'complete generation brief');
  assert.match(app.copied[0], /1080 × 864/);
  assert.match(app.copied[0], /Forest at dawn/);
  assert.match(app.copied[0], /benchmark\.png/);
  assert.match(app.copied[0], /Native ChatGPT ImageGen creates the images one by one/);
  assert.doesNotMatch(app.copied[0], /processes this brief automatically/);
  await until(() => !$('submitRequest').disabled, 'submission save to finish before polling');

  generator = { paired: true, connected: true, lastSeenAt: '2026-10-14T10:10:00Z', state: 'busy', needsAttention: 0 };
  saved.status = 'in_progress';
  saved.items[0].generation = { state: 'started' };
  saved.updatedAt = '2026-10-14T10:10:00Z';
  await app.poll();
  assert.equal($('generatorBadge').textContent, 'Online');
  assert.match($('generatorStatus').textContent, /creating images/);
  assert.match($('generatorStatus').textContent, /finished folder goes to the owner in chat/);
  assert.match($('generatorHeartbeat').textContent, /Last connected/);
  assert.match($('detailMeta').textContent, /Generating/);
  assert.ok($('detailItems').textContent.includes('Generating'));
  generator = { ...generator, connected: false, state: 'needs_attention', needsAttention: 1 };
  saved.status = 'needs_attention';
  saved.items[0].generation = { state: 'needs_attention', message: '<img src=x onerror=alert(1)>' };
  saved.updatedAt = '2026-10-14T10:20:00Z';
  await app.poll();
  assert.equal($('generatorBadge').textContent, 'Needs attention');
  assert.match($('generatorStatus').textContent, /owner’s review before generation can continue/);
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
  await until(() => !$('detailSection').hidden && !$('ownerControls').hidden, 'owner request controls');
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
  assert.equal($('detailHeading').textContent, '', 'locking clears private owner request details');
  assert.equal($('detailItems').children.length, 0);
  assert.equal($('detailResults').children.length, 0);
  assert.equal($('credential').value, '');
  assert.equal($('downloadPairing').hidden, true, 'the in-memory connection file is cleared when locked');
  assert.doesNotMatch(client, /localStorage|sessionStorage|innerHTML/, 'credentials stay in memory and untrusted text stays text');
});

test('team submits and stops its current acknowledgement without fetching, displaying or polling history', async () => {
  const calls = [], creates = [], cancels = [];
  let failCreate = true;
  const app = browser(async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const action = body?.action ?? new URL('https://craftush.test' + path).searchParams.get('action');
    calls.push(action);
    if (action === 'meta') return json({ enabled: true, teamConfigured: true, uploadPolicy: 'local_folder', generator: { paired: true, connected: true } });
    if (options.headers['X-Team-Code'] === 'wrong') return json({ errors: [{ message: 'Wrong team code.' }] }, 403);
    assert.equal(options.headers['X-Team-Code'], 'team-secret');
    if (action === 'access') return json({ role: 'team', historyVisibility: 'owner_only', uploadPolicy: 'local_folder' });
    if (action === 'create') {
      creates.push(body);
      if (failCreate) { failCreate = false; throw new Error('Save response lost'); }
      return json({ acknowledgement: { id: body.submissionId, accepted: true }, duplicate: true });
    }
    if (action === 'cancel') {
      cancels.push(body);
      return json({ acknowledgement: { id: body.id, stopped: true } });
    }
    assert.fail('Team must not fetch history, request details or assets: ' + action);
  });
  const { $, event } = app;
  await until(() => !$('accessButton').disabled, 'backend ready');
  $('credential').value = 'wrong'; event('accessForm');
  await until(() => $('accessMessage').textContent === 'Wrong team code.', 'denied team access');
  assert.equal($('workspace').hidden, true);
  $('credential').value = 'team-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'team request form');
  assert.equal($('queueSection').hidden, true);
  assert.equal($('detailSection').hidden, true);
  assert.equal($('queueList').children.length, 0);
  assert.equal(app.scheduledPolls(), 0, 'team does not schedule background polling');
  event('refreshQueue', 'click');
  event('statusFilter', 'change');
  app.document.dispatchEvent(new app.document.defaultView.Event('visibilitychange'));
  assert.equal(app.scheduledPolls(), 0);

  $('requesterName').value = 'Riya';
  $('projectTitle').value = 'Share Market <b>Track</b>';
  app.batch();
  $('batchTitles').value = 'Episode one\nEpisode two';
  $('imagePrompt').value = 'Thumbnail with centered English text.';
  $('styleNotes').value = 'Match the supplied reference.';
  $('referenceFile').files = [{ name: 'reference.png', type: 'image/png', size: 8 }];
  event('requestForm');
  await until(() => !$('pendingSubmission').hidden && !$('retrySubmission').disabled, 'uncertain submission');
  assert.equal(creates.length, 1);
  event('retrySubmission', 'click');
  await until(() => !$('teamReceipt').hidden && $('pendingSubmission').hidden, 'accepted acknowledgement');
  assert.equal(creates[0].submissionId, creates[1].submissionId, 'retry confirms exactly the same request');
  assert.equal(creates[1].items.length, 2);
  assert.equal(creates[1].reference.name, 'reference.png');
  assert.equal(creates[1].styleNotes, 'Match the supplied reference.');
  assert.match($('requestMessage').textContent, /one by one/);
  assert.match($('requestMessage').textContent, /owner receives a folder named after your project in chat/);
  assert.equal($('teamReceiptMessage').querySelector('b'), null, 'track names are literal text');
  assert.match($('teamReceiptMessage').textContent, /Share Market <b>Track<\/b>/);
  assert.equal($('detailSection').hidden, true);
  assert.equal(app.scheduledPolls(), 0);

  event('teamStopRequest', 'click');
  assert.equal($('teamStopConfirmation').hidden, false);
  event('teamKeepRunning', 'click');
  assert.equal(cancels.length, 0);
  event('teamStopRequest', 'click'); event('teamConfirmStop', 'click'); event('teamConfirmStop', 'click');
  await until(() => $('teamStopControls').hidden, 'stopped acknowledgement');
  assert.deepEqual(cancels, [{ action: 'cancel', id: creates[1].submissionId }]);
  assert.match($('teamStopMessage').textContent, /Request stopped/);
  assert.equal(calls.some(action => ['list', 'detail', 'asset', 'deliver'].includes(action)), false);
  event('lockButton', 'click');
  assert.equal($('teamReceipt').hidden, true);
  assert.equal($('teamReceiptMessage').textContent, '', 'in-memory acknowledgement is cleared on lock');
  assert.equal($('credential').value, '');
});

test('an undeployed backend disables access and explains why the queue is unavailable', async () => {
  const app = browser(async () => json({ errors: [{ code: 'BACKEND_NOT_HOSTED', message: 'Backend unavailable.' }] }, 503));
  await until(() => app.$('connectionNotice').textContent.includes('deployed Craftush backend'), 'deployment notice');
  assert.equal(app.$('accessButton').disabled, true);
  assert.match(app.$('connectionNotice').textContent, /deployment settings/);
});

function unzipStored(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'original images use ZIP store mode');
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const start = offset + 30 + nameLength + extraLength;
    const data = bytes.slice(start, start + size);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    assert.equal(view.getUint32(offset + 14, true), (crc ^ 0xffffffff) >>> 0, 'ZIP checksum matches original image bytes');
    entries.push({ name: new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength)), data });
    offset = start + size;
  }
  const directoryOffset = offset;
  for (const entry of entries) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, 'central directory entry exists');
    const nameLength = view.getUint16(offset + 28, true);
    assert.equal(new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength)), entry.name);
    assert.equal(view.getUint32(view.getUint32(offset + 42, true), true), 0x04034b50, 'central directory points to a local file header');
    offset += 46 + nameLength;
  }
  assert.equal(view.getUint32(offset, true), 0x06054b50);
  assert.equal(view.getUint16(offset + 10, true), entries.length);
  assert.equal(view.getUint32(offset + 12, true), offset - directoryOffset);
  assert.equal(view.getUint32(offset + 16, true), directoryOffset);
  assert.equal(offset + 22, bytes.length, 'archive has no extra or missing bytes');
  return entries;
}

test('owner sees local-folder completion while retaining prior downloads and Stop controls', async () => {
  const batch = {
    id: webcrypto.randomUUID(), title: '132 episodes', name: 'Editor', status: 'in_progress', width: 1080, height: 864,
    createdAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:00Z', references: [], results: [],
    items: Array.from({ length: 132 }, (_, index) => ({ id: String(index + 1), title: 'Episode ' + (index + 1), prompt: '', filename: 'episode-' + (index + 1) + '.png', generation: { state: 'pending' } })),
  };
  const app = browser(async (path, options) => {
    const action = new URL('https://craftush.test' + path).searchParams.get('action');
    if (action === 'meta') return json({ enabled: true, teamConfigured: true, generator: { paired: true, connected: true, state: 'busy' } });
    assert.equal(options.headers['X-Admin-Password'], 'owner-secret');
    if (action === 'list') return json({ requests: [{ ...batch, itemCount: batch.items.length, resultCount: batch.results.length }], total: 1 });
    if (action === 'detail') return json({ request: batch });
    assert.fail('Delivery messaging must not start or upload images: ' + action);
  });
  const { $, event, click } = app;
  await until(() => !$('accessButton').disabled, 'backend metadata');
  assert.match($('requestDeliveryPolicy').textContent, /generated one by one/);
  $('accessRole').value = 'owner'; event('accessRole', 'change');
  $('credential').value = 'owner-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'owner workspace');
  click($('queueList').querySelector('button'));
  await until(() => !$('detailSection').hidden, 'request details');
  assert.match($('detailDeliveryPolicy').textContent, /owner receives it in chat/);
  assert.equal($('detailDeliveryPolicy').hidden, false);
  assert.equal($('stopControls').hidden, false);
  assert.equal($('bulkDownloadControls').hidden, true);
  assert.match($('resultsEmpty').textContent, /No archived website images/);

  batch.results = [{ assetId: webcrypto.randomUUID(), itemId: '1', name: 'episode-1.png', mime: 'image/png', bytes: 8 }];
  batch.updatedAt = '2026-10-15T12:01:00Z';
  await app.poll();
  assert.match($('detailDeliveryPolicy').textContent, /saved in a folder named after this project/);
  assert.match($('detailDeliveryPolicy').textContent, /Previous website images remain in this owner archive/);
  assert.equal($('bulkDownloadControls').hidden, false);
  assert.equal($('downloadAllResults').disabled, false);
  assert.equal($('detailResults').querySelectorAll('.asset-card').length, 1);

  batch.status = 'cancelled'; batch.updatedAt = '2026-10-15T12:02:00Z';
  await app.poll();
  assert.equal($('detailDeliveryPolicy').hidden, true, 'a stopped request does not promise further delivery');
  assert.equal($('stopControls').hidden, true);
  assert.equal($('bulkDownloadControls').hidden, false, 'earlier delivery remains downloadable after Stop');

  batch.status = 'completed'; batch.updatedAt = '2026-10-15T12:03:00Z';
  batch.uploadPolicy = 'local_folder';
  batch.localDelivery = { folderName: '132 episodes', itemCount: 132, completedAt: '2026-10-15T12:03:00Z' };
  await app.poll();
  assert.equal($('detailDeliveryPolicy').hidden, false);
  assert.match($('detailDeliveryPolicy').textContent, /Folder complete: 132 episodes/);
  assert.equal($('deliveryForm').hidden, true, 'local folders do not have an upload flow');
  assert.equal($('bulkDownloadControls').hidden, false, 'previous assets remain available to the owner');
});

test('a new local-folder request shows completion without missing-image warnings or website downloads', async () => {
  const batch = {
    id: webcrypto.randomUUID(), title: 'Share Market', name: 'Editor', status: 'completed', uploadPolicy: 'local_folder', width: 1080, height: 864,
    references: [], results: [], items: [{ id: '1', title: 'Markets', prompt: 'Thumbnail', filename: 'markets.png', generation: { state: 'completed' } }],
    localDelivery: { folderName: 'Share Market', itemCount: 1, completedAt: '2026-10-15T12:00:00Z' },
  };
  const app = browser(async (path, options) => {
    const action = new URL('https://craftush.test' + path).searchParams.get('action');
    if (action === 'meta') return json({ enabled: true, teamConfigured: true, uploadPolicy: 'local_folder', generator: {} });
    assert.equal(options.headers['X-Admin-Password'], 'owner-secret');
    if (action === 'list') return json({ requests: [{ ...batch, itemCount: 1, resultCount: 0, localResultCount: 1 }], total: 1 });
    if (action === 'detail') return json({ request: batch });
    assert.fail('A local-folder completion must not fetch or upload images: ' + action);
  });
  const { $, event, click } = app;
  await until(() => !$('accessButton').disabled, 'backend ready');
  $('accessRole').value = 'owner'; event('accessRole', 'change');
  $('credential').value = 'owner-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'owner archive');
  assert.match($('queueList').textContent, /1 saved in folder/);
  click($('queueList').querySelector('button'));
  await until(() => !$('detailSection').hidden, 'folder completion details');
  assert.match($('detailDeliveryPolicy').textContent, /Folder complete: Share Market/);
  assert.match($('resultsEmpty').textContent, /saved in the owner’s folder in chat/);
  assert.equal($('bulkDownloadControls').hidden, true);
  assert.equal($('deliveryForm').hidden, true);
  assert.equal($('stopControls').hidden, true);
  assert.doesNotMatch($('resultsEmpty').textContent, /missing|waiting|error/i);
});

test('owner confirms stopping exactly the selected request and can keep it running without a mutation', async () => {
  const batch = { id: webcrypto.randomUUID(), title: 'Stop fixture', name: 'Editor', status: 'in_progress', width: 1080, height: 864, createdAt: '2026-10-15T12:00:00Z', references: [], results: [], items: [{ id: '1', title: 'Earth', prompt: '', filename: 'earth.png' }] };
  const cancels = [];
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const app = browser(async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const action = body?.action ?? new URL('https://craftush.test' + path).searchParams.get('action');
    if (action === 'meta') return json({ enabled: true, teamConfigured: true, generator: {} });
    assert.equal(options.headers['X-Admin-Password'], 'owner-secret');
    if (action === 'list') return json({ requests: [{ ...batch, itemCount: 1, resultCount: 0 }], total: 1 });
    if (action === 'detail') return json({ request: batch });
    assert.equal(action, 'cancel'); cancels.push(body); await waiting;
    batch.status = 'cancelled'; return json({ request: batch });
  });
  const { $, event, click } = app;
  await until(() => !$('accessButton').disabled, 'ready backend');
  $('accessRole').value = 'owner'; event('accessRole', 'change');
  $('credential').value = 'owner-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'owner access');
  click($('queueList').querySelector('button'));
  await until(() => !$('detailSection').hidden, 'request details');
  assert.equal($('stopControls').hidden, false);
  event('stopRequest', 'click'); assert.equal($('stopConfirmation').hidden, false);
  assert.match($('stopConfirmation').textContent, /already generating may finish/);
  event('keepRunning', 'click'); assert.equal(cancels.length, 0);
  event('stopRequest', 'click'); event('confirmStop', 'click');
  event('confirmStop', 'click'); event('closeDetail', 'click'); event('lockButton', 'click');
  assert.equal(cancels.length, 1); assert.equal($('workspace').hidden, false); assert.equal($('detailSection').hidden, false);
  assert.deepEqual(cancels[0], { action: 'cancel', id: batch.id });
  release(); await until(() => $('stopControls').hidden, 'request stopped');
  assert.match($('stopMessage').textContent, /Request stopped/);
});

test('owner downloads prior images as one authenticated ZIP with safe unique names and releases its URL', async () => {
  const requestID = webcrypto.randomUUID();
  const firstID = webcrypto.randomUUID(), secondID = webcrypto.randomUUID();
  const images = new Map([[firstID, new Uint8Array([137, 80, 78, 71, 1])], [secondID, new Uint8Array([255, 216, 255, 2])]]);
  const batch = {
    id: requestID, title: '../../Stock market', name: 'Riya', status: 'in_progress', width: 1080, height: 864,
    createdAt: '2026-10-15T12:00:00Z', references: [],
    items: [{ id: '1', title: 'One', prompt: '', filename: 'same.png' }, { id: '2', title: 'Two', prompt: '', filename: 'same.png' }, { id: '3', title: 'Pending', prompt: '', filename: 'pending.png' }],
    results: [{ assetId: secondID, itemId: '2', name: '../../same.png' }, { assetId: firstID, itemId: '1', name: '../../same.png' }],
  };
  const assets = [];
  let releaseFirst;
  const waitFirst = new Promise(resolve => { releaseFirst = resolve; });
  const app = browser(async (path, options) => {
    const url = new URL('https://craftush.test' + path), action = url.searchParams.get('action');
    if (action === 'meta') return json({ enabled: true, teamConfigured: true, generator: {} });
    assert.equal(options.headers['X-Admin-Password'], 'owner-secret');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (action === 'list') return json({ requests: [{ ...batch, itemCount: 3, resultCount: 2 }], total: 1 });
    if (action === 'detail') return json({ request: batch });
    assert.equal(action, 'asset');
    assert.equal(url.searchParams.get('id'), requestID);
    const assetID = url.searchParams.get('assetId');
    assets.push(assetID);
    if (assets.length === 1) await waitFirst;
    return new Response(images.get(assetID), { headers: { 'Content-Type': assetID === firstID ? 'image/png' : 'image/jpeg' } });
  });
  const { $, event, click } = app;
  await until(() => !$('accessButton').disabled, 'ready backend');
  $('accessRole').value = 'owner'; event('accessRole', 'change');
  $('credential').value = 'owner-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'owner access');
  click($('queueList').querySelector('button'));
  await until(() => !$('detailSection').hidden, 'request details');
  assert.equal($('bulkDownloadControls').hidden, false);
  assert.match($('bulkDownloadMessage').textContent, /2 finished images available now/);
  assert.equal(assets.length, 0, 'no result images are fetched until download');
  event('downloadAllResults', 'click');
  await until(() => assets.length === 1, 'first image download');
  assert.equal($('downloadAllResults').disabled, true);
  assert.equal($('bulkDownloadControls').getAttribute('aria-busy'), 'true');
  assert.match($('bulkDownloadMessage').textContent, /1 of 2/);
  event('downloadAllResults', 'click');
  event('closeDetail', 'click'); event('lockButton', 'click');
  assert.equal($('workspace').hidden, false, 'session stays open during the authenticated download');
  assert.equal($('detailSection').hidden, false);
  releaseFirst();
  await until(() => app.blobDownloads.length === 1 && !$('downloadAllResults').disabled, 'complete ZIP download');
  assert.deepEqual(assets, [firstID, secondID], 'each available result is fetched once in request order');
  const downloaded = app.blobDownloads[0];
  assert.equal(downloaded.name, 'Stock-market-images.zip');
  assert.equal(downloaded.blob.type, 'application/zip');
  const entries = unzipStored(await downloaded.blob.arrayBuffer());
  assert.deepEqual(entries.map(entry => entry.name), ['001-same.png', '002-same.jpg']);
  assert.deepEqual(entries.map(entry => [...entry.data]), [[...images.get(firstID)], [...images.get(secondID)]]);
  assert.equal($('bulkDownloadControls').hasAttribute('aria-busy'), false);
  assert.match($('bulkDownloadMessage').textContent, /ZIP ready: 2 images.*still pending/);
  app.cleanupDownloads();
  assert.equal(app.revoked.length, 1, 'the archive object URL is released');
  event('lockButton', 'click');
  assert.equal($('workspace').hidden, true);
});

test('ZIP download never presents a partial success after one image fails and can be retried', async () => {
  let failImage = true;
  const batch = {
    id: webcrypto.randomUUID(), title: 'Results', name: 'Riya', status: 'completed', width: 1080, height: 864,
    items: [{ id: '1', title: 'One', prompt: '', filename: 'one.png' }, { id: '2', title: 'Two', prompt: '', filename: 'two.png' }],
    results: [{ assetId: 'first', itemId: '1', name: 'one.png' }, { assetId: 'second', itemId: '2', name: 'two.png' }], references: [],
  };
  const app = browser(async (path, options) => {
    const url = new URL('https://craftush.test' + path), action = url.searchParams.get('action');
    if (action === 'meta') return json({ enabled: true, teamConfigured: true, generator: {} });
    assert.equal(options.headers['X-Admin-Password'], 'owner-secret');
    if (action === 'list') return json({ requests: [{ ...batch, itemCount: 2, resultCount: 2 }], total: 1 });
    if (action === 'detail') return json({ request: batch });
    assert.equal(action, 'asset');
    if (url.searchParams.get('assetId') === 'second' && failImage) return new Response('Unavailable', { status: 500 });
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
  });
  const { $, event, click } = app;
  await until(() => !$('accessButton').disabled, 'ready backend');
  $('accessRole').value = 'owner'; event('accessRole', 'change');
  $('credential').value = 'owner-secret'; event('accessForm');
  await until(() => !$('workspace').hidden, 'owner access');
  click($('queueList').querySelector('button'));
  await until(() => !$('detailSection').hidden, 'request details');
  event('downloadAllResults', 'click');
  await until(() => $('bulkDownloadMessage').classList.contains('error'), 'failed image notice');
  assert.match($('bulkDownloadMessage').textContent, /No ZIP was downloaded/);
  assert.equal(app.blobDownloads.length, 0);
  assert.equal($('downloadAllResults').disabled, false);
  assert.equal($('bulkDownloadControls').hasAttribute('aria-busy'), false);
  failImage = false;
  event('downloadAllResults', 'click');
  await until(() => app.blobDownloads.length === 1, 'ZIP retry');
  assert.equal(unzipStored(await app.blobDownloads[0].blob.arrayBuffer()).length, 2);
});

test('every image UI control exists and GitHub Pages adapts both authenticated API calls', () => {
  const { document } = parseHTML(html);
  const referencedIDs = [...new Set([...client.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]))];
  assert.deepEqual(referencedIDs.filter(id => !document.getElementById(id)), []);
  const output = adaptPagesText(client, '/Craftush', 'js', 'https://backend.example');
  assert.equal((output.match(/window\.craftushAPI\('/g) || []).length, 2);
  assert.doesNotMatch(output, /fetch\(['"]\/api\//);
  const page = adaptPagesText(html, '/Craftush', 'html', 'https://backend.example');
  assert.match(page, /src="\/Craftush\/images\/app\.js\?v=20261022-owner-controls"/);
  assert.match(page, /href="\/Craftush\/images\/style\.css\?v=20261015-local-folder"/);
});

test('owner archive exposes cancellation confirmation and next-check selection without starting generation',async()=>{
  const saved={id:'chosen-request',name:'Ayush',title:'How Algorithms Work',status:'queued',itemCount:75,resultCount:0,width:1080,height:864,createdAt:'2026-10-22T05:00:00Z',items:[{id:'1',title:'Topic',prompt:'Art',filename:'Topic.png'}],references:[],results:[],uploadPolicy:'local_folder'};
  const calls=[];
  const app=browser(async(path,options)=>{
    const body=options.body?JSON.parse(options.body):null;
    const action=body?.action||new URL('https://fixture'+path).searchParams.get('action');
    calls.push({action,body});
    if(action==='meta')return json({enabled:true,teamConfigured:true,generator:{paired:true,connected:false}});
    if(action==='list')return json({requests:[{...saved}],total:1});
    if(action==='selectNext'){saved.nextManualCheck=true;return json({request:{...saved},startsAutomatically:false});}
    if(action==='detail')return json({request:{...saved}});
    if(action==='cancel'){saved.status='cancelled';saved.nextManualCheck=false;return json({request:{...saved}});}
    assert.fail('Unexpected action: '+action);
  });
  const {$,event,click}=app;
  await until(()=>!$('accessButton').disabled,'ready');
  $('accessRole').value='owner';event('accessRole','change');$('credential').value='owner-fixture';event('accessForm');
  await until(()=>!$('workspace').hidden,'owner archive');
  const find=label=>$('queueList').querySelector('[aria-label="'+label+'"]');
  assert.ok(find('Use next: How Algorithms Work'));
  click(find('Use next: How Algorithms Work'));
  await until(()=>$('queueMessage').classList.contains('success'),'selection acknowledgement');
  assert.match($('queueMessage').textContent,/manual check/);
  assert.ok(find('Chosen next: How Algorithms Work').disabled);
  assert.equal(calls.filter(c=>c.action==='selectNext').length,1);
  assert.equal(saved.items[0].title,'Topic');
  click(find('Cancel request: How Algorithms Work'));
  await until(()=>!$('stopConfirmation').hidden,'explicit cancellation confirmation');
  assert.equal(calls.filter(c=>c.action==='cancel').length,0);
  event('confirmStop','click');
  await until(()=>saved.status==='cancelled'&&$('stopControls').hidden,'cancelled request');
  assert.equal(calls.filter(c=>c.action==='cancel').length,1);
  assert.ok(!find('Use next: How Algorithms Work'));
  assert.ok(!calls.some(c=>/claim|start|runner/i.test(c.action)));
});

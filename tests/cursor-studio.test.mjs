import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { buildPages } from '../scripts/build-github-pages.mjs';
import { dashboardView } from '../netlify/lib/shared.js';

const root = new URL('../public/cursor/', import.meta.url);
const hosted = 'https://tusharmondal01.github.io/Craftush/cursor/';

function zipFiles(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0, 'ZIP must have a complete directory');
  const count = bytes.readUInt16LE(end + 10), files = new Map();
  let offset = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const payload = bytes.subarray(start, start + compressed);
    files.set(name, method === 8 ? inflateRawSync(payload) : payload);
    offset += 46 + nameLength + extra + comment;
  }
  return files;
}

test('the existing backend configuration keeps the original four tools followed by Cursor Studio', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const { document, CustomEvent } = parseHTML(html);
  const main = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].find(match => match[2].includes('async function loadConfig'))[2];
  const oldSettings = dashboardView({});
  assert.equal(oldSettings.cards.cursor, undefined);
  const context = vm.createContext({ document, CustomEvent, Response,
    matchMedia: () => ({ matches: false }), requestAnimationFrame: callback => callback(),
    fetch: async () => Response.json(oldSettings) });
  vm.runInContext(main, context);
  await new Promise(resolve => setImmediate(resolve));
  const slides = [...document.querySelectorAll('#track .slide')];
  assert.deepEqual(slides.map(slide => slide.dataset.id), ['thumbnail', 'visuals', 'comfy', 'documentary', 'cursor']);
  assert.equal(slides[4].querySelector('.open').getAttribute('href'), '/cursor/');
  assert.equal(slides[4].querySelector('.open').hidden, false);
  assert.equal(slides[4].querySelector('.title').textContent, 'Cursor Studio');
  assert(slides[4].querySelector('.motion-stage'));
  assert.match(document.getElementById('studioHeading').textContent, /Five creative tools/);
});

test('the Pages build preserves the recording modules and serves the fifth tool, sample and both ZIP downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craftush-cursor-'));
  try {
    await buildPages({ destination: directory, backendURL: 'https://craftush.tushar-mondal.workers.dev' });
    const homepage = parseHTML(await readFile(join(directory, 'index.html'), 'utf8')).document;
    assert.equal(homepage.querySelector('[data-id="cursor"] .open').getAttribute('href'), '/Craftush/cursor/');
    const page = parseHTML(await readFile(join(directory, 'cursor/index.html'), 'utf8')).document;
    assert.equal(page.querySelector('a.brand').getAttribute('href'), '/Craftush/');
    assert.match(page.querySelector('script[type="module"]').getAttribute('src'), /^app\.js(?:\?|$)/);
    assert(page.querySelector('link[href*="craftush.css"]'));
    for (const selector of ['#record-btn', '#demo-btn', '#upload-btn', '#export-btn', '#mobile-editor', '#camera-timeline']) assert(page.querySelector(selector), selector);
    for (const asset of ['app.js', 'camera.js', 'mobile-editor.js', 'styles.css', 'workflow.js', 'workflow.css', 'touch-studio.css', 'touch-detector.js', 'touch-worker.js', 'touch-analysis.js', 'touch-motion.js', 'motion-timeline.js', 'Examples/phone-demo-raw.mp4', 'Examples/mobile-touch-demo.mp4', 'cursor-studio-desktop.zip']) {
      assert.deepEqual(await readFile(join(directory, 'cursor', asset)), await readFile(new URL(asset, root)), asset);
    }
    const desktop = zipFiles(await readFile(new URL('cursor-studio-desktop.zip', root)));
    const original = parseHTML(desktop.get('index.html').toString()).document;
    for (const control of original.querySelectorAll('[id]')) assert(page.getElementById(control.id), 'original control retained: ' + control.id);
    for (const asset of ['app.js', 'camera.js', 'mobile-editor.js']) assert(desktop.get(asset)?.length, 'the original desktop download retains ' + asset);
    const extension = zipFiles(await readFile(join(directory, 'cursor/cursor-studio-extension.zip')));
    const manifest = JSON.parse(extension.get('manifest.json').toString());
    assert.deepEqual(manifest.content_scripts[0].js, ['recorder-location.js', 'content.js']);
    for (const file of [manifest.background.service_worker, ...manifest.content_scripts[0].js, 'popup.html', 'popup.js', 'popup.css']) {
      assert.deepEqual(extension.get(file), await readFile(new URL('extension/' + file, root)), file);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the extension accepts only the hosted recorder route and the original local development origins', async () => {
  const context = vm.createContext({ URL });
  vm.runInContext(await readFile(new URL('extension/recorder-location.js', root), 'utf8'), context);
  const allowed = context.CursorStudioRecorderLocation.isRecorderURL;
  for (const url of [hosted, hosted + 'index.html#studio', hosted.slice(0, -1), 'http://127.0.0.1:4173/', 'http://localhost:4173/']) assert.equal(allowed(url), true, url);
  for (const url of ['https://tusharmondal01.github.io/Craftush/visuals/', 'https://tusharmondal01.github.io/OtherProject/cursor/',
    'https://tusharmondal01.github.io/Craftush/cursor-evil/', 'https://tusharmondal01.github.io.evil.test/Craftush/cursor/',
    'http://tusharmondal01.github.io/Craftush/cursor/', 'https://user:secret@tusharmondal01.github.io/Craftush/cursor/', 'not a URL']) assert.equal(allowed(url), false, url);
});

test('the hosted extension starts only from its recorder and forwards cursor samples from one explicitly selected tab', async () => {
  const messages = [], events = {}, sessionStore = {};
  const helper = await readFile(new URL('extension/recorder-location.js', root), 'utf8');
  const context = vm.createContext({ URL, console, chrome: {
    storage: { session: { get: async () => ({}), set: async data => Object.assign(sessionStore, data), remove: async key => delete sessionStore[key] } },
    runtime: { getURL: name => 'chrome-extension://fixture/' + name, onMessage: { addListener: callback => events.message = callback } },
    tabs: { sendMessage: async (tab, message) => messages.push({ tab, message }), query: async () => [{ id: 7, url: 'https://example.org/', title: 'Shared example' }],
      onRemoved: { addListener: callback => events.removed = callback }, onUpdated: { addListener: callback => events.updated = callback } },
  } });
  context.importScripts = name => { assert.equal(name, 'recorder-location.js'); vm.runInContext(helper, context); };
  vm.runInContext(await readFile(new URL('extension/background.js', root), 'utf8'), context);
  const send = (message, sender) => new Promise(resolve => events.message(message, sender, resolve));
  const recorder = { frameId: 0, tab: { id: 1 }, url: hosted }, nonce = 'a'.repeat(48);
  assert.equal((await send({ type: 'START', nonce }, { ...recorder, url: 'https://tusharmondal01.github.io/Craftush/' })).ok, false);
  assert.equal((await send({ type: 'START', nonce }, { ...recorder, frameId: 1 })).ok, false);
  assert.equal((await send({ type: 'START', nonce }, recorder)).ok, true);
  assert.equal((await send({ type: 'TARGET_TAB' }, { url: 'chrome-extension://fixture/popup.html' })).ok, true);
  const pointer = { type: 'POINTER', x: .4, y: .6, click: true, timestamp: Date.now(), viewportWidth: 1280, viewportHeight: 720 };
  assert.equal((await send(pointer, { frameId: 0, tab: { id: 8 }, url: 'https://unselected.example/' })).ok, false);
  assert.equal((await send(pointer, { frameId: 1, tab: { id: 7 }, url: 'https://example.org/' })).ok, false);
  assert.equal((await send(pointer, { frameId: 0, tab: { id: 7 }, url: 'https://example.org/' })).ok, true);
  const forwarded = messages.filter(value => value.message.type === 'CURSOR_STUDIO_POINTER');
  assert.equal(forwarded.length, 1); assert.equal(forwarded[0].tab, 1); assert.equal(forwarded[0].message.nonce, nonce);
  assert.equal((await send({ type: 'STOP', nonce: 'wrong' }, recorder)).ok, false);
  assert.equal((await send({ type: 'STOP', nonce }, recorder)).ok, true);
  assert.equal((await send(pointer, { frameId: 0, tab: { id: 7 }, url: 'https://example.org/' })).ok, false);
  assert.equal(sessionStore.cursorStudioSession, undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildPages, pagesRuntime, adaptPagesText } from '../scripts/build-github-pages.mjs';

test('Pages routes stay within the repository while remote models and relative workers keep their URLs', () => {
  const result = adaptPagesText('<head></head><a href="/">Home</a><a href="/visuals/">Visuals</a><img src="https://example.org/pic.jpg"><script>fetch(\'/api/tools\');location.assign(\'/documentary/#export\');new Worker(\'./voice-worker.mjs\')</script>', '/Craftush', 'html');
  assert.match(result, /href="\/Craftush\/"/);
  assert.match(result, /href="\/Craftush\/visuals\/"/);
  assert.match(result, /window.craftushAPI\('\/api\/tools'\)/);
  assert.match(result, /location.assign\('\/Craftush\/documentary\/#export'\)/);
  assert.match(result, /new Worker\('\.\/voice-worker.mjs'\)/);
  assert.match(result, /src="https:\/\/example.org\/pic.jpg"/);
});

test('the Pages build cannot transmit admin passwords or generation requests to an unavailable backend', async () => {
  let networkCalls = 0;
  const context = vm.createContext({ window: {}, document: { addEventListener() {} }, Response,
    fetch: () => { networkCalls++; throw new Error('No backend is connected'); } });
  vm.runInContext(pagesRuntime(), context);
  const response = await context.window.craftushAPI('/api/admin', { method: 'POST', headers: { 'x-admin-password': 'fixture-secret' } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).errors[0].code, 'BACKEND_NOT_HOSTED');
  assert.equal(networkCalls, 0);
});

test('the complete v17 frontend has working static routes, valid inline scripts and no Vercel connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craftush-pages-'));
  try {
    await buildPages({ destination: directory });
    const source = new URL('../public/', import.meta.url);
    const htmlFiles = [];
    async function collect(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await collect(join(path, entry.name));
        else if (entry.name.endsWith('.html')) htmlFiles.push(join(path, entry.name));
      }
    }
    await collect(directory);
    for (const path of htmlFiles) {
      const text = await readFile(path, 'utf8');
      assert(!text.includes('.vercel.app'), path);
      assert(text.includes('/Craftush/github-pages-runtime.js'), path);
      for (const match of text.matchAll(/\b(?:href|src)=["'](\/Craftush\/[^"']*)["']/g)) {
        const relative = match[1].slice('/Craftush/'.length).split(/[?#]/)[0];
        const target = join(directory, relative);
        const info = await stat(target);
        if (info.isDirectory()) await stat(join(target, 'index.html'));
      }
      for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\bsrc=|type=["']module/i.test(match[1])) continue;
        new vm.Script(match[2], { filename: path });
      }
    }
    for (const asset of ['visuals/narration-sync.js', 'visuals/voice-worker.mjs', 'documentary/assemble.js']) {
      assert.equal(await readFile(join(directory, asset), 'utf8'), await readFile(new URL(asset, source), 'utf8'), asset);
    }
    const metadata = JSON.parse(await readFile(join(directory, 'hosting.json'), 'utf8'));
    assert.equal(metadata.version, '17'); assert.equal(metadata.backendConnected, false);
    await assert.rejects(stat(join(directory, 'api')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

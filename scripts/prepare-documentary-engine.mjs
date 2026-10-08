import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Restore the exact engine distributed in the v16 ZIP without a large Git upload.
const packageInfo = JSON.parse(await readFile(new URL('../node_modules/@ffmpeg/core/package.json', import.meta.url), 'utf8'));
if (packageInfo.version !== '0.12.10') throw new Error('Expected @ffmpeg/core 0.12.10.');
const hashes = JSON.parse(await readFile(new URL('../public/documentary/vendor/asset-sha256.json', import.meta.url), 'utf8'));
const assets = ['core/dist/esm/ffmpeg-core.js', 'core/dist/esm/ffmpeg-core.wasm'];
const verified = [];
for (const asset of assets) {
  const source = new URL('../node_modules/@ffmpeg/core/' + asset.slice('core/'.length), import.meta.url);
  const bytes = await readFile(source);
  if (createHash('sha256').update(bytes).digest('hex') !== hashes[asset]) throw new Error('Documentary engine checksum mismatch: ' + asset);
  verified.push({ bytes, target: new URL('../public/documentary/vendor/' + asset, import.meta.url) });
}
for (const { bytes, target } of verified) {
  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  await writeFile(target, bytes);
}
console.log('Documentary engine ready: @ffmpeg/core 0.12.10, exact v16 checksums verified.');

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';

const configURL = new URL('../wrangler.jsonc', import.meta.url);
const raw = JSON.parse(await readFile(configURL, 'utf8'));

test('Wrangler validates an explicit local-class Preview binding without reusing a production namespace', () => {
  const normalized = unstable_readConfig({ config: fileURLToPath(configURL) }, { hideWarnings: true });
  assert.deepEqual(normalized.previews.durable_objects.bindings, [{ name: 'CRAFTUSH_DATA', class_name: 'CraftushStorage' }]);
  // Local classes without script_name get a distinct namespace for each Preview.
  // Binding to another script/environment would defeat that automatic isolation.
  for (const binding of raw.previews.durable_objects.bindings) {
    assert.equal(binding.script_name, undefined); assert.equal(binding.environment, undefined);
    assert.equal(binding.namespace_id, undefined);
  }
  assert.equal(raw.previews.secrets, undefined);
  assert.deepEqual(Object.keys(raw.previews.vars).sort(), ['ALLOWED_ORIGINS', 'PUBLIC_SITE_URL']);
});

test('enabling Previews preserves the production storage class, SQLite migration, and public variables', () => {
  assert.equal(raw.name, 'craftush'); assert.equal(raw.main, 'cloudflare/worker.js');
  assert.deepEqual(raw.durable_objects.bindings, [{ name: 'CRAFTUSH_DATA', class_name: 'CraftushStorage' }]);
  assert.deepEqual(raw.migrations, [{ tag: 'v17-storage-1', new_sqlite_classes: ['CraftushStorage'] }]);
  assert.deepEqual(raw.vars, { ALLOWED_ORIGINS: 'https://tusharmondal01.github.io', PUBLIC_SITE_URL: 'https://tusharmondal01.github.io/Craftush' });
});

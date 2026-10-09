import { initializeRateLimits, consumeQuota } from './rate-limit.js';

// Private SQLite-backed Durable Object; only its Worker binding can access it.
// Chunks stay below SQLite's 2 MB row limit, including multibyte scripts.
export const CHUNK_BYTES = 512 * 1024;
export const MAX_STORE_BYTES = 24 * 1024 * 1024;
const encoder = new TextEncoder();
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export class CraftushStorage {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, parts INTEGER NOT NULL, bytes INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (key TEXT NOT NULL, part INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY (key, part))');
    initializeRateLimits(this.sql);
  }

  async fetch(request) {
    if (new URL(request.url).pathname === '/rate-limit') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const raw = await request.text();
      if (raw.length > 8192) return new Response('Invalid quota request', { status: 400 });
      try {
        return Response.json(consumeQuota(this.storage, JSON.parse(raw).rules), { headers: { 'cache-control': 'no-store' } });
      } catch { return new Response('Quota check failed', { status: 503 }); }
    }
    const key = new URL(request.url).searchParams.get('key');
    if (!key || encoder.encode(key).length > 512) return new Response('Invalid record key', { status: 400 });
    if (request.method === 'GET') {
      const meta = this.sql.exec('SELECT parts, bytes FROM records WHERE key = ?', key).toArray()[0];
      if (!meta) return new Response(null, { status: 404 });
      const rows = this.sql.exec('SELECT part, value FROM chunks WHERE key = ? ORDER BY part', key).toArray();
      if (meta.bytes > MAX_STORE_BYTES || rows.length !== meta.parts) throw new Error('Incomplete private record');
      const bytes = new Uint8Array(meta.bytes);
      let offset = 0;
      for (let i = 0; i < rows.length; i++) {
        const part = new Uint8Array(rows[i].value);
        if (rows[i].part !== i || offset + part.length > bytes.length) throw new Error('Invalid private record');
        bytes.set(part, offset); offset += part.length;
      }
      if (offset !== bytes.length) throw new Error('Incomplete private record');
      return new Response(decode(bytes), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (request.method !== 'PUT') return new Response(null, { status: 405 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_STORE_BYTES) return new Response('Private record exceeds the upload limit', { status: 413 });
    const parts = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    // Replacement is atomic. An interrupted upload cannot leave half a record
    // or replace valid saved settings with an incomplete value.
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM chunks WHERE key = ?', key);
      for (let part = 0; part < parts; part++) {
        this.sql.exec('INSERT INTO chunks (key, part, value) VALUES (?, ?, ?)', key, part, bytes.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
      }
      this.sql.exec('INSERT OR REPLACE INTO records (key, parts, bytes) VALUES (?, ?, ?)', key, parts, bytes.length);
    });
    return new Response(null, { status: 204 });
  }
}

export function cloudflareStore(namespace) {
  if (!namespace?.idFromName || !namespace?.get) throw new Error('Private storage is not bound');
  const object = namespace.get(namespace.idFromName('craftush-v17'));
  const address = key => 'https://private-storage.invalid/?key=' + encodeURIComponent(String(key));
  async function getText(key) {
    const response = await object.fetch(new Request(address(key)));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Private storage read failed');
    return response.text();
  }
  async function setText(key, value) {
    const text = String(value ?? '');
    if (encoder.encode(text).length > MAX_STORE_BYTES) throw new Error('Private record exceeds the upload limit');
    const response = await object.fetch(new Request(address(key), { method: 'PUT', body: text }));
    if (!response.ok) throw new Error('Private storage write failed');
  }
  return {
    async get(key, options = {}) {
      const text = await getText(key);
      if (text === null || options.type !== 'json') return text;
      const value = JSON.parse(text);
      if (key === 'settings' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid private settings');
      return value;
    },
    set: setText,
    setJSON: (key, value) => setText(key, JSON.stringify(value)),
  };
}

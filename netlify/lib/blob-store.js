// Netlify-Blobs-compatible storage on Vercel Private Blob.
// The SDK uses the deployment's rotating OIDC credentials; no token is copied to the browser.
// Only the explicitly connected CRAFTUSH store is used, never a default/public Blob store.
import { PrivateStorageError } from './storage-errors.js';
let sdkPromise;
const sdk = () => sdkPromise || (sdkPromise = import("@vercel/blob"));
const stores = new Map();
// Keep frequently read configuration in server memory briefly. Dynamic project
// records stay uncached; writes update this instance's cache only after success.
const cacheTTL = (key) => key === 'settings' ? 30000 : key === 'usage' ? 5000 : 0;

export function privateBlobStore(storeId) {
  if (stores.has(storeId)) return stores.get(storeId);
  const cache = new Map(), pending = new Map(), versions = new Map();
  const path = (key) => "craftush/" + encodeURIComponent(String(key)) + ".txt";
  async function getText(key) {
    const ttl = cacheTTL(key), cached = cache.get(key);
    if (ttl && cached && cached.until > Date.now()) return cached.text;
    if (ttl && pending.has(key)) return pending.get(key);
    const version = versions.get(key) || 0;
    const read = (async () => {
      try {
        const { get } = await sdk();
        const result = await get(path(key), { access: "private", storeId, useCache: false });
        if (result === null) return null;
        if (result.statusCode !== 200) throw new Error("Private storage read failed: HTTP " + result.statusCode);
        const text = await new Response(result.stream).text();
        if (ttl && version === (versions.get(key) || 0)) cache.set(key, { text, until: Date.now() + ttl });
        return text;
      } catch (error) { throw new PrivateStorageError(error); }
    })();
    if (ttl) pending.set(key, read);
    try { return await read; }
    finally { if (pending.get(key) === read) pending.delete(key); }
  }
  async function setText(key, value) {
    const ttl = cacheTTL(key), text = String(value ?? '');
    if (ttl) { versions.set(key, (versions.get(key) || 0) + 1); cache.delete(key); }
    try {
      const { put } = await sdk();
      const result = await put(path(key), text, {
        access: "private", storeId, addRandomSuffix: false, allowOverwrite: true,
        contentType: "text/plain; charset=utf-8", cacheControlMaxAge: 60,
      });
      if (ttl) {
        versions.set(key, (versions.get(key) || 0) + 1);
        pending.delete(key);
        cache.set(key, { text, until: Date.now() + ttl });
      }
      return result;
    } catch (error) { throw new PrivateStorageError(error); }
  }
  const store = {
    async get(key, options = {}) {
      const text = await getText(key);
      if (text === null) return null;
      if (options.type === "json") {
        try {
          const value = JSON.parse(text);
          if (key === 'settings' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid settings');
          return value;
        } catch (error) {
          if (key === 'settings') { cache.delete(key); throw new PrivateStorageError(error); }
          return null;
        }
      }
      return text;
    },
    set: setText,
    setJSON: (key, value) => setText(key, JSON.stringify(value)),
  };
  stores.set(storeId, store);
  return store;
}

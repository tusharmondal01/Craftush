// Netlify-Blobs-compatible storage on Vercel Private Blob.
// The SDK uses the deployment's rotating OIDC credentials; no token is copied to the browser.
// Only the explicitly connected CRAFTUSH store is used, never a default/public Blob store.
let sdkPromise;
const sdk = () => sdkPromise || (sdkPromise = import("@vercel/blob"));

export function privateBlobStore(storeId) {
  const path = (key) => "craftush/" + encodeURIComponent(String(key)) + ".txt";
  async function getText(key) {
    const { get } = await sdk();
    const result = await get(path(key), { access: "private", storeId, useCache: false });
    if (result === null) return null;
    if (result.statusCode !== 200) throw new Error("Private storage read failed");
    return new Response(result.stream).text();
  }
  async function setText(key, value) {
    const { put } = await sdk();
    return put(path(key), String(value ?? ""), {
      access: "private", storeId, addRandomSuffix: false, allowOverwrite: true,
      contentType: "text/plain; charset=utf-8", cacheControlMaxAge: 60,
    });
  }
  return {
    async get(key, options = {}) {
      const text = await getText(key);
      if (text === null) return null;
      if (options.type === "json") {
        try { return JSON.parse(text); } catch { return null; }
      }
      return text;
    },
    set: setText,
    setJSON: (key, value) => setText(key, JSON.stringify(value)),
  };
}

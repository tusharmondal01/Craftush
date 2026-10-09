// Wrangler excludes the other hosts' storage SDKs from the Cloudflare bundle.
// The request context provides the Durable Object store before these fallbacks.
const unavailable = () => { throw new Error('Legacy storage is not used on Cloudflare'); };
export const getStore = unavailable;
export const get = unavailable;
export const put = unavailable;

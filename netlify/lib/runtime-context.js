import { AsyncLocalStorage } from 'node:async_hooks';

// Bindings belong to one request. Never copy a Worker's credentials into globals
// or process.env: simultaneous requests and environments must stay isolated.
export const runtimeContext = new AsyncLocalStorage();
export const withRuntime = (environment, store, callback, services = {}) =>
  runtimeContext.run({ ...services, environment, store }, callback);

// Other hosts retain their existing behavior. Cloudflare supplies an isolated
// quota service for this request, called only after authorization and validation.
export const limitRunwareTasks = async tasks =>
  (await runtimeContext.getStore()?.limitRunware?.(tasks)) || null;

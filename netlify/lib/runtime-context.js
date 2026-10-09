import { AsyncLocalStorage } from 'node:async_hooks';

// Bindings belong to one request. Never copy a Worker's credentials into globals
// or process.env: simultaneous requests and environments must stay isolated.
export const runtimeContext = new AsyncLocalStorage();
export const withRuntime = (environment, store, callback) =>
  runtimeContext.run({ environment, store }, callback);

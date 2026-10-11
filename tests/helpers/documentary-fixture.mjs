import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseHTML } from 'linkedom';
import * as core from '../../public/documentary/core.js';
import { createProgressUI } from '../../public/documentary/progress.js';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function until(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Workflow did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

// Run the actual studio event handlers against its HTML. Only storage, media
// assembly and provider transport are substituted; no Runware credits are used.
export async function documentaryFixture({ project, media = {}, reply, confirm = true, onPut, assemble } = {}) {
  const html = await readFile(new URL('../../public/documentary/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../../public/documentary/studio.js', import.meta.url), 'utf8');
  const { document } = parseHTML(html), records = new Map(Object.entries(media)), calls = [], confirmations = [];
  if (project) records.set('current-project', structuredClone(project));
  const handlers = new Map(), timers = new Set(), intervals = new Set();
  const elements = [...document.querySelectorAll('*')];
  for (const element of elements) {
    const register = element.addEventListener.bind(element);
    element.addEventListener = (type, handler, options) => {
      const key = element;
      if (!handlers.has(key)) handlers.set(key, new Map());
      handlers.get(key).set(type, handler); register(type, handler, options);
    };
  }
  for (const element of document.querySelectorAll('video,audio')) {
    element.pause = () => {}; element.load = () => {};
  }
  document.querySelector('#concurrency option[value="3"]').setAttribute('selected', '');
  let storagePending = Promise.resolve(), replyHandler = reply;
  class Store {
    async get(key) { return structuredClone(records.get(key) || null); }
    put(key, value) {
      const snapshot = structuredClone(value);
      const result = storagePending.then(async () => { await onPut?.(key, snapshot); records.set(key, snapshot); });
      storagePending = result.catch(() => {}); return result;
    }
    async delete(key) { await storagePending; records.delete(key); }
  }
  const transport = async (url, options = {}) => {
    if (!options.method) return Response.json({ configured: true, enabled: true, codeRequired: false });
    const body = JSON.parse(options.body); calls.push(body);
    const signal = options.signal;
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    let stop;
    const aborted = new Promise((_, reject) => {
      stop = () => reject(new DOMException('Stopped', 'AbortError'));
      signal?.addEventListener('abort', stop, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve(replyHandler?.(body, signal) || { data: [] }), aborted]);
      return result?.json ? result : Response.json(result);
    } finally { signal?.removeEventListener('abort', stop); }
  };
  const context = vm.createContext({
    ...core, createProgressUI, DocumentaryStore: Store,
    assembleDocumentary: assemble || (() => { throw new Error('Unexpected assembly.'); }),
    document, fetch: transport, console, crypto: webcrypto, structuredClone,
    URL, Blob, Response, DOMException, AbortController, AbortSignal, TextDecoder,
    navigator: { locks: { request: async (name, options, work) => work({ name }) } },
    history: { replaceState() {} }, location: { hash: '#idea' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    window: { addEventListener() {} },
    confirm: message => { confirmations.push(message); return confirm; },
    setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms >= 1800 ? 2 : ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    setInterval(fn, ms) { const timer = setInterval(fn, ms); intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); clearInterval(timer); },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace('await init();', 'globalThis.studioReady = init();'), context);
  await context.studioReady;
  return {
    document, records, calls, confirmations,
    el: id => document.getElementById(id),
    read: () => JSON.parse(vm.runInContext('JSON.stringify(project)', context)),
    busy: () => vm.runInContext('busy || assembling', context),
    reply(fn) { replyHandler = fn; },
    input(id, value) { const element = document.getElementById(id); element.value = value; handlers.get(element).get('input')({ target: element }); },
    trigger(id) { const element = typeof id === 'string' ? document.getElementById(id) : id; if (element.disabled) throw new Error('Disabled control: ' + element.id); return handlers.get(element).get('click')({ target: element }); },
    stop() { return this.trigger(document.querySelector('[data-stop-workflow]:not([hidden])')); },
    close() { timers.forEach(clearTimeout); intervals.forEach(clearInterval); },
  };
}

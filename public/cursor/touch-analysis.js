import { createTouchTracker } from './touch-detector.js';
const abortError = () => new DOMException('Touch analysis stopped.', 'AbortError');

export async function analyseVideoTouches({ url, width, height, duration, signal, onProgress = () => {}, hint = null, fps = 12 }) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no readable duration.');
  const scale = Math.min(1, 384 / width, 768 / height);
  const w = Math.max(8, Math.round(width * scale)), h = Math.max(8, Math.round(height * scale));
  const probe = document.createElement('video');
  probe.muted = true; probe.playsInline = true; probe.preload = 'auto';
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let worker, sequence = 0, stopped = false;
  const check = () => { if (signal?.aborted || stopped) throw abortError(); };
  const wait = (event, action, timeout = 12000) => new Promise((resolve, reject) => {
    let timer;
    const clean = () => { clearTimeout(timer); probe.removeEventListener(event, done); probe.removeEventListener('error', failed); signal?.removeEventListener('abort', cancelled); };
    const done = () => { clean(); resolve(); }, failed = () => { clean(); reject(new Error('This video frame could not be read.')); }, cancelled = () => { clean(); reject(abortError()); };
    probe.addEventListener(event, done, { once: true }); probe.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => { clean(); reject(new Error('Reading a video frame timed out. Try scanning again.')); }, timeout);
    if (signal?.aborted) { cancelled(); return; }
    action();
  });
  const job = crypto.randomUUID();
  const scaledHint = hint ? { ...hint, ...(Number.isFinite(hint.radius) ? { radius: hint.radius * scale } : {}) } : null;
  const fallback = createTouchTracker({ width: w, height: h, hint: scaledHint });
  const request = message => new Promise((resolve, reject) => {
    let timer;
    const clean = () => { clearTimeout(timer); worker.removeEventListener('message', received); worker.removeEventListener('error', failed); signal?.removeEventListener('abort', cancelled); };
    const received = event => { const data = event.data; if (data.job !== job || (message.sequence !== undefined && data.sequence !== message.sequence && data.type !== 'error')) return; clean(); data.type === 'error' ? reject(new Error(data.message)) : resolve(data); };
    const failed = () => { clean(); reject(new Error('Touch analysis could not run. Try scanning again.')); }, cancelled = () => { clean(); reject(abortError()); };
    worker.addEventListener('message', received); worker.addEventListener('error', failed); signal?.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(failed, 12000);
    if (signal?.aborted) { cancelled(); return; }
    worker.postMessage({ ...message, job }, message.pixels ? [message.pixels] : []);
  });
  try {
    check(); await wait('loadeddata', () => { probe.src = url; }); check();
    if (typeof Worker !== 'undefined') {
      try { worker = new Worker(new URL('./touch-worker.js', import.meta.url), { type: 'module' }); await request({ type: 'start', width: w, height: h, hint: scaledHint }); }
      catch (error) { worker?.terminate(); worker = null; check(); }
    }
    const total = Math.max(1, Math.ceil(duration * fps));
    const started = performance.now();
    for (let i = 0; i < total; i++) {
      check();
      const time = Math.min(duration - .001, i / fps);
      if (Math.abs(probe.currentTime - time) > .001) await wait('seeked', () => { probe.currentTime = time; });
      check(); context.drawImage(probe, 0, 0, w, h);
      const pixels = context.getImageData(0, 0, w, h).data;
      if (worker) await request({ type: 'frame', sequence: ++sequence, time, pixels: pixels.buffer });
      else fallback.push(pixels, time);
      const elapsed = (performance.now() - started) / 1000;
      onProgress({ percent: Math.round((i + 1) / total * 100), frames: i + 1, total, remaining: Math.ceil(elapsed / (i + 1) * (total - i - 1)) });
      if (!worker || i % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    check();
    const result = worker ? await request({ type: 'finish' }) : fallback.result();
    return { samples: result.samples, frames: result.frames, fps, duration, complete: true };
  } finally {
    stopped = true; worker?.terminate(); probe.pause(); probe.removeAttribute('src'); probe.load();
  }
}

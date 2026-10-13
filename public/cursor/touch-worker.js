import { createTouchTracker } from './touch-detector.js?v=20261013-touch2';
let tracker, job;
self.onmessage = event => {
  const message = event.data;
  try {
    if (message.type === 'start') {
      job = message.job;
      tracker = createTouchTracker(message);
      self.postMessage({ type: 'ready', job });
    } else if (message.job === job && tracker && message.type === 'frame') {
      const sample = tracker.push(new Uint8ClampedArray(message.pixels), message.time);
      self.postMessage({ type: 'frame', job, sequence: message.sequence, sample });
    } else if (message.job === job && tracker && message.type === 'finish') {
      self.postMessage({ type: 'result', job, ...tracker.result() });
    }
  } catch (error) { self.postMessage({ type: 'error', job: message.job, message: error.message }); }
};

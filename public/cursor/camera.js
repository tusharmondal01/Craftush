// Camera poses are calculated from time, never from the previous rendered frame.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const smootherstep = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

function normalizePose(pose = {}) {
  return {
    x: clamp(finite(pose.x, .5), 0, 1),
    y: clamp(finite(pose.y, .5), 0, 1),
    zoom: clamp(finite(pose.zoom, 1), 1, 5),
  };
}

/** Return sorted, bounded events without changing the caller's array or objects.
 * Missing duration uses 650 ms. Non-finite supplied values are discarded.
 * The last input event at a shared timestamp supersedes earlier ones.
 */
export function normalizeEvents(events = []) {
  if (!Array.isArray(events)) return [];
  const normalized = [];
  events.forEach((event, index) => {
    if (!event || typeof event !== 'object' ||
        ![event.time, event.x, event.y, event.zoom].every(Number.isFinite) ||
        (event.duration !== undefined && !Number.isFinite(event.duration))) return;
    normalized.push({
      id: event.id,
      time: Math.max(0, event.time),
      duration: clamp(event.duration ?? .65, .15, 2.5),
      ...normalizePose(event),
      easing: event.easing === 'glide' ? 'glide' : 'smooth',
      ...(event.curve === 'follow' ? { curve: 'follow' } : {}),
      ...(event.origin === 'touch' ? { origin: 'touch' } : {}),
      ...(Number.isFinite(event.gesture) ? { gesture: Math.max(0, event.gesture) } : {}),
      ...(typeof event.kind === 'string' ? { kind: event.kind.slice(0, 30) } : {}),
      index,
    });
  });
  normalized.sort((a, b) => a.time - b.time || a.index - b.index);
  const result = [];
  for (const { index, ...event } of normalized) {
    if (result.length && result.at(-1).time === event.time) result[result.length - 1] = event;
    else result.push(event);
  }
  return result;
}

function followPose(events, index, time) {
  const a = events[index], b = events[index + 1];
  if (!b || b.curve !== 'follow') return normalizePose(a);
  const length = b.time - a.time, t = clamp((time - a.time) / length, 0, 1);
  const result = {};
  const value = (event, key) => key === 'zoom' ? Math.log(event.zoom) : event[key];
  const tangent = (position, key) => {
    const prev = events[position - 1], here = events[position], next = events[position + 1];
    if (!prev || !next || prev.curve !== 'follow' || next.curve !== 'follow') return 0;
    const left = (value(here, key) - value(prev, key)) / (here.time - prev.time);
    const right = (value(next, key) - value(here, key)) / (next.time - here.time);
    if (!left || !right || left * right <= 0) return 0;
    const w1 = 2 * (next.time - here.time) + here.time - prev.time;
    const w2 = next.time - here.time + 2 * (here.time - prev.time);
    return (w1 + w2) / (w1 / left + w2 / right);
  };
  for (const key of ['x', 'y', 'zoom']) {
    const start = value(a, key), end = value(b, key);
    const n = (2 * t ** 3 - 3 * t ** 2 + 1) * start + (t ** 3 - 2 * t ** 2 + t) * length * tangent(index, key) + (-2 * t ** 3 + 3 * t ** 2) * end + (t ** 3 - t ** 2) * length * tangent(index + 1, key);
    const bounded = clamp(n, Math.min(start, end), Math.max(start, end));
    result[key] = key === 'zoom' ? Math.exp(bounded) : bounded;
  }
  return result;
}

function evaluate(transition, time, initial, events) {
  if (!transition) return { ...initial };
  if (transition.follow !== undefined) return followPose(events, transition.follow, time);
  const progress = clamp((time - transition.time) / transition.duration, 0, 1);
  if (progress <= 0) return { ...transition.from };
  if (progress >= 1) return { ...transition.to };
  const amount = smootherstep(progress);
  const { from, to } = transition;
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    // Equal distances in log zoom feel like equal changes in magnification.
    zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * amount),
  };
}

/** Evaluate any time independently, including backward seeks and export frames.
 * Both easing names use a C2 quintic; event duration controls how gently it glides.
 * A new event starts from the interrupted transition's exact pose at that time.
 */
function sampleCamera(events, time, initial = { x: .5, y: .5, zoom: 1 }) {
  const origin = normalizePose(initial);
  const query = Math.max(0, finite(time, 0));
  let transition = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.time > query) break;
    if (event.curve === 'follow') transition = { follow: index };
    else {
      const from = evaluate(transition, event.time, origin, events);
      transition = { time: event.time, duration: event.duration, from, to: normalizePose(event) };
    }
  }
  return evaluate(transition, query, origin, events);
}

export function cameraAt(events, time, initial) { return sampleCamera(normalizeEvents(events), time, initial); }
export function createCameraSampler(events) { const normalized = normalizeEvents(events); return (time, initial) => sampleCamera(normalized, time, initial); }

/** Source cropping and destination framing for drawImage, without distortion.
 * Default cover fills the frame. Set pose.fit='contain' for letterboxing.
 * sw/sh describe the original source; cropW/cropH describe its visible crop.
 * fx/fy/fw/fh describe the actual drawn rectangle within the requested frame.
 */
export function cropForCamera(sourceWidth, sourceHeight, frameWidth, frameHeight, pose = {}) {
  if (![sourceWidth, sourceHeight, frameWidth, frameHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Source and frame dimensions must be positive finite numbers.');
  }
  const { x, y, zoom } = normalizePose(pose);
  const contain = pose.fit === 'contain';
  const ratio = frameWidth / frameHeight;
  const baseWidth = contain ? sourceWidth : Math.min(sourceWidth, sourceHeight * ratio);
  const baseHeight = contain ? sourceHeight : Math.min(sourceHeight, sourceWidth / ratio);
  const cropW = baseWidth / zoom;
  const cropH = baseHeight / zoom;
  const fit = contain ? Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight) : 1;
  const fw = contain ? sourceWidth * fit : frameWidth;
  const fh = contain ? sourceHeight * fit : frameHeight;
  return {
    sx: clamp(x * sourceWidth - cropW / 2, 0, sourceWidth - cropW),
    sy: clamp(y * sourceHeight - cropH / 2, 0, sourceHeight - cropH),
    cropW,
    cropH,
    sw: sourceWidth,
    sh: sourceHeight,
    fx: (frameWidth - fw) / 2,
    fy: (frameHeight - fh) / 2,
    fw,
    fh,
  };
}

/** Map a point in canvas coordinates through the visible crop to the source.
 * Letterboxing and all points outside the actual drawn frame return null.
 */
export function screenPointToSource(px, py, geometry) {
  if (!geometry || ![px, py, geometry.sx, geometry.sy, geometry.cropW, geometry.cropH,
      geometry.sw, geometry.sh, geometry.fx, geometry.fy, geometry.fw, geometry.fh].every(Number.isFinite) ||
      [geometry.cropW, geometry.cropH, geometry.sw, geometry.sh, geometry.fw, geometry.fh].some(value => value <= 0)) return null;
  const { sx, sy, cropW, cropH, sw, sh, fx, fy, fw, fh } = geometry;
  if (px < fx || px > fx + fw || py < fy || py > fy + fh) return null;
  return {
    x: clamp((sx + ((px - fx) / fw) * cropW) / sw, 0, 1),
    y: clamp((sy + ((py - fy) / fh) * cropH) / sh, 0, 1),
  };
}

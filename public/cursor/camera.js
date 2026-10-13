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

function evaluate(transition, time, initial) {
  if (!transition) return { ...initial };
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
export function cameraAt(events, time, initial = { x: .5, y: .5, zoom: 1 }) {
  const origin = normalizePose(initial);
  const query = Math.max(0, finite(time, 0));
  let transition = null;
  for (const event of normalizeEvents(events)) {
    if (event.time > query) break;
    const from = evaluate(transition, event.time, origin);
    transition = { time: event.time, duration: event.duration, from, to: normalizePose(event) };
  }
  return evaluate(transition, query, origin);
}

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

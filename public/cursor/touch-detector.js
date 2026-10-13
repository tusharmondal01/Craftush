// Local pixel analysis for a visible, neutral Android-style touch indicator.
// Circular shape, temporal novelty and continuity all have to agree.
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function grayscale(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width * height > 800000 || rgba.length !== width * height * 4) throw new RangeError('Invalid analysis frame.');
  const gray = new Uint8Array(width * height), color = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4, r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
    color[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { gray, color };
}

function circleScore(gray, color, width, height, x, y, radius) {
  if (x < radius * 1.6 || y < radius * 1.6 || x > width - radius * 1.6 || y > height - radius * 1.6) return null;
  const at = (a, b) => gray[clamp(Math.round(b), 0, height - 1) * width + clamp(Math.round(a), 0, width - 1)];
  let coverage = 0, contrast = 0, chroma = 0, inside = 0, squared = 0;
  const angles = 24;
  for (let i = 0; i < angles; i++) {
    const angle = i * Math.PI * 2 / angles, ux = Math.cos(angle), uy = Math.sin(angle);
    const inner = at(x + ux * radius * .48, y + uy * radius * .48);
    const outer = at(x + ux * radius * 1.45, y + uy * radius * 1.45);
    inside += inner; squared += inner * inner;
    chroma += color[Math.round(y + uy * radius * .4) * width + Math.round(x + ux * radius * .4)];
    let radial = 0;
    for (const shift of [-.8, 0, .8]) {
      const px = x + ux * (radius + shift), py = y + uy * (radius + shift);
      const gx = at(px + 1, py) - at(px - 1, py), gy = at(px, py + 1) - at(px, py - 1);
      const magnitude = Math.hypot(gx, gy), alignment = magnitude ? Math.abs((gx * ux + gy * uy) / magnitude) : 0;
      if (alignment > .68) radial = Math.max(radial, magnitude);
    }
    if (radial >= 12) coverage++;
    contrast += Math.max(Math.abs(inner - outer), Math.abs(inner - at(x + ux * radius, y + uy * radius)));
  }
  const mean = inside / angles, deviation = Math.sqrt(Math.max(0, squared / angles - mean * mean));
  const neutral = chroma / angles < 38, uniform = deviation < 35;
  if (!neutral || !uniform || mean < 75 || coverage < 16 || contrast / angles < 7) return null;
  const confidence = clamp(.5 * coverage / angles + .3 * Math.min(1, contrast / angles / 35) + .2 * Math.max(0, 1 - deviation / 42), 0, 1);
  return { x, y, radius, confidence, luminance: mean };
}

export function findTouchCircles(frame, width, height, { minRadius = 5, maxRadius = 15, hint = null } = {}) {
  const { gray, color } = frame;
  const votes = new Uint16Array(width * height), edges = [];
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const p = y * width + x, gx = gray[p + 1] - gray[p - 1], gy = gray[p + width] - gray[p - width];
    const length = Math.hypot(gx, gy);
    if (length > 18) edges.push({ x, y, dx: gx / length, dy: gy / length });
  }
  const stride = Math.max(1, Math.ceil(edges.length / 22000));
  const lo = Math.max(2, Math.floor(hint?.radius ? hint.radius * .65 : hint ? 2 : minRadius));
  const hi = Math.min(24, Math.ceil(hint?.radius ? hint.radius * 1.35 : maxRadius));
  for (let i = 0; i < edges.length; i += stride) {
    const edge = edges[i];
    for (let r = lo; r <= hi; r++) for (const sign of [-1, 1]) {
      const x = Math.round(edge.x + sign * edge.dx * r), y = Math.round(edge.y + sign * edge.dy * r);
      if (x >= hi && x < width - hi && y >= hi && y < height - hi) votes[y * width + x]++;
    }
  }
  const centers = [];
  for (let y = hi; y < height - hi; y++) for (let x = hi; x < width - hi; x++) {
    const p = y * width + x, score = votes[p];
    if (score < Math.max(8, 12 / stride) || score < votes[p - 1] || score < votes[p + 1] || score < votes[p - width] || score < votes[p + width]) continue;
    centers.push({ x, y, score });
  }
  centers.sort((a, b) => b.score - a.score);
  const result = [];
  for (const center of centers.slice(0, 70)) {
    if (result.some(other => Math.hypot(center.x - other.x, center.y - other.y) < 4)) continue;
    let best = null;
    for (let r = lo; r <= hi; r += .5) {
      const candidate = circleScore(gray, color, width, height, center.x, center.y, r);
      if (candidate && (!best || candidate.confidence > best.confidence)) best = candidate;
    }
    if (best) result.push(best);
  }
  return result.sort((a, b) => b.confidence - a.confidence).slice(0, 16);
}

function patchChange(current, previous, width, x, y, radius, outer = false) {
  if (!previous) return 0;
  let change = 0;
  for (let i = 0; i < 16; i++) {
    // An outline can produce an inner Hough radius; inspect the whole rim band.
    const angle = i * Math.PI / 8;
    let peak = 0;
    for (const factor of outer ? [1.95] : [.55, .9, 1.25, 1.45]) {
      const r = radius * factor;
      const p = Math.round(y + Math.sin(angle) * r) * width + Math.round(x + Math.cos(angle) * r);
      peak = Math.max(peak, Math.abs(current[p] - previous[p]) || 0);
    }
    change += peak;
  }
  return change / 16;
}

export function createTouchTracker({ width, height, hint = null } = {}) {
  let previous = null, reference = null, last = null, gesture = 0, baseline = [], frames = 0, lastFrameTime = -Infinity;
  const samples = [];
  return {
    push(rgba, time) {
      if (!Number.isFinite(time) || time < 0 || time <= lastFrameTime) return null;
      const frame = grayscale(rgba, width, height);
      lastFrameTime = time;
      const candidates = findTouchCircles(frame, width, height, { hint });
      if (!frames) baseline = candidates;
      const recent = last && time - last.time <= .36;
      const scored = candidates.map(candidate => {
        const innerChange = patchChange(frame.gray, previous, width, candidate.x, candidate.y, candidate.radius);
        const outerChange = patchChange(frame.gray, previous, width, candidate.x, candidate.y, candidate.radius, true);
        const changed = innerChange > 4 && innerChange > outerChange * 1.08 + 2;
        const distance = recent ? Math.hypot((candidate.x - last.px) / width, (candidate.y - last.py) / height) : Infinity;
        const continuation = recent && distance < .22 && Math.abs(candidate.radius - last.radius) < Math.max(3, last.radius * .4);
        const persistentChange = patchChange(frame.gray, reference, width, candidate.x, candidate.y, candidate.radius);
        const persistentOuter = patchChange(frame.gray, reference, width, candidate.x, candidate.y, candidate.radius, true);
        const wasStatic = baseline.some(dot => Math.hypot(dot.x - candidate.x, dot.y - candidate.y) < 4 && Math.abs(dot.radius - candidate.radius) < 3);
        const calibrated = hint && Math.hypot((candidate.x / width) - hint.x, (candidate.y / height) - hint.y) < .035 && Math.abs(time - hint.time) <= .2;
        if (wasStatic && !calibrated && (!changed || !continuation)) return null;
        if (continuation && reference && (persistentChange < 5 || persistentChange < persistentOuter * 1.02 + 2)) return null;
        if (!continuation && !calibrated && (!changed || wasStatic || candidate.confidence < .74)) return null;
        return { ...candidate, continuation, score: candidate.confidence + (continuation ? .45 - distance : 0) + (calibrated ? .8 : 0) };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      const chosen = scored[0];
      const before = previous;
      previous = frame.gray; frames++;
      if (!chosen) return null;
      if (!chosen.continuation) { gesture++; reference = before; }
      const sample = { time, x: chosen.x / width, y: chosen.y / height, radius: chosen.radius, confidence: chosen.confidence, gesture };
      samples.push(sample); last = { ...sample, px: chosen.x, py: chosen.y };
      return sample;
    },
    result() { return { samples: samples.map(point => ({ ...point })), frames }; },
  };
}

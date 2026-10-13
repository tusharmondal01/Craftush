import { normalizeEvents, createCameraSampler } from './camera.js?v=20261013-touch2';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const ease = t => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };

export function buildTouchMotion(samples, duration, { zoom = 2, smooth = .8 } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  zoom = clamp(Number.isFinite(zoom) ? zoom : 2, 1.1, 5);
  smooth = clamp(Number.isFinite(smooth) ? smooth : .8, .3, 2);
  const points = (samples || []).filter(p => p && [p.time, p.x, p.y, p.confidence].every(Number.isFinite) && p.time >= 0 && p.time < duration && p.confidence >= .65 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1).sort((a, b) => a.time - b.time);
  const groups = [];
  for (const point of points) {
    const group = groups.at(-1), previous = group?.at(-1);
    if (!previous || point.time - previous.time > .36 || point.gesture !== previous.gesture) groups.push([point]);
    else if (point.time > previous.time) group.push(point);
  }
  const reliable = groups.filter(group => group.length >= 2 && group.at(-1).time - group[0].time >= .06);
  if (!reliable.length) return [];
  const events = [], emit = event => events.push({ id: `touch-${events.length}`, duration: .4, easing: 'smooth', curve: 'follow', origin: 'touch', ...event });
  let previous = { x: .5, y: .5, zoom: 1 };
  emit({ time: 0, ...previous, gesture: 0, kind: 'Full frame' });
  reliable.forEach((group, index) => {
    const start = group[0].time, nextStart = reliable[index + 1]?.[0].time ?? duration;
    const ramp = Math.max(.15, Math.min(smooth, nextStart - start - .02));
    const gesture = index + 1;
    const filtered = group.map(point => {
      let weight = 0, x = 0, y = 0;
      for (const other of group) {
        const distance = Math.abs(other.time - point.time);
        if (distance > .18) continue;
        const w = Math.exp(-distance * distance / .0128);
        weight += w; x += other.x * w; y += other.y * w;
      }
      return { ...point, x: x / weight, y: y / weight };
    });
    emit({ time: start, ...previous, gesture, kind: previous.zoom < zoom - .01 ? 'Zoom in' : 'Pan' });
    let lastKept = start;
    for (let i = 0; i < filtered.length; i++) {
      const point = filtered[i], amount = ease((point.time - start) / ramp);
      if (point.time <= start) continue;
      const pose = { x: previous.x + (point.x - previous.x) * amount, y: previous.y + (point.y - previous.y) * amount, zoom: Math.exp(Math.log(previous.zoom) + (Math.log(zoom) - Math.log(previous.zoom)) * amount) };
      const old = events.at(-1), distance = Math.hypot(pose.x - old.x, pose.y - old.y);
      if (i !== filtered.length - 1 && point.time - lastKept < .18 && distance < .012 && Math.abs(pose.zoom - old.zoom) < .06) continue;
      emit({ time: point.time, ...pose, gesture, kind: pose.zoom < zoom - .03 ? 'Zoom in' : 'Pan' });
      lastKept = point.time;
    }
    const last = filtered.at(-1);
    previous = { x: last.x, y: last.y, zoom };
    const rampEnd = Math.min(duration - .001, start + ramp);
    if (events.at(-1).time < rampEnd) emit({ time: rampEnd, ...previous, gesture, kind: 'Zoom in' });
    else previous = { x: events.at(-1).x, y: events.at(-1).y, zoom: events.at(-1).zoom };
    const holdEnd = Math.min(duration - .001, nextStart - .001);
    if (events.at(-1).time < holdEnd) emit({ time: holdEnd, ...previous, gesture, kind: 'Hold focus' });
  });
  return normalizeEvents(events);
}

/** A manual move overrides this gesture. Tracking resumes smoothly at the next gesture. */
export function insertCameraMove(events, event, duration) {
  const original = normalizeEvents(events), previousTouch = [...original].reverse().find(p => p.origin === 'touch' && p.time <= event.time && p.gesture > 0);
  const starts=[];let lastGesture=0;
  for(const point of original)if(point.origin==='touch'&&point.gesture>0&&point.gesture!==lastGesture){starts.push(point);lastGesture=point.gesture;}
  const resume = starts.find(p => p.time > event.time + Math.max(.3, event.duration) && p.gesture !== previousTouch?.gesture);
  const end = resume?.time ?? Infinity;
  let changed = original.filter(p => Math.abs(p.time - event.time) > .025 && !(p.origin === 'touch' && p.time >= event.time && p.time < end));
  if(event.time>0&&original.some(point=>point.origin==='touch')){
    const pose=createCameraSampler(original)(event.time);
    changed.push({id:`start-${event.id}`,time:Math.max(0,event.time-.0001),duration:.4,origin:'touch',curve:'follow',gesture:previousTouch?.gesture||0,kind:'Hold focus',easing:'smooth',...pose});
  }
  changed.push(event);
  if (resume) {
    const sample = createCameraSampler(original);
    const finish = Math.min(duration - .001, end + .8);
    changed = changed.filter(p => !(p.origin === 'touch' && p.time >= end && p.time <= finish));
    for (let time = end; time <= finish + .0001; time = Math.min(finish, time + .1)) {
      const target = sample(time), amount = ease((time - end) / Math.max(.01, finish - end));
      changed.push({ id: `resume-${event.id}-${time.toFixed(4)}`, time, duration: .4, origin: 'touch', curve: 'follow', gesture: resume.gesture, kind: 'Resume tracking', easing: 'smooth', x: event.x + (target.x - event.x) * amount, y: event.y + (target.y - event.y) * amount, zoom: Math.exp(Math.log(event.zoom) + (Math.log(target.zoom) - Math.log(event.zoom)) * amount) });
      if (time === finish) break;
    }
  }
  return normalizeEvents(changed);
}

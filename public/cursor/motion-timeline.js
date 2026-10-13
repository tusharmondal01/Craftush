import { normalizeEvents, createCameraSampler } from './camera.js';
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const clock = time => `${String(Math.floor(time / 60)).padStart(2, '0')}:${(time % 60).toFixed(2).padStart(5, '0')}`;
const tracks = [{ key: 'zoom', label: 'Scale', min: 1, max: 5 }, { key: 'x', label: 'Pan X', min: 0, max: 1 }, { key: 'y', label: 'Pan Y', min: 0, max: 1 }];

export function createMotionTimeline({ document, video, state, active, captureUndo, onChange, onSeek, clearTransient, getCameraEvents=()=>state.cameraEvents }) {
  const $ = id => document.getElementById(id);
  let selected = null, dragging = null;
  const list = () => normalizeEvents(state.cameraEvents);
  function choose(id, seek = true) {
    if (!active()) return;
    const event = list().find(item => item.id === id);
    if (!event) return;
    selected = id;
    if (seek) { clearTransient(); video.pause(); state.playing = false; video.currentTime = event.time; onSeek(); }
    drawSelection();
    for (const marker of $('motion-tracks').querySelectorAll('.motion-key')) marker.classList.toggle('selected', marker.dataset.eventId === id);
  }
  function replace(id, updates) {
    if (Number.isFinite(updates.time)) {
      const others = list().filter(event => event.id !== id);
      let time = updates.time;
      for (let attempt = 0; attempt <= others.length; attempt++) {
        const collision = others.find(event => Math.abs(event.time - time) < .02);
        if (!collision) break;
        time = collision.time + .021 < state.duration ? collision.time + .021 : collision.time - .021;
      }
      updates = { ...updates, time: clamp(time, 0, state.duration - .001) };
    }
    const before = list();
    let changed = normalizeEvents(before.map(event => event.id === id ? { ...event, ...updates, origin: undefined, kind: 'Edited focus' } : event));
    if (changed.length < before.length && Number.isFinite(updates.time)) {
      updates.time = before.find(event => event.id === id).time;
      changed = normalizeEvents(before.map(event => event.id === id ? { ...event, ...updates, origin: undefined, kind: 'Edited focus' } : event));
    }
    state.cameraEvents = changed;
    clearTransient(); onChange();
  }
  function drawSelection() {
    const container = $('camera-events'); container.replaceChildren();
    const event = list().find(item => item.id === selected);
    if (!event) { const note = document.createElement('p'); note.className = 'camera-empty'; note.textContent = 'Select a key to change its time, scale or position. Drag any key left or right to move it.'; container.append(note); return; }
    const heading = document.createElement('p'); heading.className = 'selected-motion-heading'; heading.textContent = `${event.kind || (event.zoom === 1 ? 'Full frame' : 'Camera move')} · ${event.origin === 'touch' ? 'Detected touch' : 'Your edit'} · ${clock(event.time)}`; container.append(heading);
    const fields = document.createElement('div'); fields.className = 'selected-motion-fields';
    for (const field of [{ key: 'time', label: 'Time (s)', value: event.time, max: state.duration - .001, step: .05 }, { key: 'zoom', label: 'Scale (×)', value: event.zoom, min: 1, max: 5, step: .1 }, { key: 'x', label: 'Pan X (%)', value: event.x * 100, max: 100, step: 1, factor: .01 }, { key: 'y', label: 'Pan Y (%)', value: event.y * 100, max: 100, step: 1, factor: .01 }, { key: 'duration', label: 'Ease (s)', value: event.duration, min: .15, max: 2.5, step: .05 }]) {
      const label = document.createElement('label'); label.textContent = field.label;
      const input = document.createElement('input'); input.type = 'number'; input.min = field.min ?? 0; input.max = field.max; input.step = field.step; input.value = field.value.toFixed(field.factor ? 1 : 2); input.disabled = !active(); input.setAttribute('aria-label', `${field.label} for selected move`);
      input.addEventListener('change', () => {
        if (!active() || input.value === '' || !Number.isFinite(Number(input.value))) return;
        captureUndo(); const value = clamp(Number(input.value), Number(input.min), Number(input.max)) * (field.factor || 1);
        const updates = { [field.key]: value };
        if (field.key === 'duration' && event.curve === 'follow') updates.curve = undefined;
        replace(event.id, updates); video.pause(); state.playing = false; video.currentTime = field.key === 'time' ? value : event.time; onSeek(); render();
      });
      label.append(input); fields.append(label);
    }
    container.append(fields);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'motion-button'; remove.textContent = 'Delete selected move'; remove.disabled = !active();
    remove.addEventListener('click', () => { if (!active()) return; captureUndo(); state.cameraEvents = list().filter(item => item.id !== event.id); selected = null; clearTransient(); onChange(); render(); }); container.append(remove);
  }
  function paths() {
    const sample = createCameraSampler(getCameraEvents());
    const count = Math.min(1200, Math.max(120, list().length * 5));
    for (const track of tracks) {
      let d = '';
      for (let i = 0; i <= count; i++) {
        const value = sample(state.duration * i / count)[track.key];
        const y = 40 - clamp((value - track.min) / (track.max - track.min), 0, 1) * 30;
        d += `${i ? 'L' : 'M'}${(i / count * 1000).toFixed(2)},${y.toFixed(2)} `;
      }
      $(`motion-path-${track.key}`).setAttribute('d', d);
    }
  }
  function markerLabel(event, track) {
    const value = track.key === 'zoom' ? `${event.zoom.toFixed(1)}×` : `${Math.round(event[track.key] * 100)}%`;
    return `${track.label} key at ${clock(event.time)}: ${value}`;
  }
  function updateMarkers() {
    const events = new Map(list().map(event => [event.id, event]));
    for (const marker of $('motion-tracks').querySelectorAll('.motion-key')) {
      const event = events.get(marker.dataset.eventId), track = tracks.find(item => item.key === marker.dataset.track);
      if (!event) continue;
      marker.style.left = `${clamp(event.time / state.duration * 100, 0, 100)}%`;
      marker.style.top = `${40 - (event[track.key] - track.min) / (track.max - track.min) * 30}px`;
      marker.setAttribute('aria-label', markerLabel(event, track)); marker.title = markerLabel(event, track);
    }
  }
  function render() {
    const events = list();
    $('timeline-zoom').max = String(Math.max(6, Math.ceil(state.duration / 8)));
    if (selected && !events.some(event => event.id === selected)) selected = null;
    const container = $('motion-tracks'); container.replaceChildren();
    $('motion-duration').textContent = `${clock(state.duration)} · ${events.length} camera keys`;
    const ruler = document.createElement('div'); ruler.className = 'motion-row motion-ruler';
    const rulerTitle = document.createElement('span'); rulerTitle.className = 'motion-track-label'; rulerTitle.textContent = 'Time'; ruler.append(rulerTitle);
    const ticks = document.createElement('div'); ticks.className = 'motion-plot';
    for (let i = 0; i <= 8; i++) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'motion-tick'; button.style.left = `${i / 8 * 100}%`; button.textContent = clock(state.duration * i / 8); button.setAttribute('aria-label', `Seek to ${button.textContent}`); button.disabled = !active();
      button.addEventListener('click', () => { if (!active()) return; clearTransient(); video.pause(); state.playing = false; video.currentTime = state.duration * i / 8; onSeek(); }); ticks.append(button);
    }
    ruler.append(ticks); container.append(ruler);
    for (const track of tracks) {
      const row = document.createElement('div'); row.className = `motion-row motion-row-${track.key}`;
      const label = document.createElement('span'); label.className = 'motion-track-label'; label.textContent = track.label; row.append(label);
      const plot = document.createElement('div'); plot.className = 'motion-plot'; plot.dataset.track = track.key;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 1000 50'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.id = `motion-path-${track.key}`; svg.append(path); plot.append(svg);
      const head = document.createElement('span'); head.className = 'motion-playhead'; plot.append(head);
      for (const event of events) {
        const marker = document.createElement('button'); marker.type = 'button'; marker.className = 'motion-key'; marker.classList.toggle('automatic', event.origin === 'touch'); marker.classList.toggle('selected', event.id === selected); marker.dataset.eventId = event.id; marker.dataset.track = track.key; marker.disabled = !active();
        marker.addEventListener('click', () => { if (marker.dataset.wasDragged === 'true') { marker.dataset.wasDragged = 'false'; return; } choose(event.id); });
        marker.addEventListener('keydown', key => {
          if (!active() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key.key)) return;
          key.preventDefault(); captureUndo(); const current = list().find(item => item.id === event.id); if (!current) return;
          if (key.key === 'ArrowLeft' || key.key === 'ArrowRight') replace(event.id, { time: clamp(current.time + (key.key === 'ArrowRight' ? 1 : -1) * (key.shiftKey ? 1 : .1), 0, state.duration - .001) });
          else replace(event.id, { [track.key]: clamp(current[track.key] + (key.key === 'ArrowUp' ? 1 : -1) * (track.key === 'zoom' ? .1 : .01), track.min, track.max) });
          selected = event.id; paths(); updateMarkers(); drawSelection();
        });
        marker.addEventListener('pointerdown', pointer => {
          if (!active() || pointer.button !== 0) return;
          const current = list().find(item => item.id === event.id); if (!current) return;
          dragging = { id: event.id, startX: pointer.clientX, startTime: current.time, width: plot.getBoundingClientRect().width, changed: false };
          marker.setPointerCapture(pointer.pointerId);
        });
        marker.addEventListener('pointermove', pointer => {
          if (!dragging || dragging.id !== event.id || !active()) return;
          const distance = pointer.clientX - dragging.startX;
          if (!dragging.changed && Math.abs(distance) < 4) return;
          if (!dragging.changed) { captureUndo(); dragging.changed = true; selected = event.id; }
          const time = clamp(dragging.startTime + distance / Math.max(1, dragging.width) * state.duration, 0, state.duration - .001);
          replace(event.id, { time }); paths(); updateMarkers(); marker.dataset.wasDragged = 'true';
        });
        const finish = pointer => { if (!dragging || dragging.id !== event.id) return; const changed = dragging.changed; dragging = null; if (marker.hasPointerCapture(pointer.pointerId)) marker.releasePointerCapture(pointer.pointerId); if (changed) { video.pause(); state.playing = false; video.currentTime = list().find(item => item.id === event.id)?.time || 0; onSeek(); drawSelection(); } };
        marker.addEventListener('pointerup', finish); marker.addEventListener('pointercancel', finish);
        plot.append(marker);
      }
      row.append(plot); container.append(row);
    }
    paths(); updateMarkers(); drawSelection(); updatePlayhead(video.currentTime);
  }
  function updatePlayhead(time) {
    const percent = clamp(time / Math.max(.001, state.duration) * 100, 0, 100);
    for (const head of $('motion-tracks').querySelectorAll('.motion-playhead')) head.style.left = `${percent}%`;
    $('motion-playhead-time').textContent = clock(time);
  }
  $('timeline-zoom').addEventListener('input', () => { $('motion-tracks').style.minWidth = `${Math.max(560, $('motion-scroll').clientWidth) * Number($('timeline-zoom').value)}px`; });
  $('timeline-fit').addEventListener('click', () => { $('timeline-zoom').value = '1'; $('motion-tracks').style.minWidth = '560px'; });
  return { render, updatePlayhead, choose, reset() { selected = null; dragging = null; $('timeline-zoom').value = '1'; $('motion-tracks').style.minWidth = '560px'; } };
}

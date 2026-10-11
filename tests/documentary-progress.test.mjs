import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, restoreProject } from '../public/documentary/core.js';
import { generationProgress, taskElapsed, estimateWait, createProgressUI } from '../public/documentary/progress.js';

const now = Date.parse('2026-10-11T07:00:00Z');
const task = (status = 'processing', progress = 0) => ({ id: crypto.randomUUID(), status, progress, started: new Date(now - 65000).toISOString() });
test('story writing stays indeterminate until the complete plan is returned', () => {
  const p = newProject(); p.master.task = task();
  const a = generationProgress(p, { busy: true, now });
  const b = generationProgress(p, { busy: true, now: now + 600000 });
  assert.equal(a.story.phase, 'working'); assert.equal(a.story.elapsed, '1:05');
  assert.match(a.story.text, /min remaining/); assert.match(a.story.source, /Rough initial estimate/);
  assert.equal(a.queue.percent, 0); assert.equal(b.queue.percent, 0);
  assert.equal(b.story.text, 'Taking longer than estimated');
  p.master.task.status = 'complete';
  const checking = generationProgress(p, { busy: true, now });
  assert.equal(checking.story.phase, 'checking'); assert.equal(checking.queue.percent, 0);
});
test('confirmed directions and videos advance milestones without counting active jobs', () => {
  const p = newProject(); p.master.text = 'validated plan';
  p.scenes[0].prompt = 'validated prompt'; p.scenes[0].videoURL = 'https://vm.runware.ai/video/example.mp4';
  p.scenes[1].prompt = 'validated prompt'; p.scenes[1].videoTask = task('processing', 68);
  p.scenes[2].directorTask = task('processing', 25);
  const model = generationProgress(p, { busy: true, now, concurrency: 3 });
  assert.equal(model.queue.percent, 14); assert.equal(model.queue.milestones, 4); assert.equal(model.queue.milestoneTotal, 27);
  assert.equal(model.queue.directions, 2); assert.equal(model.queue.videos, 1);
  assert.equal(model.queue.writing, 1); assert.equal(model.queue.rendering, 1);
  assert.equal(model.tiles[1].providerPercent, 68); assert.equal(model.tiles[2].providerPercent, 25);
  assert.equal(model.tiles[3].label, 'Queued'); assert.equal(model.tiles[3].state, 'idle');
});
test('paused and interrupted tasks keep saved counts and stop loading animation', () => {
  const p = newProject(); p.master.task = task('uncertain');
  let model = generationProgress(p, { busy: true, now });
  assert.equal(model.story.phase, 'uncertain');
  model = generationProgress(p, { busy: false, now });
  assert.equal(model.story.phase, 'paused'); assert.match(model.story.text, /Resume/);
  p.master.text = 'validated plan'; p.scenes[0].directorTask = task();
  model = generationProgress(p, { busy: false, now });
  assert.equal(model.tiles[0].state, 'paused'); assert.equal(model.tiles[0].providerPercent, null);
  assert.equal(model.queue.percent, 3); assert.equal(model.queue.writing, 0);
});
test('100 percent requires every usable scene and uploaded clips need no generated direction', () => {
  const p = newProject(); p.master.text = 'validated plan';
  p.scenes.forEach((s, i) => { s.prompt = 'validated prompt'; if (i < 12) s.mediaKey = crypto.randomUUID(); });
  p.scenes[12].videoTask = task('complete', 100);
  let model = generationProgress(p, { busy: true, now });
  assert.equal(model.queue.percent, 96); assert.equal(model.queue.state, 'working');
  p.scenes[12].mediaKey = crypto.randomUUID();
  model = generationProgress(p, { busy: false, now });
  assert.equal(model.queue.percent, 100); assert.equal(model.queue.state, 'done');
  p.master.text = ''; p.scenes.forEach(s => { s.prompt = ''; });
  assert.equal(generationProgress(p).queue.percent, 100);
});
test('retry errors retain completed work and pending provider percentages never imply a ready video', () => {
  const p = newProject(); p.master.text = 'validated plan'; p.scenes[0].prompt = 'validated prompt';
  p.scenes[0].videoTask = task('error', 75); p.scenes[1].videoTask = task('processing', 100);
  const model = generationProgress(p, { busy: true, now });
  assert.equal(model.queue.failures, 1); assert.equal(model.queue.videos, 0);
  assert.equal(model.tiles[0].state, 'error'); assert.equal(model.tiles[0].providerPercent, null);
  assert.equal(model.tiles[1].providerPercent, 99); assert.equal(model.queue.percent, 7);
});
test('timing estimates learn from valid samples and corrupt history is ignored', () => {
  assert.match(estimateWait('master', task(), now, { master: [100, 120, 140] }).source, /recent jobs/);
  assert.match(estimateWait('master', task(), now, { master: 'broken' }).source, /Rough initial/);
  assert.match(estimateWait('master', task(), now, { master: [NaN, -5, 99999] }).source, /Rough initial/);
  assert.equal(taskElapsed({ started: 'bad' }, now), 0);
  assert.equal(taskElapsed({ started: new Date(now + 5000).toISOString() }, now), 0);
  assert.equal(taskElapsed({ started: new Date(now - 65000).toISOString(), finished: new Date(now - 5000).toISOString() }, now + 100000), 60);
});
test('finished timestamps survive portable project restore for stable completed timers', () => {
  const p = newProject(); p.master.task = { ...task('complete', 100), finished: new Date(now).toISOString() };
  const restored = restoreProject(p);
  assert.equal(restored.master.task.finished, p.master.task.finished);
  p.master.task.finished = 'not a date'; assert.equal(restoreProject(p).master.task.finished, undefined);
});

function documentFixture() {
  const nodes = new Map(), listeners = new Map();
  const node = () => ({ textContent: '', hidden: false, dataset: {}, attributes: {}, style: { width: '', setProperty(k, v) { this[k] = v; } },
    classList: { toggle() {} }, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; } });
  const doc = { hidden: true, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    querySelectorAll() { return []; }, addEventListener(k, fn) { listeners.set(k, fn); }, removeEventListener(k) { listeners.delete(k); } };
  return { doc, nodes, listeners };
}
test('presenter updates accessible progress and completion navigation from actual results', () => {
  const f = documentFixture(), p = newProject(); p.master.text = 'validated plan'; p.scenes[0].prompt = 'validated prompt';
  let busy = true;
  const ui = createProgressUI(f.doc, () => ({ project: p, busy, now }), { getItem() { throw new Error('Storage disabled'); }, setItem() { throw new Error('Storage disabled'); } });
  try {
    ui.update();
    assert.equal(f.nodes.get('scenesPercent').textContent, '7%');
    assert.equal(f.nodes.get('scenesProgressMeter').attributes['aria-valuenow'], '7');
    assert.equal(f.nodes.get('progressToExport').hidden, true);
    assert.equal(f.nodes.get('storyReadyStep').dataset.state, 'done');
    p.scenes.forEach(s => { s.mediaKey = crypto.randomUUID(); }); busy = false; ui.update();
    assert.equal(f.nodes.get('scenesPercent').textContent, '100%');
    assert.equal(f.nodes.get('progressToExport').hidden, false);
    assert.equal(f.nodes.get('previewActivity').hidden, true);
    ui.record('master', 130);
  } finally { ui.destroy(); }
  assert.equal(f.listeners.size, 0);
});

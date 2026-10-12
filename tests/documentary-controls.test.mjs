import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, MASTER_KEYS, restoreProject } from '../public/documentary/core.js';
import { documentaryFixture, deferred, until } from './helpers/documentary-fixture.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const prompt = 'Voiceover: a calm narrator. Voiceover narration says: यह एक कहानी है। Avoid: captions.';
const master = topic => JSON.stringify(Object.fromEntries(MASTER_KEYS.map(key => [key, key.startsWith('scene') ? `Narration: ${topic}. Shot note: a wide scene. Sound: ambience.` : topic])));
function projectWithPlan() {
  const p = newProject(ID); p.idea = 'Titanic'; p.master.idea = p.idea; p.master.text = master(p.idea); return p;
}
function pausedProject() {
  const p = newProject(ID); p.idea = 'Titanic'; p.master.task = { id: TASK, status: 'paused', started: new Date().toISOString() }; return p;
}

test('a restored pending story keeps its original topic and allows idea editing', async t => {
  const f = await documentaryFixture({ project: pausedProject() }); t.after(() => f.close());
  assert.equal(f.el('idea').disabled, false);
  assert.equal(f.read().master.idea, 'Titanic');
  f.input('idea', 'Little Krishna story');
  await f.trigger('resume');
  assert.match(f.el('notice').textContent, /idea has changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.read().master.task.id, TASK);
  assert.equal(f.read().master.idea, 'Titanic');
  f.reply(body => ({ data: [{ taskUUID: body.taskUUID, text: master('Little Krishna story') }] }));
  await f.trigger('generatePlan');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].action, 'master');
  assert.equal(f.calls[0].idea, 'Little Krishna story');
  assert.notEqual(f.calls[0].taskUUID, TASK);
  assert.equal(f.read().master.idea, 'Little Krishna story');
  assert.equal(f.records.get('archive-' + ID).master.task.id, TASK);
  assert.equal(f.records.get('archive-' + ID).master.idea, 'Titanic');
});

test('declining a replacement preserves the old plan, clips and pending task', async t => {
  const p = pausedProject(); p.scenes[0].prompt = prompt; p.ledger[ID] = { kind: 'video', cost: 12.10 };
  const f = await documentaryFixture({ project: p, confirm: false }); t.after(() => f.close());
  f.input('idea', 'A new idea'); await f.trigger('generatePlan');
  assert.equal(f.calls.length, 0); assert.equal(f.read().master.task.id, TASK);
  assert.equal(f.read().scenes[0].prompt, prompt);
  assert.equal(f.el('idea').disabled, false);
  assert.equal(f.el('summaryCost').textContent, '$12.10');
  assert.deepEqual(f.read().ledger, p.ledger);
});

test('a confirmed new idea starts its own cost total and keeps the previous ledger in the archive', async t => {
  const p = pausedProject(); p.ledger[ID] = { kind: 'video', cost: 12.10 };
  const held = deferred();
  const f = await documentaryFixture({ project: p, reply: () => held.promise }); t.after(() => f.close());
  assert.equal(f.el('summaryCost').textContent, '$12.10');
  f.input('idea', 'Little Krishna story');
  assert.equal(f.el('summaryCost').textContent, '$12.10');
  const running = f.trigger('generatePlan'); await until(() => f.calls.length === 1);
  assert.equal(f.el('summaryCost').textContent, '$0.00');
  assert.deepEqual(f.read().ledger, {});
  assert.deepEqual(f.records.get('archive-' + ID).ledger, p.ledger);
  f.stop(); await running;
  f.reply(body => ({ data: [{ taskUUID: body.taskUUID, text: master('Little Krishna story'), cost: 0.35 }] }));
  await f.trigger('generatePlan');
  assert.equal(f.el('summaryCost').textContent, '$0.35');
  assert.deepEqual(f.read().ledger, { [f.calls[0].taskUUID]: { kind: 'master', cost: 0.35 } });
  assert.deepEqual(f.records.get('archive-' + ID).ledger, p.ledger);
  assert.equal(restoreProject(f.records.get('current-project')).ledger[ID], undefined);
});

test('continuing the same idea keeps its accumulated Runware cost', async t => {
  const p = projectWithPlan(); p.ledger[ID] = { kind: 'video', cost: 12.10 };
  const f = await documentaryFixture({ project: p }); t.after(() => f.close());
  f.input('idea', '  Titanic  '); await f.trigger('generatePlan');
  assert.equal(f.el('summaryCost').textContent, '$12.10');
  assert.deepEqual(f.read().ledger, p.ledger); assert.equal(f.calls.length, 0);
  assert.equal(f.records.has('archive-' + ID), false);
});

test('Stop during story polling unlocks the idea and Resume polls the original UUID', async t => {
  const poll = deferred();
  const f = await documentaryFixture({ reply: body => body.action === 'poll' ? poll.promise : { data: [] } }); t.after(() => f.close());
  f.input('idea', 'Titanic');
  const running = f.trigger('generateAll');
  await until(() => f.calls.some(body => body.action === 'poll'));
  assert.equal(f.el('idea').disabled, true);
  assert.equal(f.el('ideaEditHint').hidden, false);
  for (const button of f.document.querySelectorAll('[data-stop-workflow]')) {
    assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  }
  f.stop(); await running;
  const taskID = f.read().master.task.id;
  assert.equal(f.busy(), false); assert.equal(f.el('idea').disabled, false);
  assert.equal(f.read().master.task.status, 'paused');
  assert(!f.calls.some(body => body.action === 'director' || body.action === 'video'));
  assert.match(f.el('queueStatus').textContent, /Workflow stopped/);
  f.reply(body => ({ data: [{ taskUUID: body.taskUUID, text: master('Titanic') }] }));
  await f.trigger('generatePlan');
  assert.equal(f.calls.filter(body => body.action === 'master').length, 1);
  assert.equal(f.calls.at(-1).action, 'poll');
  assert.equal(f.calls.at(-1).taskUUID, taskID);
  assert.equal(f.read().master.idea, 'Titanic');
  assert.equal(f.read().master.text, master('Titanic'));
});

test('Stop before dispatch keeps an unsent job resumable without polling a missing task', async t => {
  const storage = deferred(); let blocked = false;
  const f = await documentaryFixture({
    onPut: async (key, value) => { if (key === 'current-project' && value.master?.task && !blocked) { blocked = true; await storage.promise; } },
    reply: body => ({ data: [{ taskUUID: body.taskUUID, text: master('Titanic') }] }),
  }); t.after(() => f.close());
  f.input('idea', 'Titanic'); const running = f.trigger('generatePlan');
  await until(() => blocked); f.stop(); storage.resolve(); await running;
  assert.equal(f.calls.length, 0); assert.equal(f.read().master.task.status, 'queued');
  const taskID = f.read().master.task.id;
  await f.trigger('generatePlan');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'master');
  assert.equal(f.calls[0].taskUUID, taskID); assert.equal(f.read().master.text, master('Titanic'));
});

test('Stop aborts parallel scene jobs, preserves ready clips and reuses submitted UUIDs', async t => {
  const p = projectWithPlan(); p.scenes[0].prompt = prompt;
  p.scenes[0].videoURL = 'https://vm.runware.ai/video/os/test/ws/1/vi/ready.mp4';
  const held = deferred();
  const f = await documentaryFixture({ project: p, reply: () => held.promise }); t.after(() => f.close());
  const running = f.trigger('generateScenes');
  await until(() => f.calls.filter(body => body.action === 'director').length === 3);
  const submitted = f.calls.map(body => body.taskUUID);
  f.stop(); await running;
  assert.equal(f.read().scenes[0].videoURL, p.scenes[0].videoURL);
  assert.equal(f.calls.length, 3); assert.equal(f.el('idea').disabled, false);
  const paused = f.read().scenes.filter(scene => scene.directorTask?.status === 'paused');
  assert.equal(paused.length, 3);
  f.reply(body => body.action === 'poll' ? { data: [{ taskUUID: body.taskUUID, text: prompt }] } : held.promise);
  const resumed = f.trigger('resume');
  await until(() => f.calls.filter(body => body.action === 'video').length === 3);
  f.stop(); await resumed;
  assert.deepEqual(f.calls.filter(body => body.action === 'poll').map(body => body.taskUUID).sort(), submitted.sort());
  assert.equal(f.calls.filter(body => body.action === 'director').length, 3);
  assert.equal(f.read().scenes[0].videoURL, p.scenes[0].videoURL);
});

test('a result delivered after Stop cannot start downstream scene requests', async t => {
  const body = deferred();
  const f = await documentaryFixture({ reply: () => ({ ok: true, json: () => body.promise }) }); t.after(() => f.close());
  f.input('idea', 'Titanic'); const running = f.trigger('generateAll');
  await until(() => f.calls.length === 1); f.stop();
  body.resolve({ data: [{ taskUUID: f.calls[0].taskUUID, text: master('Titanic') }] }); await running;
  assert.equal(f.calls.length, 1); assert.equal(f.read().master.task.status, 'paused');
  assert.equal(f.read().master.text, ''); assert.equal(f.el('idea').disabled, false);
});

test('Stop during final assembly retains all clips and a previous final video', async t => {
  const p = projectWithPlan(), media = {};
  for (const scene of p.scenes) {
    scene.mediaKey = `${String(scene.index).padStart(8, '0')}-1111-4111-8111-111111111111`;
    media['media-' + scene.mediaKey] = new Blob(['clip'], { type: 'video/mp4' });
  }
  p.final = { mediaKey: TASK, fileName: 'previous.mp4', duration: 156, size: 5, engine: 'fixture' };
  media['media-' + TASK] = new Blob(['final'], { type: 'video/mp4' });
  let signal;
  const f = await documentaryFixture({ project: p, media, assemble: async (clips, options) => {
    assert.equal(clips.length, 13); signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
  } }); t.after(() => f.close());
  const running = f.trigger('assemble'); await until(() => !!signal); f.stop(); await running;
  assert.equal(signal.aborted, true); assert.equal(f.busy(), false);
  assert.equal(f.read().final.fileName, 'previous.mp4');
  assert(f.read().scenes.every(scene => scene.mediaKey));
  assert.equal(f.el('downloadFinal').disabled, false); assert.equal(f.el('idea').disabled, false);
  assert.match(f.el('notice').textContent, /Assembly stopped/); assert.equal(f.calls.length, 0);
});

test('project import preserves explicit original topics and supports queued unsent jobs', () => {
  const p = pausedProject(); p.idea = 'Edited draft'; p.master.idea = 'Titanic'; p.master.task.status = 'queued';
  const restored = restoreProject(p);
  assert.equal(restored.idea, 'Edited draft'); assert.equal(restored.master.idea, 'Titanic');
  assert.equal(restored.master.task.status, 'queued'); assert.equal(restored.master.task.id, TASK);
});

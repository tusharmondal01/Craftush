import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createCursorWorkflow } from '../public/cursor/workflow.js';

async function studio() {
  const { document, Event } = parseHTML(await readFile(new URL('../public/cursor/index.html', import.meta.url), 'utf8'));
  const flow = createCursorWorkflow(document);
  const $ = id => document.getElementById(id);
  const ready = () => { $('new-btn').hidden = false; $('record-btn').hidden = true; $('demo-btn').hidden = true; $('stop-btn').hidden = true; $('record-btn').disabled = false; $('upload-btn').disabled = false; $('export-btn').disabled = false; $('duration').textContent = '00:00 / 00:08'; $('status-text').textContent = 'Ready to export'; flow.sync(); };
  return { document, Event, flow, $, ready };
}

test('the simple workflow opens with two input choices and keeps advanced controls collapsed', async () => {
  const { document, flow, $ } = await studio();
  try {
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    assert.equal(ids.length, new Set(ids).size, 'no duplicate controls');
    assert.equal(document.body.dataset.cursorStep, 'start');
    assert.equal($('record-btn').hidden, false); assert.equal($('upload-btn').disabled, false);
    assert.equal($('step-edit').disabled, true); assert.equal($('step-export').disabled, true);
    assert.equal(flow.goTo('export'), false);
    for (const details of document.querySelectorAll('details')) assert.equal(details.hasAttribute('open'), false);
  } finally { flow.destroy(); }
});

test('capture blocks step changes, completion enters Edit, and returning to Start preserves the take', async () => {
  const { document, flow, $, ready } = await studio();
  try {
    $('stop-btn').hidden = false; $('record-btn').hidden = true; $('status-text').textContent = 'Recording'; flow.sync();
    assert.equal(document.body.dataset.cursorBusy, 'true');
    assert.equal(flow.goTo('edit'), false); assert.equal($('step-start').disabled, true);
    ready();
    assert.equal(document.body.dataset.cursorStep, 'edit');
    assert.equal($('continue-export').disabled, false);
    assert.equal(flow.goTo('start'), true); assert.equal($('new-btn').hidden, false);
    assert.equal($('duration').textContent, '00:00 / 00:08');
    $('new-btn').hidden = true; $('record-btn').hidden = false; $('export-btn').disabled = true; $('status-text').textContent = 'Ready to record'; flow.sync();
    assert.equal(document.body.dataset.cursorStep, 'start');
    assert.equal($('step-edit').disabled, true);
  } finally { flow.destroy(); }
});

test('export shows measured progress, prevents leaving mid-render and unlocks on success or error', async () => {
  const { document, Event, flow, $, ready } = await studio();
  try {
    ready(); flow.goTo('export');
    $('export-btn').disabled = true; $('export-btn').textContent = 'Rendering…'; $('status-text').textContent = 'Rendering your video · 25%'; flow.sync();
    assert.equal($('export-progress-panel').hidden, false); assert.equal($('export-progress').value, 25);
    assert.match($('export-progress-label').textContent, /About 6 sec remaining/);
    assert.equal(flow.goTo('edit'), false); assert.equal($('back-to-edit').disabled, true);
    $('export-btn').disabled = false; $('export-btn').textContent = 'Export video'; $('status-text').textContent = 'Video exported'; flow.sync();
    assert.equal($('export-progress').value, 100); assert.equal($('back-to-edit').disabled, false);
    assert.equal(flow.goTo('edit'), true);
    $('aspect-ratio').dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal($('export-progress-panel').hidden, true, 'a changed edit is ready for a new export');
    flow.goTo('export'); $('export-btn').disabled = true; $('export-btn').textContent = 'Rendering…'; $('status-text').textContent = 'Rendering your video · 40%'; flow.sync();
    $('export-btn').disabled = false; $('export-btn').textContent = 'Export video'; $('status-text').textContent = 'Ready to export'; flow.sync();
    assert.equal($('export-progress-panel').hidden, true); assert.equal(flow.goTo('edit'), true);
    assert.equal(document.body.dataset.cursorReady, 'true', 'failed export retains editable footage');
  } finally { flow.destroy(); }
});

test('upload loading and cancellation stay at Start; mobile completion reveals the editing step', async () => {
  const { document, flow, $, ready } = await studio();
  try {
    $('record-btn').disabled = true; $('upload-btn').disabled = true; flow.sync();
    assert.equal(document.body.dataset.cursorBusy, 'true'); assert.equal(flow.goTo('edit'), false);
    $('record-btn').disabled = false; $('upload-btn').disabled = false; flow.sync();
    assert.equal(document.body.dataset.cursorStep, 'start');
    $('mobile-editor').hidden = false; $('capture-settings').hidden = true; $('cursor-settings').hidden = true;
    ready();
    assert.equal(document.body.dataset.cursorStep, 'edit');
    assert.match($('workflow-hint').textContent, /pause, click a detail and choose Zoom in/);
    assert.equal($('mobile-editor').hidden, false); assert.equal($('cursor-settings').hidden, true);
  } finally { flow.destroy(); }
});

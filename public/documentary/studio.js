import { newProject, restoreProject, parseMaster, validatePrompt, sceneNarration, projectCost, filename, cleanMusic, ACTIVE_STATES } from './core.js';
import { DocumentaryStore } from './storage.js';
import { assembleDocumentary } from './assemble.js';

const $ = id => document.getElementById(id);
const store = new DocumentaryStore(), memoryMedia = new Map(), mediaURLs = new Map();
let project = newProject(), connection = null, selected = 0, stage = 'idea', busy = false, assembling = false;
let queueController = null, assemblyController = null, saveTimer, previewSequence = 0, persistNoticeShown = false;
let musicBlob = null, musicURL = '', musicFileName = '', finalBlob = null;
const abort = () => new DOMException('Queue paused.', 'AbortError');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = b => `${(b / 1048576).toFixed(1)} MB`;
const time = seconds => { const n = Math.round(seconds); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };

function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; $('notice').hidden = !message; }
function queueStatus(message) { $('queueStatus').textContent = message; }
async function persist({ required = false } = {}) {
  project.updated = new Date().toISOString();
  try { await store.put('current-project', structuredClone(project)); }
  catch (e) {
    if (required) throw e;
    if (!persistNoticeShown) { persistNoticeShown = true; notice(e.message, 'warn'); }
  }
}
function persistSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist(), 300); }
async function getMedia(key) { return key ? memoryMedia.get(key) || await store.get('media-' + key).catch(() => null) : null; }
async function reconcileMedia() {
  for (const s of project.scenes) if (s.mediaKey && !await getMedia(s.mediaKey)) s.mediaKey = '';
  finalBlob = await getMedia(project.final?.mediaKey);
  if (project.final && !finalBlob) project.final = null;
}
async function cacheMedia(key, blob) {
  memoryMedia.set(key, blob);
  try { await store.put('media-' + key, blob); }
  catch (e) { notice(e.message + ' The current file is still available to download.', 'warn'); }
}
function mediaURL(key, blob) {
  if (!mediaURLs.has(key)) mediaURLs.set(key, URL.createObjectURL(blob));
  return mediaURLs.get(key);
}
function invalidateFinal() {
  if (project.final) { const url = mediaURLs.get(project.final.mediaKey); if (url) URL.revokeObjectURL(url); mediaURLs.delete(project.final.mediaKey); }
  project.final = null; finalBlob = null;
}
function setStage(next) {
  stage = ['idea', 'story', 'scenes', 'export'].includes(next) ? next : 'idea';
  document.querySelectorAll('.stage').forEach(e => { e.hidden = e.id !== 'stage-' + stage; });
  document.querySelectorAll('.step').forEach(e => { e.classList.toggle('active', e.dataset.step === stage); if (e.dataset.step === stage) e.setAttribute('aria-current', 'step'); else e.removeAttribute('aria-current'); });
  history.replaceState(null, '', '#' + stage); render();
}
function ready(s) { return !!(s.mediaKey || s.videoURL); }
function sceneState(s) {
  if (ready(s)) return 'Ready';
  if (s.videoTask?.status === 'error' || s.directorTask?.status === 'error') return 'Needs retry';
  if (ACTIVE_STATES.has(s.videoTask?.status)) return s.videoTask.status === 'paused' ? 'Video paused' : 'Generating video';
  if (ACTIVE_STATES.has(s.directorTask?.status)) return s.directorTask.status === 'paused' ? 'Direction paused' : 'Writing prompt';
  return s.prompt ? 'Prompt ready' : 'Waiting';
}
function anyPaused() { return [project.master.task, ...project.scenes.flatMap(s => [s.directorTask, s.videoTask])].some(t => t && ACTIVE_STATES.has(t.status)); }
function renderStory() {
  if (document.activeElement !== $('masterText')) $('masterText').value = project.master.text || project.master.failedText || '';
  $('masterStatus').textContent = project.master.text ? 'Plan ready' : project.master.task ? ({ submitted: 'Writing', processing: 'Writing', uncertain: 'Check pending task', paused: 'Paused', error: 'Needs retry' }[project.master.task.status] || 'Not started') : 'Not started';
  $('masterStatus').classList.toggle('error', project.master.task?.status === 'error');
  if (!project.master.text) { $('storySummary').innerHTML = '<p class="empty-copy">Create a story plan to see it here.</p>'; return; }
  let plan;
  try { plan = parseMaster(project.master.text); } catch (e) { $('storySummary').textContent = e.message; return; }
  $('storySummary').innerHTML = ['glossary', 'subject_sheet', 'continuity_sheet'].map(k => `<div class="story-block"><details><summary>${esc({ glossary: 'Pronunciation glossary', subject_sheet: 'Subjects & life stages', continuity_sheet: 'Locations, light & continuity' }[k])}</summary><p>${esc(plan[k])}</p></details></div>`).join('') +
    `<div class="story-block"><h3>Opening narration</h3><p lang="hi">${esc(sceneNarration(plan.scene1))}</p></div>`;
}
function render() {
  const complete = project.scenes.filter(ready).length, s = project.scenes[selected];
  $('summaryScenes').textContent = `${complete} / 13`; $('summaryCost').textContent = '$' + projectCost(project).toFixed(2);
  $('readyCount').textContent = `${complete} of 13 scenes ready`; $('readyBar').style.width = `${complete / 13 * 100}%`;
  $('exportStatus').textContent = project.final ? 'Final video ready' : complete === 13 ? 'Ready to assemble' : 'Waiting for scenes';
  $('exportHint').textContent = complete === 13 ? 'All scenes will be joined in order with their original narration and ambient sound.' : 'Generate or upload every scene before assembling the final video.';
  $('sceneGrid').innerHTML = project.scenes.map((s, i) => {
    const state = sceneState(s), active = ACTIVE_STATES.has(s.videoTask?.status) || ACTIVE_STATES.has(s.directorTask?.status), progress = Number(s.videoTask?.progress || s.directorTask?.progress || 0);
    return `<button class="scene-tile ${i === selected ? 'selected' : ''} ${ready(s) ? 'done' : ''} ${state === 'Needs retry' ? 'failed' : ''}" data-scene="${i}" type="button" aria-label="Scene ${s.index}: ${esc(state)}" aria-pressed="${i === selected}"><span class="scene-number">${String(s.index).padStart(2, '0')}</span><small>${ready(s) ? '✓' : '12s'}</small><span class="scene-state">${state}</span>${active ? `<span class="tile-progress" style="width:${progress || 8}%"></span>` : ''}</button>`;
  }).join('');
  $('selectedLabel').textContent = `Scene ${String(selected + 1).padStart(2, '0')} / 13`; $('selectedStatus').textContent = sceneState(s);
  $('selectedStatus').classList.toggle('error', sceneState(s) === 'Needs retry');
  let plan; try { if (project.master.text) plan = parseMaster(project.master.text); } catch { /* master editor explains the invalid plan */ }
  $('selectedNarration').textContent = plan ? sceneNarration(plan['scene' + s.index]) || plan['scene' + s.index] : 'The narration for this scene will appear after the story plan is ready.';
  if (document.activeElement !== $('scenePrompt') || $('scenePrompt').dataset.scene !== String(selected)) { $('scenePrompt').value = s.prompt || s.failedPrompt || ''; $('scenePrompt').dataset.scene = String(selected); }
  $('promptCount').textContent = s.prompt ? `· ${s.prompt.length.toLocaleString()} characters` : '';
  $('resume').textContent = anyPaused() ? 'Resume existing jobs' : 'Generate remaining scenes';
  $('generateSelected').textContent = ready(s) ? 'Regenerate this scene' : sceneState(s) === 'Needs retry' ? 'Retry this scene' : 'Generate this scene';
  const locked = busy || assembling;
  const pendingMaster = ACTIVE_STATES.has(project.master.task?.status), pendingScene = ACTIVE_STATES.has(s.directorTask?.status) || ACTIVE_STATES.has(s.videoTask?.status);
  for (const id of ['generateAll', 'generatePlan', 'retryMaster', 'saveMaster', 'savePrompt', 'newProject']) $(id).disabled = locked;
  for (const id of ['generateScenes', 'resume', 'retryFailed', 'generateSelected', 'retryDirection']) $(id).disabled = locked || !project.master.text;
  $('generateScenes').disabled = locked || (!project.master.text && !pendingMaster); $('resume').disabled = locked || (!project.master.text && !pendingMaster);
  $('generateScenes').textContent = pendingMaster && !project.master.text ? 'Resume story & scenes ↗' : 'Generate all scenes ↗';
  $('downloadMaster').disabled = !project.master.text; $('downloadPrompt').disabled = !s.prompt; $('downloadScene').disabled = !ready(s);
  $('retryMaster').disabled = locked || anyPaused(); $('saveMaster').disabled = locked || anyPaused();
  $('retryDirection').disabled = locked || !project.master.text || pendingScene; $('savePrompt').disabled = locked || pendingScene;
  $('projectTitle').disabled = locked; $('idea').disabled = locked || pendingMaster; $('concurrency').disabled = locked;
  $('masterText').disabled = locked; $('scenePrompt').disabled = locked; $('sceneFile').disabled = locked; $('projectFile').disabled = locked;
  $('masterText').disabled = locked || anyPaused(); $('scenePrompt').disabled = locked || pendingScene; $('sceneFile').disabled = locked || pendingScene;
  for (const id of ['musicFile', 'musicVolume', 'narrationVolume', 'fadeIn', 'fadeOut', 'musicStart', 'loopMusic', 'removeMusic']) $(id).disabled = assembling;
  $('assemble').disabled = complete !== 13 || locked; $('downloadFinal').disabled = !finalBlob || assembling;
  $('pause').hidden = !busy; $('assemblyProgress').hidden = !assembling;
  $('musicDb').textContent = `${project.music.musicVolumeDb} dB`; $('narrationDb').textContent = `${project.music.narrationVolumeDb} dB`;
  $('removeMusic').hidden = !musicBlob; $('musicPreview').hidden = !musicBlob;
  $('finalMeta').hidden = !project.final || !finalBlob;
  if (project.final && finalBlob) $('finalMeta').textContent = `${time(project.final.duration)} · 720 × 1280 · ${size(finalBlob.size)} · ${project.final.engine}`;
  renderStory(); void updatePreview();
}
async function updatePreview() {
  const seq = ++previewSequence, s = project.scenes[selected], final = stage === 'export' && project.final && finalBlob;
  const key = final ? project.final.mediaKey : s.mediaKey;
  let url = '';
  if (final) url = mediaURL(key, finalBlob);
  else if (key) { const blob = await getMedia(key); if (blob) url = mediaURL(key, blob); }
  if (!url && !final && s.videoURL) url = s.videoURL;
  if (seq !== previewSequence) return;
  $('previewLabel').textContent = final ? 'Final documentary' : 'Scene preview';
  $('previewTitle').textContent = final ? project.title || 'Your documentary' : 'Scene ' + String(s.index).padStart(2, '0');
  $('previewMeta').textContent = final ? `${time(project.final.duration)} · 720p · MP4` : '12 seconds · 720p';
  const player = $('previewVideo'); player.hidden = !url; $('previewEmpty').hidden = !!url;
  if (url && player.getAttribute('src') !== url) { player.pause(); player.src = url; player.load(); }
  if (!url && player.getAttribute('src')) { player.pause(); player.removeAttribute('src'); player.load(); }
}
async function checkConnection() {
  $('connectionStatus').textContent = 'Checking Runware connection…'; $('connectionStatus').className = 'connection-status';
  try {
    const response = await fetch('/api/documentary', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.errors?.[0]?.message || 'The documentary backend is not available. Deploy the complete ZIP, including its API routes.');
    connection = data; $('teamCodeWrap').hidden = !data.codeRequired; $('setupLink').hidden = data.configured;
    const message = !data.enabled ? 'Documentary Studio is disabled in admin.' : data.configured ? 'Runware key connected' : 'Runware key needs setup in admin';
    $('connectionStatus').innerHTML = '<i></i>' + esc(message); $('connectionStatus').className = 'connection-status ' + (data.configured && data.enabled ? 'ready' : 'error');
  } catch (e) { connection = null; $('connectionStatus').innerHTML = '<i></i>Connection unavailable'; $('connectionStatus').className = 'connection-status error'; notice(e.message, 'error'); }
}
function ensureConnection() {
  if (!connection?.configured) throw new Error('Open Admin and save your Runware API key, then check the connection again.');
  if (!connection.enabled) throw new Error('Enable Documentary Studio in Admin → Dashboard cards.');
  if (connection.codeRequired && !$('teamCode').value.trim()) throw new Error('Enter your team access code before generating.');
}
class ServiceError extends Error { constructor(message, status = 0) { super(message); this.status = status; this.uncertain = status === 0 || status >= 500; } }
async function api(body, signal) {
  let response;
  try { response = await fetch('/api/documentary', { method: 'POST', headers: { 'content-type': 'application/json', 'x-team-code': $('teamCode').value.trim() }, body: JSON.stringify(body), signal }); }
  catch (e) { if (signal?.aborted) throw abort(); throw new ServiceError('The connection was interrupted. Resume to check this existing task.'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ServiceError(result.errors?.[0]?.message || `The service returned HTTP ${response.status}.`, response.status);
  return result;
}
function delay(ms, signal) { return new Promise((resolve, reject) => { if (signal?.aborted) return reject(abort()); const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', stop); resolve(); } function stop() { clearTimeout(timer); reject(abort()); } signal?.addEventListener('abort', stop, { once: true }); }); }
function taskOutput(result, task, kind) {
  const items = (result.data || []).filter(d => d && (!d.taskUUID || d.taskUUID === task.id));
  const item = items.find(d => kind === 'video' ? !!d.videoURL : typeof d.text === 'string' && !!d.text);
  if (item) { if (item.finishReason === 'length') throw new Error('The model response was truncated. Retry this task before generating the next stage.'); return item; }
  const error = (result.errors || []).find(e => !e.taskUUID || e.taskUUID === task.id);
  if (error && !/not.?found|not.?ready|not.?available|processing/i.test(String(error.code || '') + ' ' + String(error.message || ''))) throw new Error(error.message || 'Runware could not complete this task.');
  const active = items.find(d => d.status === 'processing' || d.progress !== undefined); if (active) task.progress = Number(active.progress) || 0;
  return null;
}
async function executeTask(task, body, kind, isNew, signal) {
  const started = Date.now(); let pauseMs = 1800, transportFailures = 0;
  try {
    if (isNew) {
      task.status = 'submitted'; await persist({ required: true }); render();
      const result = await api({ ...body, taskUUID: task.id }, signal);
      const output = taskOutput(result, task, kind); if (output) return completeTask(task, output, kind);
    }
    task.status = 'processing'; render(); await persist();
    while (Date.now() - started < 3600000) {
      await delay(pauseMs, signal);
      try {
        const result = await api({ action: 'poll', taskUUID: task.id }, signal);
        const output = taskOutput(result, task, kind); transportFailures = 0;
        if (output) return completeTask(task, output, kind);
        task.status = 'processing'; task.error = ''; await persist(); render();
      } catch (e) {
        if (signal?.aborted || !e.uncertain) throw e;
        transportFailures++; task.status = 'uncertain'; task.error = e.message; render(); await persist();
        if (transportFailures >= 6) throw e;
      }
      pauseMs = Math.min(10000, Math.round(pauseMs * 1.25));
    }
    throw new ServiceError('This task is still pending. Resume to retrieve its result without resubmitting it.', 504);
  } catch (e) {
    task.status = signal?.aborted ? 'paused' : e.uncertain ? 'uncertain' : 'error'; task.error = e.message; await persist(); render(); throw e;
  }
}
async function completeTask(task, output, kind) {
  task.status = 'complete'; task.progress = 100; task.error = '';
  if (Number.isFinite(output.cost) && output.cost >= 0) project.ledger[task.id] = { kind, cost: output.cost };
  await persist(); render(); return output;
}
function freshTask() { return { id: crypto.randomUUID(), status: 'submitted', started: new Date().toISOString(), progress: 0, error: '' }; }
async function ensureMaster(signal) {
  if (project.master.text) {
    if (project.master.idea !== project.idea) throw new Error('Your idea has changed. Generate a new story plan before creating scenes for the new topic.');
    return parseMaster(project.master.text);
  }
  const isNew = !project.master.task;
  if (project.master.task?.status === 'error') throw new Error('The master director needs a retry. Use Generate a new plan in Story plan.');
  project.master.task ||= freshTask(); queueStatus('Writing the complete story with Claude Fable 5…'); setStage('story');
  const output = await executeTask(project.master.task, { action: 'master', idea: project.idea }, 'master', isNew, signal);
  let plan;
  try { plan = parseMaster(output.text); } catch (e) { project.master.task.status = 'error'; project.master.task.error = e.message; project.master.failedText = output.text; await persist(); throw e; }
  project.master.text = output.text; project.master.idea = project.idea; project.master.failedText = ''; invalidateFinal(); await persist(); render(); return plan;
}
async function ensureDirection(s, signal) {
  if (s.prompt) return validatePrompt(s.prompt);
  if (s.directorTask?.status === 'error') throw new Error(`Scene ${s.index}: its prompt needs a retry.`);
  const isNew = !s.directorTask; s.directorTask ||= freshTask();
  queueStatus(`Directing scene ${String(s.index).padStart(2, '0')} with Claude Sonnet 4.6…`);
  const output = await executeTask(s.directorTask, { action: 'director', master: project.master.text, scene: s.index }, 'director', isNew, signal);
  try { validatePrompt(output.text); } catch (e) { s.directorTask.status = 'error'; s.directorTask.error = e.message; s.failedPrompt = output.text; await persist(); throw e; }
  s.prompt = output.text; s.failedPrompt = ''; await persist(); render(); return s.prompt;
}
async function downloadRemote(url, signal) {
  try {
    const timeout = AbortSignal.timeout(35000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, { signal: combined });
    if (!response.ok) throw new Error('Direct download unavailable.');
    if (Number(response.headers.get('content-length')) > 160 * 1024 * 1024) throw new Error('This scene is too large.');
    const blob = await response.blob(); if (!blob.size || blob.size > 160 * 1024 * 1024) throw new Error('Invalid scene file size.');
    return new Blob([blob], { type: 'video/mp4' });
  } catch (e) { if (signal?.aborted) throw abort(); }
  const pieces = []; let offset = 0, total = null;
  do {
    const response = await fetch('/api/documentary-media', { method: 'POST', headers: { 'content-type': 'application/json', 'x-team-code': $('teamCode').value.trim() }, body: JSON.stringify({ url, start: offset }), signal });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.errors?.[0]?.message || 'The scene could not be downloaded.'); }
    const next = Number(response.headers.get('x-media-next')), length = Number(response.headers.get('x-media-total'));
    const bytes = await response.arrayBuffer();
    if (!Number.isInteger(next) || !Number.isInteger(length) || length <= 0 || length > 160 * 1024 * 1024 || next !== offset + bytes.byteLength || next > length || bytes.byteLength === 0 || (total !== null && total !== length)) throw new Error('The scene download returned an invalid or incomplete range.');
    total = length; pieces.push(bytes); offset = next;
  } while (offset < total);
  return new Blob(pieces, { type: 'video/mp4' });
}
async function sceneBlob(s, signal) {
  let blob = await getMedia(s.mediaKey); if (blob) return blob;
  if (!s.videoURL) throw new Error(`Scene ${s.index} has no video file. Generate it or upload its MP4.`);
  blob = await downloadRemote(s.videoURL, signal); s.mediaKey ||= s.videoTask?.id || crypto.randomUUID();
  await cacheMedia(s.mediaKey, blob); await persist(); return blob;
}
async function ensureVideo(s, signal) {
  if (ready(s)) return;
  if (s.videoTask?.status === 'error') throw new Error(`Scene ${s.index}: its video needs a retry.`);
  const isNew = !s.videoTask; s.videoTask ||= freshTask();
  queueStatus(`Generating scene ${String(s.index).padStart(2, '0')} with PixVerse V6…`);
  const output = await executeTask(s.videoTask, { action: 'video', prompt: s.prompt }, 'video', isNew, signal);
  s.videoURL = output.videoURL; s.mediaKey = ''; invalidateFinal(); await persist(); render();
  try { await sceneBlob(s, signal); } catch (e) { if (signal?.aborted) throw e; notice(`Scene ${s.index} is generated. Its local download needs a retry: ${e.message}`, 'warn'); }
  render();
}
async function workScenes(indices, signal) {
  let cursor = 0; const problems = [], concurrency = Math.max(1, Math.min(13, Number($('concurrency').value) || 3));
  const worker = async () => {
    while (cursor < indices.length && !signal.aborted) {
      const s = project.scenes[indices[cursor++]];
      try { await ensureDirection(s, signal); if (signal.aborted) throw abort(); await ensureVideo(s, signal); }
      catch (e) { if (signal.aborted) return; problems.push(`Scene ${s.index}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, indices.length) }, worker));
  if (signal.aborted) throw abort();
  if (problems.length) notice(`${problems.length} scene${problems.length === 1 ? '' : 's'} need attention. ${problems[0]}`, 'error');
  return problems;
}
async function run(mode, indices = project.scenes.map((_, i) => i)) {
  if (busy || assembling) return;
  try { ensureConnection(); } catch (e) { notice(e.message, 'error'); return; }
  const work = async lock => {
    if (!lock && navigator.locks) { notice('A generation queue is already running in another Craftush tab. Pause that queue first.', 'warn'); return; }
    busy = true; queueController = new AbortController(); const signal = queueController.signal; notice(''); render();
    try {
      project.title = $('projectTitle').value.trim(); project.idea = $('idea').value.trim();
      if (!project.idea && !project.master.text) throw new Error('Enter your documentary idea first.');
      await persist({ required: true });
      await ensureMaster(signal);
      if (mode === 'plan') { queueStatus('The complete story plan is ready to review.'); notice('Story plan ready. Review it or generate all scenes.'); return; }
      setStage('scenes'); const problems = await workScenes(indices, signal);
      const complete = project.scenes.filter(ready).length; queueStatus(`${complete} of 13 scenes ready${problems.length ? '. Review the scenes marked Needs retry.' : '.'}`);
      if (complete === 13) { notice('All 13 scenes are ready. Add optional music and assemble your final video.'); setStage('export'); }
    } catch (e) { if (signal.aborted) { queueStatus('Queue paused. Submitted Runware jobs continue; Resume checks those same jobs.'); notice('Queue paused. Resume retrieves existing jobs before starting remaining scenes.'); } else { notice(e.message, 'error'); queueStatus('Review the error, then resume or retry the affected stage.'); } }
    finally { busy = false; queueController = null; await persist(); render(); }
  };
  if (navigator.locks) await navigator.locks.request('craftush-documentary-generation', { ifAvailable: true }, work); else await work(true);
}
function archiveScene(s, { prompt = false } = {}) {
  if (ready(s) || s.prompt) { s.history.push({ prompt: s.prompt, videoURL: s.videoURL, mediaKey: s.mediaKey, date: new Date().toISOString() }); s.history = s.history.slice(-10); }
  s.videoURL = ''; s.mediaKey = ''; s.videoTask = null;
  if (prompt) { s.prompt = ''; s.failedPrompt = ''; s.directorTask = null; }
  invalidateFinal();
}
function resetFailures(s) { if (s.directorTask?.status === 'error') { s.directorTask = null; s.prompt = ''; } if (s.videoTask?.status === 'error') s.videoTask = null; }
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function saveProject() { download(new Blob([JSON.stringify(restoreProject(project), null, 2)], { type: 'application/json' }), filename(project.title, '-project.json')); }
async function startFromIdea(mode) {
  ensureConnection();
  if (project.master.text && project.master.idea !== $('idea').value.trim()) {
    if (!confirm('Use this new idea to create a new story plan and reset the current scenes? Save the current project first if needed.')) return;
    await store.put('archive-' + project.id, structuredClone(project)); project.master = { text: '', task: null, idea: '', failedText: '' }; project.scenes.forEach(s => archiveScene(s, { prompt: true }));
  }
  if (project.master.task?.status === 'error') project.master.task = null;
  await run(mode);
}
async function guarded(fn) { try { await fn(); } catch (e) { notice(e.message, 'error'); } }
async function assemble() {
  if (busy || assembling || project.scenes.some(s => !ready(s))) return;
  assembling = true; assemblyController = new AbortController(); const signal = assemblyController.signal;
  notice(''); render(); $('previewVideo').pause(); queueStatus('Preparing the final documentary…');
  try {
    const clips = [];
    for (const s of project.scenes) { $('assemblyLabel').textContent = `Preparing scene ${s.index} of 13…`; $('assemblyBar').value = s.index / 13 * 20; clips.push(await sceneBlob(s, signal)); }
    const result = await assembleDocumentary(clips, { musicBlob, music: project.music, signal, onProgress: ({ stage, part, progress }) => {
      $('assemblyLabel').textContent = stage + (stage === 'Checking scene files' || stage === 'Matching scene formats' ? ` · ${part} / 13` : '');
      $('assemblyBar').value = stage === 'Checking scene files' ? 20 + progress * 15 : stage === 'Matching scene formats' ? 35 + (part - 1 + progress) / 13 * 35 : stage === 'Joining all 13 scenes' ? 70 + progress * 15 : stage === 'Mixing background music' || stage === 'Adjusting narration volume' ? 85 + progress * 14 : stage === 'Final video ready' ? 100 : 20;
    } });
    const key = crypto.randomUUID(); await cacheMedia(key, result.blob); finalBlob = result.blob;
    project.final = { mediaKey: key, fileName: filename(project.title, '.mp4'), duration: result.duration, size: result.blob.size, engine: result.engine };
    await persist(); notice('Your final documentary is ready to preview and download.'); queueStatus('Final video ready.');
  } catch (e) { notice(signal.aborted ? 'Assembly stopped. Your scene videos remain ready.' : e.message, signal.aborted ? '' : 'error'); queueStatus('Assembly stopped. You can try again.'); }
  finally { assembling = false; assemblyController = null; render(); }
}
function syncMusicInputs() {
  $('musicVolume').value = project.music.musicVolumeDb; $('narrationVolume').value = project.music.narrationVolumeDb;
  $('fadeIn').value = project.music.fadeIn; $('fadeOut').value = project.music.fadeOut; $('musicStart').value = project.music.start; $('loopMusic').checked = project.music.loop;
}
function updateMusic() {
  project.music = cleanMusic({ musicVolumeDb: $('musicVolume').value, narrationVolumeDb: $('narrationVolume').value, fadeIn: $('fadeIn').value, fadeOut: $('fadeOut').value, start: $('musicStart').value, loop: $('loopMusic').checked });
  invalidateFinal(); persistSoon(); render();
}
async function loadMusic() {
  if (musicURL) URL.revokeObjectURL(musicURL);
  const record = await store.get('music-' + project.id).catch(() => null); musicBlob = record?.blob || null; musicFileName = record?.name || '';
  musicURL = musicBlob ? URL.createObjectURL(musicBlob) : ''; $('musicPreview').src = musicURL; $('musicName').textContent = musicBlob ? `${musicFileName} · ${size(musicBlob.size)}` : 'The generated narration and ambient sound stay in the final video.';
}

document.querySelectorAll('[data-step]').forEach(e => e.addEventListener('click', () => setStage(e.dataset.step)));
document.querySelectorAll('[data-go]').forEach(e => e.addEventListener('click', () => setStage(e.dataset.go)));
$('checkConnection').addEventListener('click', checkConnection);
$('teamCode').addEventListener('change', () => { try { sessionStorage.setItem('craftush-documentary-code', $('teamCode').value.trim()); } catch { /* private browser */ } });
for (const id of ['idea', 'projectTitle']) $(id).addEventListener('input', () => { project.idea = $('idea').value; project.title = $('projectTitle').value; $('ideaCount').textContent = `${project.idea.length.toLocaleString()} / 20,000`; persistSoon(); });
$('generateAll').addEventListener('click', () => guarded(() => startFromIdea('all'))); $('generatePlan').addEventListener('click', () => guarded(() => startFromIdea('plan'))); $('generateScenes').addEventListener('click', () => run('all')); $('resume').addEventListener('click', () => run('all'));
$('pause').addEventListener('click', () => queueController?.abort());
$('retryFailed').addEventListener('click', () => guarded(async () => { ensureConnection(); const indices = []; project.scenes.forEach((s, i) => { if (s.directorTask?.status === 'error' || s.videoTask?.status === 'error') { resetFailures(s); indices.push(i); } }); if (!indices.length) notice('There are no failed scenes to retry.'); else await run('all', indices); }));
$('sceneGrid').addEventListener('click', e => { const button = e.target.closest('[data-scene]'); if (button) { selected = Number(button.dataset.scene); render(); } });
$('generateSelected').addEventListener('click', () => guarded(async () => { ensureConnection(); const s = project.scenes[selected]; if (ready(s)) archiveScene(s); resetFailures(s); await run('selected', [selected]); }));
$('retryDirection').addEventListener('click', () => guarded(async () => { ensureConnection(); archiveScene(project.scenes[selected], { prompt: true }); await run('selected', [selected]); }));
$('retryMaster').addEventListener('click', () => guarded(async () => { ensureConnection(); if (project.master.text && !confirm('Generate a new story plan and reset the current scenes? Save this project first if you need a portable backup.')) return; await store.put('archive-' + project.id, structuredClone(project)); project.master = { text: '', task: null, idea: '', failedText: '' }; project.scenes.forEach(s => archiveScene(s, { prompt: true })); await run('plan'); }));
$('saveMaster').addEventListener('click', () => guarded(async () => {
  const text = $('masterText').value; parseMaster(text); if (text === project.master.text) return;
  if (project.scenes.some(s => s.prompt || ready(s)) && !confirm('Apply this master plan and reset its scene prompts and videos? Save the current project first if needed.')) return;
  project.master.text = text; project.master.task = null; project.master.idea = project.idea.trim(); project.master.failedText = ''; project.scenes.forEach(s => archiveScene(s, { prompt: true })); await persist(); render(); notice('Master plan applied. Generate the scenes from this complete plan.');
}));
$('savePrompt').addEventListener('click', () => guarded(async () => { const s = project.scenes[selected], text = $('scenePrompt').value; validatePrompt(text); if (text === s.prompt) return; archiveScene(s); s.prompt = text; s.failedPrompt = ''; s.directorTask = null; await persist(); render(); notice('Prompt applied. Generate this scene to use the updated prompt.'); }));
$('sceneFile').addEventListener('change', () => guarded(async () => {
  const file = $('sceneFile').files[0]; if (!file) return; if (!file.size || file.size > 160 * 1024 * 1024) throw new Error('Choose a scene MP4 smaller than 160 MB.');
  const signature = new TextDecoder().decode(await file.slice(4, 12).arrayBuffer()); if (!signature.includes('ftyp')) throw new Error('This file is not an MP4 video.');
  const s = project.scenes[selected]; archiveScene(s); const key = crypto.randomUUID(); await cacheMedia(key, new Blob([file], { type: 'video/mp4' })); s.mediaKey = key;
  await persist(); $('sceneFile').value = ''; render(); notice(`Scene ${s.index} uploaded. Audio and duration will be checked during assembly.`);
}));
$('musicFile').addEventListener('change', () => guarded(async () => { const file = $('musicFile').files[0]; if (!file) return; if (!file.size || file.size > 80 * 1024 * 1024) throw new Error('Choose an audio file smaller than 80 MB.'); await store.put('music-' + project.id, { blob: file, name: file.name }); await loadMusic(); invalidateFinal(); await persist(); render(); }));
$('removeMusic').addEventListener('click', () => guarded(async () => { await store.delete('music-' + project.id); $('musicFile').value = ''; await loadMusic(); invalidateFinal(); await persist(); render(); }));
for (const id of ['musicVolume', 'narrationVolume', 'fadeIn', 'fadeOut', 'musicStart', 'loopMusic']) $(id).addEventListener('input', updateMusic);
$('assemble').addEventListener('click', assemble); $('stopAssembly').addEventListener('click', () => assemblyController?.abort());
$('downloadFinal').addEventListener('click', () => { if (finalBlob) download(finalBlob, project.final.fileName); });
$('downloadScene').addEventListener('click', () => guarded(async () => { const s = project.scenes[selected]; download(await sceneBlob(s), filename(project.title, `-scene-${String(s.index).padStart(2, '0')}.mp4`)); }));
$('downloadPrompt').addEventListener('click', () => { const s = project.scenes[selected]; if (s.prompt) download(new Blob([s.prompt], { type: 'text/plain;charset=utf-8' }), filename(project.title, `-scene-${String(s.index).padStart(2, '0')}-prompt.txt`)); });
$('downloadMaster').addEventListener('click', () => { if (project.master.text) download(new Blob([project.master.text], { type: 'application/json;charset=utf-8' }), filename(project.title, '-master-script.json')); });
for (const id of ['saveProject', 'saveProjectExport']) $(id).addEventListener('click', () => guarded(saveProject));
$('projectFile').addEventListener('change', () => guarded(async () => {
  const file = $('projectFile').files[0]; if (!file) return; if (file.size > 3 * 1024 * 1024) throw new Error('This project file is too large.');
  const imported = restoreProject(JSON.parse(await file.text())); await store.put('archive-' + project.id, structuredClone(project)); project = imported;
  $('idea').value = project.idea; $('projectTitle').value = project.title; $('ideaCount').textContent = `${project.idea.length.toLocaleString()} / 20,000`; syncMusicInputs(); await loadMusic(); await reconcileMedia();
  await persist(); $('projectFile').value = ''; setStage(project.master.text ? 'scenes' : 'idea'); queueStatus(anyPaused() ? 'Restored project. Resume retrieves the existing jobs.' : 'Project opened.'); notice('Project opened. On a different device, upload your saved scene MP4s if the Runware URLs have expired.');
}));
$('newProject').addEventListener('click', () => guarded(async () => {
  if ((project.idea || project.master.text || project.scenes.some(ready)) && !confirm('Start a new project? The current draft will be kept on this device; save its project JSON to reopen it.')) return;
  await store.put('archive-' + project.id, structuredClone(project)); project = newProject(); $('idea').value = ''; $('projectTitle').value = ''; $('ideaCount').textContent = '0 / 20,000'; selected = 0; finalBlob = null; await loadMusic(); syncMusicInputs(); await persist(); setStage('idea'); notice(''); queueStatus('Ready when you are.');
}));
window.addEventListener('beforeunload', e => { if (busy || assembling) { e.preventDefault(); e.returnValue = ''; } });
async function init() {
  try { const saved = await store.get('current-project'); if (saved) project = restoreProject(saved); } catch (e) { notice(e.message, 'warn'); }
  try { $('teamCode').value = sessionStorage.getItem('craftush-documentary-code') || ''; } catch { /* private browser */ }
  $('idea').value = project.idea; $('projectTitle').value = project.title; $('ideaCount').textContent = `${project.idea.length.toLocaleString()} / 20,000`;
  syncMusicInputs(); await loadMusic(); await reconcileMedia();
  setStage(location.hash.slice(1) || (project.master.text ? 'scenes' : 'idea'));
  if (anyPaused()) queueStatus('There are saved jobs to resume. No generation starts automatically.');
  await checkConnection(); render();
}
await init();

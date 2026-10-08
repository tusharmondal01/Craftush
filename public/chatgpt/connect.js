import { restoreProject, parseMaster, sceneNarration, projectCost, filename } from '../documentary/core.js';
import { DocumentaryStore } from '../documentary/storage.js';

const $ = id => document.getElementById(id), store = new DocumentaryStore();
let connection = null, project = null, selected = 0, enabled = false, refreshing = false, pending = false;
function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = 'notice ' + kind; $('notice').hidden = !message; }
async function api(body) {
  const response = await fetch('/api/chatgpt-bridge', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-team-code': $('teamCode').value.trim() }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(result.errors?.[0]?.message || 'The project connection is unavailable.'); e.status = response.status; throw e; }
  return result;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    if (!$('projectPanel').hidden) { $('command').value = text; $('command').focus(); $('command').select(); throw new Error('Automatic copy is unavailable. The text is selected; copy it with your keyboard.'); }
    throw new Error('Automatic copy is unavailable. Use the Download link for this setup file.');
  }
}
const state = scene => scene.videoURL ? 'Ready' : scene.videoTask?.status === 'error' || scene.directorTask?.status === 'error' ? 'Needs retry'
  : scene.videoTask ? 'Video pending' : scene.directorTask && !scene.prompt ? 'Direction pending' : scene.prompt ? 'Prompt ready' : 'Waiting';
function render() {
  const connected = !!connection;
  $('createPanel').hidden = connected; $('projectPanel').hidden = !connected;
  $('createConnection').disabled = pending || !enabled; $('refresh').disabled = refreshing; $('endConnection').disabled = pending;
  if (!project) return;
  const ready = project.scenes.filter(s => s.videoURL).length;
  $('connectedTitle').textContent = project.title || 'Your connected documentary';
  $('readyCount').textContent = ready + ' / 13'; $('summaryScenes').textContent = ready + ' / 13'; $('summaryCost').textContent = '$' + projectCost(project).toFixed(2);
  $('expiry').textContent = 'Expires ' + new Date(connection.expiresAt).toLocaleString();
  $('openStudio').disabled = ready !== 13 || pending; $('saveProject').disabled = pending;
  $('sceneGrid').replaceChildren(...project.scenes.map((s, i) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'scene-tile ' + (i === selected ? 'selected ' : '') + (s.videoURL ? 'done' : '');
    button.dataset.scene = String(i); button.setAttribute('aria-label', `Scene ${s.index}: ${state(s)}`); button.setAttribute('aria-pressed', String(i === selected));
    for (const [tag, text, className] of [['span', String(s.index).padStart(2, '0'), 'scene-number'], ['small', s.videoURL ? '✓' : '12s', ''], ['span', state(s), 'scene-state']]) {
      const element = document.createElement(tag); element.textContent = text; element.className = className; button.append(element);
    }
    return button;
  }));
  const s = project.scenes[selected], title = 'Scene ' + String(s.index).padStart(2, '0');
  $('sceneTitle').textContent = title; $('previewTitle').textContent = title; $('scenePrompt').textContent = s.prompt || 'The scene director has not finished yet.';
  $('narration').textContent = project.master.text ? sceneNarration(parseMaster(project.master.text)['scene' + s.index]) : 'The master story plan will appear after generation in ChatGPT.';
  const video = $('previewVideo'); video.hidden = !s.videoURL; $('previewEmpty').hidden = !!s.videoURL;
  if (s.videoURL && video.getAttribute('src') !== s.videoURL) { video.pause(); video.src = s.videoURL; video.load(); }
  if (!s.videoURL && video.getAttribute('src')) { video.pause(); video.removeAttribute('src'); video.load(); }
}
async function refresh({ quiet = false } = {}) {
  if (!connection || refreshing) return;
  refreshing = true; render();
  try {
    const result = await api({ action: 'project', projectToken: connection.projectToken });
    project = restoreProject(result.project); project.generationSource = 'chatgpt';
    connection.expiresAt = result.expiresAt; connection.project = project;
    await store.put('chatgpt-connection', connection);
    $('queueStatus').textContent = result.readyScenes === 13 ? 'All scenes ready. Open preview & save to finish your video.' : result.next ? `Continue in ChatGPT: ${result.next.kind === 'master' ? 'master story plan' : result.next.kind + ' for scene ' + result.next.scene}.` : 'Waiting for results.';
    if (!quiet) notice('Results refreshed.');
  } catch (e) { if (e.status === 410) $('queueStatus').textContent = 'Connection ended. Save your available results before starting a new project.'; if (!quiet || e.status === 410) notice(e.message, 'error'); }
  finally { refreshing = false; render(); }
}
async function guarded(fn) { try { await fn(); } catch (e) { notice(e.message, 'error'); } }
function download(blob, name) { const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function commandText() {
  return 'Use my Craftush and official Runware connections. Read craftush_workflow, then generate this documentary using the preserved workflow.\nProject connection code: ' + connection.projectToken +
    '\nRead this project first. Prepare and submit only new tasks; recover existing task UUIDs before continuing. Record each completed output in Craftush. Never request or send my Runware API key or OAuth token to Craftush.';
}
$('createConnection').addEventListener('click', () => guarded(async () => {
  if (!enabled || pending) return;
  if (!$('idea').value.trim()) throw new Error('Enter your documentary idea first.');
  pending = true; render();
  try {
    const result = await api({ action: 'create', idea: $('idea').value, title: $('projectTitle').value });
    connection = { projectToken: result.projectToken, expiresAt: result.expiresAt, projectId: result.projectId };
    await store.put('chatgpt-connection', connection); $('command').value = commandText();
    await refresh({ quiet: true }); notice('Connection ready. Copy the command into ChatGPT with Craftush and Runware selected.');
  } finally { pending = false; render(); }
}));
$('copyCommand').addEventListener('click', () => guarded(async () => { await copy(commandText()); notice('Command copied. Paste into ChatGPT with Craftush and Runware selected.'); }));
$('refresh').addEventListener('click', () => guarded(() => refresh()));
$('sceneGrid').addEventListener('click', e => { const button = e.target.closest('[data-scene]'); if (button) { selected = Number(button.dataset.scene); render(); } });
$('saveProject').addEventListener('click', () => { if (project) download(new Blob([JSON.stringify(restoreProject(project), null, 2)], { type: 'application/json' }), filename(project.title, '-project.json')); });
$('openStudio').addEventListener('click', () => guarded(async () => {
  if (!project || project.scenes.some(s => !s.videoURL) || pending) return;
  pending = true; render();
  try {
    const saved = await store.get('current-project');
    if (saved && saved.id !== project.id) await store.put('archive-' + saved.id, saved);
    const imported = restoreProject(project);
    if (saved?.id === imported.id) {
      imported.music = saved.music;
      for (const s of imported.scenes) { const old = saved.scenes.find(other => other.index === s.index); if (old?.videoURL === s.videoURL) s.mediaKey = old.mediaKey; }
      if (saved.scenes.every(s => imported.scenes[s.index - 1].videoURL === s.videoURL)) imported.final = saved.final;
    }
    await store.put('current-project', imported); location.assign('/documentary/#export');
  } finally { pending = false; render(); }
}));
$('endConnection').addEventListener('click', () => guarded(async () => {
  if (!connection || pending) return;
  if (!confirm('End this project connection? Save the project JSON first. Any submitted Runware jobs will continue at the provider.')) return;
  pending = true; render();
  try {
    try { await api({ action: 'revoke', projectToken: connection.projectToken }); } catch (e) { if (e.status !== 410) throw e; }
    await store.delete('chatgpt-connection'); connection = null; project = null; $('command').value = ''; location.reload();
  }
  finally { pending = false; render(); }
}));
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', () => guarded(async () => {
  const response = await fetch('./' + button.dataset.copy, { cache: 'no-cache' }); if (!response.ok) throw new Error('The setup file is unavailable.');
  await copy(await response.text()); notice('Setup text copied.');
}));
for (const button of document.querySelectorAll('[data-value]')) button.addEventListener('click', () => guarded(async () => {
  await copy(button.dataset.value); notice('Server URL copied. Use it in ChatGPT’s Add custom MCP server form.');
}));
$('teamCode').addEventListener('input', () => { try { sessionStorage.setItem('craftush-documentary-code', $('teamCode').value); } catch {} });
async function init() {
  try {
    $('teamCode').value = sessionStorage.getItem('craftush-documentary-code') || '';
    const response = await fetch('/api/chatgpt-bridge', { cache: 'no-store' }), metadata = await response.json();
    if (!response.ok) throw new Error(metadata.errors?.[0]?.message || 'The connection service is unavailable.');
    enabled = metadata.enabled; $('teamCodeWrap').hidden = !metadata.codeRequired;
    $('connectionStatus').textContent = enabled ? 'ChatGPT handoff ready · no Runware key needed here' : 'Documentary Studio is disabled';
    $('connectionStatus').className = 'connection-status ' + (enabled ? 'ready' : 'error');
    connection = await store.get('chatgpt-connection');
    if (connection) { project = connection.project ? restoreProject(connection.project) : null; $('command').value = commandText(); await refresh({ quiet: true }); }
  } catch (e) { notice(e.message, 'error'); }
  render();
}
setInterval(() => { if (connection && !document.hidden && !pending) void refresh({ quiet: true }); }, 10000);
await init();

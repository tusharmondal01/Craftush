// Progress reflects returned, validated work. Time estimates never fill a bar.
const pending = new Set(['queued', 'submitted', 'processing', 'uncertain', 'paused']);
const defaults = { master: [180, 480], director: [45, 180], video: [90, 360] };
const timingKey = 'craftush-documentary-timing-v1';
const hasVideo = scene => !!(scene.mediaKey || scene.videoURL);
const percent = (done, total) => done === total ? 100 : Math.floor(done / total * 100);
const duration = seconds => {
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
export function taskElapsed(task, now = Date.now()) {
  const start = Date.parse(task?.started), end = Date.parse(task?.finished);
  return Number.isFinite(start) ? Math.max(0, ((Number.isFinite(end) ? end : now) - start) / 1000) : 0;
}
export function estimateWait(kind, task, now, history = {}) {
  const values = (Array.isArray(history[kind]) ? history[kind] : []).filter(n => Number.isFinite(n) && n >= 5 && n <= 3600).slice(-9).sort((a, b) => a - b);
  const learned = values.length >= 3, median = values[Math.floor(values.length / 2)];
  const [low, high] = learned ? [median * .65, median * 1.65] : defaults[kind];
  const elapsed = taskElapsed(task, now);
  if (elapsed >= high) return { text: 'Taking longer than estimated', source: 'The existing task is still pending. You can pause and resume without starting it again.' };
  const min = Math.max(1, Math.ceil((low - elapsed) / 60)), max = Math.max(min, Math.ceil((high - elapsed) / 60));
  return { text: `About ${min === max ? min : min + '–' + max} min remaining`,
    source: learned ? 'Estimate from recent jobs on this device; provider queues can vary.' : 'Rough initial estimate; model speed and provider queues can vary.' };
}
function phase(task, ready, busy) {
  if (ready) return 'done';
  if (task?.status === 'error') return 'error';
  if (task?.status === 'uncertain') return busy ? 'uncertain' : 'paused';
  if (pending.has(task?.status)) return busy && task.status !== 'paused' ? 'working' : 'paused';
  if (task?.status === 'complete') return busy ? 'checking' : 'paused';
  return 'idle';
}
export function generationProgress(project, { busy = false, now = Date.now(), concurrency = 3, history = {} } = {}) {
  const scenes = project.scenes, total = scenes.length, master = project.master, videos = scenes.filter(hasVideo).length;
  const directions = scenes.filter(s => s.prompt || hasVideo(s)).length;
  const storyDone = !!master.text, storySatisfied = storyDone || videos === total;
  const milestones = Number(storySatisfied) + directions + videos, milestoneTotal = 1 + total * 2;
  const writing = scenes.filter(s => !s.prompt && !hasVideo(s) && phase(s.directorTask, false, busy) === 'working').length;
  const rendering = scenes.filter(s => !hasVideo(s) && phase(s.videoTask, false, busy) === 'working').length;
  const failures = scenes.filter(s => !hasVideo(s) && (s.directorTask?.status === 'error' || s.videoTask?.status === 'error')).length;
  const uncertain = busy && scenes.some(s => !hasVideo(s) && (s.videoTask?.status === 'uncertain' || s.directorTask?.status === 'uncertain'));
  const masterPhase = phase(master.task, storyDone, busy);
  const storyTitles = { idle: 'Your story plan tracker', working: master.task?.status === 'submitted' ? 'Sending your idea' : 'Writing your complete story',
    checking: 'Checking the story plan', done: 'Your story plan is ready', paused: 'Story task saved', uncertain: 'Checking the connection', error: 'Story plan needs attention' };
  const storyWait = masterPhase === 'working' ? estimateWait('master', master.task, now, history) :
    { text: masterPhase === 'done' ? `${total} connected scenes planned` : masterPhase === 'paused' ? 'Resume to check the saved task' : masterPhase === 'error' ? 'Review the error before retrying' : masterPhase === 'uncertain' ? 'Reconnecting to the existing task' : masterPhase === 'checking' ? 'Checking the returned result' : 'Start with your documentary idea', source: '' };
  const story = { phase: masterPhase, title: storyTitles[masterPhase], elapsed: duration(taskElapsed(master.task, now)), ...storyWait,
    step: storyDone ? 3 : master.task?.status === 'complete' ? 2 : master.task && master.task.status !== 'submitted' ? 1 : 0,
    caption: masterPhase === 'working' ? `The director is building narration, subjects and continuity for all ${total} scenes. The full result appears together.` :
      masterPhase === 'done' ? 'The complete plan is saved. Review it below, or continue to the scene workspace.' :
      masterPhase === 'paused' ? 'Generation is not being checked in this tab. Resume retrieves the same task before starting anything new.' :
      masterPhase === 'uncertain' ? 'The connection is interrupted. This does not mean the provider task failed; the queue checks the same task.' :
      masterPhase === 'error' ? 'Your draft is kept. Review the message above, then retry the story plan when ready.' :
      masterPhase === 'checking' ? 'Checking the returned plan before scenes can use it.' : 'Your idea becomes one connected story plan before any scene videos are generated.' };
  const state = videos === total ? 'done' : uncertain ? 'uncertain' : busy && storyDone ? 'working' : busy && masterPhase === 'working' ? 'planning' : failures ? 'error' : milestones ? 'paused' : 'idle';
  const queue = { state, percent: percent(milestones, milestoneTotal), milestones, milestoneTotal, videos, directions, total, writing, rendering, failures,
    title: state === 'done' ? 'All scenes are ready' : state === 'working' ? 'Your documentary is taking shape' : state === 'planning' ? 'Preparing your story first' : state === 'uncertain' ? 'Checking saved scene tasks' : state === 'error' ? 'Some scenes need attention' : state === 'paused' ? 'Your progress is saved' : 'Your scene progress',
    caption: state === 'working' ? `${writing} writing prompt${writing === 1 ? '' : 's'} · ${rendering} rendering video${rendering === 1 ? '' : 's'} · up to ${concurrency} scenes at once` :
      state === 'planning' ? 'The scene queue starts when the complete story plan is ready.' :
      state === 'done' ? 'Every scene video is available. Continue to Preview & save to assemble your film.' :
      state === 'uncertain' ? 'Reconnecting to existing jobs. Finished work stays saved.' :
      state === 'error' ? `${failures} scene${failures === 1 ? '' : 's'} need a retry. Finished scenes stay saved.` :
      state === 'paused' ? 'Resume to check existing jobs and continue the remaining scenes.' : 'Create the story plan, then generate or upload your scene videos.' };
  const tiles = scenes.map(s => {
    const done = hasVideo(s), kind = s.videoTask ? 'video' : 'director', task = kind === 'video' ? s.videoTask : s.directorTask;
    const state = phase(task, done, busy), reported = Number(task?.progress);
    const providerPercent = state === 'working' && Number.isFinite(reported) && reported > 0 ? Math.min(99, Math.floor(reported)) : null;
    const wait = state === 'working' ? estimateWait(kind, task, now, history) : null;
    return { state, kind, providerPercent, elapsed: duration(taskElapsed(task, now)), wait,
      label: done ? 'Ready' : state === 'error' ? 'Needs retry' : state === 'uncertain' ? 'Reconnecting' : state === 'paused' ? 'Saved · resume' : state === 'checking' ? 'Checking result' : state === 'working' ? kind === 'video' ? 'Rendering video' : 'Writing prompt' : s.prompt ? 'Prompt ready' : busy && storyDone ? 'Queued' : 'Waiting' };
  });
  return { story, queue, tiles };
}

export function createProgressUI(doc, readState, storage = null) {
  let timer = null, history = {};
  try { const value = JSON.parse(storage?.getItem(timingKey) || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) history = value; } catch { /* timing history is optional */ }
  const $ = id => doc.getElementById(id);
  const text = (id, value) => { const e = $(id); if (e && e.textContent !== value) e.textContent = value; };
  function update() {
    const state = readState(), model = generationProgress(state.project, { ...state, history });
    const story = model.story, queue = model.queue, selected = model.tiles[state.selected || 0];
    $('storyProgress').dataset.state = story.phase;
    $('storyProgress').setAttribute('aria-busy', String(story.phase === 'working' || story.phase === 'checking'));
    text('storyProgressTitle', story.title); text('storyProgressCaption', story.caption); text('storyElapsed', story.elapsed);
    text('storyEstimate', story.text); text('storyEstimateSource', story.source);
    $('storyClock').hidden = !state.project.master.task;
    $('storySkeleton').hidden = !['working', 'checking'].includes(story.phase);
    $('storyProgressTrack').hidden = !['working', 'checking'].includes(story.phase);
    ['storyRequestStep', 'storyWriteStep', 'storyReadyStep'].forEach((id, i) => {
      $(id).dataset.state = story.phase === 'done' || i < story.step ? 'done' : i === story.step && ['working', 'checking'].includes(story.phase) ? 'current' : 'waiting';
      if (i === story.step && ['working', 'checking'].includes(story.phase)) $(id).setAttribute('aria-current', 'step'); else $(id).removeAttribute('aria-current');
    });
    text('storyNavState', story.phase === 'working' || story.phase === 'checking' ? 'Working…' : story.phase === 'done' ? 'Ready' : story.phase === 'error' ? 'Needs retry' : story.phase === 'paused' || story.phase === 'uncertain' ? 'Saved task' : 'Not started');
    text('scenesNavState', `${queue.videos} / ${queue.total} ready`);
    $('scenesProgress').dataset.state = queue.state;
    text('scenesProgressTitle', queue.title); text('scenesProgressCaption', queue.caption);
    text('scenesPercent', `${queue.percent}%`); text('scenesMilestones', `${queue.milestones} / ${queue.milestoneTotal} generation steps complete`);
    text('progressStoryCount', state.project.master.text ? 'Ready' : queue.videos === queue.total ? 'Clips uploaded' : 'Pending');
    text('progressPromptCount', `${queue.directions} / ${queue.total}`); text('progressVideoCount', `${queue.videos} / ${queue.total}`);
    $('scenesProgressBar').style.width = `${queue.percent}%`;
    $('scenesProgressRing').style.setProperty('--completion', `${queue.percent}%`);
    $('scenesProgressMeter').setAttribute('aria-valuenow', String(queue.percent));
    $('scenesProgressMeter').setAttribute('aria-valuetext', `${queue.percent} percent; ${queue.videos} of ${queue.total} scene videos ready`);
    $('progressToScenes').hidden = !state.project.master.text;
    $('progressExploreScenes').hidden = !!state.project.master.text;
    text('progressNavigationHint', story.phase === 'done' ? 'Review the plan below or continue to your scenes.' : 'You can explore the workspace while generation runs.');
    $('progressToExport').hidden = queue.videos !== queue.total;
    const tiles = doc.querySelectorAll('[data-scene]');
    tiles.forEach((tile, i) => {
      const t = model.tiles[i]; if (!t) return;
      tile.dataset.activity = t.state;
      const stateLabel = tile.querySelector('.scene-state'), detail = tile.querySelector('.scene-activity-detail'), bar = tile.querySelector('.tile-progress');
      if (stateLabel) stateLabel.textContent = t.label;
      const activity = t.state === 'working' ? `${t.elapsed} elapsed${t.providerPercent !== null ? ' · ' + t.providerPercent + '%' : ''}` : t.state === 'checking' ? 'Result received' : t.label === 'Queued' ? 'Waiting for a free slot' : '';
      if (detail) detail.textContent = activity;
      if (bar) { bar.hidden = !['working', 'checking'].includes(t.state); bar.classList.toggle('indeterminate', t.providerPercent === null); bar.style.width = t.providerPercent === null ? '' : `${t.providerPercent}%`; }
      tile.setAttribute('aria-label', `Scene ${i + 1}: ${t.label}${activity ? ', ' + activity : ''}`);
    });
    const working = selected.state === 'working' || selected.state === 'checking', storyWorking = ['working', 'checking'].includes(story.phase);
    $('previewActivity').hidden = !working && !storyWorking;
    $('previewEmptyIcon').hidden = working || storyWorking;
    text('previewEmptyTitle', storyWorking ? 'Building your story' : working ? selected.kind === 'video' ? 'Your scene is rendering' : 'Directing this scene' : selected.label === 'Queued' ? 'This scene is in the queue' : selected.state === 'error' ? 'This scene needs a retry' : 'Your story starts here.');
    text('previewEmptyHint', storyWorking ? 'The complete plan arrives together.' : working ? selected.wait?.text || 'Checking the returned result…' : selected.label === 'Queued' ? 'It starts when a generation slot is free.' : 'Select a generated scene or assemble your final video.');
    text('previewActivityTime', storyWorking ? `${story.elapsed} elapsed` : `${selected.elapsed} elapsed`);
    // Only this small view ticks. It does not rerender media or poll the API.
    const ticking = state.busy && !doc.hidden;
    if (ticking && !timer) timer = setInterval(update, 1000);
    else if (!ticking && timer) { clearInterval(timer); timer = null; }
    return model;
  }
  const onVisibility = () => update(); doc.addEventListener('visibilitychange', onVisibility);
  return { update, record(kind, seconds) {
    if (!defaults[kind] || !Number.isFinite(seconds) || seconds < 5 || seconds > 3600) return;
    const previous = Array.isArray(history[kind]) ? history[kind].filter(Number.isFinite) : [];
    history[kind] = [...previous.slice(-8), Math.round(seconds)];
    try { storage?.setItem(timingKey, JSON.stringify(history)); } catch { /* no storage permission needed */ }
  }, destroy() { if (timer) clearInterval(timer); timer = null; doc.removeEventListener('visibilitychange', onVisibility); } };
}


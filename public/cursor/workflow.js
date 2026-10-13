// Presentation only: the supplied recorder, camera editor and export engine own the video.
export function createCursorWorkflow(document) {
  const $ = id => document.getElementById(id);
  const body = document.body;
  const steps = ['start', 'edit', 'export'];
  let step = 'start', wasReady = false, exported = false, lastStatus = '';
  const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const mode = () => {
    const ready = !$('new-btn').hidden;
    const live = !$('stop-btn').hidden;
    const exporting = ready && $('export-btn').disabled && $('export-btn').textContent === 'Rendering…';
    const waiting = !ready && !live && ($('record-btn').disabled || $('upload-btn').disabled);
    return { ready, live, exporting, busy: live || waiting || exporting };
  };
  function goTo(next, focus = false) {
    const state = mode();
    if (!steps.includes(next) || state.busy || (next !== 'start' && !state.ready)) return false;
    step = next;
    sync();
    if (focus) $('workflow-title').focus({ preventScroll: true });
    return true;
  }
  function sync() {
    const state = mode(), status = $('status-text').textContent;
    if (state.ready && !wasReady) step = 'edit';
    if (!state.ready && !state.busy) step = 'start';
    if (state.live) step = 'start';
    if (state.exporting) step = 'export';
    if (status !== lastStatus) {
      exported = status === 'Video exported';
      lastStatus = status;
    }
    if (!state.ready) exported = false;
    wasReady = state.ready;
    body.dataset.cursorStep = step;
    body.dataset.cursorReady = String(state.ready);
    body.dataset.cursorBusy = String(state.busy);
    for (const name of steps) {
      const button = $('step-' + name);
      button.disabled = state.busy || (name !== 'start' && !state.ready);
      if (name === step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
      button.classList.toggle('is-complete', state.ready && (name === 'start' || (name === 'edit' && step === 'export')) || name === 'export' && exported);
    }
    $('continue-export').disabled = !state.ready || state.busy;
    $('back-to-edit').disabled = state.busy;
    $('change-source').disabled = state.busy;
    const imported = !$('mobile-editor').hidden;
    const titles = {
      start: state.live ? 'Recording in progress' : state.busy ? 'Preparing your video' : state.ready ? 'Choose another video' : 'Start with a video',
      edit: 'Preview and polish', export: exported ? 'Your video is downloaded' : 'Ready to share'
    };
    const hints = {
      start: state.live ? 'Pause for a break, or finish recording to continue.' : state.busy ? 'Keep this tab open. Your video will appear here.' : state.ready ? 'Your current edit stays here until you upload another video or start a new recording.' : 'Record your screen or choose a video from your device.',
      edit: imported ? 'Play your video. To add a zoom, pause, click a detail and choose Zoom in.' : 'Play your recording. Adjust the look if you want, then continue to export.',
      export: exported ? 'Your file is in your browser’s downloads. You can return to edit or export again.' : 'Review the preview, then export to save the video on your device.'
    };
    text('workflow-title', titles[step]);
    text('workflow-hint', hints[step]);
    text('settings-title', step === 'export' ? 'Download' : 'Make it yours');
    $('export-progress-panel').hidden = !state.exporting && !exported;
    const percent = status.match(/Rendering your video · (\d+)%/);
    if (state.exporting) {
      if (percent) {
        const value = Math.max(0, Math.min(100, Number(percent[1])));
        $('export-progress').value = value;
        const duration = $('duration').textContent.match(/\/\s*(\d+):(\d+)/);
        const seconds = duration ? Math.ceil((Number(duration[1]) * 60 + Number(duration[2])) * (1 - value / 100)) : null;
        text('export-progress-label', `${value}% · ${seconds === null ? 'Rendering your video.' : seconds > 0 ? `About ${seconds} sec remaining.` : 'Finishing your download.'} Keep this tab visible.`);
      } else {
        $('export-progress').removeAttribute('value');
        text('export-progress-label', 'Preparing your download. Keep this tab visible.');
      }
    } else if (exported) {
      $('export-progress').value = 100;
      text('export-progress-label', '100% · Download complete.');
    }
  }
  const listeners = [];
  const on = (node, event, callback, options) => { node.addEventListener(event, callback, options); listeners.push(() => node.removeEventListener(event, callback, options)); };
  for (const name of steps) on($('step-' + name), 'click', () => goTo(name, true));
  on($('continue-export'), 'click', () => goTo('export', true));
  on($('back-to-edit'), 'click', () => goTo('edit', true));
  on($('change-source'), 'click', () => goTo('start', true));
  const editChanged = event => {
    if (event.target.matches('input,select,button') && event.target.closest('.inspector-section')) { exported = false; sync(); }
  };
  on(document, 'change', editChanged);
  on(document, 'input', editChanged);
  on(document, 'click', editChanged);
  // Space activates the focused control; the preview keeps its original playback shortcut.
  on(document, 'keydown', event => {
    if (event.code === 'Space' && event.target.closest('button,summary,a,[role="button"]')) event.stopPropagation();
  }, true);
  const Observer = document.defaultView.MutationObserver;
  const observer = new Observer(sync);
  for (const id of ['record-btn', 'upload-btn', 'stop-btn', 'new-btn', 'export-btn', 'mobile-editor']) observer.observe($(id), { attributes: true, attributeFilter: ['hidden', 'disabled'] });
  observer.observe($('status-text'), { childList: true, characterData: true, subtree: true });
  sync();
  return { goTo, sync, destroy() { observer.disconnect(); listeners.forEach(remove => remove()); } };
}

if (typeof document !== 'undefined') createCursorWorkflow(document);

/* Local-only preview of the sampled native motion keys. No API calls or image uploads. */
const transitionPreviewState = { ticket: 0, raf: 0, playing: false, scene: null, elapsed: 0, previous: null };

function stopTransitionPreview(){
  transitionPreviewState.ticket++;
  if (transitionPreviewState.raf) cancelAnimationFrame(transitionPreviewState.raf);
  transitionPreviewState.raf = 0; transitionPreviewState.playing = false;
  transitionPreviewState.scene = null; transitionPreviewState.previous = null;
  $('#transitionPreview').hidden = true;
}

function updateTransitionControls(){
  const native = /^(auto|gentle|reference)$/.test($('#trans').value);
  $('#transitionEnergy').disabled = $('#trans').value !== 'auto';
  const plan = native && state.timeline.length > 1 ? getAutoTransitions() : [];
  const active = plan.filter(Boolean);
  const available = plan.some((t, k) => t && state.items[state.timeline[k].i]?.url && state.items[state.timeline[k + 1].i]?.url);
  $('#previewTransitions').disabled = !available || state.running;
  $('#shuffleTransitions').disabled = !active.length || !native || state.running || $('#trans').value === 'reference';
  if (!native){ $('#transitionSummary').textContent = 'Choose an automatic transition mode to preview and shuffle the mix.'; return; }
  if (!state.timeline.length){ $('#transitionSummary').textContent = 'Add timings to see the transition mix.'; return; }
  if (!active.length){ $('#transitionSummary').textContent = 'These beats use direct cuts; their timing stays intact.'; return; }
  const names = [...new Set(active.map(t => t.preset.name))];
  $('#transitionSummary').textContent = `${active.length} transitions · ${names.length} styles · ${Math.min(...active.map(t => t.seconds)).toFixed(2)}–${Math.max(...active.map(t => t.seconds)).toFixed(2)} s · ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}${available ? '' : ' · Generate two adjacent images to preview.'}`;
}

function loadTransitionImage(url){
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error('An image could not be loaded. Generate it again, then retry the preview.')), 15000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('An image could not be loaded. Generate it again, then retry the preview.')); };
    image.src = url;
  });
}

function drawTransitionImage(context, image, point, scene){
  const { width, height } = context.canvas;
  context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = 1;
  context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
  context.translate(width / 2 + point.x * width, height / 2 + point.y * height);
  context.rotate(point.turn * Math.PI / 180);
  const factor = point.scale / 100 * width / scene.sw;
  context.drawImage(image, -scene.iw * factor / 2, -scene.ih * factor / 2, scene.iw * factor, scene.ih * factor);
  context.setTransform(1, 0, 0, 1, 0, 0);
}

function renderTransitionFrame(canvas, scene, elapsed){
  // Show a readable hold on each side; the transition itself runs at its exported speed.
  const hold = .65, cycle = 2 * hold + scene.transition.seconds;
  const within = ((elapsed % cycle) + cycle) % cycle;
  const p = Math.max(0, Math.min(1, (within - hold) / scene.transition.seconds));
  const sequenceFrame = scene.transition.start + p * scene.transition.frames;
  for (let j = 0; j < 2; j++){
    const clip = scene.clips[j], sourceFrame = sequenceFrame - clip.start + clip.motion.pre;
    const point = CraftushTransitions.sampleAt(clip.motion, sourceFrame);
    drawTransitionImage(scene.buffers[j].getContext('2d'), scene.images[j], point, scene);
  }
  const context = canvas.getContext('2d');
  context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = 1;
  context.drawImage(scene.buffers[0], 0, 0);
  context.globalAlpha = p; context.drawImage(scene.buffers[1], 0, 0); context.globalAlpha = 1;
}

function transitionPreviewTick(now){
  const preview = transitionPreviewState;
  if (!preview.playing || !preview.scene) return;
  if (preview.previous !== null) preview.elapsed += Math.min(.1, (now - preview.previous) / 1000);
  preview.previous = now;
  renderTransitionFrame($('#transitionCanvas'), preview.scene, preview.elapsed);
  preview.raf = requestAnimationFrame(transitionPreviewTick);
}

async function openTransitionPreview(pair){
  stopTransitionPreview();
  const ticket = transitionPreviewState.ticket, plan = getAutoTransitions();
  const choices = plan.map((t, k) => ({ t, k })).filter(({ t, k }) => t && state.items[state.timeline[k].i]?.url && state.items[state.timeline[k + 1].i]?.url);
  if (!choices.length) return;
  const choice = choices.find(c => c.k === Number(pair)) || choices[0], k = choice.k, t = choice.t;
  $('#transitionPair').innerHTML = choices.map(({ t, k }) => `<option value="${k}">${esc(fname(state.timeline[k].i))} → ${esc(fname(state.timeline[k + 1].i))} · ${esc(t.preset.name)} · ${t.seconds.toFixed(2)} s</option>`).join('');
  $('#transitionPair').value = String(k);
  $('#transitionPreview').hidden = false; $('#transitionPreviewStatus').textContent = 'Loading the two images…';
  const canvas = $('#transitionCanvas'), [sw, sh] = seqSize(), [iw, ih] = imgSize();
  const size = Math.min(1, 640 / Math.max(sw, sh));
  canvas.width = Math.max(1, Math.round(sw * size)); canvas.height = Math.max(1, Math.round(sh * size));
  try {
    const images = await Promise.all([k, k + 1].map(j => loadTransitionImage(state.items[state.timeline[j].i].url)));
    if (ticket !== transitionPreviewState.ticket) return;
    const clips = [k, k + 1].map(j => ({ ...state.timeline[j], motion: getClipMotion(j, plan).motion }));
    const buffers = images.map(() => { const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; return c; });
    transitionPreviewState.scene = { transition: t, clips, images, buffers, sw, sh, iw, ih };
    transitionPreviewState.elapsed = 0; transitionPreviewState.previous = null;
    $('#transitionPreviewStatus').textContent = `${t.preset.name} · ${t.seconds.toFixed(2)} s · Cut at ${fmtTime(t.cut / rateInfo().fps)}. The same motion keys are included in your Premiere XML.`;
    // Reduced-motion users explicitly start playback from the Play button.
    transitionPreviewState.playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('#transitionPlay').textContent = transitionPreviewState.playing ? 'Pause' : 'Play';
    renderTransitionFrame(canvas, transitionPreviewState.scene, 0);
    if (transitionPreviewState.playing) transitionPreviewState.raf = requestAnimationFrame(transitionPreviewTick);
  } catch (error){ if (ticket === transitionPreviewState.ticket) $('#transitionPreviewStatus').textContent = error.message; }
}

function initTransitionPreview(){
  $('#previewTransitions').addEventListener('click', () => openTransitionPreview());
  $('#transitionPair').addEventListener('change', e => openTransitionPreview(e.target.value));
  $('#transitionClose').addEventListener('click', stopTransitionPreview);
  $('#transitionPlay').addEventListener('click', () => {
    const p = transitionPreviewState; if (!p.scene) return;
    p.playing = !p.playing; p.previous = null;
    $('#transitionPlay').textContent = p.playing ? 'Pause' : 'Play';
    if (p.playing) p.raf = requestAnimationFrame(transitionPreviewTick);
    else { cancelAnimationFrame(p.raf); p.raf = 0; }
  });
  $('#shuffleTransitions').addEventListener('click', () => {
    const pair = $('#transitionPair').value, reopen = !$('#transitionPreview').hidden;
    state.transitionSeed = uuidSeed(); state.xmlDone = false;
    refreshTimeline();
    if (reopen) openTransitionPreview(pair);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden){
      transitionPreviewState.playing = false; transitionPreviewState.previous = null;
      if (transitionPreviewState.raf) cancelAnimationFrame(transitionPreviewState.raf);
      transitionPreviewState.raf = 0; $('#transitionPlay').textContent = 'Play';
    }
  });
}

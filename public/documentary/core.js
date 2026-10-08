// Pure workflow and export helpers, shared by the browser, backend and tests.
export const SCENE_COUNT = 13;
export const SCENE_SECONDS = 12;
export const MASTER_KEYS = ['glossary', 'subject_sheet', 'continuity_sheet', ...Array.from({ length: SCENE_COUNT }, (_, i) => `scene${i + 1}`)];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ACTIVE_STATES = new Set(['submitted', 'processing', 'uncertain', 'paused']);

export function parseMaster(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('The master script is empty or too large.');
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let plan;
  try { plan = JSON.parse(raw); } catch { throw new Error('The director returned incomplete or invalid JSON. Review the master script or retry the director before generating scenes.'); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).length !== MASTER_KEYS.length || MASTER_KEYS.some(k => typeof plan[k] !== 'string' || !plan[k].trim())) {
    throw new Error('The master script must contain the glossary, subject sheet, continuity sheet and all 13 scenes as nonempty strings.');
  }
  return plan;
}

export function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('The scene prompt is empty. Generate its scene direction first.');
  if (prompt.length > 5000) throw new Error(`The scene prompt has ${prompt.length} characters; PixVerse accepts at most 5000. Edit the scene prompt before generating its video.`);
  if (!prompt.trimStart().startsWith('Voiceover:') || !/Voiceover narration says:/i.test(prompt) || !/Avoid:/i.test(prompt)) {
    throw new Error('The scene director did not return the expected video prompt. Review it or retry scene direction.');
  }
  return prompt;
}

export function sceneNarration(plan) {
  return [...String(plan || '').matchAll(/Narration:\s*([\s\S]*?)(?=\s*(?:Shot(?:\s+(?:note|one|two|three|four|five|\d+))?:|Sound:|Continuity:|$))/gi)]
    .map(m => m[1].trim()).join(' ');
}

export function newProject(id = crypto.randomUUID()) {
  return {
    schema: 'craftush-documentary-v1', id, title: '', idea: '', created: new Date().toISOString(), updated: new Date().toISOString(),
    master: { text: '', task: null, idea: '', failedText: '' }, ledger: {},
    scenes: Array.from({ length: SCENE_COUNT }, (_, i) => ({ index: i + 1, prompt: '', failedPrompt: '', directorTask: null, videoTask: null, videoURL: '', mediaKey: '', history: [] })),
    music: { musicVolumeDb: -18, narrationVolumeDb: 0, loop: true, fadeIn: 1, fadeOut: 3, start: 0 }, final: null,
  };
}

function cleanTask(t) {
  if (!t || !UUID.test(String(t.id || ''))) return null;
  return { id: t.id, status: String(t.status || 'paused'), started: t.started || '', error: String(t.error || '').slice(0, 500), progress: Math.max(0, Math.min(100, Number(t.progress) || 0)) };
}

function safeVideoURL(value) {
  if (!value) return '';
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname === 'vm.runware.ai' && u.pathname.startsWith('/video/') ? u.href : '';
  } catch { return ''; }
}

export function cleanMusic(m = {}) {
  const finite = (k, fallback, lo, hi) => Number.isFinite(Number(m[k])) ? Math.max(lo, Math.min(hi, Number(m[k]))) : fallback;
  return { musicVolumeDb: finite('musicVolumeDb', -18, -60, 0), narrationVolumeDb: finite('narrationVolumeDb', 0, -30, 6), loop: m.loop !== false,
    fadeIn: finite('fadeIn', 1, 0, 20), fadeOut: finite('fadeOut', 3, 0, 20), start: finite('start', 0, 0, 3600) };
}

// Explicit allowlist: imported files and exports can never restore a key or access code.
export function restoreProject(input) {
  if (!input || input.schema !== 'craftush-documentary-v1' || !UUID.test(input.id) || !Array.isArray(input.scenes) || input.scenes.length !== SCENE_COUNT) {
    throw new Error('Choose a Documentary Studio project JSON containing all 13 scenes.');
  }
  const p = newProject(input.id);
  if (input.generationSource === 'chatgpt') p.generationSource = 'chatgpt';
  p.title = String(input.title || '').slice(0, 120); p.idea = String(input.idea || '').slice(0, 20000);
  p.created = String(input.created || p.created); p.updated = String(input.updated || p.updated);
  p.master.text = String(input.master?.text || '').slice(0, 200000); p.master.task = cleanTask(input.master?.task);
  p.master.idea = String(input.master?.idea ?? p.idea).slice(0, 20000); p.master.failedText = String(input.master?.failedText || '').slice(0, 200000);
  if (p.master.text) parseMaster(p.master.text);
  const seen = new Set();
  p.scenes = input.scenes.map(s => {
    if (!s || !Number.isInteger(s.index) || s.index < 1 || s.index > SCENE_COUNT || seen.has(s.index)) throw new Error('Project scene numbers must be unique and run from 1 to 13.');
    seen.add(s.index);
    const prompt = String(s.prompt || '').slice(0, 10000);
    if (prompt) validatePrompt(prompt);
    return { index: s.index, prompt, failedPrompt: String(s.failedPrompt || '').slice(0, 10000), directorTask: cleanTask(s.directorTask), videoTask: cleanTask(s.videoTask), videoURL: safeVideoURL(s.videoURL),
      mediaKey: typeof s.mediaKey === 'string' && UUID.test(s.mediaKey) ? s.mediaKey : '', history: Array.isArray(s.history) ? s.history.slice(-10).map(h => ({
        prompt: String(h.prompt || '').slice(0, 10000), videoURL: safeVideoURL(h.videoURL), mediaKey: UUID.test(String(h.mediaKey || '')) ? h.mediaKey : '', date: String(h.date || ''),
      })) : [] };
  }).sort((a, b) => a.index - b.index);
  for (const [id, entry] of Object.entries(input.ledger || {})) {
    if (UUID.test(id) && entry && Number.isFinite(entry.cost) && entry.cost >= 0) p.ledger[id] = { kind: String(entry.kind || '').slice(0, 30), cost: entry.cost };
  }
  p.music = cleanMusic(input.music);
  if (input.final && UUID.test(String(input.final.mediaKey || ''))) p.final = {
    mediaKey: input.final.mediaKey, fileName: String(input.final.fileName || 'documentary.mp4').slice(0, 150), duration: Number(input.final.duration) || 0,
    size: Number(input.final.size) || 0, engine: String(input.final.engine || ''),
  };
  return p;
}

export function projectCost(p) { return Object.values(p.ledger || {}).reduce((s, t) => s + (Number(t.cost) || 0), 0); }
export function filename(title, suffix = '') {
  return (String(title || 'Documentary').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\.+$/g, '').trim().slice(0, 90) || 'Documentary') + suffix;
}
export function normalizedCommand(input, output) {
  return ['-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1:first_pts=0', output];
}
export function concatenateCommand(list, output) {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', output];
}
export function musicCommand(input, music, output, seconds, settings = {}) {
  const m = cleanMusic(settings), a = ['-y', '-i', input];
  if (music) {
    if (m.loop) a.push('-stream_loop', '-1');
    a.push('-ss', String(m.start), '-i', music);
    const fadeIn = Math.min(m.fadeIn, seconds), fadeOut = Math.min(m.fadeOut, seconds);
    const bg = [`volume=${m.musicVolumeDb}dB`, ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${fadeIn}`] : []), ...(fadeOut > 0 ? [`afade=t=out:st=${Math.max(0, seconds - fadeOut)}:d=${fadeOut}`] : []), 'apad'].join(',');
    a.push('-filter_complex', `[0:a]volume=${m.narrationVolumeDb}dB[n];[1:a]${bg}[bg];[n][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`, '-map', '0:v:0', '-map', '[a]');
  } else a.push('-map', '0:v:0', '-map', '0:a:0', '-af', `volume=${m.narrationVolumeDb}dB`);
  a.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', output);
  return a;
}

export function assertMedia(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find(s => s.codec_type === 'video'), audio = streams.find(s => s.codec_type === 'audio');
  const duration = Number(probe?.format?.duration || video?.duration);
  if (!video || !audio) throw new Error('A scene is missing video or narration audio. Replace that clip before assembling.');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error('A scene has an invalid duration.');
  return { video, audio, duration };
}
export function compatibleMedia(infos) {
  const signature = ({ video: v, audio: a }) => JSON.stringify([v.codec_name, v.profile, v.level, v.width, v.height, v.pix_fmt, v.r_frame_rate, v.time_base, a.codec_name, a.sample_rate, a.channels, a.channel_layout, a.time_base]);
  return infos.length > 0 && infos.every(i => i.video.width === 720 && i.video.height === 1280 && i.video.codec_name === 'h264' && i.audio.codec_name === 'aac' && signature(i) === signature(infos[0]));
}

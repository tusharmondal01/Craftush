// Shared invariants for the narration-first studio. No provider credentials.
export const VERSION = 'documentary-narration-1';
export const MAX_REQUESTS = 100;
export const FPS = 30;
export const TEXT_MODEL = 'anthropic:claude@sonnet-4.6';
export const VIDEO_MODEL = 'pixverse:1@8';
export const VOICES = {
  'google:gemini@3.1-flash-tts': { label: 'Gemini 3.1 Flash TTS', voice: 'Charon', limit: 4000 },
  'fishaudio:s2.1@pro': { label: 'Fish Audio S2.1 Pro', voice: 'bf322df2096a46f18c579d0baa36f41d', limit: 3000 },
};
export function newUUID() {
  if(crypto.randomUUID)return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const h=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function object(text) {
  if (typeof text !== 'string' || text.length > 88000) throw new Error('The model response is too large.');
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value;
}
export function scriptText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 30000) throw new Error('Use a script between 1 and 30,000 characters.');
  return value.trim();
}
export function audioChunks(text, model) {
  const limit = VOICES[model]?.limit;
  if (!limit) throw new Error('Choose Gemini or Fish Audio.');
  let rest = scriptText(text), chunks = [];
  while (rest.length > limit) {
    const head = rest.slice(0, limit), matches = [...head.matchAll(/[।.!?]\s+|\n+/g)];
    let cut = matches.at(-1)?.index;
    if (cut !== undefined && cut > limit / 3) cut += matches.at(-1)[0].length;
    else cut = head.lastIndexOf(' ');
    if (cut < 1) throw new Error('Add punctuation or spaces to this long narration section.');
    chunks.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
export function mediaURL(value, type) {
  let u; try { u = new URL(value); } catch { throw new Error('Missing Runware media URL.'); }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hostname !== (type === 'audio' ? 'am.runware.ai' : 'vm.runware.ai') || !u.pathname.startsWith('/' + type + '/') || [...u.searchParams.keys()].some(k => /key|token|auth|secret/i.test(k))) throw new Error('Only Runware result URLs without credentials are accepted.');
  return u.href;
}
export function validWords(words, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1200) throw new Error('Narration must be between 0 and 1,200 seconds.');
  if (!Array.isArray(words) || !words.length || words.length > 6000) throw new Error('Analyze the narration first to obtain word timestamps.');
  let previous = -1;
  return words.map(w => {
    const text = String(w.text ?? w.raw ?? '').trim(), start = w.start, end = w.end;
    if (!text || text.length > 200 || !Number.isFinite(start) || !Number.isFinite(end) || start < previous || start < 0 || end < start || end > duration + .1) throw new Error('Narration timestamps are invalid or out of order.');
    previous = start; return { text, start, end: Math.min(duration, end) };
  });
}
export function validatePlan(input, duration) {
  const value = typeof input === 'string' ? object(input) : input;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1200 || !Array.isArray(value?.requests) || !value.requests.length || value.requests.length > MAX_REQUESTS) throw new Error('The plan must contain 1–100 video requests for the measured narration.');
  let cursor = 0, shotCount = 0;
  const requests = value.requests.map((r, index) => {
    if (!Array.isArray(r.shots) || !r.shots.length || r.shots.length > 6) throw new Error(`Request ${index + 1} needs 1–6 shots.`);
    const requestStart = cursor;
    const shots = r.shots.map(s => {
      if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || Math.abs(s.start - cursor) > .04 || s.end <= cursor || s.end > duration + .04) throw new Error('Shot timings must cover the narration in order without gaps, overlaps or extra scenes.');
      const start = cursor, end = Math.abs(s.end - duration) <= .04 ? duration : s.end;
      if (end - start < .3) throw new Error('A shot is too short. Combine it with a neighbouring shot.');
      for (const field of ['narration', 'visual']) if (typeof s[field] !== 'string' || !s[field].trim() || s[field].length > 1800) throw new Error(`Every shot needs ${field}.`);
      cursor = end; shotCount++;
      return { shot: shotCount, start, end, duration: +(end - start).toFixed(4), narration: s.narration.trim(), visual: s.visual.trim(), camera: String(s.camera || 'Slow motivated camera movement').slice(0, 400) };
    });
    const seconds = cursor - requestStart;
    if (seconds > 15.001 || seconds < .3) throw new Error('Each video request must cover at most 15 seconds. Split long requests at a spoken-word boundary.');
    const generationSeconds = Math.max(1, Math.ceil(seconds - .00001));
    const frames = Math.round(cursor * FPS) - Math.round(requestStart * FPS);
    return { index: index + 1, enabled: true, start: requestStart, end: cursor, duration: +seconds.toFixed(4), generationSeconds, frames, shots };
  });
  if (Math.abs(cursor - duration) > .04) throw new Error('The plan does not cover the full narration. No video requests have been submitted.');
  return { schema: VERSION, audioDuration: duration, fps: FPS, shotCount, requestCount: requests.length, disabledSlots: MAX_REQUESTS - requests.length,
    continuity: String(value.continuity || '').slice(0, 4000), requests };
}
export function videoPrompt(plan, index) {
  const r = plan.requests[index - 1]; if (!r) throw new Error('This generation slot is disabled.');
  const prompt = `Premium photorealistic cinematic documentary, 9:16, physically plausible action, consistent subjects and period details. No captions, readable text, logos, music or speech. A separate approved narration track is added during editing.\nContinuity: ${plan.continuity}\n` +
    r.shots.map(s => `Shot ${s.shot}, ${(s.start-r.start).toFixed(2)}–${(s.end-r.start).toFixed(2)}s: ${s.visual} Camera: ${s.camera}. Context only, do not speak: ${s.narration}`).join('\n') + '\nHard cuts only at the specified shot boundaries. Hold the last composition through the remaining generation time. Avoid morphing, anatomical errors and unrelated filler.';
  if (prompt.length > 5000) throw new Error(`Request ${index} exceeds PixVerse's prompt limit. Shorten its visual notes in the plan.`);
  return prompt;
}
export function newNarrationProject() {
  return { schema: VERSION, id: newUUID(), title: '', idea: '', targetSeconds: 156, script: '', revisions: [], feedback: '', approvedScript: '', audioModel: Object.keys(VOICES)[0], voice: 'Charon', concurrency: 3, mode: 'server', tasks: {}, ledger: {}, audio: null, plan: null, clips: {}, final: null, stage: 'idea', created: new Date().toISOString() };
}
export function invalidateNarration(p) { p.approvedScript = ''; p.audio = null; p.plan = null; p.clips = {}; p.final = null; }
export function approveScript(p) { p.approvedScript = scriptText(p.script); return p.approvedScript; }
export function scriptApproved(p) { return !!p.script && p.approvedScript === p.script; }
export function restoreNarrationProject(input) {
  if (input?.schema !== VERSION || !UUID.test(input.id)) throw new Error('Choose a narration-first project JSON. Open older projects in Classic Studio.');
  const p = newNarrationProject(); p.id = input.id;
  p.title = String(input.title || '').slice(0, 120); p.idea = String(input.idea || '').slice(0, 20000);
  p.script = input.script ? scriptText(input.script) : ''; p.approvedScript = input.approvedScript === p.script ? p.script : '';
  p.feedback = String(input.feedback || '').slice(0, 8000); p.targetSeconds = Math.max(30, Math.min(1200, Number(input.targetSeconds) || 156));
  p.revisions = (input.revisions || []).slice(-30).filter(r => typeof r.text === 'string').map(r => ({ text: r.text.slice(0, 30000), feedback: String(r.feedback || '').slice(0,8000), date: String(r.date || '') }));
  p.audioModel = VOICES[input.audioModel] ? input.audioModel : p.audioModel; p.voice = String(input.voice || VOICES[p.audioModel].voice).slice(0,100);
  p.concurrency = Math.max(1, Math.min(8, Number(input.concurrency) || 3)); p.mode = input.mode === 'chatgpt' ? 'chatgpt' : 'server';
  if (scriptApproved(p) && input.audio) {
    p.audio = { key: UUID.test(input.audio.key || '') ? input.audio.key : '', duration: Number(input.audio.duration) || 0, urls: (input.audio.urls || []).slice(0,30).map(u => mediaURL(u,'audio')), words: [], reviewed: input.audio.reviewed === true, source: String(input.audio.source || '') };
    if (input.audio.words?.length) p.audio.words = validWords(input.audio.words,p.audio.duration);
    if (input.plan) { p.plan = validatePlan(input.plan,p.audio.duration); p.plan.requests.forEach(r => videoPrompt(p.plan,r.index)); }
  }
  for (const [id, t] of Object.entries(input.tasks || {})) if (UUID.test(t?.id || '') && typeof t.fingerprint === 'string' && t.fingerprint.length === 64 && ['queued','submitted','processing','paused','uncertain','complete','error'].includes(t.status)) p.tasks[id] = { id:t.id, fingerprint:t.fingerprint, status:t.status, started:String(t.started||''), error:String(t.error||'').slice(0,600) };
  for (const [id, cost] of Object.entries(input.ledger || {})) if (UUID.test(id) && Number.isFinite(cost) && cost>=0) p.ledger[id] = cost;
  if(p.plan) for(const r of p.plan.requests) { const c=input.clips?.[r.index]; if(c?.url||UUID.test(c?.key||'')) p.clips[r.index] = {url:c.url?mediaURL(c.url,'video'):'',key:UUID.test(c.key||'')?c.key:'',taskUUID:UUID.test(c.taskUUID||'')?c.taskUUID:''}; }
  p.stage = ['idea','script','voice','plan','videos','export'].includes(input.stage) ? input.stage : 'idea';
  return p;
}
export function normalizationCommand(input, output, frames) {
  if(!Number.isInteger(frames)||frames<1)throw new Error('Invalid planned clip duration.');
  return ['-y','-i',input,'-map','0:v:0','-an','-vf',`scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},trim=end_frame=${frames},setpts=PTS-STARTPTS`,'-frames:v',String(frames),'-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p',output];
}

/* ---------- VISUAL DIRECTOR PIPELINE ----------
   Loaded after the main page script and uses its helpers (relay, state, pool, setStatus, runware, ...).

   FULL SCRIPT (split by scene in step 1)
   → 1. Casting: topic, setting and a character bible (one profile per recurring person)
   → 2. Visual plan: one structured scene per line (concept, subject, action, environment, emotion,
        shot, camera, composition), with shot variation and continuity driven by the narration
   → 3. Prompt engineering: Claude writes each prompt in its own words, in story order, seeing the video
        concept, the full script and the prompts already written; repeated prompts are rewritten
   → 4. Quality control after each image: Claude looks at the image; failures are regenerated
        with a corrected prompt.

   All steps use TEXT_MODEL (the admin's text model on Runware, with fallback); images use IMAGE_MODEL (GPT Image 2). */

const SHOTS = ['wide shot', 'medium shot', 'close-up', 'over-the-shoulder', 'top-down', 'side angle', 'low angle', 'environment shot', 'object close-up', 'screen + person', 'group shot', 'action shot'];
const DIRECTOR_VERSION = 13; // shown in the status line so you can tell the new code is running
const PLAN_CHUNK = 6;    // lines per visual-plan request (sequential, so continuity carries over; small enough for Vercel's 60 s limit)
const MAX_FAILS = 2;     // this many failed requests in a row with no success stops the run and shows the error

/* Counts failed Claude requests; a run that never gets an answer stops with the real error instead of
   silently filling every line from the template. */
function failTracker(){
  const t = { inRow: 0, ok: 0, last: '' };
  t.fail = e => { t.inRow++; t.last = cleanMsg(e && e.message) || 'no answer'; if (!t.ok && t.inRow >= MAX_FAILS) { const err = new Error(t.last); err.stop = true; throw err; } };
  t.success = () => { t.inRow = 0; t.ok++; };
  return t;
}

/* ---------- small helpers ---------- */
async function askClaude(content, { maxTokens = 4000, temperature = 0.4, images } = {}){
  const task = { taskType: 'textInference', taskUUID: uuid(), model: TEXT_MODEL, includeCost: true,
    messages: [{ role: 'user', content }], settings: { maxTokens, temperature } };
  if (images && images.length) task.inputs = { images };
  const json = await relay([task]);
  if (json.errors && json.errors.length){ const e = new Error(cleanMsg(json.errors[0].message) || 'Runware returned an error'); e.runware = true; throw e; }
  const t = (json.data || []).find(d => d.taskType === 'textInference');
  if (t && typeof t.cost === 'number') state.cost.prompts += t.cost;
  if (!t || !t.text) throw new Error('Claude returned an empty answer');
  return t.text;
}
function parseJSONLoose(text){
  const t = String(text || '').replace(/```json|```/g, '').trim();
  const a = t.indexOf('['), o = t.indexOf('{');
  const start = a >= 0 && (o < 0 || a < o) ? a : o;
  const end = start === a ? t.lastIndexOf(']') : t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude’s answer wasn’t in the expected format');
  return JSON.parse(t.slice(start, end + 1));
}
const videoTitle = () => ($('#videoTitle').value || '').trim();
const scriptText = () => $('#script').value.trim();
const creatorNotes = () => { const n = ($('#notes').value || '').trim(); return n ? `\nEXTRA DIRECTION FROM THE CREATOR (follow it; any people described here appear ONLY in lines that are about them, never in every image): ${n}\n` : ''; };
const contextSource = () => JSON.stringify([videoTitle(), scriptText(), $('#notes').value.trim()]);

/* The title establishes context, not a mandatory object in every photograph. */
const SEMANTIC_DIRECTION = `LINE MEANING BEFORE TOPIC DECORATION:
- Translate the actual narration beat into plain English. Resolve pronouns, references and implied causes from neighbouring lines. Identify the one new fact or action the viewer needs to understand.
- Select visible evidence for THAT fact: its cause, process, result, environment, life-cycle stage, resource, obstacle or human action. A topical portrait that does not explain the beat is a failure.
- The video's headline subject is NOT compulsory in every frame. Include it when the line describes its appearance, behaviour, interaction or a process involving it; otherwise show the relevant supporting subject. Do not omit it when the line genuinely needs it.
- Example, only for a butterfly script: wing colour -> the correct butterfly wings; caterpillar feeding -> the caterpillar and its host plant, not an adult; eggs -> correctly placed eggs; loss of habitat -> the damaged habitat; winter destination -> the named overwintering environment; migration -> the actual movement or route environment. Do not reuse this example in unrelated videos.
- Preserve species, geography, era, life stage, mechanisms and quantities specified by the script. Do not invent a specific species, location or historical scene to fill missing facts. If unknown, keep the uncertain detail general.
- Choose literal relevant subjects before metaphor. Vary the information shown, not just the camera angle. No compulsory people, workplaces, golden light or repeated mascot. The full script and explicit creator direction override stale concept notes.`;

async function ensureBible(){
  const prior = state.directorBible;
  if (!$('#bible').value.trim() || (prior && prior.text === $('#bible').value && prior.source !== contextSource())) await buildBible();
}

/* ---------- 1. Character & style bible ----------
   Stored as editable lines in #bible:  "setting: ..."  and  "employee_01: Indian man, 28, ..." */
function parseBible(){
  const out = { setting: '', topic: '', concept: '', audience: '', chars: {} };
  ($('#bible').value || '').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/); if (!m) return;
    const k = m[1].toLowerCase();
    if (k === 'setting') out.setting = m[2].trim();
    else if (k === 'topic') out.topic = m[2].trim();
    else if (k === 'concept') out.concept = m[2].trim();
    else if (k === 'audience') out.audience = m[2].trim();
    else out.chars[m[1]] = m[2].trim();
  });
  return out;
}
const bibleText = b => [b.topic && 'topic: ' + b.topic, b.concept && 'concept: ' + b.concept, b.audience && 'audience: ' + b.audience, b.setting && 'setting: ' + b.setting, ...Object.entries(b.chars).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n');

async function buildBible(){
  const txt = await askClaude(`You are the script analyst and casting director for a short video. Read the video title and the WHOLE script, then plan who and where the video shows.
${videoTitle() ? `\nVIDEO TITLE: "${videoTitle()}"\n` : ''}
SCRIPT (may be Hindi, Hinglish or English):
"""${scriptText()}"""
${creatorNotes()}

Return ONLY JSON:
{"topic": "the video's topic in one short English sentence",
 "concept": "2 to 3 sentences: what the video is really about, its message, and how the story moves from start to end (hook, problem, explanation, advice, ending)",
 "audience": "who the video is for",
 "setting": "script-grounded geography, era, ecosystem or real places; keep unspecified facts general",
 "characters": [{"character_id": "short_snake_case_id", "gender": "", "age": "", "appearance": "ethnicity, build, face, skin tone", "hair": "", "clothing": "specific garments with colours and fabric", "role": "their role in the story"}]}

Rules:
- 0 to 3 recurring characters. Cast someone ONLY if the script follows a specific person or clearly talks about the same person across several lines (a named person, "a student who...", a story). Scripts about facts, products, money, places, history, science, tips or processes usually need NO characters: return "characters": [] for them.
- Do not invent a "viewer", "user" or presenter character just to have a person in the video.
- Infer geography, era, habitat and species from the SCRIPT and creator notes. Do not default nature, science, global or historical videos to modern India. Hindi narration alone does not imply an Indian location. Keep unspecified facts general.
${SEMANTIC_DIRECTION}
- Ordinary believable people, not models or celebrities. No real, named public figures.
- Clothing must be specific and stay the same across the video.`, { maxTokens: 1500, temperature: 0.3 });
  const j = parseJSONLoose(txt);
  const chars = {};
  (j.characters || []).forEach(c => {
    if (!c || !c.character_id) return;
    chars[String(c.character_id).replace(/[^A-Za-z0-9_-]/g, '_')] =
      [c.appearance, c.gender, c.age && `about ${c.age} years old`, c.hair, c.clothing && `wearing ${c.clothing}`].filter(Boolean).join(', ') + (c.role ? ` (${c.role})` : '');
  });
  $('#bible').value = bibleText({ topic: j.topic || '', concept: j.concept || '', audience: j.audience || '', setting: j.setting || '', chars });
  state.directorBible = { source: contextSource(), text: $('#bible').value };
}

/* ---------- 2. Visual plan: structured scene per line ---------- */
function planPrompt(lines, offset, prev){
  const b = parseBible();
  return `You are the Visual Director of a video. The narration below is shown one photograph at a time. For every numbered line, plan ONE photorealistic scene as structured data.
${videoTitle() ? `\nVIDEO TITLE: "${videoTitle()}"` : ''}
TOPIC: ${b.topic || 'work it out from the script'}
${b.concept ? `VIDEO CONCEPT: ${b.concept}\n` : ''}SETTING: ${b.setting || 'infer from the script; keep unknown facts general'}
CHARACTER BIBLE (use these ids ONLY in lines where that person really appears; do not invent new looks for them):
${Object.entries(b.chars).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- none: this video has no recurring people'}

FULL SCRIPT (context only):
"""${scriptText()}"""
${creatorNotes()}${prev.length ? `\nPREVIOUS SCENES (preserve relevant continuity and add new visual information):\n${prev.map(p => `- line ${p.n}: ${p.narration_meaning || ''}; subject: ${p.main_subject}; ${p.shot}; ${p.visual_concept}; ${p.environment}`).join('\n')}\n` : ''}
LINES TO PLAN:
${lines.map((l, k) => `${offset + k + 1}. ${l}`).join('\n')}

HOW TO PLAN EACH LINE
${SEMANTIC_DIRECTION}
1. Understand the line in its place in the story (read the lines before it). Ask: is it directly visual? Does it add a new visual idea? Does it continue the previous scene?
2. One meaningful visual idea = one image. Show the idea as a REAL moment a photographer could capture:
   - literal lines: show exactly what the line names: the object, place, product, food, animal, vehicle, document or action. If the line is about a thing or a place, the thing or place is the subject, with NO person;
   - analytical or conceptual lines (numbers, problems, reasons, advice): show the most direct real thing that demonstrates it: an object, a place, a detail, or, only when the line is about what someone does or feels, a person. Never symbols (lightbulbs, gears, brains, arrows, floating icons, charts in the air).
3. PEOPLE ARE OPTIONAL. Set "people" to "none" unless the line is about a person: what someone does, says, feels or decides, or an interaction between people. Money, prices, products, places, buildings, nature, food, tools, documents, processes and statistics are usually shown WITHOUT people (close-ups of the object, the place, the result). Never add a person just to fill the frame or to "make it relatable". When people is "none", character_ids is [] and main_subject is the object or place.
4. Continuity: if the line continues the previous situation, keep the same place and time (and the same characters if they were in it), set "same_scene_as_previous": true, and change the shot or angle. Use character ids from the bible only in lines where that person appears; describe one-off extras inside main_subject.
5. Shot variation driven by the narration, chosen from: ${SHOTS.join(', ')}. Choose lenses appropriate to the subject, including macro for small biological details. Change the information shown when the narration changes. Preserve the same habitat or place when continuity requires it. Never force a workplace, city, person or new environment just for variety.
6. Screens, documents and signs are angled away or softly blurred. text_in_image is always false.

Return ONLY a JSON array with exactly ${lines.length} objects, in order, each shaped like:
{"line": ${offset + 1}, "narration_meaning": "this line's resolved meaning", "visual_evidence": "visible detail that explains the fact or action", "subject_reason": "why this focal subject explains THIS line", "topic_subject_required": false, "beat_role": "detail | process | cause | result | context | action | hook | ending", "factual_constraints": ["only facts established by the script"], "scene_type": "nature | science | workplace | education | business | product | lifestyle | ...", "visual_concept": "one sentence", "people": "none | one | two | group", "character_ids": [], "main_subject": "who or what, concrete", "action": "what is happening right now", "environment": "script-grounded real place with physical details", "time_of_day": "", "lighting": "real light source and direction", "emotion": "", "shot": "one of the shot types", "camera": "lens, distance and angle", "composition": "where the subject sits in the ${frameWords()}", "key_props": ["..."], "same_scene_as_previous": false, "text_in_image": false}`;
}

async function planScenes(onProgress){
  const items = state.items; let prev = [], planned = 0, failed = 0; const track = failTracker();
  for (let start = 0; start < items.length; start += PLAN_CHUNK){
    if (state.cancel) break;
    const lines = items.slice(start, start + PLAN_CHUNK).map(it => it.text);
    let scenes = null;
    for (let attempt = 0; attempt < 2 && !scenes; attempt++){
      try {
        const arr = parseJSONLoose(await askClaude(planPrompt(lines, start, prev), { maxTokens: Math.min(8000, 400 + lines.length * 550), temperature: 0.35 }));
        if (!Array.isArray(arr) || lines.some((_, k) => arr.filter(s => s && +s.line === start + k + 1).length !== 1)) throw new Error('The scene planner omitted or duplicated a line');
        scenes = arr; track.success();
      } catch (e){ if (e.auth) throw e; console.warn('Visual plan failed', e); track.fail(e); }
    }
    lines.forEach((_, k) => {
      const sc = scenes && scenes.find(s => +s.line === start + k + 1);
      if (sc && typeof sc === 'object'){
        sc.text_in_image = false;
        sc.people = /^(one|two|group)$/i.test(String(sc.people || '')) ? String(sc.people).toLowerCase() : 'none';
        if (sc.people === 'none') sc.character_ids = [];
        items[start + k].scene = sc; planned++;
      }
      else { items[start + k].scene = null; failed++; }
    });
    const prevStart = Math.max(0, start + lines.length - 6);
    prev = items.slice(prevStart, start + lines.length)
      .map((it, k) => it.scene ? { ...it.scene, n: prevStart + k + 1 } : null).filter(Boolean);
    onProgress(Math.min(start + PLAN_CHUNK, items.length));
    renderPrompts();
  }
  return { planned, failed, error: track.last };
}

/* ---------- 3. Prompt engineering: free-form, in story order ----------
   Claude writes every prompt in its own words (no fixed opening line). Lines are written IN ORDER, a few at a
   time, and each request carries the video concept, the full script, the planned scene and the prompts already
   written for the previous lines, so every image is checked against the whole video, not just its own line.
   The page only appends one short technical tail (PROMPT_TAIL) so no text or cartoon look sneaks in. */
const PROMPT_TAIL = 'Real photograph, no visible text, no logos, no watermark, no cartoon, no illustration, no CGI.';
const NO_PEOPLE = 'No people anywhere in the frame.';
const PROMPT_BATCH = 4;   // lines per prompt-writing request (sequential, so each batch sees the prompts before it)
const PREV_PROMPTS = 6;   // how many earlier prompts each request sees
const orientation = () => { const [w, h] = imgSize(); return w > h * 1.1 ? 'horizontal' : h > w * 1.1 ? 'vertical' : 'square'; };
const BANNED_OPENERS = /^(photorealistic|a photorealistic|cinematic|a cinematic|hyper-?realistic|ultra-?realistic|realistic|a realistic|a photo of|a photograph of|an image of|image of|photo of|scene of|a scene of|a shot of|shot of)\b[\s,:-]*/i;

function finishPrompt(text, scene, hasPerson){
  let p = String(text || '').replace(/\s+/g, ' ').trim().replace(/^["'“]+|["'”]+$/g, '');
  for (let k = 0; k < 3 && BANNED_OPENERS.test(p); k++) p = p.replace(BANNED_OPENERS, '');
  if (!p) return '';
  p = p.charAt(0).toUpperCase() + p.slice(1);
  p = p.replace(/[\s.,;]+$/, '') + '.';
  const noPeople = (scene && scene.people === 'none') || hasPerson === false;
  return `${p}${noPeople && !/no people/i.test(p) ? ' ' + NO_PEOPLE : ''} ${PROMPT_TAIL}`;
}
const isTemplatePrompt = p => /instantly connects with this voiceover line/.test(String(p || ''));
const promptBody = p => String(p || '').replace(PROMPT_TAIL, '').replace(NO_PEOPLE, '').trim();

function writerPrompt(batch, avoidLike, corrections){
  const b = parseBible(), items = state.items, all = items.map(it => it.text);
  const first = batch[0].i;
  const prev = items.slice(Math.max(0, first - PREV_PROMPTS), first).map((it, k) => ({ n: Math.max(0, first - PREV_PROMPTS) + k + 1, text: it.text, prompt: promptBody(it.prompt) })).filter(x => x.prompt);
  const usedChars = new Set(batch.flatMap(({ it }) => (it.scene && it.scene.people !== 'none' && it.scene.character_ids) || []));
  return `You are the Visual Director and prompt writer for one video. The narration is shown one photograph at a time. Write the image prompt for each numbered line below.

STEP 1: UNDERSTAND THE WHOLE VIDEO FIRST
${videoTitle() ? `VIDEO TITLE: "${videoTitle()}"\n` : ''}TOPIC: ${b.topic || 'work it out from the full script'}
${b.concept ? `VIDEO CONCEPT: ${b.concept}\n` : ''}${b.audience ? `AUDIENCE: ${b.audience}\n` : ''}SETTING: ${b.setting || 'infer from the script; do not invent geography'}
${usedChars.size ? `RECURRING PEOPLE IN THESE LINES (describe them with these exact words, and ONLY in the lines listed as showing them):\n${[...usedChars].map(id => `- ${id}: ${b.chars[id] || 'describe from the scene'}`).join('\n')}\n` : ''}${creatorNotes()}
FULL SCRIPT (read all of it; it may be Hindi, Hinglish or English):
"""${scriptText()}"""

STEP 2: KNOW WHAT CAME BEFORE
${prev.length ? `PROMPTS ALREADY WRITTEN FOR THE PREVIOUS LINES (the images the viewer has just seen):\n${prev.map(x => `- line ${x.n} "${x.text}": ${x.prompt.slice(0, 420)}`).join('\n')}` : 'This is the start of the video: the first image must hook the viewer and establish the topic.'}
${avoidLike ? `\nTHESE PROMPTS ARE TOO SIMILAR TO YOURS; WRITE CLEARLY DIFFERENT IMAGES:\n${avoidLike.map(x => '- ' + promptBody(x).slice(0, 260)).join('\n')}\n` : ''}
${corrections ? `RELEVANCE REVIEW: fix the meaning and subject selection, not just adjectives or angles:\n${JSON.stringify(corrections)}\n` : ''}
STEP 3: WRITE ONE PROMPT PER LINE
${batch.map(({ it, i }) => `${i + 1}. "${it.text}"
   previous line: "${all[i - 1] || 'start of video'}"
   next line: "${all[i + 1] || 'end of video'}"${it.scene ? `\n   planned scene: ${JSON.stringify(it.scene)}` : ''}`).join('\n')}

HOW TO WRITE EACH PROMPT
${SEMANTIC_DIRECTION}
1. Relevance: the image must show what THIS line means INSIDE this video. Ask: what is the video about, where are we in its story, what did the viewer just see, and what does this line add? A line like "yahi sabse badi galti hai" means nothing alone: use the lines before it to show WHICH mistake.
2. Continuity: if the line continues the previous situation, keep the same place, time and objects (and the same person only if that person was in it) but change the angle or moment. If the story moves on, move the image on. Never jump to an unrelated generic scene.
3. People are optional. Show a person ONLY when the line is about what someone does, says, feels or decides. Money, prices, products, places, food, nature, documents, tools, processes and statistics are shown as the thing itself. Never add a person just to fill the frame, and never give every line the same character.${usedChars.size ? '' : ' No recurring character is planned for these lines.'}
4. No symbols: no lightbulbs, gears, brains, arrows, floating icons or charts in the air. Show a real moment a photographer could capture.
5. Write each prompt in your own words, ${strength().words} words, as one flowing description. START WITH THE SUBJECT ITSELF. Never use a repeated generic opening or the title as the default subject.
6. Include the subject's defining details, visible evidence for the beat, action or state, script-grounded setting, physically plausible light, suitable lens (including macro when needed), and composition for the ${orientation()} frame. Apply the chosen visual style (${ $('#style').selectedOptions[0].textContent }) only where it fits the scene; it must not override factual meaning or require golden light, skin or greenery everywhere.
7. Screens, papers and signs are turned away or softly blurred, never readable. Do not write "no text" or style tags: the page adds them.

Return ONLY a JSON array of ${batch.length} objects, in order:
[{"line": ${first + 1}, "link": "one short sentence: how this image connects to the video's topic and to the previous image", "has_person": false, "prompt": "..."}]`;
}

async function reviewPrompts(batch, prompts){
  const all = state.items;
  const txt = await askClaude(`Act as a documentary editor reviewing image prompts, NOT their prose style.
TITLE: ${videoTitle()}
FULL SCRIPT: ${scriptText()}
${creatorNotes()}${SEMANTIC_DIRECTION}
Review each numbered beat with its neighbours and planned intent. Fail images that merely repeat the headline animal/person/product instead of showing the line's actual cause, evidence, process, result or context. A meaningful continuation of the SAME subject is allowed; do not impose arbitrary quotas or replace relevant subjects just for variety.
Verify facts, species, place, life stage, pronoun meaning and continuity. The image must be useful WHILE this beat is spoken, without captions. When uncertain, require a less specific depiction rather than inventing facts.
${JSON.stringify(batch.map(({ it, i }, k) => ({ line: i + 1, narration: it.text, previous_line: all[i - 1]?.text || '', next_line: all[i + 1]?.text || '', scene: it.scene || null, prompt: prompts[k] })))}
Return ONLY a JSON array, one object per supplied line:
[{"line": 1, "meaning_ok": true, "subject_ok": true, "facts_ok": true, "continuity_ok": true, "score": 9, "issue": "", "replacement_direction": ""}]`, { maxTokens: 300 + batch.length * 240, temperature: 0 });
  const arr = parseJSONLoose(txt);
  if (!Array.isArray(arr)) throw new Error('Relevance review returned an unexpected format');
  return batch.map(({ i }) => {
    const hits = arr.filter(x => x && +x.line === i + 1);
    if (hits.length !== 1) throw new Error('Relevance review omitted or duplicated a line');
    const r = hits[0];
    r.pass = r.meaning_ok === true && r.subject_ok === true && r.facts_ok === true && r.continuity_ok === true && Number(r.score) >= 7;
    return r;
  });
}

async function writeBatch(batch, avoidLike){
  let corrections;
  for (let attempt = 0; attempt < 2; attempt++){
    const arr = parseJSONLoose(await askClaude(writerPrompt(batch, avoidLike, corrections), { maxTokens: Math.min(8000, 600 + batch.length * 950), temperature: 0.45 }));
    if (!Array.isArray(arr)) throw new Error('Unexpected prompt format');
    const prompts = batch.map(({ it, i }) => {
      const hits = arr.filter(x => x && +x.line === i + 1);
      if (hits.length !== 1 || !hits[0].prompt) throw new Error('The prompt writer omitted or duplicated a line');
      return finishPrompt(hits[0].prompt, it.scene, hits[0].has_person);
    });
    const reviews = await reviewPrompts(batch, prompts);
    batch.forEach(({ it }, k) => { it.promptReview = reviews[k]; });
    if (reviews.every(r => r.pass)) return prompts;
    corrections = reviews.filter(r => !r.pass);
  }
  throw new Error('Some prompts still failed the narration relevance check. Adjust the scene or creator notes and retry.');
}

/* Word-overlap similarity of two prompts (0..1), ignoring the fixed tail. */
function similarity(a, b){
  const words = p => new Set(promptBody(p).toLowerCase().match(/[a-z]{4,}/g) || []);
  const A = words(a), B = words(b); if (!A.size || !B.size) return 0;
  let same = 0; A.forEach(w => { if (B.has(w)) same++; });
  return same / Math.min(A.size, B.size);
}
const opener = p => (promptBody(p).toLowerCase().match(/[a-z0-9'-]+/g) || []).slice(0, 3).join(' ');

/* Writes prompts for the given item indexes in story order, then rewrites any that repeat an earlier one. */
async function writeStrictPrompts(indexes, onProgress){
  const items = state.items;
  const list = [...indexes].sort((x, y) => x - y).map(i => ({ it: items[i], i }));
  // Batches are consecutive lines, written one after another so each batch sees the prompts before it.
  const batches = [];
  list.forEach(entry => {
    const last = batches[batches.length - 1];
    if (last && last.length < PROMPT_BATCH && last[last.length - 1].i === entry.i - 1) last.push(entry); else batches.push([entry]);
  });
  let done = 0, failed = 0; const track = failTracker();
  for (const batch of batches){
    if (state.cancel) break;
    let out = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++){
      try { out = await writeBatch(batch); track.success(); } catch (e){ if (e.auth) throw e; console.warn('Prompt batch failed', e); track.fail(e); }
    }
    batch.forEach(({ it }, k) => { if (out && out[k]) it.prompt = out[k]; else { it.prompt = ''; failed++; } });
    done += batch.length; onProgress(done, list.length); renderPrompts();
  }
  // Repetition pass: a prompt too close to one of the 6 before it, or opening with the same words, is rewritten once.
  const dupes = [];
  items.forEach((it, i) => {
    if (!it.prompt || !indexes.includes(i)) return;
    const near = items.slice(Math.max(0, i - 6), i).map(x => x.prompt).filter(Boolean);
    if (near.some(p => similarity(p, it.prompt) > 0.6 || opener(p) === opener(it.prompt))) dupes.push(i);
  });
  for (const i of dupes){
    if (state.cancel) break;
    const avoidLike = items.slice(Math.max(0, i - 6), i).map(x => x.prompt).filter(Boolean);
    try { const [p] = await writeBatch([{ it: items[i], i }], avoidLike); if (p) items[i].prompt = p; }
    catch (e){ if (e.auth) throw e; console.warn('Repetition rewrite failed', e); }
  }
  renderPrompts();
  return { failed, rewritten: dupes.length, error: track.last };
}

async function writeScenePrompts(onProgress){
  return writeStrictPrompts(state.items.map((_, i) => i), onProgress);
}

/* "Direct" writer: same writer, without the scene-planning step (the video concept is still read first). */
async function runDirect(){
  const items = state.items; if (!items.length) return;
  if (needCode('#s2')) return;
  const c0 = state.cost.prompts;
  $('#promptBtn').disabled = true; state.cancel = false;
  try {
    items.forEach(it => { it.scene = null; if (isTemplatePrompt(it.prompt)) it.prompt = ''; });
    setStatus('#s2', 'Reading the script and checking its visual context…');
    await ensureBible();
    const res = await writeStrictPrompts(items.map((_, i) => i), (d, n) => setStatus('#s2', `Writing prompts in story order… ${d} of ${n}`));
    renderPrompts();
    const cost = state.cost.prompts > c0 ? ` for ${money(state.cost.prompts - c0)}` : '';
    setStatus('#s2', res.failed ? `${items.length - res.failed} prompts written${cost}; ${res.failed} line(s) got no answer (${res.error}) and are empty. Press Write prompts again to retry them.` : `All ${items.length} prompts written by ${TEXT_MODEL}${cost}${res.rewritten ? `, ${res.rewritten} rewritten to be more different` : ''}.`, res.failed ? 'err' : 'ok');
  } catch (e){
    setStatus('#s2', e.auth ? e.message + ' Then press Write prompts again.' : (e.stop ? 'Claude didn’t answer, so no prompts were written. Runware / server said: ' : 'Prompt writing stopped: ') + cleanMsg(e.message), 'err');
  } finally { $('#promptBtn').disabled = false; updateCost(); updateButtons(); }
}

/* ---------- The whole pipeline, run by "Write prompts" when the writer is the Visual Director ---------- */
async function runDirector(){
  const items = state.items; if (!items.length) return;
  if (needCode('#s2')) return;
  const c0 = state.cost.prompts;
  $('#promptBtn').disabled = true; state.cancel = false;
  try {
    items.forEach(it => { if (isTemplatePrompt(it.prompt)) it.prompt = ''; });
    setStatus('#s2', `Visual Director v${DIRECTOR_VERSION} · Step 1 of 3 · Reading the script and checking its visual context…`);
    await ensureBible();
    setStatus('#s2', `Visual Director v${DIRECTOR_VERSION} · Step 2 of 3 · Planning scenes, shots and continuity… 0 of ${items.length}`);
    let plan;
    try { plan = await planScenes(n => setStatus('#s2', `Step 2 of 3 · Planning scenes, shots and continuity… ${n} of ${items.length}`)); }
    catch (e){
      if (!e.stop) throw e;
      // Planning got no answer at all: write the prompts from the script directly (that step stops with the error if Claude is really unreachable).
      items.forEach(it => { it.scene = null; });
      plan = { planned: 0, failed: items.length, error: cleanMsg(e.message) };
    }
    setStatus('#s2', `Step 3 of 3 · Writing prompts in story order… 0 of ${plan.planned}`);
    const res = await writeScenePrompts((d, n) => setStatus('#s2', `Step 3 of 3 · Writing prompts in story order… ${d} of ${n}`));
    renderPrompts();
    const cost = state.cost.prompts > c0 ? ` for ${money(state.cost.prompts - c0)}` : '';
    if (res.failed || plan.failed)
      setStatus('#s2', `Prompts ready${cost}. ${plan.failed ? `${plan.failed} line(s) couldn’t be planned (${plan.error}) and were written from the script directly. ` : ''}${res.failed ? `${res.failed} line(s) got no answer (${res.error}) and are empty; press Write prompts again to retry them.` : ''}`, 'err');
    else setStatus('#s2', `All ${items.length} scenes planned and prompts written by ${TEXT_MODEL}${cost}${res.rewritten ? ` (${res.rewritten} rewritten to be more different)` : ''}. Check the character bible and edit any prompt before generating.`, 'ok');
  } catch (e){
    setStatus('#s2', (e.auth ? e.message + ' Then press Write prompts again.' : (e.stop ? 'Claude didn’t answer, so no prompts were written. Runware / server said: ' : 'The Visual Director stopped: ') + cleanMsg(e.message)), 'err');
  } finally {
    $('#promptBtn').disabled = false; updateCost(); updateButtons();
  }
}

/* Scene chips shown under each line in step 2. */
function sceneSummary(sc){
  const bits = [sc.main_subject, sc.beat_role, sc.shot, sc.environment, ...(sc.character_ids || [])].filter(Boolean).map(b => `<span class="chip-s">${esc(String(b).slice(0, 60))}</span>`);
  return `<p class="scene-plan" title="${esc([sc.narration_meaning, sc.visual_evidence, sc.subject_reason, sc.visual_concept].filter(Boolean).join(' • '))}">${bits.join('')}</p>`;
}

/* ---------- 4. Quality control: Claude looks at each generated image ---------- */
const qc = { disabled: false };
const qcOn = () => $('#qcOn') && $('#qcOn').checked && !qc.disabled;

function shrinkForCheck(b64){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 640 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve('data:image/jpeg;base64,' + b64);
    img.src = 'data:image/jpeg;base64,' + b64;
  });
}

const noPeople = it => (it.scene && it.scene.people === 'none') || /No people anywhere in the frame/.test(it.prompt || '');

async function checkImage(it, b64){
  const sc = it.scene || {};
  const txt = await askClaude(`You are a strict photo editor checking one generated image for a video. Look at the attached image and compare it with what was intended.

VIDEO TITLE: ${videoTitle()}
VIDEO CONCEPT: ${parseBible().concept}
NARRATION: "${it.text}"
PREVIOUS LINE: ${state.items[state.items.indexOf(it) - 1]?.text || 'start'}
NEXT LINE: ${state.items[state.items.indexOf(it) + 1]?.text || 'end'}
RESOLVED MEANING: ${sc.narration_meaning || it.text}
REQUIRED VISUAL EVIDENCE: ${sc.visual_evidence || it.prompt}
FACTUAL CONSTRAINTS: ${JSON.stringify(sc.factual_constraints || [])}
PEOPLE EXPECTED: ${noPeople(it) ? 'NO - the image must not show any person, face, hand or body' : 'yes, as described'}
INTENDED SCENE: ${it.scene ? JSON.stringify({ visual_concept: sc.visual_concept, people: sc.people, main_subject: sc.main_subject, action: sc.action, environment: sc.environment, shot: sc.shot, composition: sc.composition }) : it.prompt.slice(0, 900)}

Check: is it a believable real photograph (not cartoon, illustration, anime, 3D or CGI, no plastic skin)? Correct subject, action and environment? Any readable or garbled text, captions, logos or watermarks? Any distorted face, hands, fingers or body? Correct composition? Consistent professional photo style?

Reject a picture of the general topic that fails to illustrate this particular narration beat. Check species and life stage when specified. Missing physical evidence is a relevance failure.
Return ONLY JSON: {"photorealistic": true, "cartoon_or_cgi": false, "unexpected_person": false, "meaning_ok": true, "facts_ok": true, "subject_ok": true, "action_ok": true, "environment_ok": true, "unwanted_text": false, "distortion": false, "composition_ok": true, "score": 0-10, "issues": ["short issue"], "fix": "one or two sentences to add to the prompt that would fix the issues"}`,
    { maxTokens: 500, temperature: 0, images: [await shrinkForCheck(b64)] });
  const r = parseJSONLoose(txt);
  const min = parseFloat($('#qcMin').value) || 7;
  if (!noPeople(it)) r.unexpected_person = false;
  r.pass = r.photorealistic === true && r.meaning_ok === true && r.facts_ok === true && r.subject_ok === true && r.action_ok === true && r.environment_ok === true && r.composition_ok === true && !r.cartoon_or_cgi && !r.unexpected_person && !r.unwanted_text && !r.distortion && (+r.score || 0) >= min;
  return r;
}

/* Called by generateOne() after each image. Returns the image to keep. */
async function qcAfterGenerate(i, first){
  const it = state.items[i];
  if (!qcOn() || !it) return first;
  let best = { ...first, score: -1 }, current = first;
  const tries = parseInt($('#qcRetries').value, 10) || 0;
  for (let attempt = 0; attempt <= tries; attempt++){
    let r;
    try { r = await checkImage(it, current.b64); }
    catch (e){
      if (e.auth) throw e;
      // The model or account can't check images: keep going without checks, and say so once.
      if (e.runware && !qc.disabled){ qc.disabled = true; setStatus('#s3', 'Image checking isn’t available on this Runware account (' + cleanMsg(e.message) + '). Images are generated without checks.', 'err'); }
      it.qc = null; return current;
    }
    it.qc = { score: +r.score || 0, pass: r.pass, issues: r.issues || [], redone: attempt };
    if ((r.pass && !best.qc?.pass) || (r.pass === !!best.qc?.pass && (+r.score || 0) > best.score)) best = { ...current, score: +r.score || 0, qc: it.qc };
    if (r.pass || attempt === tries || state.cancel) break;
    // Regenerate with a corrected prompt.
    it.status = 'loading'; it.err = `Check failed (${(r.issues || []).slice(0, 2).join('; ') || 'low score'}), regenerating…`; updateCell(i);
    const fix = [r.fix, r.cartoon_or_cgi || !r.photorealistic ? 'This must be an unedited real photograph of real people and places, with natural skin and real materials.' : '',
      r.unexpected_person ? 'Show no people at all: no person, face, hands or body anywhere in the frame; only the objects and the place.' : '',
      r.unwanted_text ? 'Remove every letter and word: screens, papers and signs are angled away or blurred.' : '',
      r.distortion ? 'Keep hands simple and relaxed with five natural fingers, and faces naturally proportioned.' : ''].filter(Boolean).join(' ');
    const next = await runware(`${it.prompt.replace(/\s+$/, '')} Corrections: ${fix}`.slice(0, 3800));
    if (next.cost !== null){ state.cost.images += next.cost; }
    current = next;
  }
  it.qc = best.qc || it.qc;
  return best.score >= 0 ? best : current;
}

function qcBadge(it){
  if (!it.qc || it.status !== 'done') return '';
  const cls = it.qc.pass ? 'qc-ok' : 'qc-warn';
  const tip = it.qc.issues && it.qc.issues.length ? it.qc.issues.join('; ') : 'Passed the photo check';
  return `<span class="qc ${cls}" title="${esc(tip)}">${it.qc.pass ? '✓' : '!'} ${it.qc.score}/10${it.qc.redone ? ` · redone ${it.qc.redone}×` : ''}</span>`;
}

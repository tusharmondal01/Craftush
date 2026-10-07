/* Cinematic camera transitions: native XMEML Cross Dissolve + Basic Motion.
   The preview reads exactly the sampled keys exported to Premiere. */
(function(root){
  'use strict';
  const preset = (id, name, family, zoom, x, y, turn, curve = 'ramp') =>
    Object.freeze({ id, name, family, zoom, x, y, turn, curve });
  const PRESETS = Object.freeze([
    preset('dissolve', 'Cinematic dissolve', 'soft', 0, 0, 0, 0, 'smooth'),
    preset('crash-zoom', 'Crash zoom', 'zoom', .62, 0, 0, 0),
    preset('snap-pull', 'Snap pull-back', 'zoom', -.48, 0, 0, 0, 'pull'),
    preset('whip-left', 'Whip left', 'whip', .18, -.32, 0, 0, 'whip'),
    preset('whip-right', 'Whip right', 'whip', .18, .32, 0, 0, 'whip'),
    preset('whip-up', 'Whip up', 'whip', .18, 0, -.30, 0, 'whip'),
    preset('whip-down', 'Whip down', 'whip', .18, 0, .30, 0, 'whip'),
    preset('diagonal-nw', 'Diagonal sweep up left', 'diagonal', .27, -.20, -.18, -4),
    preset('diagonal-ne', 'Diagonal sweep up right', 'diagonal', .27, .20, -.18, 4),
    preset('diagonal-sw', 'Diagonal sweep down left', 'diagonal', .27, -.20, .18, 4),
    preset('diagonal-se', 'Diagonal sweep down right', 'diagonal', .27, .20, .18, -4),
    preset('spin-clock', 'Spin zoom clockwise', 'spin', .42, 0, 0, 22),
    preset('spin-counter', 'Spin zoom counterclockwise', 'spin', .42, 0, 0, -22),
    preset('roll-clock', 'Camera roll clockwise', 'roll', .20, .06, 0, 32),
    preset('roll-counter', 'Camera roll counterclockwise', 'roll', .20, -.06, 0, -32),
    preset('bounce-left', 'Spring slide left', 'bounce', .16, -.22, 0, 0, 'spring'),
    preset('bounce-right', 'Spring slide right', 'bounce', .16, .22, 0, 0, 'spring'),
    preset('bounce-up', 'Spring lift', 'bounce', .16, 0, -.18, 0, 'spring'),
    preset('bounce-down', 'Spring drop', 'bounce', .16, 0, .18, 0, 'spring'),
    preset('impact-in', 'Impact punch', 'impact', .48, 0, 0, 2, 'punch'),
    preset('impact-out', 'Impact pull-back', 'impact', -.36, 0, 0, -3, 'punch'),
    preset('shake-zoom', 'Camera shake punch', 'shake', .30, .045, .018, 1.4, 'shake'),
    preset('orbit-clock', 'Orbit sweep clockwise', 'orbit', .30, .12, -.10, 12),
    preset('orbit-counter', 'Orbit sweep counterclockwise', 'orbit', .30, -.12, .10, -12),
    preset('match-push', 'Match push', 'match', .12, 0, 0, 0, 'smooth'),
    preset('match-pull', 'Match pull-back', 'match', -.09, 0, 0, 0, 'pull'),
    preset('soft-lift', 'Soft lift', 'soft', .04, 0, -.02, 0, 'smooth'),
    preset('soft-drift', 'Soft diagonal drift', 'soft', .04, .02, .015, 0, 'smooth')
  ]);
  const GENTLE_PRESETS = Object.freeze([
    preset('dissolve', 'Cross Dissolve', 'soft', 0, 0, 0, 0, 'smooth'),
    preset('zoom-in', 'Zoom through', 'zoom', .075, 0, 0, 0, 'smooth'),
    preset('zoom-out', 'Pull back', 'zoom', -.065, 0, 0, 0, 'smooth'),
    preset('left', 'Glide left', 'glide', 0, -.025, 0, 0, 'smooth'),
    preset('right', 'Glide right', 'glide', 0, .025, 0, 0, 'smooth'),
    preset('up', 'Glide up', 'glide', 0, 0, -.025, 0, 'smooth'),
    preset('down', 'Glide down', 'glide', 0, 0, .025, 0, 'smooth'),
    preset('up-left', 'Diagonal up left', 'diagonal', .035, -.018, -.018, 0, 'smooth'),
    preset('down-right', 'Diagonal down right', 'diagonal', .035, .018, .018, 0, 'smooth'),
    preset('clockwise', 'Clockwise settle', 'orbit', .03, 0, 0, 1.5, 'smooth'),
    preset('counterclockwise', 'Counterclockwise settle', 'orbit', .03, 0, 0, -1.5, 'smooth'),
    preset('lift', 'Lift and pull back', 'glide', -.04, 0, -.018, 0, 'smooth')
  ]);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smooth = t => t * t * (3 - 2 * t);
  const escapeXML = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
  function random(seed){
    let n = 2166136261;
    for (const c of String(seed)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
    return () => { n += 0x6D2B79F5; let t = Math.imul(n ^ n >>> 15, n | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function sceneContext(before, after){
    const sc = after?.scene || {}, prev = before?.scene || {};
    const description = [sc.beat_role, sc.emotion, after?.text].join(' ').toLowerCase();
    const continuity = sc.same_scene_as_previous === true || sc.same_scene_as_previous === 1 || /^(true|yes)$/i.test(String(sc.same_scene_as_previous));
    const quiet = /\b(ending|reflective|sad|grief|sensitive|somber|solemn|calm)\b/.test(description);
    const action = !quiet && /\b(hook|action|result|shocked|excited|dramatic)\b/.test(description);
    const close = /macro|close[- ]?up/.test([sc.shot, prev.shot].join(' '));
    return { continuity, quiet, action, close, role: sc.beat_role || 'detail' };
  }
  function planner(timeline, items, fps, seed, options = {}){
    const mode = options.mode || 'auto', energy = options.energy === 'balanced' ? .78 : 1;
    const rng = random(seed + '|' + JSON.stringify([timeline, items.map(it => [it.text, it.scene]), mode, energy]));
    const used = new Set(); let history = [], energeticRun = 0;
    const pool = mode === 'gentle' || mode === 'reference' ? GENTLE_PRESETS : PRESETS;
    return timeline.slice(0, -1).map((c, k) => {
      const next = timeline[k + 1], shorter = Math.min(c.end - c.start, next.end - next.start);
      const context = sceneContext(items[c.i], items[next.i]);
      const rest = energeticRun >= 3 && !context.action;
      let allowed = pool.filter(p => !context.quiet && !rest || /^(soft|match|zoom)$/.test(p.family));
      if (context.continuity) allowed = allowed.filter(p => /^(soft|match|zoom|orbit|glide)$/.test(p.family));
      if (context.quiet) allowed = allowed.filter(p => /^(soft|match)$/.test(p.family));
      if (mode === 'reference') allowed = [GENTLE_PRESETS[0]];
      // Reset only the eligible bag when scene constraints exhaust its unused presets.
      let candidates = allowed.filter(p => !used.has(p.id) && !history.slice(-2).some(h => h.id === p.id));
      if (!candidates.length){ allowed.forEach(p => used.delete(p.id)); candidates = allowed.filter(p => p.id !== history.at(-1)?.id); }
      if (!candidates.length) candidates = allowed;
      const weights = candidates.map(p => {
        let w = /^(soft|match)$/.test(p.family) ? .6 : 1;
        if (context.action && /^(zoom|whip|impact|shake|spin)$/.test(p.family)) w *= 2.3;
        if (context.close && /^(spin|roll|shake)$/.test(p.family)) w *= .35;
        if (p.family === history.at(-1)?.family) w *= .035;
        return w;
      });
      let draw = rng() * weights.reduce((a, b) => a + b, 0), pick = candidates.at(-1);
      for (let j = 0; j < candidates.length; j++){ draw -= weights[j]; if (draw <= 0){ pick = candidates[j]; break; } }
      const calm = /^(soft|match)$/.test(pick.family);
      let seconds = mode === 'reference' ? (rng() < .5 ? 14 : 16) * 1001 / 24000 :
        mode === 'gentle' ? .48 + rng() * .25 : context.quiet || calm ? .52 + rng() * .30 :
        context.action ? .26 + rng() * .18 : .32 + rng() * .30;
      if (mode === 'auto' && !calm) seconds *= energy === 1 ? 1 : 1.12;
      const cap = 2 * Math.floor(shorter * .30 / 2);
      const frames = Math.min(cap, Math.max(4, 2 * Math.round(seconds * fps / 2)));
      if (frames < 4) return null;
      const strength = mode === 'auto' ? energy * (context.close ? .68 : 1) * (context.continuity ? .78 : 1) * (context.action ? 1.12 : 1) : 1;
      used.add(pick.id); history.push(pick); history = history.slice(-2);
      energeticRun = calm ? 0 : energeticRun + 1;
      const half = frames / 2, cut = c.end;
      return { preset: pick, strength, context, frames, seconds: frames / fps, cut, start: cut - half, end: cut + half };
    });
  }
  function transitionXML(t, rate, fps){
    if (!t) return '';
    return `<transitionitem>
      <start>${t.start}</start><end>${t.end}</end><alignment>center</alignment>
      <cutPointTicks>${Math.round((t.frames / 2) / fps * 254016000000)}</cutPointTicks>${rate}
      <effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid>
        <effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype>
        <wipecode>0</wipecode><wipeaccuracy>100</wipeaccuracy><startratio>0</startratio><endratio>1</endratio><reverse>FALSE</reverse>
      </effect></transitionitem>`;
  }
  function envelope(t, curve){
    t = clamp(t, 0, 1);
    if (curve === 'smooth') return smooth(t);
    if (curve === 'whip') return Math.pow(t, 2.1);
    if (curve === 'spring') return Math.pow(t, 1.7) + .20 * Math.sin(t * Math.PI * 3) * Math.sin(t * Math.PI);
    if (curve === 'punch') return Math.pow(t, 1.45);
    if (curve === 'pull') return Math.pow(t, 1.3);
    return Math.pow(t, 2);
  }
  function motionSamples({ len, incoming, outgoing, base, zoom, direction, fill, sw, sh, iw, ih }){
    const pre = incoming ? incoming.frames / 2 : 0, post = outgoing ? outgoing.frames / 2 : 0;
    const media = len + pre + post, inWindow = pre * 2, outStart = media - post * 2;
    const at = frame => {
      const body = clamp((frame - pre) / Math.max(1, len), 0, 1);
      let scale = base * (1 + (direction > 0 ? zoom * body : direction < 0 ? zoom * (1 - body) : 0));
      let x = 0, y = 0, turn = 0;
      for (const [transition, incomingSide] of [[incoming, true], [outgoing, false]]){
        if (!transition) continue;
        const p = transition.preset, strength = transition.strength ?? 1;
        const phase = incomingSide ? 1 - clamp(frame / inWindow, 0, 1) : clamp((frame - outStart) / (post * 2), 0, 1);
        const amount = envelope(phase, p.curve), sign = incomingSide ? -1 : 1;
        let shift = amount;
        if (p.curve === 'shake') shift = phase * phase * Math.cos((1 - phase) * Math.PI * 8);
        x += sign * p.x * shift * strength;
        y += sign * p.y * shift * strength;
        turn += sign * p.turn * shift * strength;
        // Pull-backs peak around the cut and settle without keeping the whole image cropped.
        const z = p.zoom < 0 && !incomingSide ? Math.sin(Math.PI * phase) ** 2 : Math.abs(amount);
        scale *= 1 + Math.abs(p.zoom) * z * strength;
      }
      if (fill){
        // Inverse-transform the viewport corners. Overscan is local to the transition.
        const a = turn * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const dx = x * sw, dy = y * sh;
        const requiredW = sw * Math.abs(c) + sh * Math.abs(s) + 2 * Math.abs(dx * c + dy * s);
        const requiredH = sw * Math.abs(s) + sh * Math.abs(c) + 2 * Math.abs(-dx * s + dy * c);
        const needsMotion = Math.abs(x) + Math.abs(y) + Math.abs(turn) > 1e-10;
        scale = Math.max(scale, Math.max(requiredW / iw, requiredH / ih) * 100 * (needsMotion ? 1.008 : 1));
      }
      return { frame, scale, x, y, turn };
    };
    const times = new Set([0, pre, media - post, media]);
    if (inWindow) for (let t = 0; t <= inWindow; t++) times.add(t);
    if (post) for (let t = outStart; t <= media; t++) times.add(t);
    const samples = [...times].sort((a, b) => a - b).map(at);
    if (fill){
      // Linear interpolation of a rotated rectangle can expose a corner between two keys.
      // Guard those intervals too; raising both scales keeps XML and preview identical.
      for (let j = 1; j < samples.length; j++){
        const a = samples[j - 1], b = samples[j]; let guard = 1;
        for (let k = 1; k < 16; k++){
          const t = k / 16, turn = a.turn + (b.turn - a.turn) * t;
          const angle = turn * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
          const dx = (a.x + (b.x - a.x) * t) * sw, dy = (a.y + (b.y - a.y) * t) * sh;
          const w = sw * Math.abs(c) + sh * Math.abs(s) + 2 * Math.abs(dx * c + dy * s);
          const h = sw * Math.abs(s) + sh * Math.abs(c) + 2 * Math.abs(-dx * s + dy * c);
          guard = Math.max(guard, Math.max(w / iw, h / ih) * 100 / (a.scale + (b.scale - a.scale) * t));
        }
        if (guard > 1){ a.scale *= guard * 1.002; b.scale *= guard * 1.002; }
      }
    }
    return { media, pre, post, samples };
  }
  function sampleAt(motion, frame){
    const samples = motion.samples;
    frame = clamp(frame, 0, motion.media);
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1){ const mid = (lo + hi) >>> 1; if (samples[mid].frame <= frame) lo = mid; else hi = mid; }
    const a = samples[lo], b = samples[hi], t = b.frame === a.frame ? 0 : (frame - a.frame) / (b.frame - a.frame);
    const result = { frame };
    for (const field of ['scale', 'x', 'y', 'turn']) result[field] = a[field] + (b[field] - a[field]) * t;
    return result;
  }
  function motionXML(motion, enabled){
    if (!enabled) return '';
    const num = x => Number(x).toFixed(6);
    const scalar = (id, name, field, min, max) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name><valuemin>${min}</valuemin><valuemax>${max}</valuemax><value>${num(motion.samples[0][field])}</value>${motion.samples.map(p => `<keyframe><when>${p.frame}</when><value>${num(p[field])}</value><interpolation>linear</interpolation></keyframe>`).join('')}</parameter>`;
    const center = p => `<value><horiz>${num(p.x)}</horiz><vert>${num(p.y)}</vert></value>`;
    return `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
      ${scalar('scale', 'Scale', 'scale', 0, 1000)}
      <parameter authoringApp="PremierePro"><parameterid>center</parameterid><name>Center</name>${center(motion.samples[0])}${motion.samples.map(p => `<keyframe><when>${p.frame}</when>${center(p)}<interpolation>linear</interpolation></keyframe>`).join('')}</parameter>
      ${scalar('rotation', 'Rotation', 'turn', -360, 360)}
    </effect></filter>`;
  }
  root.CraftushTransitions = Object.freeze({ PRESETS, GENTLE_PRESETS, planner, sceneContext, motionSamples, sampleAt, motionXML, transitionXML, escapeXML });
})(globalThis);

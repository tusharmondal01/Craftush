/* Native XMEML Cross Dissolve + Basic Motion. No external plug-in or AI service.
   Reference: Adjustment Layer(1).xml (centered 14/16-frame dissolves at 23.976 fps).
   Smooth tween curves are sampled into ordinary keyframes for interchange portability. */
(function(root){
  'use strict';
  const PRESETS = [
    { id: 'dissolve', name: 'Cross Dissolve', zoom: 0, x: 0, y: 0, turn: 0 },
    { id: 'zoom-in', name: 'Zoom through', zoom: .075, x: 0, y: 0, turn: 0 },
    { id: 'zoom-out', name: 'Pull back', zoom: -.065, x: 0, y: 0, turn: 0 },
    { id: 'left', name: 'Glide left', zoom: 0, x: -.025, y: 0, turn: 0 },
    { id: 'right', name: 'Glide right', zoom: 0, x: .025, y: 0, turn: 0 },
    { id: 'up', name: 'Glide up', zoom: 0, x: 0, y: -.025, turn: 0 },
    { id: 'down', name: 'Glide down', zoom: 0, x: 0, y: .025, turn: 0 },
    { id: 'up-left', name: 'Diagonal up left', zoom: .035, x: -.018, y: -.018, turn: 0 },
    { id: 'down-right', name: 'Diagonal down right', zoom: .035, x: .018, y: .018, turn: 0 },
    { id: 'clockwise', name: 'Clockwise settle', zoom: .03, x: 0, y: 0, turn: 1.5 },
    { id: 'counterclockwise', name: 'Counterclockwise settle', zoom: .03, x: 0, y: 0, turn: -1.5 },
    { id: 'lift', name: 'Lift and pull back', zoom: -.04, x: 0, y: -.018, turn: 0 }
  ];
  const escapeXML = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
  const smooth = t => t * t * (3 - 2 * t);
  function random(seed){
    let n = 2166136261;
    for (const c of String(seed)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
    return () => { n += 0x6D2B79F5; let t = Math.imul(n ^ n >>> 15, n | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function planner(timeline, items, fps, seed){
    const rng = random(seed + '|' + JSON.stringify(timeline));
    let bag = [], last = '';
    const pick = () => {
      if (!bag.length){
        bag = PRESETS.slice();
        for (let i = bag.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
        if (bag[bag.length - 1].id === last) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
      const p = bag.pop(); last = p.id; return p;
    };
    return timeline.slice(0, -1).map((c, k) => {
      const next = timeline[k + 1], shorter = Math.min(c.end - c.start, next.end - next.start);
      const role = items[next.i]?.scene?.beat_role || '';
      const referenceSeconds = (rng() < .5 ? 14 : 16) * 1001 / 24000;
      const pace = /action|hook/.test(role) ? .78 : /context|ending/.test(role) ? 1.16 : 1;
      const targetSeconds = Math.max(.4, Math.min(.85, referenceSeconds * pace * (.88 + rng() * .24)));
      // Even frame counts put the dissolve midpoint precisely on the existing narration cut.
      const cap = 2 * Math.floor(shorter * .3 / 2);
      const frames = Math.min(cap, Math.max(4, 2 * Math.round(targetSeconds * fps / 2)));
      if (frames < 4) return null; // Very short beats get a cut rather than consuming the image.
      const preset = pick(), half = frames / 2, cut = c.end;
      return { preset, frames, seconds: frames / fps, cut, start: cut - half, end: cut + half };
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
  function motionSamples({ len, incoming, outgoing, base, zoom, direction, fill, sw, sh, iw, ih }){
    const pre = incoming ? incoming.frames / 2 : 0, post = outgoing ? outgoing.frames / 2 : 0;
    const media = len + pre + post;
    // Motion tween windows cover the entire blend. Their timing includes still-image handles.
    const inWindow = pre * 2, outStart = media - post * 2;
    const inP = incoming?.preset, outP = outgoing?.preset;
    const active = p => p && p.id !== 'dissolve';
    let safety = 1;
    if (fill && (active(inP) || active(outP))){
      // Cover translation and rotation for portrait, square and landscape frames.
      let maxX = 0, maxY = 0, angle = 0;
      for (const p of [inP, outP]) if (p){ maxX = Math.max(maxX, Math.abs(p.x)); maxY = Math.max(maxY, Math.abs(p.y)); angle = Math.max(angle, Math.abs(p.turn) * Math.PI / 180); }
      const requiredW = (sw * Math.cos(angle) + sh * Math.sin(angle) + 2 * maxX * sw) / (iw * base / 100);
      const requiredH = (sh * Math.cos(angle) + sw * Math.sin(angle) + 2 * maxY * sh) / (ih * base / 100);
      safety = Math.max(1, requiredW, requiredH) + .01;
    }
    const at = frame => {
      const body = Math.max(0, Math.min(1, (frame - pre) / Math.max(1, len)));
      let scale = base * safety * (1 + (direction > 0 ? zoom * body : direction < 0 ? zoom * (1 - body) : 0));
      let x = 0, y = 0, turn = 0;
      const a = inWindow ? 1 - smooth(Math.max(0, Math.min(1, frame / inWindow))) : 0;
      const b = post ? smooth(Math.max(0, Math.min(1, (frame - outStart) / (post * 2)))) : 0;
      if (inP){ scale *= 1 + Math.abs(inP.zoom) * a; x -= inP.x * a; y -= inP.y * a; turn -= inP.turn * a; }
      if (outP){ scale *= 1 + Math.abs(outP.zoom) * b; x += outP.x * b; y += outP.y * b; turn += outP.turn * b; }
      // For pull-back the outgoing picture begins enlarged and settles towards the cut.
      if (inP?.zoom < 0){ scale /= 1 + Math.abs(inP.zoom) * a; scale *= 1 + Math.abs(inP.zoom) * (1 - a); }
      if (outP?.zoom < 0){ scale /= 1 + Math.abs(outP.zoom) * b; scale *= 1 + Math.abs(outP.zoom) * (1 - b); }
      return { frame, scale, x, y, turn };
    };
    const times = new Set([0, media]);
    if (inWindow) for (let t = 0; t <= inWindow; t++) times.add(t);
    if (post) for (let t = outStart; t <= media; t++) times.add(t);
    return { media, pre, post, samples: [...times].sort((a, b) => a - b).map(at) };
  }
  function motionXML(motion, enabled){
    if (!enabled) return '';
    const num = x => Number(x).toFixed(6);
    const scalar = (id, name, field, min, max) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name><valuemin>${min}</valuemin><valuemax>${max}</valuemax><value>${num(motion.samples[0][field])}</value>${motion.samples.map(p => `<keyframe><when>${p.frame}</when><value>${num(p[field])}</value></keyframe>`).join('')}</parameter>`;
    const center = p => `<value><horiz>${num(p.x)}</horiz><vert>${num(p.y)}</vert></value>`;
    return `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
      ${scalar('scale', 'Scale', 'scale', 0, 1000)}
      <parameter authoringApp="PremierePro"><parameterid>center</parameterid><name>Center</name>${center(motion.samples[0])}${motion.samples.map(p => `<keyframe><when>${p.frame}</when>${center(p)}</keyframe>`).join('')}</parameter>
      ${scalar('rotation', 'Rotation', 'turn', -360, 360)}
    </effect></filter>`;
  }
  root.CraftushTransitions = Object.freeze({ PRESETS, planner, motionSamples, motionXML, transitionXML, escapeXML });
})(globalThis);

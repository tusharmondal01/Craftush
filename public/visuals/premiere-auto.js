/* Page adapter for automatic native Premiere XML transitions. */
function getAutoTransitions(){
  const plan = CraftushTransitions.planner(state.timeline, state.items, rateInfo().fps, state.transitionSeed);
  if ($('#trans').value === 'reference') plan.forEach(t => { if (t) t.preset = CraftushTransitions.PRESETS[0]; });
  state.transitionPlan = plan;
  return plan;
}

function buildAutoXML(){
  const r = rateInfo(), rate = `<rate><timebase>${r.tb}</timebase><ntsc>${r.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const [sw, sh] = seqSize(), [iw, ih] = imgSize();
  const tl = state.timeline, blends = getAutoTransitions();
  const total = tl[tl.length - 1].end, folder = $('#folder').value;
  const fill = $('#fill').checked, base = fill ? Math.max(sw / iw, sh / ih) * 100 : 100;
  const zoom = parseFloat($('#zoomAmt').value) || 0, setting = $('#motion').value;
  const clips = tl.map((c, k) => {
    const incoming = blends[k - 1] || null, outgoing = blends[k] || null;
    const id = k + 1, name = fname(c.i), len = c.end - c.start;
    const direction = setting === 'in' ? 1 : setting === 'out' ? -1 : setting === 'alt' ? (k % 2 ? -1 : 1) : 0;
    const motion = CraftushTransitions.motionSamples({ len, incoming, outgoing, base, zoom, direction, fill, sw, sh, iw, ih });
    const animated = fill || direction !== 0 || [incoming, outgoing].some(t => t && t.preset.id !== 'dissolve');
    const filter = CraftushTransitions.motionXML(motion, animated);
    // -1 is the interchange-format sentinel for a clip edge controlled by an adjacent transition.
    // Include both still-image handles in in/out; the nominal narration cuts remain unchanged.
    return `<clipitem id="clipitem-${id}">
      <masterclipid>masterclip-${id}</masterclipid><name>${xesc(name)}</name><enabled>TRUE</enabled>
      <duration>${motion.media}</duration>${rate}
      <start>${incoming ? -1 : c.start}</start><end>${outgoing ? -1 : c.end}</end>
      <in>0</in><out>${motion.media}</out><alphatype>none</alphatype>
      <file id="file-${id}"><name>${xesc(name)}</name><pathurl>${xesc(pathUrl(folder, name))}</pathurl>${rate}
        <duration>${motion.media}</duration><media><video><samplecharacteristics>${rate}
          <width>${iw}</width><height>${ih}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>
        </samplecharacteristics></video></media>
      </file>${filter}
      <comments><clipcommenta>${xesc(incoming ? 'Incoming: ' + incoming.preset.name + ' (' + incoming.seconds.toFixed(2) + ' s)' : 'First image')}</clipcommenta>
      <clipcommentb>${xesc(outgoing ? 'Outgoing: ' + outgoing.preset.name + ' (' + outgoing.seconds.toFixed(2) + ' s)' : 'Last image')}</clipcommentb></comments>
    </clipitem>${outgoing ? '\n' + CraftushTransitions.transitionXML(outgoing, rate, r.fps) : ''}`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4"><sequence id="sequence-1"><uuid>${uuid()}</uuid>
  <name>${xesc($('#seqName').value.trim() || 'Script images')}</name><duration>${total}</duration>${rate}
  <timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
  <media><video><format><samplecharacteristics>${rate}<width>${sw}</width><height>${sh}</height>
    <anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance>
  </samplecharacteristics></format><track>${clips}<enabled>TRUE</enabled><locked>FALSE</locked></track></video></media>
</sequence></xmeml>`;
}

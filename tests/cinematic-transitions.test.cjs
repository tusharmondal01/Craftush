const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const base = path.join(__dirname, '../public/visuals');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(base, 'transitions.js'), 'utf8'), ctx);
const fx = ctx.CraftushTransitions;
const items = n => Array.from({length:n}, (_,i) => ({text:`Narration ${i}.`, scene:{beat_role: i%4 ? 'detail' : 'action'}}));
const timeline = n => Array.from({length:n}, (_,i) => ({i, start:i*120, end:(i+1)*120}));

test('28 immutable styles create varied, deterministic mixes with no adjacent preset repeat', () => {
  assert.equal(fx.PRESETS.length, 28);
  assert.equal(new Set(fx.PRESETS.map(p=>p.id)).size, 28);
  assert(Object.isFrozen(fx.PRESETS));
  for(let seed=0;seed<80;seed++){
    const plan=fx.planner(timeline(70), items(70), 30, seed);
    assert.equal(JSON.stringify(plan), JSON.stringify(fx.planner(timeline(70), items(70), 30, seed)));
    assert(new Set(plan.map(t=>t.preset.id)).size>=18);
    for(let k=1;k<plan.length;k++) assert.notEqual(plan[k].preset.id, plan[k-1].preset.id);
  }
  assert.notEqual(JSON.stringify(fx.planner(timeline(20),items(20),30,1)),JSON.stringify(fx.planner(timeline(20),items(20),30,2)));
});

test('scene continuity and quiet endings constrain the random choices; street words do not', () => {
  const scenes=items(20);
  scenes.forEach(it=>it.scene={beat_role:'process',same_scene_as_previous:true});
  for(const t of fx.planner(timeline(20),scenes,30,52)) assert.match(t.preset.family,/^(soft|match|zoom|orbit)$/);
  scenes.forEach(it=>it.scene={beat_role:'ending',emotion:'reflective'});
  for(const t of fx.planner(timeline(20),scenes,30,53)) assert.match(t.preset.family,/^(soft|match)$/);
  assert.equal(fx.sceneContext(null,{text:'Sadak par traffic hai.',scene:{beat_role:'context'}}).quiet,false);
  assert.equal(fx.sceneContext(null,{scene:{same_scene_as_previous:'false'}}).continuity,false);
  assert.equal(fx.sceneContext(null,{scene:{same_scene_as_previous:'true'}}).continuity,true);
});

test('all frame rates preserve centered cuts, short beats and at least 70% of each nominal image', () => {
  for(const fps of [24000/1001,24,25,30000/1001,30,50,60000/1001,60]){
    for(const mode of ['auto','gentle','reference']){
      const tl=timeline(30), sceneItems=items(30);
      for(const t of fx.planner(tl,sceneItems,fps,2026,{mode})){
        assert.equal(t.frames%2,0); assert.equal(t.start+t.end,t.cut*2);
        assert(t.frames>=4 && t.frames<=36);
        assert.equal(t.seconds,t.frames/fps);
      }
    }
    const tiny=[{i:0,start:0,end:1},{i:1,start:1,end:5},{i:2,start:5,end:10}];
    assert(fx.planner(tiny,items(3),fps,3).every(t=>t===null));
  }
  assert.equal(fx.planner(timeline(1),items(1),30,1).length,0);
  assert.equal(fx.planner([],[],30,1).length,0);
});

test('the XML reference is only Cross Dissolve; the original gentle pack remains selectable', () => {
  const plan=fx.planner(timeline(30),items(30),24000/1001,2026,{mode:'reference'});
  for(const t of plan){ assert.equal(t.preset.id,'dissolve'); assert([14,16].includes(t.frames)); }
  const gentle=fx.planner(timeline(30),items(30),30,2026,{mode:'gentle'});
  assert(gentle.every(t=>fx.GENTLE_PRESETS.some(p=>p.id===t.preset.id)));
  const xml=fx.transitionXML(plan[0],'<rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate>',24000/1001);
  assert.match(xml,/<effectid>Cross Dissolve<\/effectid>/);
  assert.match(xml,/<alignment>center<\/alignment>/);
});

test('high energy is visibly stronger than balanced on the same scene and preset', () => {
  const high=fx.planner(timeline(60),items(60),30,20,{energy:'high'});
  const balanced=fx.planner(timeline(60),items(60),30,20,{energy:'balanced'});
  assert(high.every(t=>t.strength>0));
  assert(balanced.every(t=>t.strength<=1.12*.78+.00001));
  assert(high.some(t=>t.strength===1.12));
});

function covers(point,sw,sh,iw,ih){
  const a=point.turn*Math.PI/180,c=Math.cos(a),s=Math.sin(a),scale=point.scale/100;
  for(const x of [-sw/2,sw/2]) for(const y of [-sh/2,sh/2]){
    const dx=x-point.x*sw,dy=y-point.y*sh;
    assert(Math.abs((dx*c+dy*s)/scale)<=iw/2+.0001,`uncovered width: ${JSON.stringify(point)}`);
    assert(Math.abs((-dx*s+dy*c)/scale)<=ih/2+.0001,`uncovered height: ${JSON.stringify(point)}`);
  }
}

test('every cinematic preset covers the frame at exported and interpolated keys in all aspect ratios', () => {
  for(const [sw,sh,iw,ih] of [[1080,1920,1024,1536],[1920,1080,1536,1024],[1080,1080,1024,1024]]){
    for(const p of fx.PRESETS) for(const frames of [4,8,18,40]){
      const t={frames,preset:p,strength:1.12};
      const motion=fx.motionSamples({len:140,incoming:t,outgoing:t,base:Math.max(sw/iw,sh/ih)*100,zoom:.15,direction:1,fill:true,sw,sh,iw,ih});
      assert.equal(motion.pre,frames/2); assert.equal(motion.media,140+frames);
      for(let frame=0;frame<=motion.media;frame+=.25) covers(fx.sampleAt(motion,frame),sw,sh,iw,ih);
    }
  }
});

test('strong transitions do not keep the resting image unnecessarily cropped', () => {
  const p=fx.PRESETS.find(p=>p.id==='whip-left'), t={frames:18,preset:p,strength:1};
  const motion=fx.motionSamples({len:120,incoming:t,outgoing:t,base:100,zoom:0,direction:0,fill:true,sw:1080,sh:1920,iw:1080,ih:1920});
  const resting=fx.sampleAt(motion,60);
  assert.equal(resting.scale,100); assert.equal(resting.x,0); assert.equal(resting.y,0); assert.equal(resting.turn,0);
});

test('preview interpolation reads exported keys; keyframes stay ordered and inside the media handles', () => {
  const t={frames:16,preset:fx.PRESETS.find(p=>p.id==='spin-clock'),strength:1};
  const motion=fx.motionSamples({len:90,incoming:t,outgoing:t,base:125,zoom:.06,direction:-1,fill:true,sw:1080,sh:1920,iw:1024,ih:1536});
  const xml=fx.motionXML(motion,true);
  for(let k=0;k<motion.samples.length;k++){
    const p=motion.samples[k], preview=fx.sampleAt(motion,p.frame);
    for(const field of ['scale','x','y','turn']) assert(Math.abs(p[field]-preview[field])<1e-9);
    assert(p.frame>=0 && p.frame<=motion.media);
    if(k) assert(p.frame>motion.samples[k-1].frame);
    assert(xml.includes(`<when>${p.frame}</when>`));
    assert(xml.includes(`<value>${p.scale.toFixed(6)}</value>`));
  }
  assert.match(xml,/<interpolation>linear<\/interpolation>/);
  assert.equal(fx.motionXML(motion,false),'');
  const first=fx.sampleAt(motion,-20),last=fx.sampleAt(motion,999);
  assert.equal(first.frame,0);assert.equal(last.frame,motion.media);
});

const {previewFixture}=require('./helpers/page-fixture.cjs');

test('preview controls honor modes, missing images and very short beats', () => {
  const {el,run}=previewFixture();
  assert.equal(el('#previewTransitions').disabled,false);
  assert.equal(el('#shuffleTransitions').disabled,false);
  assert.match(el('#transitionSummary').textContent,/3 transitions/);
  el('#trans').value='reference';run('updateTransitionControls()');
  assert.equal(el('#shuffleTransitions').disabled,true);assert.equal(el('#transitionEnergy').disabled,true);
  el('#trans').value='0';run('updateTransitionControls()');assert.equal(el('#previewTransitions').disabled,true);
  el('#trans').value='auto';run('state.items.forEach(it=>it.url=null);updateTransitionControls()');
  assert.equal(el('#previewTransitions').disabled,true);assert.match(el('#transitionSummary').textContent,/Generate two adjacent images/);
  run('state.timeline=[{i:0,start:0,end:1},{i:1,start:1,end:4}];updateTransitionControls()');
  assert.equal(el('#shuffleTransitions').disabled,true);assert.match(el('#transitionSummary').textContent,/direct cuts/);
});

test('the preview loads the selected pair, draws shared motion and stops cleanly', async () => {
  const {el,run,drawn}=previewFixture();
  await run('openTransitionPreview(1)');
  assert.equal(el('#transitionPreview').hidden,false);assert.equal(el('#transitionPair').value,'1');
  assert.equal(el('#transitionPlay').textContent,'Play');
  assert.match(el('#transitionPreviewStatus').textContent,/same motion keys/);
  assert.equal(el('#transitionCanvas').height,640);assert.equal(el('#transitionCanvas').width,360);
  const before=drawn.length;
  run('renderTransitionFrame(document.querySelector("#transitionCanvas"),transitionPreviewState.scene,1)');
  assert.equal(drawn.length-before,4);
  el('#transitionPlay').events.click();assert.equal(el('#transitionPlay').textContent,'Pause');
  run('stopTransitionPreview()');assert.equal(el('#transitionPreview').hidden,true);
  assert.equal(run('transitionPreviewState.playing'),false);assert.equal(run('transitionPreviewState.scene'),null);
});

test('shuffle changes the mix while keeping image timing and invalidating the old export', () => {
  const {el,run}=previewFixture();
  const before=run('JSON.stringify(state.timeline)'),plan=run('JSON.stringify(getAutoTransitions())');
  run('uuidSeed=()=>1234;state.xmlDone=true');
  el('#shuffleTransitions').events.click();
  assert.equal(run('JSON.stringify(state.timeline)'),before);assert.equal(run('state.xmlDone'),false);
  assert.notEqual(run('JSON.stringify(getAutoTransitions())'),plan);
});

test('the combined download includes images, reloadable prompts, XML and the matching transition plan', async () => {
  const {page,run}=previewFixture(), files=new Map();let downloaded='';
  page.JSZip=class{file(name,data,options){files.set(name,{data,options});}async generateAsync(){return new Blob(['zip']);}};
  page.captureDownload=(blob,name)=>{downloaded=name;};run('downloadBlob=captureDownload');
  await run('downloadZip("#s4")');
  assert.equal(downloaded,'premiere-project.zip');
  for(const name of ['001.jpg','002.jpg','003.jpg','004.jpg','prompts.txt','prompts.json','timeline.xml','transitions.json']) assert(files.has(name),name);
  assert.equal(JSON.parse(files.get('prompts.json').data).items.length,4);
  assert.equal(JSON.parse(files.get('transitions.json').data).cuts.length,3);
  assert.match(files.get('timeline.xml').data,/<duration>480<\/duration>/);
  assert.equal(run('state.xmlDone'),true);
});

test('a failed ZIP remains retryable, and a changed timeline is never marked as the exported one', async () => {
  const {page,el,run}=previewFixture();
  page.JSZip=class{file(){}async generateAsync(){throw new Error('packing failed');}};
  await run('downloadZip("#s4")');
  assert.match(el('#s4').textContent,/could not be packed/);assert.equal(el('#zipBtn2').disabled,false);
  page.JSZip=class{file(){}async generateAsync(){run('state.transitionSeed=999');return new Blob(['zip']);}};
  run('downloadBlob=()=>{};state.xmlDone=false');await run('downloadZip("#s4")');
  assert.equal(run('state.xmlDone'),false);
});

test('script autosave stores only narration, title and direction, with no credentials or images', () => {
  const {page,el,run}=previewFixture();let draft;
  el('#script').value='Complete script.';el('#videoTitle').value='Video title';el('#notes').value='Optional direction';
  el('#teamCode').value='example-private-code';el('#anthKey').value='example-private-key';
  page.localStorage.setItem=(key,value)=>{assert.equal(key,'craftush-script-draft-v14');draft=JSON.parse(value);};
  run('saveScriptDraft()');
  assert.deepEqual(Object.keys(draft).sort(),['notes','script','title']);assert.equal(draft.script,'Complete script.');
  assert(!JSON.stringify(draft).includes('example-private'));
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {previewFixture}=require('./helpers/page-fixture.cjs');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/visuals/narration-alignment.js'),'utf8'),context);
const A=context.CraftushAlignment;
const scenes=lines=>lines.map(text=>({text}));
const words=(text,start=0,step=.4)=>A.tokenize(text).map((t,i)=>({...t,start:start+i*step,end:start+(i+.8)*step,exact:true}));
const starts=result=>Array.from(result.rows,r=>r.start);

test('actual word starts preserve uneven speaking speeds, opening silence and long pauses',()=>{
  const items=scenes(['Butterflies visit bright flowers.','Tiny eggs rest beneath leaves.','Caterpillars emerge much later.']);
  const transcript=[...words(items[0].text,2,.2),...words(items[1].text,8,1.2),...words(items[2].text,22,.6)];
  const r=A.align(items,transcript,{duration:30});
  assert.deepEqual(starts(r),[2,8,22]);assert.equal(r.end,30);
  assert(r.rows.every(row=>row.confidence==='matched'));
  const tl=A.buildTimeline(r.rows,r.end,30);
  assert.deepEqual(Array.from(tl.clips,c=>[c.i,c.start,c.end]),[[0,60,240],[1,240,660],[2,660,900]]);
});

test('global matching resolves repeated phrases in story order',()=>{
  const items=scenes(['Look closely at the eggs.','Look closely at the caterpillar.','Look closely at the wings.']);
  const transcript=[...words(items[0].text,1),...words(items[1].text,9),...words(items[2].text,17)];
  assert.deepEqual(starts(A.align(items,transcript,{duration:23})),[1,9,17]);
});

test('missing or changed narration is flagged instead of distributed by text length',()=>{
  const r=A.align(scenes(['Butterflies visit flowers.','Caterpillars eat green leaves.','Birds migrate south.']),[...words('Butterflies visit flowers.',1),...words('Birds migrate south.',10)],{duration:15});
  assert.equal(r.rows.length,3);assert.equal(r.rows[1].start,null);assert.equal(r.rows[1].confidence,'review');
  assert(A.buildTimeline(r.rows,15,30).errors.length>0);
  assert.deepEqual(starts(r),[1,null,10]);
});

test('extra spoken passages and incomplete first words require a review',()=>{
  const r=A.align(scenes(['Butterflies visit flowers.','Caterpillars eat leaves.']),[...words('Butterflies visit flowers.',1),...words('Climate damage destroys their habitat.',5),...words('Caterpillars eat leaves.',12)],{duration:16});
  assert(r.rows[1].reasons.some(reason=>reason.includes('extra narration')));
  const missing=A.align(scenes(['The butterfly opens golden wings.']),words('butterfly opens golden wings.',2),{duration:7});
  assert(missing.rows[0].reasons.includes('First word is missing'));
});

test('incomplete repeated narration flags every possible matching scene as uncertain',()=>{
  const line='Tiny caterpillars eat green leaves.';
  const r=A.align(scenes([line,line,line]),[...words(line,2),...words(line,17)],{duration:25});
  assert.equal(r.coverage,2/3);assert(r.rows.every(row=>row.confidence==='review'));
  assert(r.rows.every(row=>row.reasons.some(reason=>reason.includes('verify every scene'))));
  assert(A.buildTimeline(r.rows,25,30).errors.length>0);
});

test('Hindi and Hinglish matching handles script changes without an audio-length fallback',()=>{
  const items=scenes(['Titli phoolon par baithti hai.','Patte ke neeche ande hain.']);
  const transcript=[...words('तितली फूलों पर बैठती है।',2),...words('पत्ते के नीचे अंडे हैं।',11)];
  const r=A.align(items,transcript,{duration:17});
  assert.deepEqual(starts(r),[2,11]);assert(r.coverage>=.8);
  assert(r.rows[0].reasons.some(reason=>reason.includes('phonetic')));
  assert.equal(A.normalize('में'),A.normalize('mein'));
  assert.equal(A.normalize('नहीं'),A.normalize('nahi'));
  assert.equal(A.normalize('हैं'),A.normalize('hain'));
});

test('spoken numbers and emotion tags do not move image identity',()=>{
  const items=scenes(['[curious] Two eggs sit on a leaf.','[pause] Three larvae appear.']);
  const r=A.align(items,[...words('2 eggs sit on a leaf.',3),...words('३ larvae appear.',9)],{duration:14});
  assert.deepEqual(starts(r),[3,9]);assert.equal(r.coverage,1);
});

test('SRT cue starts stay unchanged; starts inside a cue are explicitly uncertain',()=>{
  const cues=[{start:2,end:8,text:'Butterflies visit flowers. Caterpillars eat leaves.'}];
  const r=A.align(scenes(['Butterflies visit flowers.','Caterpillars eat leaves.']),A.fromCues(cues),{});
  assert.deepEqual(starts(r),[2,5]);assert.equal(r.end,8);
  assert(r.rows[1].reasons.some(reason=>reason.includes('interpolated')));
  const shifted=A.align(scenes(['Butterflies visit flowers.']),A.fromCues([{start:5,end:8,text:'Butterflies visit flowers.'}]),{offset:-2,duration:12});
  assert.deepEqual(starts(shifted),[3]);assert.equal(shifted.end,12);
});

test('unequal one-per-subtitle counts preserve all images and block unchecked export',()=>{
  const cues=[{start:1,end:3,text:'Butterflies visit flowers.'}];
  const r=A.align(scenes(['Butterflies visit flowers.','Caterpillars eat leaves.']),A.fromCues(cues),{onePerCue:true,cues,duration:9});
  assert.equal(r.rows.length,2);assert(r.rows.every(row=>row.confidence==='review'));
  assert.equal(r.rows[1].start,null);
});

test('invalid, overlapping or reversed timestamps never get silently repaired',()=>{
  for(const cues of [[{start:3,end:2,text:'test'}],[{start:0,end:0,text:'test'}],[{start:0,end:3,text:'one'},{start:2,end:4,text:'two'}],[{start:5,end:6,text:'one'},{start:1,end:2,text:'two'}]])assert.throws(()=>A.fromCues(cues));
  for(const chunks of [[{text:'test',timestamp:[0,null]}],[{text:'test',timestamp:[4,3]}],[{text:'test',timestamp:[9,12]}]])assert.throws(()=>A.fromWords(chunks,10));
});

test('multiword ASR spans remain marked as interpolated boundaries',()=>{
  const transcript=A.fromWords([{text:'Butterflies visit flowers.',timestamp:[1,4]}],8);
  const r=A.align(scenes(['Butterflies visit flowers.']),transcript,{duration:8});
  assert.equal(r.rows[0].confidence,'review');
});

test('speech timestamps that absorb opening silence require a listening check',()=>{
  const words=A.fromWords([{text:'Butterflies',timestamp:[0,3.5]},{text:'visit',timestamp:[3.5,4]},{text:'flowers.',timestamp:[4,4.5]}],8);
  const r=A.align(scenes(['Butterflies visit flowers.']),words,{duration:8});
  assert.equal(r.rows[0].confidence,'review');assert(r.rows[0].reasons.some(reason=>reason.includes('unusually long')));
  const exact=A.align(scenes(['Butterflies.']),A.fromCues([{text:'Butterflies.',start:2,end:8}]),{duration:10});
  assert(!exact.rows[0].reasons.some(reason=>reason.includes('unusually long')));
});

test('overlapping speech windows keep absolute starts and select each boundary word once',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');
  const audio=Float32Array.from({length:400},(_,i)=>i),calls=[],progress=[];
  const result=await transcribeWindows(async(samples,options)=>{
    const from=samples[0]/10;calls.push({from,length:samples.length/10,options});
    return {chunks:[{text:' One',timestamp:[1-from,1.2-from]},{text:' boundary',timestamp:[14.8-from,15.2-from]},{text:' final',timestamp:[30.2-from,30.6-from]}].filter(c=>c.timestamp[0]>=0&&c.timestamp[1]<=samples.length/10)};
  },audio,'english',{sampleRate:10,onChunk:p=>progress.push(p)});
  assert.deepEqual(calls.map(c=>[c.from,c.length]),[[0,19],[11,23],[26,14]]);
  assert.deepEqual(result.chunks.map(c=>c.timestamp[0]),[1,14.8,30.2]);
  assert.deepEqual(progress,[{count:1,total:3},{count:2,total:3},{count:3,total:3}]);
  assert(calls.every(c=>c.options.task==='transcribe'&&c.options.return_timestamps==='word'&&c.options.language==='english'));
});

test('speech window stitching preserves repeated phrases at different audio positions',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');
  const audio=Float32Array.from({length:400},(_,i)=>i);let call=0;
  const r=await transcribeWindows(async(samples)=>({chunks:[{text:' Repeat',timestamp:[6+15*call++-samples[0]/10,6.5+15*(call-1)-samples[0]/10]}]}),audio,'auto',{sampleRate:10});
  assert.deepEqual(r.chunks.map(c=>c.timestamp[0]),[6,21,36]);assert.equal(r.chunks.length,3);
});

test('speech window failures do not manufacture incomplete word timestamps',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');
  for(const timestamp of [[0,null],[4,3],[0,30]])await assert.rejects(()=>transcribeWindows(async()=>({chunks:[{text:'word',timestamp}]}),new Float32Array(16000),'english'),/incomplete word timestamp/);
});

test('speech windows reject invalid input and preserve automatic language detection',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');let options;
  await transcribeWindows(async(audio,o)=>{options=o;return {chunks:[{text:' Hi',timestamp:[0,.3]}]};},new Float32Array(16000),'auto');
  assert(!Object.hasOwn(options,'language'));assert.equal(options.task,'transcribe');
  await assert.rejects(()=>transcribeWindows(()=>{},new Float32Array(16000),'english',{coreSeconds:30,contextSeconds:4}),/window size/);
  await assert.rejects(()=>transcribeWindows(()=>{},new Float32Array(),'english'),/No narration/);
});

test('frame rounding stays within half a frame and never invents extra one-frame scenes',()=>{
  for(const fps of [24000/1001,24,25,30000/1001,30,50,60000/1001,60]){
    const rows=[{i:0,start:1.135},{i:1,start:9.279},{i:2,start:21.015}],r=A.buildTimeline(rows,30.024,fps);
    assert.equal(r.errors.length,0);
    r.clips.forEach((c,k)=>assert(Math.abs(c.start/fps-rows[k].start)<=.5/fps+1e-9));
    assert.equal(r.clips[2].end,Math.round(30.024*fps));
    assert(A.buildTimeline([{i:0,start:1},{i:1,start:1.001}],10,fps).errors.length>0);
  }
});

test('PCM WAV preserves every sample, channel order and duration at the original sample rate',()=>{
  const input=[new Float32Array([-1,0,.5,1]),new Float32Array([1,.25,0,-1])];
  const buffer=A.wav(input,48000),view=new DataView(buffer);
  assert.equal(buffer.byteLength,60);assert.equal(view.getUint32(24,true),48000);assert.equal(view.getUint16(22,true),2);
  assert.equal(view.getUint32(40,true),16);assert.equal(view.getUint32(28,true),192000);
  assert.deepEqual(Array.from({length:8},(_,i)=>view.getInt16(44+i*2,true)),[-32768,32767,0,8192,16384,0,32767,-32768]);
});

test('manual time input rejects malformed values rather than creating a frame',()=>{
  assert.equal(A.parseTime('1:02.345'),62.345);assert.equal(A.parseTime('01:02:03,4'),3723.4);
  for(const value of ['-1','1:80','x',''])assert(Number.isNaN(A.parseTime(value)));
  assert.equal(A.formatTime(59.9999),'1:00.000');
});

test('audio without a transcript cannot enable XML or sneak it into an image ZIP',async()=>{
  const {page,el,run}=previewFixture({confirm:false});const files=new Map();
  run('state.vo={duration:40,identity:["audio"],samples:new Float32Array(10)};document.querySelector("#mode").value="audio";refreshTimeline()');
  assert.equal(run('state.timeline.length'),0);assert.equal(el('#xmlBtn').disabled,true);
  assert.throws(()=>run('buildXML()'),/Confirm/);
  page.JSZip=class{file(name,data){files.set(name,data);}async generateAsync(){return new Blob(['zip']);}};
  run('downloadBlob=()=>{}');await run('downloadZip("#s4")');
  assert(files.has('001.jpg'));assert(!files.has('timeline.xml'));assert(!files.has('narration.wav'));
});

test('SRT times are preserved with different audio duration and never stretched',()=>{
  const {run,el}=previewFixture({confirm:false});
  run('state.vo={duration:25,identity:["audio"]};refreshTimeline()');
  assert.deepEqual(JSON.parse(run('JSON.stringify(state.timeline.map(c=>c.start))')),[0,120,240,360]);
  assert.equal(run('state.timeline[3].end'),750);assert.equal(el('#xmlBtn').disabled,true);
  run('state.vo.duration=10;refreshTimeline()');
  assert.equal(run('state.timeline.length'),0);assert.match(el('#s4').textContent,/extends past/);
});

test('manual starts and review flags enable export only after final confirmation',()=>{
  const {run,el}=previewFixture({confirm:false});
  run('state.vo={duration:20,identity:["audio"]};document.querySelector("#mode").value="manual";refreshTimeline()');
  assert.equal(run('state.timeline.length'),0);
  run('for(let i=0;i<4;i++){state.cutOverrides.set(i,1+i*4);state.cutReviewed.add(i)}refreshTimeline()');
  assert.equal(el('#confirmTiming').disabled,false);assert.equal(el('#xmlBtn').disabled,true);
  el('#confirmTiming').checked=true;el('#confirmTiming').events.change();
  assert.equal(el('#xmlBtn').disabled,false);assert.match(run('buildXML()'),/<start>30<\/start>/);
  run('state.items[0].text="Changed narration";refreshTimeline()');
  assert.equal(el('#xmlBtn').disabled,true);assert.equal(run('state.cutOverrides.size'),0);
});

test('subtitle load errors clear stale timelines and replacement races keep the newest SRT',async()=>{
  const {page,run}=previewFixture();
  page.badSRT={name:'bad.srt',text:async()=> '1\n00:00:04,000 --> 00:00:02,000\nWrong order'};
  await run('loadSRT(badSRT)');assert.equal(run('state.cues.length'),0);assert.equal(run('state.timeline.length'),0);
  let resolve;page.slowSRT={name:'older.srt',text:()=>new Promise(r=>resolve=r)};
  page.newSRT={name:'latest.srt',text:async()=> '1\n00:00:02,000 --> 00:00:05,000\nScene 0'};
  const old=run('loadSRT(slowSRT)');await run('loadSRT(newSRT)');resolve('1\n00:00:20,000 --> 00:00:25,000\nScene 0');await old;
  assert.equal(run('state.cues[0].start'),2);
});

test('an edited automatic start must be checked before timing can be confirmed again',()=>{
  const {run,el}=previewFixture();
  el('#alignmentRows').events.change({target:{dataset:{cut:'1'},value:'0:04.200'}});
  assert.equal(run('state.timeline[1].start'),126);assert.equal(el('#xmlBtn').disabled,true);assert.equal(el('#confirmTiming').disabled,true);
  el('#alignmentRows').events.change({target:{dataset:{review:'1'},checked:true}});
  assert.equal(el('#confirmTiming').disabled,false);assert.equal(el('#xmlBtn').disabled,true);
  el('#confirmTiming').checked=true;el('#confirmTiming').events.change();assert.equal(el('#xmlBtn').disabled,false);
});

test('all XML modes place the same mono/stereo narration at sequence zero',()=>{
  const {run,el}=previewFixture();
  for(const fps of ['23.976','25','29.97','30','59.94'])for(const channels of [1,2])for(const mode of ['auto','gentle','reference','0.5','1','0']){
    el('#fps').value=fps;el('#trans').value=mode;
    run(`state.vo={duration:20.123,sampleRate:48000,channels:${channels},identity:["audio"],blob:new Blob(["wav"])};refreshTimeline();state.timingConfirmed=true`);
    const xml=run('buildXML()');
    assert.match(xml,/<audio><numOutputChannels>/);
    assert.equal((xml.match(/id="narration-\d"/g)||[]).length,channels);
    assert.equal((xml.match(/<start>0<\/start><end>\d+<\/end><in>0<\/in><out>/g)||[]).length,channels);
    assert.match(xml,/<name>narration.wav<\/name>/);assert.match(xml,/<samplerate>48000<\/samplerate>/);
    const expected=Math.round(20.123*run('rateInfo().fps'));
    assert(xml.includes(`<duration>${expected}</duration>`));
  }
});

test('complete ZIP packages the exact narration and frame map only after timing confirmation',async()=>{
  const {page,run}=previewFixture(),files=new Map();
  run('state.vo={duration:20,sampleRate:48000,channels:1,identity:["audio"],blob:new Blob(["original samples"])};refreshTimeline();state.timingConfirmed=true');
  page.JSZip=class{file(name,data){files.set(name,data);}async generateAsync(){return new Blob(['zip']);}};
  run('downloadBlob=()=>{}');await run('downloadZip("#s4")');
  assert.equal(await files.get('narration.wav').text(),'original samples');
  const report=JSON.parse(files.get('timing.json'));assert.equal(report.confirmed,true);assert.equal(report.images.length,4);
  assert.equal(report.images[1].image,'002.jpg');assert.equal(report.images[1].startFrame,120);assert.equal(report.images[3].endFrame,600);
});

test('cancelled transcription and stale worker callbacks cannot replace new narration timings',()=>{
  const {page,run,el}=previewFixture({confirm:false});let callback,terminated=false;
  page.Worker=class{set onmessage(fn){callback=fn;}postMessage(){}terminate(){terminated=true;}};
  run('state.vo={duration:20,identity:["old"],samples:new Float32Array(160),words:null};transcribeNarration()');
  assert.equal(run('state.transcribing'),true);assert.equal(el('#xmlBtn').disabled,true);
  el('#cancelAlignment').events.click();assert(terminated);assert.equal(run('state.transcribing'),false);
  callback({data:{type:'complete',text:'Scene 0',chunks:[{text:'Scene',timestamp:[0,.5]}]}});
  assert.equal(run('state.vo.words'),null);assert.equal(el('#xmlBtn').disabled,true);
});

test('saved scenes can export corrected audio and XML without regenerating their existing images',async()=>{
  const {page,run,el}=previewFixture(),files=new Map();let name;
  run('state.items.forEach(it=>{it.b64=null;it.url=null});state.vo={duration:20,sampleRate:48000,channels:1,identity:["audio"],blob:new Blob(["existing audio"])};refreshTimeline();state.timingConfirmed=true;updateButtons()');
  assert.equal(el('#zipBtn2').disabled,false);assert.equal(el('#zipBtn2').textContent,'Download timeline + audio (.zip)');
  page.JSZip=class{file(key,data){files.set(key,data);}async generateAsync(){return new Blob(['zip']);}};
  page.captureName=(blob,n)=>{name=n};run('downloadBlob=captureName');await run('downloadZip("#s4")');
  assert.equal(name,'timeline-audio.zip');assert(!files.has('001.jpg'));assert(files.has('narration.wav'));assert(files.has('timeline.xml'));
  assert.match(files.get('timeline.xml'),/<name>001.jpg<\/name>/);assert.match(el('#s4').textContent,/existing numbered JPGs/);
});

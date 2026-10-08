const test=require('node:test'),assert=require('node:assert/strict');
const {previewFixture}=require('./helpers/page-fixture.cjs');
const word=(text,a,b)=>({text:' '+text,timestamp:[a,b]});

test('a failed inference section receives one retry without altering the source audio',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');let calls=0;
  const samples=new Float32Array(16000*10);samples[0]=.3;
  const result=await transcribeWindows(async input=>{calls++;if(calls===1)throw Error('alignment decoder failed');assert.equal(input.length,172000);return {chunks:[word('Flowers',4,4.5)]};},samples,'english');
  assert.equal(calls,2);assert.equal(result.recovered,1);assert.deepEqual(result.chunks[0].timestamp,[4,4.5]);assert.equal(samples.length,160000);assert.equal(result.issues.length,0);
});

test('an unrecoverable section keeps valid later sections and marks the failed range for listening',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');let calls=0;
  const result=await transcribeWindows(async()=>{calls++;if(calls===1)return {chunks:[word('First',1,1.5)]};if(calls===2||calls===3)throw Error('word alignment failed');return {chunks:[word('Last',5,5.5)]};},new Float32Array(16000*40),'hindi');
  assert.equal(calls,4);assert.deepEqual(result.chunks.map(c=>c.timestamp[0]),[1,31]);assert.deepEqual(result.issues,[{start:15,end:30,kind:'recognition-failed'}]);
});

test('a wholly unreadable transcript fails clearly after a bounded retry without inventing cuts',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');let calls=0;
  await assert.rejects(transcribeWindows(async()=>{calls++;throw Error('decoder failed');},new Float32Array(16000*10),'english'),/audio is still loaded/);assert.equal(calls,2);
});

test('completed recognition reuses its warm worker while old job messages cannot replace new timings',async()=>{
  const {page,run}=previewFixture({confirm:false});let worker,created=0;page.Worker=class{constructor(){worker=this;created++;}postMessage(data){this.job=data;}terminate(){this.terminated=true;}};
  page.voice={name:'heygen.wav',identity:['one'],duration:20,samples:new Float32Array(320000),blob:new Blob(['PCM']),url:'blob:one',channels:1,sampleRate:48000};page.file={name:'heygen.wav'};
  run('analyseVoice=async()=>voice');await run('loadVoice(file)');const oldTicket=worker.job.ticket;
  const chunks=Array.from({length:4},(_,i)=>[word('Scene',i*4,i*4+.3),word(String(i),i*4+.3,i*4+.5)]).flat();
  worker.onmessage({data:{type:'complete',ticket:oldTicket,chunks,issues:[]}});assert(!worker.terminated);
  page.voice={...page.voice,name:'second.wav',identity:['two'],url:'blob:two'};await run('loadVoice(file)');assert.equal(created,1);assert.notEqual(worker.job.ticket,oldTicket);
  worker.onmessage({data:{type:'complete',ticket:oldTicket,chunks,issues:[]}});assert.equal(run('state.transcribing'),true);assert.equal(run('state.vo.words'),null);
  worker.onmessage({data:{type:'complete',ticket:worker.job.ticket,chunks,issues:[]}});assert.equal(run('state.transcribing'),false);assert.equal(run('state.timeline.length'),4);
});

test('failed automatic sync has a direct guided repair and invalid playhead cuts are rejected',()=>{
  const {run,el}=previewFixture({confirm:false});
  run('state.vo={duration:20,identity:["audio"],blob:new Blob(["PCM"])};document.querySelector("#mode").value="audio";syncStatus("error","Automatic sync failed");refreshTimeline()');
  assert.match(el('#exportBlocker').textContent,/Sync needs help/);el('#manualSyncBtn').events.click();assert.equal(el('#guidedCuts').hidden,false);
  for(const t of [0,4]){el('#narrationAudio').currentTime=t;el('#markNextCut').events.click();}
  el('#narrationAudio').currentTime=3;el('#markNextCut').events.click();assert.equal(run('state.cutOverrides.size'),2);
  for(const t of [8,12]){el('#narrationAudio').currentTime=t;el('#markNextCut').events.click();}
  assert.equal(run('state.timeline.length'),4);assert.equal(el('#guidedCuts').hidden,true);assert.equal(el('#confirmTiming').disabled,false);assert.equal(el('#xmlBtn').disabled,true);
  el('#confirmTiming').checked=true;el('#confirmTiming').events.change();assert.equal(el('#xmlBtn').disabled,false);assert.equal(el('#zipBtn2').disabled,false);
});

test('XML stays available but a ZIP missing image bytes requires an explicit existing-image choice',()=>{
  const {run,el}=previewFixture();run('state.items[2].b64=null;updateButtons()');
  assert.equal(el('#xmlBtn').disabled,false);assert.equal(el('#zipBtn2').disabled,true);assert.match(el('#exportBlocker').textContent,/1 more image/);
  el('#useExistingImages').checked=true;el('#useExistingImages').events.change();assert.equal(el('#zipBtn2').disabled,false);assert.match(el('#exportBlocker').textContent,/already have/);
});

test('a project changed during ZIP packing does not download an obsolete timeline',async()=>{
  const {page,run}=previewFixture();let release,downloads=0;
  page.JSZip=class{file(){}generateAsync(){return new Promise(resolve=>release=resolve);}};page.capture=()=>downloads++;run('downloadBlob=capture');
  const packing=run('downloadZip("#s4")');run('state.items[0].text="A different script"');release(new Blob(['ZIP']));await packing;
  assert.equal(downloads,0);assert.equal(run('state.packing'),false);assert.equal(run('state.xmlDone'),false);
});

test('restoring numbered JPEGs preserves scene identity and original bytes, and bad batches are atomic',async()=>{
  const {page,run,el}=previewFixture();page.Image=class{constructor(){this.naturalWidth=64;this.naturalHeight=64;}set src(v){queueMicrotask(()=>this.onload());}};page.btoa=value=>Buffer.from(value,'binary').toString('base64');
  const file=new Blob([Uint8Array.from([255,216,255,217])]);file.name='002.jpg';page.files=[file];const id=run('state.items[1].id');
  await run('restoreNumberedImages(files)');assert.equal(run('state.items[1].id'),id);assert.equal(run('state.items[1].b64'),'/9j/2Q==');assert.equal(el('#xmlBtn').disabled,true);
  const changed=new Blob([Uint8Array.from([255,216,1,217])]);changed.name='002.jpg';page.files=[changed,{name:'002.png'}];await run('restoreNumberedImages(files)');assert.equal(run('state.items[1].b64'),'/9j/2Q==');assert.match(el('#s4').textContent,/Two files/);
});

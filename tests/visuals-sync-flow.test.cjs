const test=require('node:test');
const assert=require('node:assert/strict');
const {previewFixture}=require('./helpers/page-fixture.cjs');

function voice(name='narration.wav'){
  return {name,duration:20,identity:[name],samples:new Float32Array(160),words:null,url:'blob:test-'+name,blob:new Blob(['wav']),sampleRate:48000,channels:1};
}
function workerMock(page){
  const workers=[];
  page.Worker=class{
    constructor(){workers.push(this);}
    postMessage(message){this.message=message;}
    terminate(){this.terminated=true;}
    send(data){this.onmessage({data});}
  };
  return workers;
}
function result(){
  return {type:'complete',text:'Scene 0 Scene 1 Scene 2 Scene 3',chunks:Array.from({length:4},(_,i)=>[
    {text:'Scene',timestamp:[1+i*4,1.3+i*4]},
    {text:String(i),timestamp:[1.4+i*4,1.7+i*4]}
  ]).flat()};
}

test('adding audio starts word sync automatically and invalidates subtitles from previous audio',async()=>{
  const {page,run,el}=previewFixture(),workers=workerMock(page);
  page.decodedVoice=voice();page.audioFile={name:'new.wav'};
  run('analyseVoice=async()=>decodedVoice');
  await run('loadVoice(audioFile)');
  assert.equal(workers.length,1);assert.equal(run('state.cues.length'),0);
  assert.equal(run('state.transcribing'),true);assert.equal(el('#mode').value,'audio');
  assert.equal(el('#zipBtn2').disabled,true);assert.equal(el('#xmlBtn').disabled,true);
  assert.doesNotMatch(el('#s4').textContent,/Choose Align|Set starts manually/);
  workers[0].send(result());
  assert.equal(run('state.transcribing'),false);
  assert.deepEqual(JSON.parse(run('JSON.stringify(state.timeline.map(c=>c.start))')),[30,150,270,390]);
  assert.equal(el('#confirmTiming').disabled,false);assert.equal(el('#zipBtn2').disabled,true);
  el('#confirmTiming').checked=true;el('#confirmTiming').events.change();
  assert.equal(el('#zipBtn2').disabled,false);
});

test('failed automatic sync keeps its recovery message and retry control visible',()=>{
  const {page,run,el}=previewFixture({confirm:false}),workers=workerMock(page);
  page.testVoice=voice();run('state.vo=testVoice;transcribeNarration()');
  workers[0].send({type:'error',message:'Model download failed'});
  run('refreshTimeline()');
  assert.equal(el('#syncRecovery').open,true);assert.equal(el('#alignNarration').hidden,false);
  assert.match(el('#s4').textContent,/Retry sync.*SRT/);
  assert.equal(el('#xmlBtn').disabled,true);assert.equal(el('#zipBtn2').disabled,true);
  el('#alignNarration').events.click();assert.equal(workers.length,2);
  workers[1].send(result());assert.equal(run('state.timeline.length'),4);
});

test('loading an SRT cancels recognition so late words cannot replace subtitle timing',async()=>{
  const {page,run,el}=previewFixture(),workers=workerMock(page);
  page.testVoice=voice();run('state.vo=testVoice;transcribeNarration()');
  page.srt={name:'exact.srt',text:async()=>Array.from({length:4},(_,i)=>`${i+1}\n00:00:${String(2+i*4).padStart(2,'0')},000 --> 00:00:${String(5+i*4).padStart(2,'0')},000\nScene ${i}`).join('\n\n')};
  await run('loadSRT(srt)');workers[0].send(result());
  assert(workers[0].terminated);assert.equal(el('#mode').value,'words');
  assert.equal(run('state.vo.words'),null);assert.equal(run('state.timeline[0].start'),60);
});

test('a slow previous audio decode and worker cannot replace newer narration',async()=>{
  const {page,run}=previewFixture(),workers=workerMock(page);let finishOld;
  page.decode=file=>file.name==='old.wav'?new Promise(resolve=>finishOld=resolve):Promise.resolve(voice('new.wav'));
  page.oldFile={name:'old.wav'};page.newFile={name:'new.wav'};
  run('analyseVoice=decode');const old=run('loadVoice(oldFile)');
  await run('loadVoice(newFile)');finishOld(voice('old.wav'));await old;
  assert.equal(run('state.vo.name'),'new.wav');assert.equal(workers.length,1);
  workers[0].send(result());assert.equal(run('state.timeline[0].start'),30);
});

test('subtitles selected while audio decodes do not cancel audio loading or force recognition',async()=>{
  const {page,run,el}=previewFixture(),workers=workerMock(page);let finish;
  page.decode=()=>new Promise(resolve=>finish=resolve);page.file={name:'audio.wav'};
  page.srt={name:'audio.srt',text:async()=> '1\n00:00:02,000 --> 00:00:05,000\nScene 0'};
  run('analyseVoice=decode');const loading=run('loadVoice(file)');
  await run('loadSRT(srt)');finish(voice());await loading;
  assert.equal(run('state.voiceLoading'),false);assert.equal(run('state.vo.name'),'narration.wav');
  assert.equal(el('#mode').value,'words');assert.equal(run('state.cues[0].start'),2);assert.equal(workers.length,0);
});

test('language changes restart sync and discard prior transcription callbacks',()=>{
  const {page,run,el}=previewFixture(),workers=workerMock(page);
  page.testVoice=voice();run('state.vo=testVoice;transcribeNarration()');
  el('#voiceLanguage').value='english';el('#voiceLanguage').events.change();
  workers[0].send(result());assert.equal(run('state.vo.words'),null);
  assert(workers[0].terminated);assert.equal(workers[1].message.language,'english');
  workers[1].send(result());assert.equal(run('state.timeline.length'),4);
});

test('scene IDs and image links agree in prompts, manifest, timing and XML',async()=>{
  const {page,run}=previewFixture(),files=new Map();
  run('state.items[1].imageSourceURL="https://example.test/kept.jpg"');
  page.JSZip=class{file(name,data){files.set(name,data);}async generateAsync(){return new Blob(['zip']);}};
  run('downloadBlob=()=>{}');await run('downloadZip("#s4")');
  const prompts=JSON.parse(files.get('prompts.json')),links=JSON.parse(files.get('image-links.json')),timing=JSON.parse(files.get('timing.json'));
  for(let i=0;i<4;i++){
    assert.equal(prompts.items[i].id,links.images[i].sceneId);
    assert.equal(links.images[i].sceneId,timing.images[i].sceneId);
    assert.equal(prompts.items[i].text,links.images[i].line);
    assert.equal(prompts.items[i].imageFile,timing.images[i].image);
    assert(files.has(links.images[i].image));
    assert(files.get('timeline.xml').includes(`<name>${links.images[i].image}</name>`));
  }
  assert.equal(links.images[1].sourceURL,'https://example.test/kept.jpg');
  assert.equal(timing.images[1].startFrame,120);
});

test('images selected by quality review retain the selected image link',async()=>{
  const {run}=previewFixture();
  run('runware=async()=>({b64:"first",cost:0,imageSourceURL:"https://example.test/first.jpg"});qcAfterGenerate=async()=>({b64:"winner",cost:0,imageSourceURL:"https://example.test/winner.jpg"});b64ToBlob=()=>new Blob(["image"])');
  await run('generateOne(1)');
  assert.equal(run('state.items[1].b64'),'winner');assert.equal(run('state.items[1].imageSourceURL'),'https://example.test/winner.jpg');
});

test('a late generated image cannot attach itself to a replaced script line',async()=>{
  const {page,run}=previewFixture();let resolve;
  page.pendingImage=new Promise(r=>resolve=r);run('runware=()=>pendingImage;b64ToBlob=()=>new Blob(["image"])');
  const work=run('generateOne(1)');run('state.items[1]={text:"New line",prompt:"new",b64:null,url:null,status:"idle"}');
  resolve({b64:'old-image',cost:0});await work;
  assert.equal(run('state.items[1].b64'),null);
});

test('partial image batches cannot masquerade as a complete Premiere package',async()=>{
  const {page,run,el}=previewFixture();let packed=false;
  run('state.items[1].b64=null;updateButtons()');assert.equal(el('#zipBtn2').disabled,true);
  page.JSZip=class{file(){}async generateAsync(){packed=true;return new Blob(['zip']);}};
  await run('downloadZip("#s4")');assert.equal(packed,false);assert.match(el('#s4').textContent,/missing images/);
  assert.equal(el('#imagesOnlyBtn').disabled,false);
});

test('listening to a long scene reaches the next image cut rather than a seven-second limit',()=>{
  const {page,run,el}=previewFixture();page.testVoice=voice();
  run('state.vo=testVoice;state.cues[0].end=10;state.cues[1].start=10;state.cues[1].end=12;state.cues[2].start=12;state.cues[2].end=16;state.cues[3].start=16;state.cues[3].end=20;refreshTimeline()');
  el('#alignmentRows').events.click({target:{closest:()=>({dataset:{listen:'0'}})}});
  assert.equal(run('narrationPreviewLimit'),10);
});

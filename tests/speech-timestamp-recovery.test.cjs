const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {previewFixture}=require('./helpers/page-fixture.cjs');
const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/visuals/narration-alignment.js'),'utf8'),context);
const A=context.CraftushAlignment;
const audio=()=>new Float32Array(16000*10);
const word=(text,start,end)=>({text:' '+text,timestamp:[start,end]});

test('punctuation without duration no longer cancels valid spoken-word timings',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');let calls=0;
  const result=await transcribeWindows(async()=>{calls++;return {chunks:[word('Butterflies',1,1.5),word('.',1.5,1.5),word('flowers',4,4.6),word('।',null,null)]};},audio(),'english');
  assert.equal(calls,1);assert.deepEqual(result.chunks.map(c=>c.timestamp),[[1,1.5],[4,4.6]]);assert.equal(result.issues.length,0);
});

test('a bounded padded pass recovers a missing end without changing narration samples or transcript',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');let calls=0;const samples=audio(),progress=[];samples[0]=.25;samples[samples.length-1]=-.5;
  const result=await transcribeWindows(async input=>{
    calls++;assert.equal(input[0],.25);
    if(calls===1)return {chunks:[word('Butterflies',1,1.5),word('flowers',4,null)]};
    assert.equal(input.length,samples.length+12000);assert.equal(input[samples.length-1],-.5);assert(input.subarray(samples.length).every(n=>n===0));
    return {chunks:[word('Butterflies',1,1.5),word('flowers',4,4.6)]};
  },samples,'english',{onChunk:p=>progress.push(p)});
  assert.equal(calls,2);assert.equal(result.recovered,1);assert.deepEqual(result.chunks.map(c=>c.timestamp),[[1,1.5],[4,4.6]]);
  assert.equal(samples.length,160000);assert.equal(samples[samples.length-1],-.5);assert.equal(progress[0].phase,'recovering');
});

test('unresolved missing ends and zero-width words retain observed starts and require scene review',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');
  const result=await transcribeWindows(async()=>({chunks:[word('Butterflies',1,1.5),word('Flowers',4,null),word('Leaves',7,7)]}),audio(),'english');
  assert.deepEqual(result.chunks.map(c=>c.timestamp),[[1,1.5],[4,4],[7,7]]);
  const words=A.fromWords(result.chunks,10),aligned=A.align([{text:'Butterflies'},{text:'Flowers'},{text:'Leaves'}],words,{duration:10});
  assert.equal(aligned.rows[0].confidence,'matched');assert.equal(aligned.rows[1].start,4);assert.equal(aligned.rows[2].start,7);
  assert(aligned.rows.slice(1).every(r=>r.confidence==='review'&&r.reasons.some(s=>s.includes('uncertain start'))));
  assert.throws(()=>A.fromWords([word('Flowers',4,4)],10)); // Unmarked zero spans remain invalid.
});

test('a final word ending beyond the recording keeps only its observed start with a review flag',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');
  const result=await transcribeWindows(async()=>({chunks:[word('Flowers',8,12)]}),audio(),'english');
  assert.deepEqual(result.chunks[0].timestamp,[8,8]);assert.equal(result.chunks[0].timingUncertain,true);
  const aligned=A.align([{text:'Flowers'}],A.fromWords(result.chunks,10),{duration:10});
  assert.equal(aligned.rows[0].start,8);assert.equal(aligned.rows[0].confidence,'review');
});

test('unrecoverable missing starts keep valid words and explicitly mark the affected audio section',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');
  const result=await transcribeWindows(async()=>({chunks:[word('Butterflies',1,1.5),word('missing',null,3),word('Flowers',4,4.6)]}),audio(),'english');
  assert.deepEqual(result.chunks.map(c=>c.timestamp),[[1,1.5],[4,4.6]]);assert(result.issues.length>0);
  const aligned=A.align([{text:'Butterflies'},{text:'Flowers'}],A.fromWords(result.chunks,10),{duration:10,issues:result.issues});
  assert(aligned.rows.every(r=>r.confidence==='review'));assert.equal(aligned.rows[1].start,4);
});

test('retry cannot replace the original phrase with a different transcript or mask a failed retry',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');
  for(const retry of [()=>({chunks:[word('Different',1,2)]}),()=>{throw Error('decoder retry failed');}]){
    let calls=0;const result=await transcribeWindows(async()=>++calls===1?{chunks:[word('Flowers',4,null)]}:retry(),audio(),'english');
    assert.equal(calls,2);assert.equal(result.chunks[0].text,' Flowers');assert.equal(result.chunks[0].timingUncertain,true);
  }
});

test('an incomplete overlap word outside its owned section does not abort or retry that section',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');let calls=0;
  const result=await transcribeWindows(async()=>++calls===1?{chunks:[word('Early',1,1.5),word('Later',17,null)]}:{chunks:[word('Later',6,6.5)]},new Float32Array(16000*25),'english');
  assert.equal(calls,2);assert.deepEqual(result.chunks.map(c=>c.timestamp[0]),[1,17]);assert.equal(result.chunks[1].timingUncertain,undefined);
});

test('duplicate overlap recovery keeps one boundary word and preserves repeats at different audio positions',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');let calls=0;
  const result=await transcribeWindows(async()=>++calls<=2?{chunks:[word('Go',1,1.5),word('Boundary',14.98,null)]}:{chunks:[word('Boundary',3.98,4.2),word('Go',8,8.5)]},new Float32Array(16000*25),'english');
  assert.deepEqual(result.chunks.map(c=>c.text),[' Go',' Boundary',' Go']);assert.deepEqual(result.chunks.map(c=>c.timestamp[0]),[1,14.98,19]);assert.equal(result.chunks[1].timingUncertain,undefined);
});

test('Hindi zero-width tokens and genuinely repeated words in the same section are retained',async()=>{
  const {transcribeWindows}=await import('../public/visuals/transcription-windows.mjs');
  const result=await transcribeWindows(async()=>({chunks:[word('बारिश',1,1.5),word('में',1.5,1.5),word('नमी',2,2.4),word('नमी',2.4,2.4),word('नमी',2.4,2.4)]}),audio(),'hindi');
  assert.deepEqual(result.chunks.map(c=>c.text),[' बारिश',' में',' नमी',' नमी',' नमी']);
  assert.equal(A.fromWords(result.chunks,10).length,5);
});

test('recovered worker results render reviewable image cuts instead of the upload error and preserve the WAV export',async()=>{
  const {page,run,el}=previewFixture({confirm:false});let worker;page.Worker=class{constructor(){worker=this;}postMessage(){}terminate(){}};
  page.decoded={name:'heygen.wav',duration:20,identity:['heygen'],samples:new Float32Array(320000),blob:new Blob(['original PCM']),url:'blob:audio',channels:1,sampleRate:48000};page.file={name:'heygen.wav'};
  run('analyseVoice=async()=>decoded');await run('loadVoice(file)');
  const chunks=Array.from({length:4},(_,i)=>[word('Scene',1+4*i,1.5+4*i),word(String(i),1.5+4*i,1.8+4*i)]).flat();
  chunks[2].timestamp=[5,5];chunks[2].timingUncertain=true;
  worker.onmessage({data:{type:'complete',chunks,issues:[],recovered:1,text:'Scene 0 Scene 1 Scene 2 Scene 3'}});
  assert.equal(run('state.timeline.length'),4);assert.equal(run('state.syncPhase'),'matched');assert.doesNotMatch(el('#s4').textContent,/could not finish|incomplete word timestamp/);
  assert.equal(el('#confirmTiming').disabled,true);assert.equal(el('#zipBtn2').disabled,true);
  run('state.cutReviewed.add(1);refreshTimeline()');assert.equal(el('#confirmTiming').disabled,false);
  el('#confirmTiming').checked=true;el('#confirmTiming').events.change();
  const files=new Map();page.JSZip=class{file(name,data){files.set(name,data);}async generateAsync(){return new Blob(['zip']);}};run('downloadBlob=()=>{}');await run('downloadZip("#s4")');
  assert.equal(files.get('narration.wav'),page.decoded.blob);assert(files.get('timeline.xml').includes('<start>0</start>'));
  assert.deepEqual(JSON.parse(files.get('timing.json')).images.map(c=>c.startFrame),[30,150,270,390]);
});

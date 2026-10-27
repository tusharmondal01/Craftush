import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {recognizeNarration,cleanRecognition} from '../public/documentary/narration-recognition.mjs';
import {mediaURL,validWords} from '../public/documentary/narration-core.js';

const samples=()=>new Float32Array(16000);
test('documentary recognizer recovers timestamp exceptions thrown before any chunks return',async()=>{
 let calls=0;const r=await recognizeNarration(async()=>{if(++calls===1)throw new Error('Speech recognition returned an incomplete word timestamp.');return {chunks:[{text:' Hello',timestamp:[.2,.7]}]};},samples(),'hi');
 assert.equal(calls,2);assert.equal(r.requiresReview,false);assert.deepEqual(r.chunks[0].timestamp,[.2,.7]);
});
test('failed retry cannot discard the first valid timing results',async()=>{
 let calls=0;const r=await recognizeNarration(async()=>{if(++calls===2)return {chunks:[]};return {chunks:[{text:' Hello',timestamp:[.1,.4]},{text:' world',timestamp:[.5,null]}]};},samples(),'hi');
 assert.equal(calls,2);assert.equal(r.requiresReview,true);assert.equal(r.chunks.length,1);assert.equal(r.issues[0].text,'world');
});
test('timestamp failures throughout analysis produce reviewable results instead of a fatal worker error',async()=>{
 let calls=0;const r=await recognizeNarration(async()=>{calls++;throw new Error('Incomplete timestamp');},samples(),'hi');
 assert.equal(calls,2);assert.equal(r.requiresReview,true);assert.deepEqual(r.chunks,[]);assert.match(r.issues[0].text,/Speech near/);
});
test('actual download and model errors still propagate clearly',async()=>{
 await assert.rejects(()=>recognizeNarration(async()=>{throw new Error('Model download failed');},samples(),'hi'),/Model download failed/);
});
test('untimed punctuation does not turn successfully timed speech into a failure',async()=>{
 let calls=0;const r=await recognizeNarration(async()=>{calls++;return {chunks:[{text:' Hello',timestamp:[.1,.4]},{text:'।',timestamp:[.4,null]}]};},samples(),'hi');
 assert.equal(calls,1);assert.equal(r.requiresReview,false);assert.equal(r.chunks.length,1);
});
test('invalid and out-of-order chunks are flagged without inventing their times',()=>{
 const r=cleanRecognition({chunks:[{text:' Good',timestamp:[.1,.3]},{text:' missing',timestamp:[null,.4]},{text:' zero',timestamp:[.5,.5]},{text:' later',timestamp:[.7,.9]},{text:' reversed',timestamp:[.4,.6]}]},1);
 assert.equal(r.requiresReview,true);assert.deepEqual(r.chunks.map(c=>c.text),[' Good',' later']);assert.equal(r.issues.length,3);
});

// Run the actual media module and dedicated worker handler together. Only the
// browser audio decoder and ASR model output are substituted, not their handoff.
async function mediaHarness(transcribe,{startupFailures=0,runtimeFailures=0}={}){
 const alignment=await readFile(new URL('../public/visuals/narration-alignment.js',import.meta.url),'utf8');
 const workerSource=(await readFile(new URL('../public/documentary/narration-worker.mjs',import.meta.url),'utf8'))
  .replace("import('./narration-recognition.mjs?v=20261027-speech-load3')",'fakeRecognition()')
  .replace("import('./vendor/speech-3.8.1/transformers.min.js')",'fakeRuntime()')
  .replaceAll('import.meta.url',JSON.stringify(new URL('../public/documentary/narration-worker.mjs',import.meta.url).href));
 const mediaSource=(await readFile(new URL('../public/documentary/narration-media.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/export /g,'').replaceAll('import.meta.url',JSON.stringify(new URL('../public/documentary/narration-media.js',import.meta.url).href));
 const messages=[],inputs=[],environments=[];let workerURL,terminated=0,workers=0,loads=0;
 class Worker {
  constructor(url,opts){workerURL=url;workers++;assert.equal(opts.type,'module');
   if(workers<=startupFailures){queueMicrotask(()=>this.onerror?.({message:'Worker script failed to load',preventDefault(){}}));return;}
   const self={postMessage:data=>{messages.push(data);queueMicrotask(()=>this.onmessage?.({data}));}};this.worker=self;
   vm.runInNewContext(workerSource,{self,URL,recognizeNarration,fakeRecognition:async()=>({recognizeNarration}),fakeRuntime:async()=>{
    if(++loads<=runtimeFailures)throw new Error('Model cache was incomplete');
    const env={backends:{onnx:{wasm:{}}}};environments.push(env);return {pipeline:async()=>transcribe,env};
   }});
  }
  postMessage(data){inputs.push(data);void this.worker.onmessage({data});}
  terminate(){terminated++;}
 }
 class AudioContext{async decodeAudioData(){return {duration:1}}async close(){}}
 class OfflineAudioContext{createBufferSource(){return {connect(){},start(){}}}async startRendering(){return {getChannelData:()=>samples()}}}
 const ctx=vm.createContext({mediaURL,validWords,cleanRecognition,AudioContext,OfflineAudioContext,Worker,URL,DOMException,AbortSignal,Float32Array,setTimeout:(fn,ms)=>setTimeout(fn,ms===600?1:ms),clearTimeout});vm.runInContext(alignment,ctx);vm.runInContext(mediaSource,ctx);
 return {recognize:(options={})=>ctx.recognizeAudio(new Blob(['audio']),options),messages,inputs,environments,workers:()=>workers,workerURL:()=>workerURL,terminated:()=>terminated};
}
test('complete media → dedicated worker → recovery → alignment chain retains partial measured timings',async()=>{
 const h=await mediaHarness(async()=>({chunks:[{text:' Hello',timestamp:[.1,.4]},{text:' world',timestamp:[.5,null]}]}));
 const result=await h.recognize();assert.match(h.workerURL().pathname,/documentary\/narration-worker\.mjs$/);assert.match(h.workerURL().search,/speech-load3/);
 assert.equal(result.requiresReview,true);assert.equal(result.words.length,1);assert.equal(result.words[0].start,.1);assert.equal(result.issues[0].text,'world');assert.equal(h.terminated(),1);assert(!h.messages.some(m=>m.type==='error'));
});
test('media handoff survives persistent recognizer timestamp exceptions with no invented words',async()=>{
 const h=await mediaHarness(async()=>{throw new Error('Speech recognition returned an incomplete word timestamp.');});
 const result=await h.recognize();assert.equal(result.words.length,0);assert.equal(result.requiresReview,true);assert.equal(h.terminated(),1);assert(!h.messages.some(m=>m.type==='error'));
});
test('successful retry passes measured word timing through the full media handoff',async()=>{
 let calls=0;const h=await mediaHarness(async()=>({chunks:[{text:' Hello',timestamp:++calls===1?[.1,null]:[.1,.4]}]}));
 const result=await h.recognize();assert.equal(calls,2);assert.equal(result.requiresReview,false);assert.equal(result.words.length,1);assert.equal(result.words[0].end,.4);
});

test('worker startup failure recovers automatically using a fresh worker and the same full samples',async()=>{
 const h=await mediaHarness(async()=>({chunks:[{text:' Hello',timestamp:[.1,.4]}]}),{startupFailures:1});const progress=[];
 const result=await h.recognize({onProgress:t=>progress.push(t)});
 assert.equal(result.words.length,1);assert.equal(h.workers(),2);assert.equal(h.inputs.length,1);assert.equal(h.inputs[0].audio.length,16000);assert.equal(h.inputs[0].fresh,true);assert(progress.some(p=>/Recovering/.test(p)));
});
test('model load failure recovers without detached audio, changes of model, or fabricated timings',async()=>{
 const h=await mediaHarness(async()=>({chunks:[{text:' Hello',timestamp:[.1,.4]}]}),{runtimeFailures:1});
 const result=await h.recognize();assert.equal(result.words[0].start,.1);assert.equal(h.workers(),2);assert.equal(h.inputs.length,2);assert.notEqual(h.inputs[0].audio.buffer,h.inputs[1].audio.buffer);assert(h.inputs.every(x=>x.audio.length===16000));
 assert.equal(h.environments[0].useBrowserCache,false);assert.match(h.environments[0].backends.onnx.wasm.wasmPaths,/documentary\/vendor\/speech-3.8.1\/$/);
});
test('persistent bootstrap failure is bounded and explicitly preserves saved narration',async()=>{
 const h=await mediaHarness(async()=>({}),{startupFailures:10});await assert.rejects(()=>h.recognize(),/after recovery.*narration is saved/);assert.equal(h.workers(),2);
});
test('Stop during recovery cancels the fresh worker without starting another attempt',async()=>{
 const h=await mediaHarness(async()=>({}),{startupFailures:1}),control=new AbortController();
 await assert.rejects(()=>h.recognize({signal:control.signal,onProgress:t=>{if(/Recovering/.test(t))control.abort();}}),{name:'AbortError'});
 await new Promise(r=>setTimeout(r,8));assert.equal(h.workers(),1);
});
test('an inference error does not redownload the model or silently retry decoding',async()=>{
 const h=await mediaHarness(async()=>{throw new Error('ASR inference failed');});await assert.rejects(()=>h.recognize(),/ASR inference failed/);assert.equal(h.workers(),1);
});

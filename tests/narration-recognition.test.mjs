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
async function mediaHarness(transcribe){
 const alignment=await readFile(new URL('../public/visuals/narration-alignment.js',import.meta.url),'utf8');
 const workerSource=(await readFile(new URL('../public/documentary/narration-worker.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace("import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js')",'fakeRuntime()');
 const mediaSource=(await readFile(new URL('../public/documentary/narration-media.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/export /g,'').replaceAll('import.meta.url',JSON.stringify(new URL('../public/documentary/narration-media.js',import.meta.url).href));
 const messages=[];let workerURL,terminated=0;
 class Worker {
  constructor(url,opts){workerURL=url;assert.equal(opts.type,'module');const self={postMessage:data=>{messages.push(data);this.onmessage?.({data});}};this.worker=self;
   vm.runInNewContext(workerSource,{self,recognizeNarration,fakeRuntime:async()=>({pipeline:async()=>transcribe,env:{backends:{onnx:{wasm:{}}}}})});
  }
  postMessage(data){void this.worker.onmessage({data});}
  terminate(){terminated++;}
 }
 class AudioContext{async decodeAudioData(){return {duration:1}}async close(){}}
 class OfflineAudioContext{createBufferSource(){return {connect(){},start(){}}}async startRendering(){return {getChannelData:()=>samples()}}}
 const ctx=vm.createContext({mediaURL,validWords,cleanRecognition,AudioContext,OfflineAudioContext,Worker,URL,DOMException,AbortSignal,Float32Array,setTimeout,clearTimeout});vm.runInContext(alignment,ctx);vm.runInContext(mediaSource,ctx);
 return {recognize:(options={})=>ctx.recognizeAudio(new Blob(['audio']),options),messages,workerURL:()=>workerURL,terminated:()=>terminated};
}
test('complete media → dedicated worker → recovery → alignment chain retains partial measured timings',async()=>{
 const h=await mediaHarness(async()=>({chunks:[{text:' Hello',timestamp:[.1,.4]},{text:' world',timestamp:[.5,null]}]}));
 const result=await h.recognize();assert.match(h.workerURL().pathname,/documentary\/narration-worker\.mjs$/);assert.match(h.workerURL().search,/audio-recovery2/);
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

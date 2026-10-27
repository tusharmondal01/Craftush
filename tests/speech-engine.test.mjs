import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPages} from '../scripts/build-github-pages.mjs';
import {newNarrationProject,approveScript} from '../public/documentary/narration-core.js';
import {narrationFixture} from './helpers/narration-fixture.mjs';

test('Pages ships byte-exact local speech runtime and WASM at the worker-relative URLs',async()=>{
 execFileSync(process.execPath,[new URL('../scripts/prepare-speech-engine.mjs',import.meta.url).pathname]);
 const folder=await mkdtemp(join(tmpdir(),'craftush-speech-pages-'));
 try{
  await buildPages({destination:folder,backendURL:'https://craftush.tushar-mondal.workers.dev'});
  for(const name of ['transformers.min.js','ort-wasm-simd-threaded.jsep.mjs','ort-wasm-simd-threaded.jsep.wasm']){
   const built=await readFile(join(folder,'documentary/vendor/speech-3.8.1',name));
   assert(built.equals(await readFile(new URL('../node_modules/@huggingface/transformers/dist/'+name,import.meta.url))),name+' must not be rewritten by the Pages adapter');
  }
  const worker=await readFile(join(folder,'documentary/narration-worker.mjs'),'utf8');
  assert.match(worker,/import\('\.\/vendor\/speech-3\.8\.1\/transformers\.min\.js'\)/);
  assert(!worker.includes('cdn.jsdelivr.net'));assert(!/^import /m.test(worker),'bootstrap must catch module-load errors');
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('failed local analysis preserves paid narration and cannot submit a shot plan',async()=>{
 const p=newNarrationProject();p.script='Hello world. Our story.';approveScript(p);p.stage='voice';
 p.audio={key:crypto.randomUUID(),duration:6,urls:[],words:[],reviewed:false};const voiceTask=crypto.randomUUID();p.ledger={[voiceTask]:.3};
 const blob=new Blob(['saved narration']),f=await narrationFixture({project:p,media:{['narration-media-'+p.audio.key]:blob},recognize:async()=>{throw new Error('Audio analysis could not start after recovery. Your narration is saved; do not generate it again.');}});
 try{
  await f.trigger('analyzeAudio');assert.equal(f.calls.length,0);assert.equal(f.read().audio.key,p.audio.key);assert.equal(f.read().ledger[voiceTask],.3);
  assert.equal(f.records.get('narration-media-'+p.audio.key).size,blob.size);assert.equal(f.el('analyzeAudio').disabled,false);assert.equal(f.el('downloadAudio').disabled,false);assert.match(f.el('notice').textContent,/narration is saved/);
 }finally{f.close();}
});

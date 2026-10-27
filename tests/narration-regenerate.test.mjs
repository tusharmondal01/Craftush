import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {newNarrationProject,approveScript,validatePlan,videoPrompt,restoreNarrationProject} from '../public/documentary/narration-core.js';
import {buildNarrationTask} from '../netlify/lib/narration-tasks.js';
import {narrationFixture} from './helpers/narration-fixture.mjs';
import {until,deferred} from './helpers/documentary-fixture.mjs';
const script='Hello world. Our story.';
const plan=validatePlan({continuity:'Same forest at dawn',requests:[{shots:[{start:0,end:1.7,narration:'Hello',visual:'Dawn over a forest'},{start:1.7,end:3,narration:'world.',visual:'A wide forest view'}]},{shots:[{start:3,end:6,narration:'Our story.',visual:'A deer walks beneath trees'}]}]},6);
function completedProject(){
 const p=newNarrationProject();p.script=script;approveScript(p);p.stage='videos';p.plan=structuredClone(plan);p.audio={key:crypto.randomUUID(),duration:6,urls:[],words:[{text:'Hello',start:0,end:1},{text:'world',start:1,end:2},{text:'Our',start:3,end:4},{text:'story',start:4,end:6}],reviewed:true};
 p.clips=Object.fromEntries([1,2].map(i=>[i,{key:crypto.randomUUID(),taskUUID:crypto.randomUUID(),url:`https://vm.runware.ai/video/old-${i}.mp4`}]));
 for(const i of [1,2])p.tasks['video-'+i]={id:p.clips[i].taskUUID,fingerprint:'a'.repeat(64),status:'complete',started:new Date().toISOString()};
 p.final={key:crypto.randomUUID(),duration:6,size:10};return p;
}
const mediaFor=p=>Object.fromEntries([p.audio.key,p.final.key,...Object.values(p.clips).map(c=>c.key)].map(k=>['narration-media-'+k,new Blob(['old saved media'])]));
const select=(f,i)=>f.el('slotGrid').onclick({target:f.el('slotGrid').querySelector(`[data-slot="${i}"]`)});
const reply=b=>({data:[{taskUUID:b.taskUUID,videoURL:`https://vm.runware.ai/video/new-${b.scene}.mp4`,cost:.1}]});

test('video prompts anchor each shot to its own narration, timing and context while preserving old submissions byte-for-byte',()=>{
 const improved=videoPrompt(plan,1);assert.match(improved,/narration is authoritative/);assert.match(improved,/No temporal flicker/);assert.match(improved,/character identity/);assert.match(improved,/Shot 1, 0\.00–1\.70s/);assert.match(improved,/Shot 2, 1\.70–3\.00s/);assert(improved.includes('Hello'));assert(improved.includes('world.'));assert(!improved.includes('A deer walks'));
 assert.equal(createHash('sha256').update(videoPrompt(plan,1,{version:1})).digest('hex'),'63570a816aae66f00e70b40a5a7df3b5af5e252b83058a84a4cad87bb833b44c');
 const nearLimit=structuredClone(plan);nearLimit.continuity='c'.repeat(3200);const old=videoPrompt(nearLimit,1,{version:1}),fresh=videoPrompt(nearLimit,1);assert(old.length<=5000);assert(fresh.length<=5000);assert(fresh.includes(nearLimit.requests[0].shots[0].narration));assert(fresh.includes(nearLimit.continuity));
});
test('new video prompt versions preserve model, output format, dimensions, timing and motion settings',()=>{
 const b={action:'narration-video',taskUUID:crypto.randomUUID(),script,approvedScript:script,audioDuration:6,plan,scene:1};
 const old=buildNarrationTask(b),fresh=buildNarrationTask({...b,promptVersion:2,seed:12345});assert.equal(old.positivePrompt,videoPrompt(plan,1,{version:1}));assert.equal(fresh.positivePrompt,videoPrompt(plan,1));
 for(const key of ['taskUUID','model','width','height','duration','outputType','outputFormat','outputQuality'])assert.equal(fresh[key],old[key]);assert.deepEqual(fresh.settings,old.settings);assert.equal(old.seed,42);assert.equal(fresh.seed,12345);
 for(const seed of [-1,2147483648,1.5])assert.throws(()=>buildNarrationTask({...b,promptVersion:2,seed}),/seed/);
});
test('regenerate button sits immediately after Retry and only replaces the selected completed clip',async()=>{
 const p=completedProject(),f=await narrationFixture({project:p,media:mediaFor(p),reply});
 try{assert.equal(f.el('retryFailed').nextElementSibling.id,'regenerateScene');select(f,2);assert.match(f.el('regenerateHint').textContent,/Scene 02/);const old=f.read();await f.trigger('regenerateScene');const next=f.read();assert.equal(f.calls.length,1);assert.equal(f.calls[0].scene,2);assert.equal(f.calls[0].promptVersion,2);assert.notEqual(f.calls[0].seed,42);assert.notEqual(next.clips[2].key,old.clips[2].key);assert.deepEqual(next.clips[1],old.clips[1]);assert.deepEqual(next.audio,old.audio);assert.deepEqual(next.plan,old.plan);assert.equal(next.final,null);assert.equal(f.el('downloadFinal').disabled,true);assert(f.records.has('narration-media-'+old.clips[2].key));assert([...f.records.keys()].some(k=>k.startsWith('narration-archive-'+p.id+'-scene-2-')));assert.equal(next.tasks['video-2'].id,next.clips[2].taskUUID);assert.equal(next.tasks['video-2'].seed,f.calls[0].seed);}finally{f.close()}
});
test('a failed regeneration keeps the old playable clip and the old final cut',async()=>{
 const p=completedProject(),f=await narrationFixture({project:p,media:mediaFor(p),reply:b=>({errors:[{taskUUID:b.taskUUID,code:'providerFailure',message:'Provider failed'}]})});
 try{const old=f.read();assert.equal(f.el('downloadFinal').disabled,false);await f.trigger('regenerateScene');assert.deepEqual(f.read().clips,old.clips);assert.deepEqual(f.read().final,old.final);assert.equal(f.el('downloadFinal').disabled,false);assert.equal(f.read().tasks['regenerate-1'].status,'error');assert.equal(f.calls.length,1);}finally{f.close()}
});
test('stopped and reopened scene regeneration resumes the same UUID and seed without another paid submission',async()=>{
 const p=completedProject(),wait=deferred(),f=await narrationFixture({project:p,media:mediaFor(p),reply:()=>wait.promise});let saved,id,seed,records;
 try{const running=f.trigger('regenerateScene');await until(()=>f.calls.length===1);({taskUUID:id,seed}=f.calls[0]);f.trigger('stop');await running;saved=f.read();records=Object.fromEntries(f.records);assert.equal(saved.tasks['regenerate-1'].status,'paused');assert.deepEqual(saved.clips,p.clips);assert.equal(f.el('regenerateScene').textContent,'Resume selected scene');}finally{f.close()}
 const reopened=await narrationFixture({project:saved,media:records,reply});try{await reopened.trigger('regenerateScene');assert.equal(reopened.calls.length,1);assert.equal(reopened.calls[0].recoverOnly,true);assert.equal(reopened.calls[0].taskUUID,id);assert.equal(reopened.calls[0].seed,seed);assert.equal(reopened.read().clips[1].taskUUID,id);const restored=restoreNarrationProject(reopened.read());assert.equal(restored.tasks['video-1'].seed,seed);assert.equal(restored.tasks['video-1'].promptVersion,2);}finally{reopened.close()}
});
test('a media download failure resumes the completed replacement instead of paying for another render',async()=>{
 const p=completedProject();let downloads=0;const f=await narrationFixture({project:p,media:mediaFor(p),reply,fetchMedia:async()=>{if(++downloads===1)throw new Error('Download interrupted');return new Blob(['replacement']);}});
 try{await f.trigger('regenerateScene');const first=f.calls[0];assert.deepEqual(f.read().clips,p.clips);assert.equal(f.read().tasks['regenerate-1'].status,'complete');await f.trigger('regenerateScene');assert.equal(f.calls.length,2);assert.equal(f.calls[1].taskUUID,first.taskUUID);assert.equal(f.calls[1].seed,first.seed);assert.equal(f.calls[1].recoverOnly,true);assert.equal(f.read().clips[1].taskUUID,first.taskUUID);}finally{f.close()}
});
test('existing pending videos retain their original request body and UUID after the prompt upgrade',async()=>{
 const p=completedProject();delete p.clips[1];const body={action:'narration-video',script,approvedScript:script,audioDuration:6,plan:p.plan,scene:1},id=p.tasks['video-1'].id;p.tasks['video-1'].fingerprint=createHash('sha256').update(JSON.stringify(body)).digest('hex');p.tasks['video-1'].status='paused';
 const f=await narrationFixture({project:p,media:mediaFor(p),reply});try{await f.trigger('generateVideos');assert.equal(f.calls.length,1);assert.equal(f.calls[0].taskUUID,id);assert.equal(f.calls[0].recoverOnly,true);assert(!('promptVersion' in f.calls[0]));assert.equal(f.read().tasks['video-1'].promptVersion,1);}finally{f.close()}
});

test('each deliberate regeneration gets a fresh variation while a new video uses the enhanced prompt',async()=>{
 const p=completedProject(),f=await narrationFixture({project:p,media:mediaFor(p),reply});
 try{await f.trigger('regenerateScene');const first=f.calls[0];await f.trigger('regenerateScene');assert.equal(f.calls.length,2);assert.notEqual(f.calls[1].taskUUID,first.taskUUID);assert.notEqual(f.calls[1].seed,first.seed);assert.equal(f.calls[1].recoverOnly,false);}finally{f.close()}
 const fresh=completedProject();delete fresh.clips[1];delete fresh.tasks['video-1'];const next=await narrationFixture({project:fresh,media:mediaFor(fresh),reply});try{await next.trigger('generateVideos');assert.equal(next.calls.length,1);assert.equal(next.calls[0].promptVersion,2);assert.equal(next.calls[0].recoverOnly,false);}finally{next.close()}
});

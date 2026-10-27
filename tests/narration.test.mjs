import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {audioChunks,validatePlan,videoPrompt,newNarrationProject,approveScript,restoreNarrationProject,VOICES} from '../public/documentary/narration-core.js';
import {buildNarrationTask} from '../netlify/lib/narration-tasks.js';
import handler,{handleNarrationProject,recoverNarrationResult} from '../netlify/lib/narration-session.js';
import {withRuntime} from '../netlify/lib/runtime-context.js';
import {CraftushStorage,cloudflareStore} from '../cloudflare/storage.js';
import {narrationFixture} from './helpers/narration-fixture.mjs';
import {until,deferred} from './helpers/documentary-fixture.mjs';
const script='Hello world. Our story.';
const plan={continuity:'Same forest at dawn',requests:[{shots:[{start:0,end:1.7,narration:'Hello',visual:'Dawn over a forest'},{start:1.7,end:3,narration:'world.',visual:'A wide forest view'}]},{shots:[{start:3,end:6,narration:'Our story.',visual:'A deer walks beneath trees'}]}]};
const base=()=>({taskUUID:crypto.randomUUID(),script,approvedScript:script});
test('long speech chunks preserve the exact script within Gemini and Fish limits',()=>{for(const [model,config] of Object.entries(VOICES)){const original=('यह हमारी कहानी है। This is a connected thought. ').repeat(300).trim();const chunks=audioChunks(original,model);assert(chunks.length>1);assert(chunks.every(c=>(config.limitUnit==='bytes'?new TextEncoder().encode(c).length:c.length)<=config.limit));assert.equal(chunks.join(' ').replace(/\s+/g,' '),original.replace(/\s+/g,' '));}});
test('Claude requires exact approval and actual reviewed timestamps; video tasks reject disabled slots',()=>{
 assert.throws(()=>buildNarrationTask({...base(),action:'narration-voice',approvedScript:'old',audioModel:Object.keys(VOICES)[0],chunk:0}),/Approve/);
 const gemini=buildNarrationTask({...base(),action:'narration-voice',audioModel:Object.keys(VOICES)[0],chunk:0});assert.equal(gemini.speech.voice,'Charon');assert.equal(gemini.speech.text,script);assert.equal(gemini.outputFormat,'WAV');
 const fish=buildNarrationTask({...base(),action:'narration-voice',audioModel:Object.keys(VOICES)[1],chunk:0});assert.equal(fish.speech.voice,VOICES[fish.model].voice);
 assert.throws(()=>buildNarrationTask({...base(),action:'narration-plan',audioDuration:6,words:[]}),/timestamps/);
 const normalized=validatePlan(plan,6);assert.equal(normalized.disabledSlots,98);assert.equal(normalized.shotCount,3);assert.equal(normalized.requests.reduce((n,r)=>n+r.frames,0),180);
 const request=buildNarrationTask({...base(),action:'narration-video',audioDuration:6,plan,scene:1});assert.equal(request.settings.audio,false);assert.equal(request.settings.multiClip,true);assert.equal(request.duration,3);assert.equal(request.model,'pixverse:1@8');
 assert.throws(()=>buildNarrationTask({...base(),action:'narration-video',audioDuration:6,plan,scene:3}),/disabled/);
 for(const mutate of [p=>p.requests[1].shots[0].start=4,p=>p.requests[1].shots[0].end=7,p=>p.requests[1].shots[0].end=5]){const p=structuredClone(plan);mutate(p);assert.throws(()=>validatePlan(p,6));}
 assert.throws(()=>validatePlan({requests:Array(101).fill(plan.requests[0])},6));assert.match(videoPrompt(normalized,1),/Context only, do not speak/);
});
test('fractional shot boundaries do not accumulate frame drift',()=>{const p={requests:Array.from({length:80},(_,i)=>({shots:[{start:i*1.11,end:(i+1)*1.11,narration:'word',visual:'Relevant landscape'}]}))};const result=validatePlan(p,88.8);assert.equal(result.requests.reduce((n,r)=>n+r.frames,0),2664);});
test('script review pauses before voice; repeat feedback uses the last revision; approval completes only active clips',async()=>{
 let writes=0,assembled=0;const f=await narrationFixture({reply:b=>{if(b.action==='narration-script'||b.action==='narration-refine'){writes++;return {data:[{taskUUID:b.taskUUID,text:JSON.stringify({script}),cost:.01}]}}if(b.action==='narration-voice')return {data:[{taskUUID:b.taskUUID,audioURL:'https://am.runware.ai/audio/test.wav',cost:.02}]};if(b.action==='narration-plan')return {data:[{taskUUID:b.taskUUID,text:JSON.stringify(plan),cost:.01}]};if(b.action==='narration-video')return {data:[{taskUUID:b.taskUUID,videoURL:`https://vm.runware.ai/video/${b.scene}.mp4`,cost:.1}]};throw new Error('unexpected '+b.action)},assemble:async(clips,audio,p)=>{assert.equal(clips.length,2);assert.equal(p.requestCount,2);assembled++;return {blob:new Blob(['final']),duration:6}}});
 try{f.input('projectTitle','Forest');f.input('idea','A forest story');await f.trigger('writeScript');assert.equal(writes,1);assert.equal(f.read().stage,'script');assert(!f.read().approvedScript);assert.equal(f.calls.length,1);
 for(const feedback of ['Improve opening','Simplify ending']){f.input('scriptFeedback',feedback);await f.trigger('refineScript');const call=f.calls.at(-1);assert.equal(call.script,script);assert.equal(call.feedback,feedback)}
 assert.equal(f.calls.filter(c=>c.action==='narration-voice').length,0);await f.trigger('approveScript');assert.equal(f.el('notice').className,'notice');assert.equal(assembled,1);assert.equal(f.read().stage,'export');assert.equal(f.read().plan.disabledSlots,98);assert.equal(f.calls.filter(c=>c.action==='narration-video').length,2);assert.equal(f.el('slotGrid').querySelectorAll('button[disabled]').length,98);assert.equal(f.el('downloadFinal').disabled,false);
 const persisted=f.records.get('narration-project');assert(persisted.final.key);assert.equal(Object.keys(persisted.clips).length,2);assert(Math.abs(Object.values(persisted.ledger).reduce((a,b)=>a+b,0)-.26)<1e-8);
 f.input('scriptText','A new approved draft.');await f.trigger('saveScript');assert.equal(f.read().approvedScript,'');assert.equal(f.read().audio,null);assert.equal(f.el('downloadFinal').disabled,true);
 }finally{f.close()}
});
test('Stop and Resume poll the original script task without another generation',async()=>{
 const wait=deferred();const f=await narrationFixture({reply:b=>!b.recoverOnly?wait.promise:{data:[{taskUUID:b.taskUUID,text:JSON.stringify({script}),cost:.01}]}});
 try{f.input('idea','Forest');const running=f.trigger('writeScript');await until(()=>f.calls.length===1);const id=f.calls[0].taskUUID;f.trigger('stop');await running;assert.equal(f.read().tasks.script.status,'paused');await f.trigger('resumeStage');assert.equal(f.calls.filter(c=>!c.recoverOnly).length,1);assert.equal(f.calls[1].recoverOnly,true);assert.equal(f.calls[1].taskUUID,id);assert.equal(f.read().script,script);}finally{f.close()}
});
test('low-confidence audio pauses before any planning or video spend',async()=>{const p=newNarrationProject();p.script=script;approveScript(p);p.idea='Forest';const f=await narrationFixture({project:p,reply:b=>({data:[{taskUUID:b.taskUUID,audioURL:'https://am.runware.ai/audio/test.wav'}]}),recognize:async()=>({words:[{text:'Unrelated',start:0,end:6}]})});try{await f.trigger('resumeStage');assert.match(f.el('notice').textContent,/did not match/);assert.equal(f.read().audio.reviewed,false);assert.equal(f.calls.length,1)}finally{f.close()}});
test('restoring a project strips credentials and keeps uploaded replacement clips',()=>{const p=newNarrationProject();p.script=script;approveScript(p);p.audio={key:crypto.randomUUID(),duration:6,urls:[],words:[],reviewed:true};p.plan=plan;p.clips={1:{key:crypto.randomUUID(),url:''}};const clean=restoreNarrationProject({...p,apiKey:'never-save',projectToken:'never-export'});assert(!JSON.stringify(clean).includes('never-'));assert.equal(clean.clips[1].key,p.clips[1].key)});
function fixture(){const db=new DatabaseSync(':memory:');const storage={sql:{exec(query,...args){const stmt=db.prepare(query),rows=/^\s*SELECT/i.test(query)?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows}}},transactionSync(fn){db.exec('BEGIN');try{const x=fn();db.exec('COMMIT');return x}catch(e){db.exec('ROLLBACK');throw e}}};const obj=new CraftushStorage({storage});return {db,store:cloudflareStore({idFromName:x=>x,get:()=>obj})}}
test('keyless queue preserves models/UUID, forbids credentials, records once and stops dispatch',async()=>{
 const f=fixture(),settings={teamCode:'team'};await f.store.setJSON('settings',settings);let token;
 const call=async(body)=>withRuntime({},f.store,()=>handler(new Request('https://test/api/documentary-session',{method:'POST',headers:{'content-type':'application/json','x-team-code':'team'},body:JSON.stringify({projectToken:token,...body})})));
 try{token=(await (await call({action:'start',title:'Forest'})).json()).projectToken;const bridge=(action,extra={})=>handleNarrationProject(f.store,{action,projectToken:token,...extra},settings);
 const task={...base(),action:'narration-script',idea:'Forest'};assert.equal((await call({action:'task',request:task,apiKey:'secret'})).status,400);
 assert.equal((await call({action:'task',request:task})).status,200);const first=await bridge('prepare');assert.equal(first.taskUUID,task.taskUUID);assert.equal(first.request[0].model,'anthropic:claude@sonnet-4.6');assert(first.submissionRequired);assert.equal((await bridge('prepare')).submissionRequired,false);
 assert.equal((await call({action:'task',request:{...task,idea:'changed'}})).status,409);
 const result={taskUUID:task.taskUUID,text:JSON.stringify({script}),cost:.01};await bridge('record',{taskUUID:task.taskUUID,result});await bridge('record',{taskUUID:task.taskUUID,result});assert.equal((await bridge('read')).cost,.01);
 const recovered=await recoverNarrationResult(f.store,token,buildNarrationTask(task));assert.equal(recovered.data[0].text,result.text);await assert.rejects(()=>recoverNarrationResult(f.store,token,buildNarrationTask({...task,idea:'Changed'})),/different inputs/);
 const done=await (await call({action:'task',request:task})).json();assert.equal(done.data[0].text,result.text);
 const next={...base(),action:'narration-voice',audioModel:Object.keys(VOICES)[0],chunk:0};await call({action:'task',request:next});await call({action:'stop'});await assert.rejects(()=>bridge('prepare'),/stopped/);await call({action:'resume'});const voice=await bridge('prepare');assert.equal(voice.taskUUID,next.taskUUID);assert.equal(voice.request[0].speech.text,script);
 await bridge('record',{taskUUID:next.taskUUID,result:{taskUUID:next.taskUUID,text:JSON.stringify({audioURL:'https://am.runware.ai/audio/test.wav'}),cost:.02}});assert.equal((await (await call({action:'task',request:next})).json()).data[0].audioURL,'https://am.runware.ai/audio/test.wav');
 }finally{f.db.close()}
});

test('saved ChatGPT projects switch to website generation without discarding task IDs or script',()=>{
 const p=newNarrationProject();assert.equal(p.mode,'server');p.mode='chatgpt';p.script=script;approveScript(p);const id=crypto.randomUUID();p.tasks.script={id,fingerprint:'b'.repeat(64),status:'complete'};
 const restored=restoreNarrationProject(p);assert.equal(restored.mode,'server');assert.equal(restored.script,script);assert.equal(restored.approvedScript,script);assert.equal(restored.tasks.script.id,id);
});
test('website generation never asks for a ChatGPT command and blocks clearly without an admin key',async()=>{
 const f=await narrationFixture({reply:b=>({data:[{taskUUID:b.taskUUID,text:JSON.stringify({script})}]})});
 try{f.input('idea','Forest');await f.trigger('writeScript');assert(f.requests.every(r=>r.url==='/api/documentary'));assert.equal(f.el('handoff').hidden,true);assert.match(f.el('connectionStatus').textContent,/website generation ready/);assert.equal(f.read().script,script);}finally{f.close()}
 const missing=await narrationFixture({configured:false});try{missing.input('idea','Forest');await missing.trigger('writeScript');assert.match(missing.el('notice').textContent,/Runware API key in Admin/);assert.equal(missing.calls.length,0);}finally{missing.close()}
});

test('changing voice after Stop starts the selected voice and switching back recovers the original UUID',async()=>{
 const p=newNarrationProject();p.script=script;approveScript(p);const wait=deferred();
 const f=await narrationFixture({project:p,reply:b=>b.recoverOnly?{data:[{taskUUID:b.taskUUID,audioURL:'https://am.runware.ai/audio/test.wav'}]}:wait.promise});
 try{
  const first=f.trigger('generateVoice');await until(()=>f.calls.length===1);const original=f.calls[0];f.trigger('stop');await first;
  await f.change('voice','Achird');assert.equal(f.calls.length,1);assert.equal(f.read().approvedScript,script);
  const second=f.trigger('generateVoice');await until(()=>f.calls.length===2);assert.equal(f.calls[1].voice,'Achird');assert.notEqual(f.calls[1].taskUUID,original.taskUUID);assert.equal(f.calls[1].recoverOnly,false);f.trigger('stop');await second;
  const saved=f.read();assert(Object.values(saved.tasks).some(t=>t.id===original.taskUUID));const restored=restoreNarrationProject(saved);assert(Object.values(restored.tasks).some(t=>t.id===original.taskUUID));
  await f.change('voice','Charon');await f.trigger('generateVoice');assert.equal(f.calls[2].taskUUID,original.taskUUID);assert.equal(f.calls[2].recoverOnly,true);assert.equal(f.el('notice').className,'notice');assert(f.read().audio.key);
 }finally{f.close()}
});
test('reopened projects with changed voice or model recover without the old pending-task blocker',async()=>{
 for(const change of [['voice','Achird'],['audioModel','fishaudio:s2.1@pro']]){
  const p=newNarrationProject();p.script=script;approveScript(p);const wait=deferred();const original=await narrationFixture({project:p,reply:()=>wait.promise});let saved,oldID;
  try{const run=original.trigger('generateVoice');await until(()=>original.calls.length===1);oldID=original.calls[0].taskUUID;original.trigger('stop');await run;await original.change(...change);saved=original.read();}finally{original.close()}
  const reopened=await narrationFixture({project:saved,reply:b=>({data:[{taskUUID:b.taskUUID,audioURL:'https://am.runware.ai/audio/test.wav'}]})});
  try{await reopened.trigger('generateVoice');assert.equal(reopened.calls.length,1);assert.notEqual(reopened.calls[0].taskUUID,oldID);assert.equal(reopened.calls[0].recoverOnly,false);assert.equal(reopened.el('notice').className,'notice');assert(reopened.read().audio.key);assert(Object.values(reopened.read().tasks).some(t=>t.id===oldID));}finally{reopened.close()}
 }
});

test('Gemini splits Hindi by UTF-8 bytes and every backend speech request preserves all text',()=>{
 const model='google:gemini@3.1-flash-tts';const original=('टाइटैनिक की उस रात की कहानी। Ocean 🌊 और जहाज़। ').repeat(70).trim();assert(original.length<4000);assert(new TextEncoder().encode(original).length>4000);
 const chunks=audioChunks(original,model);assert(chunks.length>1);assert.equal(chunks.join(' ').replace(/\s+/g,' '),original.replace(/\s+/g,' '));
 for(let chunk=0;chunk<chunks.length;chunk++){const task=buildNarrationTask({...base(),script:original,approvedScript:original,action:'narration-voice',audioModel:model,chunk});assert.equal(task.speech.text,chunks[chunk]);assert(new TextEncoder().encode(task.speech.text).length<=4000);assert(!task.speech.text.includes('�'));}
 assert.equal(audioChunks('a'.repeat(4000),model).length,1);
});
test('old rejected narration parts get new IDs when byte-safe chunk contents change',async()=>{
 const p=newNarrationProject();p.script=script;approveScript(p);const wait=deferred();const old=await narrationFixture({project:p,reply:()=>wait.promise});let saved,id;
 try{const run=old.trigger('generateVoice');await until(()=>old.calls.length===1);id=old.calls[0].taskUUID;old.trigger('stop');await run;saved=old.read();saved.tasks['voice-0'].fingerprint='f'.repeat(64);saved.tasks['voice-0'].status='error';saved.tasks['voice-0'].error='Invalid speech[text]: maximum 4000 bytes';}finally{old.close()}
 const f=await narrationFixture({project:saved,reply:b=>({data:[{taskUUID:b.taskUUID,audioURL:'https://am.runware.ai/audio/test.wav'}]})});try{await f.trigger('generateVoice');assert.notEqual(f.calls[0].taskUUID,id);assert.equal(f.calls[0].chunkText,script);assert.equal(f.calls[0].recoverOnly,false);assert(f.read().audio.key);}finally{f.close()}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { DEFAULTS, validateSettings, sheetSelection, episodeFromRow, validateScript, validateReviewedScript, scriptPrompt, researchPrompt } from '../public/visuals/automation-config.mjs';
import adminHandler from '../netlify/edge-functions/admin.js';
import handler, { digest, cleanTask, validateResearch, readEpisode, validateGoogleCredential } from '../netlify/lib/visuals-automation.js';
import { handleVisualProject } from '../netlify/lib/visuals-chatgpt.js';
import { withRuntime } from '../netlify/lib/runtime-context.js';
import { CraftushStorage, cloudflareStore } from '../cloudflare/storage.js';
const sample={id:'a'.repeat(64),episode:{title:'Great Indian Bustard',track:'Rare & Endangered Animals',subtrack:"India's Endangered Animals"},config:{...DEFAULTS,enabled:true},textModel:'anthropic:claude@sonnet-4.6',createdAt:'2026-10-23T00:00:00Z'};
const research={sources:[{title:'Official conservation programme',url:'https://example.org/conservation'},{title:'Species assessment',url:'https://example.org/species'}],facts:[{claim:'A grassland bird.',sourceURL:'https://example.org/conservation'},{claim:'Habitat is important.',sourceURL:'https://example.org/species'},{claim:'Protect nesting areas.',sourceURL:'https://example.org/species'}]};
function fixture(){const db=new DatabaseSync(':memory:');const storage={sql:{exec(query,...args){const statement=db.prepare(query);const rows=/^\s*SELECT/i.test(query)?statement.all(...args):(statement.run(...args),[]);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};const object=new CraftushStorage({storage});return {db,store:cloudflareStore({idFromName:x=>x,get:()=>object})};}
const body=(action,extra={})=>new Request('https://worker.test/api/visuals-automation',{method:'POST',headers:{'content-type':'application/json','x-team-code':'team'},body:JSON.stringify({action,jobId:sample.id,...extra})});
const env={RUNWARE_API_KEY:'fixture-provider',ADMIN_PASSWORD:'fixture-admin'};
const invoke=(f,request)=>withRuntime(env,f.store,()=>handler(request),{limitRunware:async()=>null});
test('sheet selection resolves the explicit tab and exact C–G row, leaving blanks optional',()=>{const selection=sheetSelection({sheetURL:'https://docs.google.com/spreadsheets/d/example/edit?gid=999',tab:"Birds' stories",row:2});assert.equal(selection.range,"'Birds'' stories'!C2:G2");const episode=episodeFromRow([['Wildlife','India',null,null,'Great Indian Bustard']],selection);assert.equal(episode.category,'');assert.equal(episode.title,'Great Indian Bustard');assert.throws(()=>sheetSelection({sheetURL:'https://evil.test',tab:'Birds',row:2}));assert.throws(()=>sheetSelection({sheetURL:'https://docs.google.com/spreadsheets/d/example',tab:'Birds',row:'2:2'}));assert.throws(()=>episodeFromRow([['Wildlife']],selection));});
test('shared settings validate choices and never accept credential or model substitution',()=>{assert.equal(validateSettings({voice:'hindi_male_1_v2'}).voice,'hindi_male_1_v2');assert.throws(()=>validateSettings({fps:'13'}));assert.throws(()=>validateSettings({conc:9}));assert.throws(()=>validateSettings({audioModel:'unknown:audio@1'}));assert.throws(()=>validateSettings({scriptInstructions:''}));assert(!('apiKey' in validateSettings({apiKey:'private'})));});
test('script constraints and source checks stop unsupported output before narration',()=>{assert.throws(()=>validateScript({script:'too short',hookType:'Myth Buster'}));assert.throws(()=>validateScript({script:'word '.repeat(451),hookType:'Myth Buster'}));assert.throws(()=>validateScript({script:'word '.repeat(100)+'—',hookType:'Myth Buster'}));assert.equal(validateScript({script:'word '.repeat(100),hookType:'Myth Buster'}).words,100);assert.equal(validateResearch(research).sources.length,2);assert.throws(()=>validateResearch(research,['https://example.org/species']));assert.throws(()=>validateResearch({sources:[{url:'javascript:alert(1)'}],facts:[]}));assert.match(scriptPrompt(sample.episode,research,DEFAULTS),/Great Indian Bustard/);});
test('automatic provider task sanitization preserves image model and strips caller secrets and tools',()=>{const t=cleanTask({taskType:'imageInference',model:'openai:gpt-image@2',positivePrompt:'bird',numberResults:100,apiKey:'private',webhookURL:'https://evil.test',uploadEndpoint:'https://evil.test'});assert.equal(t.numberResults,1);assert.equal(t.model,'openai:gpt-image@2');assert.equal(t.outputType,'URL');assert(!t.apiKey&&!t.webhookURL&&!t.uploadEndpoint);const text=cleanTask({taskType:'textInference',model:'anthropic:claude@sonnet-4.6',messages:[{role:'user',content:'script'}],tools:[{type:'search'}],settings:{temperature:1,maxTokens:9000}});assert.equal(text.settings.maxTokens,8000);assert(!('temperature' in text.settings));assert(!text.tools);assert.throws(()=>cleanTask({taskType:'authentication'}));});
test('private Google connection reads only named tab C–G and uses readonly scope',async()=>{const original=global.fetch;const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const credential={type:'service_account',client_email:'reader@project.iam.gserviceaccount.com',private_key:privateKey.export({format:'pem',type:'pkcs8'})};const calls=[];global.fetch=async(url,opts)=>{calls.push(String(url));if(String(url).includes('oauth2.googleapis.com')){const jwt=new URLSearchParams(opts.body).get('assertion');const payload=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url'));assert.equal(payload.scope,'https://www.googleapis.com/auth/spreadsheets.readonly');return Response.json({access_token:'fixture-token'});}assert.equal(opts.headers.authorization,'Bearer fixture-token');if(String(url).includes('/values/')){assert.match(decodeURIComponent(String(url)),/Rare & Endangered Animals.*C2:G2/);return Response.json({values:[['Rare & Endangered Animals',"India's Endangered Animals",null,null,'Great Indian Bustard']]});}return Response.json({sheets:[{properties:{title:'Rare & Endangered Animals',sheetId:42}}]});};try{const selection=sheetSelection({sheetURL:'https://docs.google.com/spreadsheets/d/example',tab:'Rare & Endangered Animals',row:2});assert.equal((await readEpisode(selection,credential)).title,'Great Indian Bustard');assert.equal(calls.length,3);await assert.rejects(()=>readEpisode(selection,null),/Connect Google Sheets/);assert.throws(()=>validateGoogleCredential({...credential,type:'authorized_user'}));}finally{global.fetch=original;}});
async function connected(f,conc=DEFAULTS.conc){
 const settings={teamCode:'team',visualsAutomation:{...DEFAULTS,enabled:true}};await f.store.setJSON('settings',settings);
 const token='c'.repeat(64);await f.store.automation('start',{...sample,config:{...sample.config,conc},tokenHash:await digest(token),expiresAt:new Date(Date.now()+86400000).toISOString(),connection:'chatgpt'});
 const bridge=(action,extra={})=>handleVisualProject(f.store,{action,projectToken:token,...extra},settings);
 return bridge;
}
test('atomic ChatGPT handoff dispatches once, preserves uncertain UUIDs and counts results once without provider fetch',async()=>{
 const f=fixture(),original=global.fetch;global.fetch=()=>{throw new Error('Provider credentials must never leave the website');};
 try{
  const bridge=await connected(f),task={taskType:'imageInference',model:'openai:gpt-image@2',positivePrompt:'A bustard in grassland'};
  const pending=await (await invoke(f,body('task',{task}))).json();assert.equal(pending.pending,true);
  const preparations=await Promise.all([bridge('prepare'),bridge('prepare')]);assert.equal(preparations.filter(p=>p.submissionRequired).length,1);
  assert.equal(preparations.find(p=>p.submissionRequired).request[0].settings.quality,'high','Shared admin quality reaches GPT Image 2');
  assert.equal(preparations[0].taskUUID,preparations[1].taskUUID);assert.equal(preparations[0].taskUUID,pending.taskUUID);
  const result={taskUUID:pending.taskUUID,text:JSON.stringify({imageURL:'https://im.runware.ai/image/test.jpg'}),cost:.05};
  await bridge('record',{taskUUID:pending.taskUUID,result});await bridge('record',{taskUUID:pending.taskUUID,result});
  const done=await (await invoke(f,body('task',{task}))).json();assert.equal(done.data[0].cost,.05);
  assert.equal((await f.store.automation('get',{id:sample.id})).job.cost,.05);
  assert.equal((await f.store.automation('usage',{})).images,1);
  await assert.rejects(()=>bridge('record',{taskUUID:pending.taskUUID,result:{...result,cost:9}}),/different result/);
 }finally{global.fetch=original;f.db.close();}
});
for(const conc of [1,3,5,8])test(`image-stage dispatch respects shared concurrency ${conc} and never resubmits an uncertain UUID`,async()=>{
 const f=fixture();try{
  const bridge=await connected(f,conc);
  await f.store.automation('checkpoint',{id:sample.id,checkpoint:{phase:4,items:[]}});
  for(let i=0;i<=conc;i++)await invoke(f,body('task',{task:{taskType:'imageInference',model:'openai:gpt-image@2',positivePrompt:'Grassland view '+i}}));
  const prepared=await Promise.all(Array.from({length:conc+1},()=>bridge('prepare')));
  const submitted=prepared.filter(p=>p.submissionRequired);assert.equal(submitted.length,conc);assert.equal(new Set(submitted.map(p=>p.taskUUID)).size,conc);
  const polling=prepared.find(p=>!p.submissionRequired);assert(polling);assert(submitted.some(p=>p.taskUUID===polling.taskUUID));
  assert.equal(prepared[0].maxInFlight,conc);
  await bridge('record',{taskUUID:submitted[0].taskUUID,result:{taskUUID:submitted[0].taskUUID,text:JSON.stringify({imageURL:'https://im.runware.ai/image/complete.jpg'}),cost:.1}});
  const fourth=await bridge('prepare');assert.equal(fourth.submissionRequired,true);assert(!submitted.some(p=>p.taskUUID===fourth.taskUUID));
 }finally{f.db.close();}
});
test('complete research, script and male narration preserve models and use only recorded ChatGPT outputs',async()=>{
 const f=fixture();try{
  const bridge=await connected(f),calls=[];
  const finish=async(action,text,cost)=>{
   const pending=await (await invoke(f,body(action))).json(),prepared=await bridge('prepare');calls.push(prepared.request[0]);
   await bridge('record',{taskUUID:pending.taskUUID,result:{taskUUID:pending.taskUUID,text,cost}});
   return (await invoke(f,body(action))).json();
  };
  assert.equal((await invoke(f,body('speech'))).status,400);
  await finish('research',JSON.stringify(research),.01);
  const script='शानदार कहानी '.repeat(50).trim();assert.equal((await finish('script',JSON.stringify({script,hookType:'Myth Buster'}),.01)).pending,true);
  assert.equal((await invoke(f,body('speech'))).status,400,'An unreviewed draft cannot be narrated');
  const review=await bridge('prepare');assert.equal(review.kind,'scriptReview');calls.push(review.request[0]);
  await bridge('record',{taskUUID:review.taskUUID,result:{taskUUID:review.taskUUID,text:JSON.stringify({script,hookType:'Myth Buster',claimChecks:research.facts}),cost:.01}});
  assert.equal((await (await invoke(f,body('script'))).json()).words,100);
  await finish('speech',JSON.stringify({audioURL:'https://am.runware.ai/audio/test.mp3'}),.1);
  assert.equal(calls[0].tools[0].type,'search');assert.equal(calls[1].model,sample.textModel);
  assert.equal(calls[3].speech.voice,'hindi_male_1_v2');assert.equal(calls[3].speech.text,script);
  assert.ok(Math.abs((await f.store.automation('get',{id:sample.id})).job.cost-.13)<1e-8);
  const second=(await f.store.automation('start',{...sample,id:'b'.repeat(64)})).job;assert.equal(second.previousHook,'Myth Buster');assert.equal(second.usedSources.length,2);
 }finally{f.db.close();}
});
test('keyless Start binds an exact private sheet row, hides token hashes and rejects credential fields',async()=>{
 const f=fixture(),original=global.fetch;global.fetch=()=>{throw new Error('No Google or Runware key is required');};
 try{
  const settings={teamCode:'team',visualsAutomation:{...DEFAULTS,enabled:true}};await f.store.setJSON('settings',settings);
  const response=await invoke(f,body('start',{sheetURL:'https://docs.google.com/spreadsheets/d/example/edit?gid=999',tab:'Rare & Endangered Animals',row:2}));assert.equal(response.status,200);
  const {job,projectToken}=await response.json();assert(!job.tokenHash);assert(!job.episode);
  const bridge=(action,extra={})=>handleVisualProject(f.store,{action,projectToken,...extra},settings);
  const prepared=await bridge('prepare');assert.equal(prepared.kind,'sheetRead');assert.equal(prepared.selection.range,"'Rare & Endangered Animals'!C2:G2");
  const result={taskUUID:prepared.taskUUID,text:JSON.stringify({values:[['Wildlife','India',null,null,'Great Indian Bustard']]})};
  await bridge('record',{taskUUID:prepared.taskUUID,result});assert.equal((await f.store.automation('get',{id:job.id})).job.episode.title,'Great Indian Bustard');
  assert.equal((await f.store.automation('usage',{})).prompts,0);
  await assert.rejects(()=>bridge('record',{taskUUID:prepared.taskUUID,result:{...result,apiKey:'secret'}}),/credentials/);
  assert.equal((await invoke(f,body('get',{jobId:job.id,apiKey:'secret'}))).status,400);
 }finally{global.fetch=original;f.db.close();}
});
test('Stop blocks dispatch, Resume rotates connection and stale task IDs cannot overwrite retried tasks',async()=>{
 const f=fixture();try{
  const bridge=await connected(f),task={taskType:'imageInference',model:'openai:gpt-image@2',positivePrompt:'grassland'};
  await invoke(f,body('task',{task}));await invoke(f,body('stop'));await assert.rejects(()=>bridge('prepare'),/stopped/);
  const resumed=await (await invoke(f,body('resume'))).json();assert.equal(await bridge('read'),null);
  const settings=await f.store.get('settings',{type:'json'}),newBridge=(action,extra={})=>handleVisualProject(f.store,{action,projectToken:resumed.projectToken,...extra},settings);
  const p=await newBridge('prepare');await newBridge('record',{taskUUID:p.taskUUID,result:{taskUUID:p.taskUUID,error:'confirmed failure'}});
  assert.equal((await invoke(f,body('task',{task}))).status,422);
  const next=await (await invoke(f,body('task',{task,retry:true}))).json();assert.notEqual(next.taskUUID,p.taskUUID);
  await assert.rejects(()=>newBridge('record',{taskUUID:p.taskUUID,result:{taskUUID:p.taskUUID,text:JSON.stringify({imageURL:'https://im.runware.ai/stale.jpg'})}}),/Prepare this task/);
 }finally{f.db.close();}
});
test('team authentication and disabled automation prevent any paid tasks',async()=>{const f=fixture();try{await f.store.setJSON('settings',{teamCode:'secret',visualsAutomation:{...DEFAULTS,enabled:true}});assert.equal((await invoke(f,body('speech'))).status,401);await f.store.setJSON('settings',{visualsAutomation:{enabled:false}});assert.equal((await invoke(f,body('speech'))).status,409);}finally{f.db.close();}});

test('admin totals include automation-only work, redact Google credentials, and reset without deleting saved run costs',async()=>{const f=fixture();try{
await f.store.setJSON('settings',{visualsGoogle:{client_email:'reader@project.iam.gserviceaccount.com',private_key:'private-key-must-never-leak'}});
await f.store.automation('start',sample);await f.store.automation('claim',{key:'usage-fixture',jobId:sample.id,taskUUID:crypto.randomUUID()});await f.store.automation('complete',{key:'usage-fixture',result:{data:[]},cost:.1,taskType:'audioInference'});
const call=action=>withRuntime(env,f.store,()=>adminHandler(new Request('https://worker.test/api/admin',{method:'POST',headers:{'content-type':'application/json','x-admin-password':env.ADMIN_PASSWORD},body:JSON.stringify({action})})),{limitRunware:async()=>null});
const first=await (await call('get')).json();assert.equal(first.usage.cost,.1);assert.equal(first.visualsAutomationUsage.audio,1);assert.equal(first.visualsGoogle.email,'reader@project.iam.gserviceaccount.com');assert(!JSON.stringify(first).includes('private-key-must-never-leak'));
const reset=await (await call('resetUsage')).json();assert.equal(reset.usage.cost,0);assert.equal((await f.store.automation('get',{id:sample.id})).job.cost,.1);
}finally{f.db.close();}});

test('research date is frozen across an overnight Resume',()=>{assert.match(researchPrompt(sample.episode,[],'2026-10-23'),/as of 2026-10-23/);});
test('a date in review metadata cannot disguise an undated spoken population statistic',()=>{
 const evidence={...research,facts:[{claim:'The population estimate was 140 individuals.',asOf:'2025',sourceURL:research.sources[0].url}]};
 const draft={hookType:'Uncomfortable Statistic',script:'Only 140 remain. '+'word '.repeat(100),claimChecks:research.facts,issuesRemoved:['Dated the 2025 estimate']};
 assert.throws(()=>validateReviewedScript(draft,evidence),/source year 2025/);
 assert.doesNotThrow(()=>validateReviewedScript({...draft,script:'The 2025 report estimated 140 birds. '+'word '.repeat(100)},evidence));
 assert.throws(()=>validateReviewedScript({...draft,script:'१४० बचे हैं। '+'शब्द '.repeat(100)},evidence),/source year 2025/);
});
test('truncated text is charged once and recovered with a larger output budget without losing context',async()=>{
 const f=fixture();try{
  const bridge=await connected(f),task={taskType:'textInference',model:sample.textModel,messages:[{role:'user',content:'Full episode context and six scene directions'}],settings:{maxTokens:3700}};
  await invoke(f,body('task',{task}));const first=await bridge('prepare');
  await bridge('record',{taskUUID:first.taskUUID,result:{taskUUID:first.taskUUID,text:'[{"line":1',finishReason:'length',cost:.06}});
  assert.equal((await (await invoke(f,body('task',{task}))).json()).pending,true);
  const expanded=await bridge('prepare');assert.equal(expanded.request[0].settings.maxTokens,7400);assert.deepEqual(expanded.request[0].messages,task.messages);assert.notEqual(expanded.taskUUID,first.taskUUID);
  await bridge('record',{taskUUID:expanded.taskUUID,result:{taskUUID:expanded.taskUUID,text:'[{"line":1}]',finishReason:'stop',cost:.08}});
  const final=await (await invoke(f,body('task',{task}))).json();assert.equal(final.data[0].text,'[{"line":1}]');assert.equal((await f.store.automation('get',{id:sample.id})).job.cost,.14);
 }finally{f.db.close();}
});

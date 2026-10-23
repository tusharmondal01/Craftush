import { openStore, readSettings, safeEqual, json, fail, MODEL_ID, textModel, cleanMessage } from './shared.js';
import { rejectVisualSecrets, randomCode, publicVisualJob } from './visuals-chatgpt.js';
import { validateSettings, sheetSelection, episodeFromRow, researchPrompt, scriptPrompt, scriptReviewPrompt, validateReviewedScript, validateScript, parseObject } from '../../public/visuals/automation-config.mjs';
const encode=new TextEncoder();
export const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encode.encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
const validated=fn=>{try{return fn();}catch(error){throw bad(error.message);}};
export function validateGoogleCredential(value) {
 if(value?.type!=='service_account'||!/^.+@.+\.iam\.gserviceaccount\.com$/.test(value.client_email||'')||typeof value.private_key!=='string'||value.private_key.length>12000||!value.private_key.startsWith('-----BEGIN PRIVATE KEY-----'))throw bad('Choose a Google service-account JSON key.');
 return {type:'service_account',client_email:value.client_email,private_key:value.private_key};
}
export async function googleToken(credential) {
 const c=validateGoogleCredential(credential),base64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
 const part=v=>base64(encode.encode(JSON.stringify(v))),now=Math.floor(Date.now()/1000);
 const message=part({alg:'RS256',typ:'JWT'})+'.'+part({iss:c.client_email,scope:'https://www.googleapis.com/auth/spreadsheets.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
 const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(c.private_key.replace(/-----[^-]+-----|\s/g,'')),x=>x.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encode.encode(message));
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:message+'.'+base64(new Uint8Array(signature))}),signal:AbortSignal.timeout(15000)});
 const data=await response.json();if(!response.ok||!data.access_token)throw bad('Google connection failed. Check the service-account key and enable the Google Sheets API.',503);
 return data.access_token;
}
export async function readEpisode(selection,credential) {
 if(!credential)throw bad('Connect Google Sheets in Admin → Visuals automation, then share this sheet with the displayed service-account email as Viewer.',409);
 const token=await googleToken(credential),url=`https://sheets.googleapis.com/v4/spreadsheets/${selection.id}`;
 const headers={authorization:'Bearer '+token};
 const meta=await fetch(url+'?fields=sheets.properties(title,sheetId)',{headers,signal:AbortSignal.timeout(15000)});
 if(!meta.ok)throw bad('The website cannot read this sheet. Share it with the Google connection email as Viewer.',403);
 const tabs=(await meta.json()).sheets||[];
 if(!tabs.some(t=>t.properties?.title===selection.tab))throw bad('Tab not found. Enter its exact name; the link’s gid does not override the tab name.');
 const response=await fetch(url+'/values/'+encodeURIComponent(selection.range),{headers,signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw bad('Google could not read columns C–G for this row.',502);
 return episodeFromRow((await response.json()).values,selection);
}
export function validateResearch(value,used=[]) {
 if(value?.error)throw bad(String(value.error).slice(0,400));
 const validURL=x=>{try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
 const sources=(value?.sources||[]).filter(s=>s&&typeof s.title==='string'&&validURL(s.url)&&!used.includes(s.url));
 const urls=new Set(sources.map(s=>s.url));
 const facts=(value?.facts||[]).filter(f=>f&&typeof f.claim==='string'&&urls.has(f.sourceURL));
 if(urls.size<2||facts.length<3)throw bad('Research needs at least two fresh source URLs and three supported facts. No script was sent to narration.');
 return {sources:sources.slice(0,12),facts:facts.slice(0,16),checkedAt:new Date().toISOString()};
}
export function cleanTask(task) {
 if(!task||!['textInference','imageInference'].includes(task.taskType)||!MODEL_ID.test(String(task.model||'')))throw bad('Unsupported automation task.');
 const {apiKey,tools,toolChoice,webhookURL,uploadEndpoint,ttl,taskUUID,strictModel,...t}=task;
 if(t.taskType==='textInference'){
  if(!Array.isArray(t.messages)||!t.messages.length)throw bad('Text messages are required.');
  const {temperature,...settings}=t.settings||{};t.settings={...settings,maxTokens:Math.min(8000,Math.max(1,+settings.maxTokens||4000))};t.deliveryMethod='sync';
 }else {t.numberResults=1;t.outputType='URL';t.outputFormat='JPG';t.deliveryMethod='async';}
 t.includeCost=true;return t;
}
// Queue only: provider credentials and generation stay in the ChatGPT Runware connection.
async function providerTask(store,job,task,kind,retry=false) {
 rejectVisualSecrets(task);
 if(JSON.stringify(task).length>82000)throw bad('This task exceeds the ChatGPT handoff size. Reduce prompt batch size before retrying.',413);
 const fingerprint=await digest(task),key=job.id+':'+kind+':'+fingerprint;
 const claim=await store.automation('claim',{key,jobId:job.id,taskUUID:crypto.randomUUID(),task,kind,retry});
 if(claim.record.state==='done'){
  if(claim.record.result.data?.some(x=>x.taskType==='textInference'&&x.finishReason==='length')){
   const maxTokens=Number(task.settings?.maxTokens)||4000;
   if(maxTokens>=8000)throw bad('The text model reached its output limit. Reduce the prompt batch size before retrying.',422);
   return providerTask(store,job,{...task,settings:{...task.settings,maxTokens:Math.min(8000,maxTokens*2)}},kind+':expanded',retry);
  }
  return {...claim.record.result,cached:true};
 }
 if(claim.record.state==='error')throw bad(claim.record.message,422);
 return {pending:true,taskUUID:claim.record.taskUUID,connection:'chatgpt',message:'Waiting for your connected ChatGPT session.'};
}
export default async function visualsAutomation(req){
 try{
  const store=openStore(),settings=await readSettings(store),config=validateSettings(settings.visualsAutomation||{});
  if(req.headers.has('authorization'))throw bad('Provider credentials are not accepted.',400);
  if(req.method==='GET')return json({config,connection:'chatgpt',keyRequired:false,configured:true,version:'visuals-chatgpt-1'});
  if(req.method!=='POST')return fail('Method not allowed',405);
  if(settings.teamCode&&!safeEqual(req.headers.get('x-team-code')||'',settings.teamCode))return fail('Enter your team access code.',401);
  if(!config.enabled)throw bad('Enable Visuals automation in Admin after saving the shared settings.',409);
  if(!store.automation)throw bad('Visuals automation needs the updated Cloudflare backend.',503);
  const raw=await req.text();if(raw.length>12000000)throw bad('Request too large.',413);const body=validated(()=>JSON.parse(raw));rejectVisualSecrets(body);
  if(body.action==='start'){
   const selection=validated(()=>sheetSelection(body)),model=MODEL_ID.test(body.textModel||'')?body.textModel:textModel(settings);
   const splitMode=body.splitMode==='smart'?'smart':'stops',imageModel=MODEL_ID.test(body.imageModel||'')?body.imageModel:'openai:gpt-image@2';
   const pace=['scene','count','fast','vfast','relaxed'].includes(body.pace)?body.pace:'scene';
   const minImg=Math.min(500,Math.max(2,Math.round(+body.minImg||60))),maxImg=Math.min(500,Math.max(minImg,Math.round(+body.maxImg||70)));
   const projectToken=randomCode(),id=randomCode(),tokenHash=await digest(projectToken),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+86400000).toISOString();
   const {job}=await store.automation('start',{id,selection,config,textModel:model,splitMode,imageModel,pace,minImg,maxImg,createdAt,expiresAt,tokenHash,connection:'chatgpt'});
   await store.automation('claim',{key:id+':sheet',jobId:id,taskUUID:crypto.randomUUID(),kind:'sheet',task:{taskType:'sheetRead',selection}});
   return json({job:publicVisualJob(job),projectToken});
  }
  if(!/^[a-f0-9]{64}$/.test(String(body.jobId||'')))throw bad('Invalid automation run.');
  const {job}=await store.automation('get',{id:body.jobId});if(!job)throw bad('Automation run not found.',404);
  if(body.action==='get')return json({job:publicVisualJob(job)});
  if(body.action==='stop')return json({job:publicVisualJob((await store.automation('stop',{id:job.id})).job)});
  if(body.action==='resume'){
   const projectToken=randomCode(),tokenHash=await digest(projectToken),expiresAt=new Date(Date.now()+86400000).toISOString();
   const resumed=await store.automation('resume',{id:job.id,tokenHash,expiresAt});return json({job:publicVisualJob(resumed.job),projectToken});
  }
  if(body.action==='checkpoint'){
   const checkpoint=body.checkpoint;if(JSON.stringify(checkpoint).length>1000000)throw bad('Checkpoint too large.',413);
   return json({job:publicVisualJob((await store.automation('checkpoint',{id:job.id,checkpoint})).job)});
  }
  if(job.stopped)throw bad('This project is stopped. Resume it on Craftush.',409);
  if(Date.parse(job.expiresAt)<=Date.now())throw bad('The ChatGPT connection expired. Resume to create a new command.',410);
  if(!job.episode)throw bad('Read the selected sheet row through ChatGPT first.',409);
  let task,kind=body.action;
  if(kind==='research'&&job.research)return json({research:job.research,cached:true});
  if(kind==='script'&&job.script)return json({script:job.script,hookType:job.hookType,words:job.words,cached:true});
  if(kind==='research')task={taskType:'textInference',model:job.config.researchModel,includeCost:true,deliveryMethod:'sync',settings:{maxTokens:5000},tools:[{type:'search'}],toolChoice:{type:'any'},messages:[{role:'user',content:researchPrompt(job.episode,job.usedSources,job.createdAt.slice(0,10))}]};
  else if(kind==='script'){
   if(!job.research)throw bad('Complete source research first.');
   task={taskType:'textInference',model:job.textModel,includeCost:true,deliveryMethod:'sync',settings:{maxTokens:5000},messages:[{role:'user',content:scriptPrompt(job.episode,job.research,job.config,job.previousHook)}]};
  }else if(kind==='speech'){
   if(!job.script)throw bad('Complete the script first.');
   task={taskType:'audioInference',model:job.config.audioModel,speech:{text:job.script,voice:job.config.voice},settings:{languageBoost:'hi',turbo:job.config.turbo},includeCost:true,outputType:'URL',outputFormat:'MP3',deliveryMethod:'async'};
  }else if(kind==='task'){
   task=cleanTask(body.task);
   if(task.taskType==='imageInference'&&task.model==='openai:gpt-image@2')task.settings={...task.settings,quality:job.config.quality==='high'?'high':'medium'};
  }
  else throw bad('Unknown automation action.');
  const result=await providerTask(store,job,task,kind,body.retry===true);
  if(result.blocked)return result.blocked;
  if(!result.pending&&kind==='research'){
   const research=validateResearch(validated(()=>parseObject(result.data.find(x=>x.text)?.text)),job.usedSources);
   await store.automation('research',{id:job.id,research});return json({...result,research});
  }
  if(!result.pending&&kind==='script'){
   const draft=validated(()=>validateScript(parseObject(result.data.find(x=>x.text)?.text)));
   const reviewTask={taskType:'textInference',model:job.textModel,includeCost:true,deliveryMethod:'sync',settings:{maxTokens:6000},messages:[{role:'user',content:scriptReviewPrompt(draft,job.research,job.config)}]};
   let reviewed=await providerTask(store,job,reviewTask,'scriptReview',body.retry===true);
   if(reviewed.pending)return json({...reviewed,message:'Reviewing the script against its sources before narration.'});
   let script;
   try{script=validateReviewedScript(parseObject(reviewed.data.find(x=>x.text)?.text),job.research);}
   catch(reviewError){
    const correction={...reviewTask,messages:[...reviewTask.messages,{role:'assistant',content:reviewed.data.find(x=>x.text)?.text||''},{role:'user',content:`The validation failed: ${reviewError.message}. Correct the actual narration. Do not just claim a correction in metadata. Return the complete corrected JSON. Remove unsupported statements about flight, movement or anatomy. Read the final script before returning it.`}]};
    reviewed=await providerTask(store,job,correction,'scriptCorrection',body.retry===true);
    if(reviewed.pending)return json({...reviewed,message:'Correcting a source or date mismatch in the narration.'});
    script=validated(()=>validateReviewedScript(parseObject(reviewed.data.find(x=>x.text)?.text),job.research));
   }
   if(script.hookType===job.previousHook)throw bad('The writer repeated the last hook type. Edit the instructions and start a new settings revision.');
   await store.automation('script',{id:job.id,...script});return json({...reviewed,...script});
  }
  return json(result);
 }catch(error){return fail(error.status?error.message:'Automation could not complete this request. Your saved work is retained.',error.status||503);}
}

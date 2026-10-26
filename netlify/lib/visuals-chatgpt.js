import { episodeFromRow, parseObject, validateScript, validateSettings } from '../../public/visuals/automation-config.mjs';
import { digest, validateResearch } from './visuals-automation.js';

const forbidden=/^(?:api.?key|runware.?key|authorization|authentication|connectionSessionUUID|password|secret|access.?token|refresh.?token)$/i;
const error=(message,status=400)=>Object.assign(new Error(message),{status});
export const randomCode=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
export function rejectVisualSecrets(value){
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){if(forbidden.test(key))throw error('Provider credentials are not accepted. Use your connected Runware account in ChatGPT.');rejectVisualSecrets(child);}
}
export function publicVisualJob(job){const {tokenHash,...out}=job;return out;}
const safeURL=value=>{
 let u;try{u=new URL(value);}catch{throw error('A valid HTTPS media URL is required.');}
 if(u.protocol!=='https:'||u.username||u.password||[...u.searchParams.keys()].some(k=>forbidden.test(k)))throw error('Use an HTTPS result URL without provider credentials.');
 return u.href;
};
const brief=(job,tasks=[])=>({projectType:'stunning-visuals',title:job.episode?.title||job.selection.tab,selection:job.selection,
 expiresAt:job.expiresAt,stopped:!!job.stopped,cost:job.cost||0,phase:job.checkpoint?.phase||0,
 complete:job.checkpoint?.phase===7,readyImages:(job.checkpoint?.items||[]).filter(i=>i.imageSourceURL).length,
 sceneCount:job.checkpoint?.items?.length||0,pendingTasks:tasks.filter(t=>t.state==='pending').length,
 next:job.stopped?'resume_on_website':tasks.some(t=>t.state==='pending')?'prepare':job.checkpoint?.phase===7?'review_export':'waiting_browser',
 maxInFlight:job.checkpoint?.phase===4?Math.min(8,Math.max(1,Number(job.config?.conc)||1)):1,
 instructions:'Keep the Craftush tab open. Call prepare without kind. sheetRead means read the exact sheet range using Google Drive and record JSON {values:[[C,D,E,F,G]]} in result.text. Call Runware once with each prepared request[0]; keep every UUID. During images, prepare and run up to maxInFlight tasks concurrently. Record exact text; image/audio use result.text JSON {imageURL:...} or {audioURL:...}. Include actual cost. Native output fields may be in separate text blocks. Never send credentials. Poll uncertain UUIDs instead of resubmitting.'});

// Returns null for documentary tokens, preserving the existing documentary bridge.
export async function handleVisualProject(store,body,settings){
 if(!store.automation||!/^[a-f0-9]{64}$/.test(body.projectToken||''))return null;
 const {job}=await store.automation('connection',{hash:await digest(body.projectToken)});
 if(!job||job.projectType==='documentary-narration')return null;
 rejectVisualSecrets(body);
 if(!validateSettings(settings.visualsAutomation||{}).enabled)throw error('Visuals automation is disabled in Admin.',409);
 if(Date.parse(job.expiresAt)<=Date.now())throw error('This connection expired. Resume on Craftush and use its new command.',410);
 const {tasks}=await store.automation('queue',{id:job.id});
 if(body.action==='read')return brief(job,tasks);
 if(body.action==='prepare'){
  if(body.kind||body.scene||body.retry)throw error('Use prepare without kind, scene or retry. Resume failed stages on Craftush.');
  const {task,submissionRequired}=await store.automation('dispatch',{id:job.id});
  if(!task)return brief(job,tasks);
  if(task.kind==='sheet')return {...brief(job,tasks),kind:'sheetRead',taskUUID:task.taskUUID,selection:job.selection,submissionRequired:false};
  return {...brief(job,tasks),kind:task.kind,taskUUID:task.taskUUID,submissionRequired,status:submissionRequired?'prepared':'processing',
   ...(submissionRequired?{request:[{...task.task,taskUUID:task.taskUUID}]}:{pollTaskUUID:task.taskUUID})};
 }
 if(body.action!=='record')throw error('Use read, prepare or record for this project.');
 const task=tasks.find(t=>t.taskUUID===body.taskUUID),result=body.result;
 if(!task||!task.dispatchedAt)throw error('Prepare this task before recording its result.',409);
 if(!result||result.taskUUID!==task.taskUUID)throw error('The result must match the prepared task UUID.');
 if(result.error){
  await store.automation('failed',{key:task.key,taskUUID:task.taskUUID,message:String(result.error).replace(/<[^>]*>/g,' ').slice(0,600)});
  return {...brief(job,tasks),recorded:true,taskStatus:task.state==='done'?'complete':'error'};
 }
 if(result.status&&!result.text)return {...brief(job,tasks),recorded:false,taskStatus:task.state};
 if(typeof result.text!=='string'||!result.text||result.text.length>88000)throw error('Record the actual text or a JSON media result, at most 88000 characters.');
 const cost=result.cost===undefined?0:result.cost;
 if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0)throw error('Invalid reported cost.');
 let data,episode;
 if(task.kind==='sheet'){
  const parsed=parseObject(result.text);
  if(!Array.isArray(parsed.values)||parsed.values.length!==1||!Array.isArray(parsed.values[0])||parsed.values[0].length>5||parsed.values[0].some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)))throw error('Supply exactly one row from the selected C–G range.');
  episode=episodeFromRow(parsed.values,job.selection);data={taskUUID:task.taskUUID,taskType:'sheetRead',episode,cost:0};
 }else if(task.task.taskType==='textInference'){
  // Record the actual paid response even if review later rejects its content.
  // The automation handler validates it before a script can reach narration.
  data={taskUUID:task.taskUUID,taskType:'textInference',text:result.text,cost,...(result.finishReason?{finishReason:result.finishReason}:{})};
 }else{
  const media=parseObject(result.text),field=task.task.taskType==='imageInference'?'imageURL':'audioURL';
  data={taskUUID:task.taskUUID,taskType:task.task.taskType,[field]:safeURL(media[field]),cost};
 }
 const output={data:[data],model:task.task.model};
 await store.automation('complete',{key:task.key,taskUUID:task.taskUUID,result:output,cost:data.cost,taskType:data.taskType});
 if(episode)await store.automation('sheet',{id:job.id,episode});
 return {...brief((await store.automation('get',{id:job.id})).job),recorded:true,taskStatus:'complete'};
}

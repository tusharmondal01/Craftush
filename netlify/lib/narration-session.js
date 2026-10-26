import { openStore,readSettings,teamCodeOk,dashboardView,json,fail } from './shared.js';
import { digest } from './visuals-automation.js';
import { randomCode,rejectVisualSecrets } from './visuals-chatgpt.js';
import { buildNarrationTask } from './narration-tasks.js';
import { mediaURL,VERSION } from '../../public/documentary/narration-core.js';
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
async function connected(store,token){
 if(!/^[a-f0-9]{64}$/.test(token||''))throw bad('Use the private project command from Documentary Studio.',401);
 const {job}=await store.automation('connection',{hash:await digest(token)});
 if(!job||job.projectType!=='documentary-narration')return null;
 if(Date.parse(job.expiresAt)<=Date.now())throw bad('Connection expired. Reconnect this project on the website.',410);
 return job;
}
function summary(job,tasks=[]){return {projectType:'documentary-narration',title:job.title,expiresAt:job.expiresAt,stopped:job.stopped,cost:job.cost||0,phase:job.checkpoint?.stage||'script',complete:job.checkpoint?.complete===true,readyVideos:job.checkpoint?.readyVideos||0,requestCount:job.checkpoint?.requestCount||0,maxInFlight:job.checkpoint?.stage==='videos'?job.config.conc:1,next:job.stopped?'resume_on_website':tasks.some(t=>t.state==='pending')?'prepare':job.checkpoint?.complete?'review_export':job.checkpoint?.stage==='script'?'await_script_approval':'waiting_browser'};}
export async function handleNarrationProject(store,body,settings){
 if(!store.automation||!/^[a-f0-9]{64}$/.test(body.projectToken||''))return null;
 const job=await connected(store,body.projectToken);if(!job)return null;
 rejectVisualSecrets(body);
 if(dashboardView(settings).cards.documentary.enabled===false)throw bad('Documentary Studio is disabled.',403);
 const {tasks}=await store.automation('queue',{id:job.id});
 if(body.action==='read')return summary(job,tasks);
 if(body.action==='prepare'){
  if(body.kind||body.scene||body.retry)throw bad('Prepare without kind, scene or retry. The website queues approved stages.');
  const {task,submissionRequired}=await store.automation('dispatch',{id:job.id});
  return task?{...summary(job,tasks),kind:task.kind,taskUUID:task.taskUUID,submissionRequired,...(submissionRequired?{request:[{...task.task,taskUUID:task.taskUUID}]}:{pollTaskUUID:task.taskUUID})}:summary(job,tasks);
 }
 if(body.action!=='record')throw bad('Use read, prepare or record.');
 const task=tasks.find(t=>t.taskUUID===body.taskUUID),r=body.result;
 if(!task?.dispatchedAt||r?.taskUUID!==task.taskUUID)throw bad('The result must match a prepared task UUID.');
 if(r.error){await store.automation('failed',{key:task.key,taskUUID:task.taskUUID,message:String(r.error).slice(0,600)});return {...summary(job,tasks),recorded:true,taskStatus:'error'};}
 if(r.status&&!r.text&&!r.videoURL)return {...summary(job,tasks),recorded:false,taskStatus:task.state};
 const cost=r.cost===undefined?0:r.cost;if(!Number.isFinite(cost)||cost<0)throw bad('Invalid reported cost.');
 const data={taskUUID:task.taskUUID,taskType:task.task.taskType,cost};
 if(task.task.taskType==='textInference'){
  if(typeof r.text!=='string'||!r.text||r.text.length>88000)throw bad('Record the complete native text response.');
  data.text=r.text;if(r.finishReason)data.finishReason=r.finishReason;
 }else{
  const type=task.task.taskType==='audioInference'?'audio':'video';
  let fields={};if(r.text){try{fields=JSON.parse(r.text);}catch{throw bad('Encode the returned media URL as JSON in result.text.');}}
  data[type+'URL']=mediaURL(type==='video'?(r.videoURL||fields.videoURL):fields.audioURL,type);
 }
 await store.automation('complete',{key:task.key,taskUUID:task.taskUUID,result:{data:[data]},cost,taskType:data.taskType});
 return {...summary((await store.automation('get',{id:job.id})).job),recorded:true,taskStatus:'complete'};
}
export default async function narrationSession(req){
 try{
  const store=openStore(),settings=await readSettings(store);
  if(req.headers.has('authorization'))throw bad('Keep provider credentials in the Runware connection.');
  if(req.method==='GET')return json({version:VERSION,connection:'chatgpt',keyRequired:false});
  if(req.method!=='POST')return fail('Method not allowed',405);
  if(!await teamCodeOk(req,settings))return fail('Enter your team access code.',401);
  if(dashboardView(settings).cards.documentary.enabled===false)return fail('Documentary Studio is disabled.',403);
  const raw=await req.text();if(raw.length>240000)throw bad('Project request too large.',413);
  const body=JSON.parse(raw);rejectVisualSecrets(body);if(!store.automation)throw bad('This feature needs the Cloudflare backend.',503);
  if(body.action==='start'){
   const projectToken=randomCode(),id=randomCode(),expiresAt=new Date(Date.now()+86400000).toISOString();
   const config={conc:Math.max(1,Math.min(8,Math.round(Number(body.concurrency)||3)))};
   await store.automation('start',{id,projectType:'documentary-narration',title:String(body.title||'Documentary').slice(0,120),config,tokenHash:await digest(projectToken),expiresAt,createdAt:new Date().toISOString(),checkpoint:{stage:'script',phase:1}});
   return json({projectToken,expiresAt});
  }
  const job=await connected(store,body.projectToken);if(!job)throw bad('Project connection not found.',404);
  if(body.action==='stop'||body.action==='resume'){await store.automation(body.action,{id:job.id});return json({ok:true});}
  if(body.action==='status')return json(summary(job,(await store.automation('queue',{id:job.id})).tasks));
  if(body.action==='checkpoint'){
   const stage=['idea','script','voice','plan','videos','export'].includes(body.stage)?body.stage:'script';
   await store.automation('checkpoint',{id:job.id,checkpoint:{stage,phase:stage==='videos'?4:1,requestCount:Math.min(100,Math.max(0,Number(body.requestCount)||0)),readyVideos:Math.min(100,Math.max(0,Number(body.readyVideos)||0)),complete:body.complete===true}});return json({ok:true});
  }
  if(body.action!=='task')throw bad('Unknown narration session action.');
  if(job.stopped)throw bad('Resume this project before continuing.',409);
  const task=buildNarrationTask(body.request),{taskUUID,...content}=task;
  if(JSON.stringify(content).length>82000)throw bad('The request exceeds the ChatGPT handoff limit.',413);
  const key=job.id+':'+taskUUID;
  const prior=(await store.automation('queue',{id:job.id})).tasks.find(t=>t.taskUUID===taskUUID);
  if(prior&&await digest(prior.task)!==await digest(content))throw bad('This task UUID already belongs to different inputs.',409);
  const claim=await store.automation('claim',{key,jobId:job.id,taskUUID,kind:body.request.action,task:content,retry:body.retry===true,existingSubmission:body.existingSubmission===true});
  if(claim.record.state==='done')return json(claim.record.result);
  if(claim.record.state==='error')throw bad(claim.record.message,422);
  return json({pending:true,taskUUID:claim.record.taskUUID});
 }catch(e){return fail(e.status?e.message:e.message||'Documentary connection failed.',e.status||400);}
}

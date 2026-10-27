import {newUUID,VERSION,VOICES,MAX_REQUESTS,scriptText,audioChunks,object,validWords,validatePlan,packPlanRequests,videoPrompt,newNarrationProject,restoreNarrationProject,invalidateNarration,approveScript,scriptApproved} from './narration-core.js?v=20261027-scene-regenerate';
import {DocumentaryStore} from './storage.js';
import {filename} from './core.js';
import {fetchMedia,joinNarration,recognizeAudio,parseSRT} from './narration-media.js?v=20261027-audio-recovery2';
import {assembleNarrated} from './narration-assemble.js';
import {pendingResult,taskFailure,waitExpired} from './task-status.js?v=20261027-planner-output';
const $=id=>document.getElementById(id),store=new DocumentaryStore(),memory=new Map(),urls=new Map();
let previewSequence=0,audioPreviewSequence=0;
let project=newNarrationProject(),connection=null,busy=false,controller=null,selected=1,started=0,timer,token='',retry=false,finalBlob=null,musicBlob=null,persistTimer;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const check=()=>{if(controller?.signal.aborted)throw new DOMException('Workflow stopped.','AbortError');};
const notice=(text,error=false)=>{$('notice').textContent=text;$('notice').hidden=!text;$('notice').className='notice'+(error?' error':'');};
function activity(text,progress){$('activity').textContent=text;$('workProgress').hidden=!busy;if(Number.isFinite(progress)){$('workProgress').value=progress;$('workProgress').max=1;}else $('workProgress').removeAttribute('value');}
function endpoint(path,options){return globalThis.craftushAPI?globalThis.craftushAPI(path,options):fetch(path,options);}
async function request(path,body,signal){
 let r,data;try{const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(65000)]):AbortSignal.timeout(65000);r=await endpoint(path,{method:'POST',headers:{'content-type':'application/json','x-team-code':$('teamCode').value.trim()},body:JSON.stringify(body),signal:bounded});data=await r.json();}catch(e){if(signal?.aborted)throw e;throw Object.assign(new Error('The connection did not return a response. Resume to check the existing request; it will not be submitted twice.'),{uncertain:true});}
 if(!r.ok)throw Object.assign(new Error(data.errors?.[0]?.message||'The service could not complete this request.'),{uncertain:r.status>=500,accessDenied:r.status===401||r.status===403});return data;
}
function session(body,signal){return request('/api/documentary-session',{...body,projectToken:token},signal);}
async function save(){project.updated=new Date().toISOString();await store.put('narration-project',structuredClone(project));}
function saveSoon(){clearTimeout(persistTimer);persistTimer=setTimeout(()=>save().catch(e=>notice(e.message,true)),300);}
async function cache(key,blob){memory.set(key,blob);await store.put('narration-media-'+key,blob);}
async function media(key){return key?(memory.get(key)||await store.get('narration-media-'+key)):null;}
function objectURL(key,blob){if(!urls.has(key))urls.set(key,URL.createObjectURL(blob));return urls.get(key);}
function download(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),30000);}
function ready(){return project.plan?.requests.filter(r=>project.clips[r.index]?.url||project.clips[r.index]?.key).length||0;}
function setStage(stage){project.stage=stage;render();saveSoon();history.replaceState(null,'','#'+stage);}
function voiceOptions(){const fish=project.audioModel.startsWith('fishaudio:');const voices=fish?[['bf322df2096a46f18c579d0baa36f41d','Adrian · male narrator'],['536d3a5e000945adb7038665781a4aca','Ethan · male explainer'],['b347db033a6549378b48d00acb0d06cd','Selene'],['933563129e564b19a115bedd57b7406a','Sarah']]:[['Charon','Charon · male, informative'],['Achird','Achird · male, friendly'],['Algieba','Algieba · male, smooth'],['Orus','Orus · male, firm'],['Puck','Puck · male, upbeat'],['Kore','Kore · female, firm'],['Aoede','Aoede · female, breezy'],['Zephyr','Zephyr · female, bright']];$('voice').innerHTML=voices.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');if(!voices.some(v=>v[0]===project.voice))project.voice=VOICES[project.audioModel].voice;$('voice').value=project.voice;}
function syncInputs(){for(const id of ['projectTitle','idea','targetSeconds','concurrency','scriptText','scriptFeedback','audioModel'])$(id).value=({projectTitle:project.title,idea:project.idea,targetSeconds:project.targetSeconds,concurrency:project.concurrency,scriptText:project.script,scriptFeedback:project.feedback,audioModel:project.audioModel})[id];voiceOptions();}
function render(){
 document.querySelectorAll('.stage').forEach(e=>e.hidden=e.id!=='stage-'+project.stage);document.querySelectorAll('[data-stage]').forEach(e=>{e.classList.toggle('active',e.dataset.stage===project.stage);if(e.dataset.stage===project.stage)e.setAttribute('aria-current','step');else e.removeAttribute('aria-current');});
 const n=project.plan?.requestCount||0,count=ready();$('readyCount').textContent=`${count} / ${n}`;$('cost').textContent='$'+Object.values(project.ledger).reduce((a,c)=>a+c,0).toFixed(4);
 $('scriptStatus').textContent=scriptApproved(project)?'Approved':'Draft';$('scriptCount').textContent=project.script?`${project.script.split(/\s+/).length} words · ${project.script.length.toLocaleString()} characters · saved on this device`:'Write a script, then review or revise it.';
 $('revision').innerHTML='<option value="">Choose a saved version</option>'+project.revisions.map((r,i)=>`<option value="${i}">Version ${i+1} · ${esc(new Date(r.date).toLocaleString())}</option>`).join('');
 $('audioMeta').textContent=project.audio?.duration?`${project.audio.duration.toFixed(2)} seconds · ${VOICES[project.audioModel].label} · ${project.audio.words.length} timed words`:scriptApproved(project)?'Generate narration for the selected voice to enable audio analysis.':'Approve the script to generate narration.';
 const planning=project.tasks.plan;
 $('planSummary').textContent=n?`${project.plan.shotCount} shots · ${n} requests`:planning&&['submitted','processing'].includes(planning.status)&&busy?'Planning shots':planning?.status==='error'?'Request failed':planning&&['paused','uncertain'].includes(planning.status)?'Request paused':project.audio?.reviewed?'Audio ready':'Waiting for audio';
 $('planStatus').textContent=n?'Shot plan saved.':planning?(planning.error||planning.providerStatus||'Ready to check the existing shot request.'):project.audio?.reviewed?'Audio timings are ready. Create the shot plan.':'Finish narration analysis in Voiceover first.';
 $('planRequest').textContent=planning?`Request: ${planning.id} · Started: ${new Date(planning.started).toLocaleString()}${planning.checked?' · Last checked: '+new Date(planning.checked).toLocaleTimeString():''}`:'No shot planning request submitted.';
 const canRestartPlan=!n&&project.audio?.reviewed&&planning&&['uncertain','error'].includes(planning.status);$('newPlanRequest').hidden=!canRestartPlan;$('newPlanHelp').hidden=!canRestartPlan;$('newPlanRequest').disabled=busy||!canRestartPlan;
 $('videoPercent').textContent=n?Math.round(count/n*100)+'%':'0%';$('videoProgress').value=n?count/n*100:0;
 $('slotSummary').textContent=n?`${n} active · ${100-n} disabled · ${count} ready. ${project.concurrency} requests can run at once.`:'All 100 slots are disabled until a timed plan is ready.';
 $('slotGrid').innerHTML=Array.from({length:100},(_,i)=>{const index=i+1,r=project.plan?.requests[i],task=project.tasks['video-'+index],clip=project.clips[index];const state=clip?'done':task?.status==='error'?'failed':['processing','submitted'].includes(task?.status)?'working':'';return `<button data-slot="${index}" ${r?'':'disabled'} class="${state} ${index===selected?'active':''}" aria-label="Video slot ${index}: ${!r?'disabled':clip?'saved':task?.status||'waiting'}">${String(index).padStart(2,'0')}<small>${r?(clip?'Saved':r.duration.toFixed(1)+'s'):'Off'}</small></button>`;}).join('');
 const r=project.plan?.requests[selected-1],replacement=project.tasks['regenerate-'+selected],displayTask=busy&&replacement?replacement:project.tasks['video-'+selected];$('selectedTitle').textContent=r?`Request ${selected} · ${r.shots.length} shots`:'Select an active slot';$('selectedShots').textContent=r?`${r.start.toFixed(2)} → ${r.end.toFixed(2)}s · Generate ${r.generationSeconds}s, use ${r.duration.toFixed(2)}s`:'';$('selectedPrompt').value=r?videoPrompt(project.plan,selected,{version:displayTask?displayTask.promptVersion||1:2}):'';
 $('exportSummary').textContent=n?`${count}/${n} required clips ready. Final duration: ${project.audio.duration.toFixed(2)} seconds. ${100-n} disabled slots will be ignored.`:'Create the timed shot plan first.';
 $('shotTimeline').innerHTML=project.plan?project.plan.requests.flatMap(r=>r.shots).map(s=>`<span title="Shot ${s.shot}: ${s.start.toFixed(2)}–${s.end.toFixed(2)}s" style="flex:${s.duration}"></span>`).join(''):'';
 $('shotList').innerHTML=project.plan?project.plan.requests.map(r=>`<div class="shot-row"><b>REQUEST ${r.index}<br>${r.duration.toFixed(2)}s</b><div>${r.shots.map(s=>`<p><strong>Shot ${s.shot}</strong> · ${s.start.toFixed(2)}–${s.end.toFixed(2)}s</p><p lang="hi">${esc(s.narration)}</p><small>${esc(s.visual)}</small>`).join('')}</div></div>`).join(''):'';
 if(document.activeElement!==$('planJson'))$('planJson').value=project.plan?JSON.stringify(project.plan,null,2):'';
 for(const id of ['backToIdea','writeScript','saveScript','refineScript','approveScript','generateVoice','analyzeAudio','applyTimings','planShots','continueVideos','generateVideos','retryFailed','savePlan','retryClip','replaceClip','newProject','projectFile','reconnect','projectTitle','idea','targetSeconds','concurrency','audioModel','voice','scriptText','scriptFeedback','revision','planJson','wordTimings','srtFile','resumeStage','musicFile','musicVolume','narrationVolume','removeMusic','timingConfirmed'])$(id).disabled=busy;
 $('refineScript').disabled=busy||!project.script;$('approveScript').disabled=busy||!project.script;
 $('generateVoice').disabled=busy||!scriptApproved(project);$('analyzeAudio').disabled=busy||!project.audio?.duration;$('planShots').disabled=busy||!project.audio?.words.length;
 for(const id of ['continueVideos','generateVideos','retryFailed','downloadPlan'])$(id).disabled=(id!=='downloadPlan'&&busy)||!n;
 $('assemble').disabled=busy||!n||count!==n;$('downloadFinal').disabled=!finalBlob;$('downloadScript').disabled=!project.script;$('downloadAudio').disabled=!project.audio?.key;$('saveClip').disabled=!project.clips[selected];$('retryClip').disabled=busy||project.tasks['video-'+selected]?.status!=='error';
 const replacementPending=replacement&&replacement.status!=='error'&&project.clips[selected]?.taskUUID!==replacement.id;
 $('regenerateScene').disabled=busy||!r||!project.clips[selected];$('regenerateScene').textContent=replacementPending?'Resume selected scene':'Regenerate selected scene';
 $('regenerateHint').textContent=r&&project.clips[selected]?`Scene ${String(selected).padStart(2,'0')} selected · ${r.shots.length} shot${r.shots.length===1?'':'s'} in this clip. ${replacementPending?'Resume checks the existing regeneration request.':'Regeneration uses Runware credits.'} The current clip stays saved until the replacement is ready.`:'Select a completed video tile below to regenerate only that clip using Runware credits.';
 $('stop').hidden=!busy;$('stop').disabled=!!controller?.signal.aborted;$('workProgress').hidden=!busy;
 $('handoff').hidden=true;if(!project.audio?.duration)$('analysisStatus').textContent='Complete narration for the selected voice to enable audio analysis.';else if(!busy&&!project.audio.words?.length)$('analysisStatus').textContent='Narration ready. Analyze audio to measure word timings and plan shots.';void showAudio();void preview();
}
async function preview(){const sequence=++previewSequence;const clip=project.clips[selected],isFinal=project.stage==='export'&&finalBlob;const blob=isFinal?finalBlob:await media(clip?.key);if(sequence!==previewSequence)return;const url=blob?objectURL(isFinal?project.final.key:clip.key,blob):clip?.url;const player=$('previewVideo');$('previewEmpty').hidden=!!url;player.hidden=!url;$('previewHeading').textContent=isFinal?'Final documentary':`Video request ${selected}`;if(url&&player.getAttribute('src')!==url){player.src=url;player.load();}if(!url)player.removeAttribute('src');}
async function showAudio(){const sequence=++audioPreviewSequence,key=project.audio?.key,blob=await media(key);if(sequence!==audioPreviewSequence)return;const player=$('audioPreview');player.hidden=!blob;if(blob){const url=objectURL(key,blob);if(player.getAttribute('src')!==url)player.src=url;}else{player.pause();player.removeAttribute('src');player.load();}}
async function connectionCheck(){try{const r=await endpoint('/api/documentary',{cache:'no-store'});const data=await r.json();if(!r.ok)throw new Error(data.errors?.[0]?.message||'Backend unavailable.');connection=data;$('teamCodeWrap').hidden=!data.codeRequired;$('connectionStatus').textContent=!data.enabled?'Disabled by admin':data.configured?'Runware connected · website generation ready':'Add your Runware key in Admin';}catch(e){connection=null;$('connectionStatus').textContent='Connection unavailable';notice(e.message,true);}render();}
async function connectSession(force=false){
 if(token&&!force){await session({action:'resume'});return;}
 const data=await request('/api/documentary-session',{action:'start',title:project.title,concurrency:project.concurrency});token=data.projectToken;await store.put('narration-connection-'+project.id,{token});
 $('projectCommand').value=`Continue my narration-first Documentary Studio project using project code ${token}. Read the Craftush workflow, then use craftush_project read/prepare/record without kind or scene. Run prepared tasks through my connected Runware account, preserving every model and task UUID. Pause for script approval on the website. Never send provider credentials to Craftush.`;render();
}
async function statusCheckpoint(){if(project.mode==='chatgpt'&&token)await session({action:'checkpoint',stage:project.stage,readyVideos:ready(),requestCount:project.plan?.requestCount||0,complete:!!project.final});}
async function fingerprint(body){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(t);reject(new DOMException('Stopped.','AbortError'));};const t=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);if(signal?.aborted)return stop();signal?.addEventListener('abort',stop,{once:true});});
async function execute(slot,body,type){
 check();const signature=await fingerprint(body);let task=project.tasks[slot];
 if(task&&task.fingerprint!==signature){project.tasks[slot+'@'+task.fingerprint]=task;task=project.tasks[slot+'@'+signature];}
 if(task?.status==='error'&&/Wrong team access code|Enter your team access code/i.test(task.error))task.status='queued';
 if(slot==='plan'&&task?.status==='error'&&!retry)task.status='uncertain';
 if(task?.status==='error'){if(!retry)throw new Error(task.error+' Use Retry failed tasks to submit a new attempt.');task=null;}
 if(!task)task={id:newUUID(),fingerprint:signature,status:'queued',started:new Date().toISOString()};
 if(body.action==='narration-video'){task.promptVersion=body.promptVersion||1;if(body.seed!==undefined)task.seed=body.seed;}
 project.tasks[slot]=task;
 const isNew=task.status==='queued';const signal=controller.signal;let dispatched=false;
 try{
  check();await save();check();const start=Date.now(),budget=type==='text'?300000:3600000;let wait=2000,failures=0,missing=0;
  while(Date.now()-start<budget){
   check();let result;
   try{
    const recoverOnly=!isNew||dispatched;task.status=recoverOnly?'processing':'submitted';task.error='';task.providerStatus=recoverOnly?'Checking the existing Runware request…':'Submitting the request to Runware…';await save();check();render();dispatched=true;
    result=await request('/api/documentary',{...body,taskUUID:task.id,recoverOnly,...(token?{projectToken:token}:{})},signal);
    check();failures=0;
    task.checked=new Date().toISOString();
    for(const item of result.data||[])if(item.taskUUID===task.id&&Number.isFinite(item.cost)&&item.cost>=0)project.ledger[task.id]=item.cost;
    const error=taskFailure(result,task.id);if(error&&!pendingResult(error))throw new Error(error.message||'Runware could not complete this request.');
    const output=(result.data||[]).find(x=>x.taskUUID===task.id&&(type==='audio'?x.audioURL:type==='video'?x.videoURL:typeof x.text==='string'&&x.text));
    if(output){if(Number.isFinite(output.cost)&&output.cost>=0)project.ledger[task.id]=output.cost;task.status='complete';task.error='';task.providerStatus='Complete';await save();if(output.finishReason==='length')throw new Error('The model response was truncated. Retry with a shorter documentary or script.');return output;}
    const state=(result.data||[]).find(x=>x.taskUUID===task.id);
    task.error='';task.providerStatus=error?String(error.message||'Runware has not returned this result yet.').slice(0,300):state?.status==='processing'?'Runware reports processing. Waiting for the completed response.':'Request submitted. Waiting for Runware to report its status.';
    if(Number.isFinite(state?.progress))task.providerStatus+=` ${Math.max(0,Math.min(100,state.progress))}% reported.`;
    if(error&&/notfound/i.test(String(error.code).replace(/[^a-z]/gi,''))){if(++missing>=3)throw Object.assign(new Error('Runware cannot find this request after repeated checks. The workflow is paused. Resume checks the same ID; no new paid request has been submitted.'),{uncertain:true,pausedWait:true});}else missing=0;
    await save();
   }catch(e){if(!e.uncertain||e.pausedWait||signal.aborted)throw e;task.status='uncertain';task.error=e.message;if(++failures>=6)throw e;await save();}
   if(waitExpired(task,type)||Date.now()-start>=budget)break;
   render();await sleep(wait,signal);wait=Math.min(10000,wait*1.3);
  }
  throw Object.assign(new Error(type==='text'?'Runware has not returned this text request within 5 minutes. Waiting is paused. Your script and narration are saved. Resume checks the same request ID without submitting it again.':'This task is still pending. Resume later to check its original task ID.'),{uncertain:true});
 }catch(e){task.status=e.accessDenied?(isNew?'queued':'uncertain'):signal.aborted?(dispatched?'paused':'queued'):e.uncertain?'uncertain':'error';task.error=e.message;await save();throw e;}
}
function base(){return {script:project.script,approvedScript:project.approvedScript};}
function revision(text,feedback=''){if(project.script&&project.revisions.at(-1)?.text!==project.script)project.revisions.push({text:project.script,feedback:project.feedback,date:new Date().toISOString()});project.script=scriptText(text);project.revisions.push({text:project.script,feedback,date:new Date().toISOString()});project.revisions=project.revisions.slice(-30);invalidateNarration(project);finalBlob=null;$('scriptText').value=project.script;}
async function write(refine=false){
 project.title=$('projectTitle').value.trim();project.idea=$('idea').value.trim();project.targetSeconds=Number($('targetSeconds').value)||156;project.feedback=$('scriptFeedback').value.trim();if(!refine&&!project.idea)throw new Error('Enter your documentary idea first.');activity(refine?'Claude is revising your script…':'Claude is writing the full script…');
 const body={action:refine?'narration-refine':'narration-script',title:project.title,idea:project.idea,targetSeconds:project.targetSeconds,...(refine?{script:project.script,feedback:project.feedback}:{})};
 const output=await execute(refine?'refine':'script',body,'text');let parsed;try{parsed=object(output.text);scriptText(parsed.script);}catch(e){project.tasks[refine?'refine':'script'].status='error';project.tasks[refine?'refine':'script'].error=e.message;throw e;}revision(parsed.script,refine?project.feedback:'');setStage('script');await save();notice('Script saved. Review it, give feedback, or approve it to start production.');activity('Script ready for your approval.');await statusCheckpoint();
}
async function ensureVoice(){
 if(!scriptApproved(project))throw new Error('Save and approve this script first.');setStage('voice');await statusCheckpoint();
 if(project.audio?.key&&await media(project.audio.key)){await showAudio();return;}
 if(project.audio?.duration&&project.audio.urls?.length){
  activity('Restoring the saved narration…');const parts=[];
  for(const url of project.audio.urls){check();parts.push(await fetchMedia(url,{type:'audio',teamCode:$('teamCode').value,signal:controller.signal}));}
  const restored=await joinNarration(parts,controller.signal);if(Math.abs(restored.duration-project.audio.duration)>.06)throw new Error('Restored audio differs from the saved plan. Start a new narration before continuing.');
  project.audio.key||=newUUID();await cache(project.audio.key,restored.blob);await save();await showAudio();return;
 }
 const chunks=audioChunks(project.script,project.audioModel),blobs=[],audioURLs=[];
 for(let i=0;i<chunks.length;i++){check();activity(`Generating narration · part ${i+1}/${chunks.length}`);const out=await execute('voice-'+i,{action:'narration-voice',...base(),audioModel:project.audioModel,voice:project.voice,chunk:i,chunkText:chunks[i]},'audio');audioURLs.push(out.audioURL);const key=project.tasks['voice-'+i].id;let blob=await media(key);if(!blob){blob=await fetchMedia(out.audioURL,{type:'audio',teamCode:$('teamCode').value,signal:controller.signal});await cache(key,blob);}blobs.push(blob);}
 activity('Joining and measuring the narration…');const joined=await joinNarration(blobs,controller.signal),key=newUUID();await cache(key,joined.blob);project.audio={key,duration:joined.duration,urls:audioURLs,words:[],reviewed:false,source:'audio'};project.plan=null;project.clips={};project.final=null;finalBlob=null;await save();await showAudio();render();
}
async function analyze(){
 if(!project.audio)throw new Error('Generate the narration first.');if(project.audio.words.length&&project.audio.reviewed)return;
 const blob=await media(project.audio.key);if(!blob)throw new Error('The narration is missing from this device. Resume voiceover to download it again.');
 activity('Analyzing the actual narration…');const found=await recognizeAudio(blob,{signal:controller.signal,onProgress:text=>{activity(text);$('analysisStatus').textContent=text;}});
 project.audio.words=found.words;project.audio.source='audio';$('wordTimings').value=JSON.stringify(found.words,null,2);
 if(!found.words.length){project.audio.reviewed=false;await save();$('transcriptReview').open=true;$('analysisStatus').textContent='No reliable word timings found. Your narration is saved.';throw new Error('Speech timing could not be measured. Retry Analyze audio, or import an SRT made from this exact narration. You do not need to regenerate the voiceover.');}
 const normalized=globalThis.CraftushAlignment.fromWords(found.words.map(w=>({text:w.text,timestamp:[w.start,w.end]})),project.audio.duration);
 const match=globalThis.CraftushAlignment.align([{text:project.script}],normalized,{duration:project.audio.duration});
 project.audio.coverage=match.coverage;project.audio.reviewed=match.coverage>=.9&&!found.requiresReview;
 await save();$('analysisStatus').textContent=`${found.words.length} timestamped words · ${Math.round(match.coverage*100)}% script match.`;
 if(found.requiresReview){$('transcriptReview').open=true;$('analysisStatus').textContent=`${found.words.length} valid timed words saved. Review missing timings for: ${(found.issues||[]).map(i=>i.text).join(', ')}`;throw new Error('Valid audio timings are saved. A few words still need review after automatic retry. Review the transcript and timings below, then apply them.');}
 if(!project.audio.reviewed){$('transcriptReview').open=true;throw new Error('Some narration words did not match the script. Review the transcript, correct timings or import an SRT before continuing.');}
}
async function ensurePlan(){
 if(project.plan)return;
 if(!project.audio?.words.length||!project.audio.reviewed)throw new Error('Analyze the audio and review any timing warnings first.');
 setStage('plan');await statusCheckpoint();activity('Claude is choosing shot boundaries from the narration timestamps…');
 const output=await execute('plan',{action:'narration-plan',...base(),audioDuration:project.audio.duration,words:project.audio.words,timingReviewed:project.audio.reviewed},'text');
 let plan;try{plan=packPlanRequests(output.text,project.audio.duration,project.audio.words);plan.requests.forEach(r=>videoPrompt(plan,r.index));}catch(e){project.tasks.plan.status='error';project.tasks.plan.error=e.message;throw e;}project.plan=plan;project.clips={};project.final=null;finalBlob=null;await save();render();await statusCheckpoint();
}
async function clipBlob(index){
 const clip=project.clips[index];if(!clip)throw new Error(`Video ${index} is not ready.`);let blob=await media(clip.key);if(blob)return blob;if(!clip.url)throw new Error(`Video ${index} must be uploaded again.`);
 blob=await fetchMedia(clip.url,{teamCode:$('teamCode').value,signal:controller?.signal});clip.key||=newUUID();await cache(clip.key,blob);await save();return blob;
}
async function videoBody(index){
 const body={action:'narration-video',...base(),audioDuration:project.audio.duration,plan:project.plan,scene:index},task=project.tasks['video-'+index];
 if(task?.status==='error'&&retry)return {...body,promptVersion:2};
 // Resume older jobs with exactly the body that owns their UUID; stronger
 // prompts apply to new submissions and explicit scene regeneration.
 if(task){const candidates=[body,{...body,promptVersion:1},{...body,promptVersion:2}];if(task.seed!==undefined)candidates.push({...body,promptVersion:2,seed:task.seed},{...body,promptVersion:1,seed:task.seed});for(const candidate of candidates)if(task.fingerprint===await fingerprint(candidate))return candidate;}
 return {...body,promptVersion:2};
}
async function regenerateScene(index){
 if(!project.plan?.requests[index-1]||!project.clips[index])throw new Error('Select a completed video tile to regenerate.');
 const slot='regenerate-'+index,previous=project.tasks[slot],uncommitted=previous&&previous.status!=='error'&&project.clips[index].taskUUID!==previous.id;
 let seed=uncommitted?previous.seed:undefined;
 if(!Number.isInteger(seed)){const oldSeed=previous?.seed??project.tasks['video-'+index]?.seed??42;seed=crypto.getRandomValues(new Uint32Array(1))[0]&2147483647;if(seed===oldSeed)seed=(seed+1)%2147483648;}
 activity(`Regenerating scene ${index} only. Your current clip is kept until its replacement is saved…`);
 const out=await execute(slot,{action:'narration-video',...base(),audioDuration:project.audio.duration,plan:project.plan,scene:index,promptVersion:2,seed},'video'),task=project.tasks[slot];
 let blob=await media(task.id);if(!blob){blob=await fetchMedia(out.videoURL,{teamCode:$('teamCode').value,signal:controller.signal});await cache(task.id,blob);}check();
 await store.put('narration-archive-'+project.id+'-scene-'+index+'-'+task.id,structuredClone(project));
 const oldTask=project.tasks['video-'+index];if(oldTask)project.tasks['video-'+index+'@'+oldTask.id]=oldTask;
 project.tasks['video-'+index]=task;project.clips[index]={url:out.videoURL,taskUUID:task.id,key:task.id};project.final=null;finalBlob=null;$('finalMeta').textContent='';
 await save();render();activity(`Scene ${index} regenerated and saved.`);notice(`Scene ${index} replaced. Rebuild the final cut to include it.`);
}
async function generateVideos(indices){
 if(!project.plan)throw new Error('Create the timed shot plan first.');setStage('videos');await statusCheckpoint();const slots=indices||project.plan.requests.map(r=>r.index);let cursor=0;const problems=[];
 const worker=async()=>{while(cursor<slots.length&&!controller.signal.aborted){const i=slots[cursor++];try{
  if(!project.clips[i]){activity(`Generating planned clips · ${ready()} of ${project.plan.requestCount} ready`);const out=await execute('video-'+i,await videoBody(i),'video');project.clips[i]={url:out.videoURL,taskUUID:project.tasks['video-'+i].id,key:project.tasks['video-'+i].id};await save();}
  await clipBlob(i);await statusCheckpoint();render();
 }catch(e){if(controller.signal.aborted)return;problems.push(`Clip ${i}: ${e.message}`);}}};
 await Promise.all(Array.from({length:Math.min(project.concurrency,slots.length)},worker));check();if(problems.length)throw new Error(problems[0]);activity(`${ready()} video clips saved. Disabled slots were skipped.`);
}
async function assemble(){
 if(!project.plan||ready()!==project.plan.requestCount)throw new Error('Finish every active video slot first.');setStage('export');$('previewVideo').pause();const clips=[];
 for(const r of project.plan.requests){check();activity(`Preparing saved clip ${r.index}/${project.plan.requestCount}`);clips.push(await clipBlob(r.index));}
 const narration=await media(project.audio.key);if(!narration)throw new Error('Restore the saved narration before assembly.');
 const result=await assembleNarrated(clips,narration,project.plan,{musicBlob,music:{musicVolumeDb:Number($('musicVolume').value),narrationVolumeDb:Number($('narrationVolume').value),loop:true,fadeIn:1,fadeOut:3},signal:controller.signal,onProgress:activity});
 check();const key=newUUID();await cache(key,result.blob);finalBlob=result.blob;project.final={key,duration:result.duration,size:result.blob.size};await save();$('finalMeta').textContent=`${result.duration.toFixed(2)} seconds · 720 × 1280 · ${(result.blob.size/1048576).toFixed(1)} MB`;
 await statusCheckpoint();notice('Final documentary saved. Preview it, then download the MP4.');render();
}
async function continueProduction(){await ensureVoice();await analyze();await ensurePlan();await generateVideos();await assemble();}
async function run(fn,{retries=false,provider=true}={}){
 if(busy)return;notice('');
 const work=async lock=>{
  if(!lock&&navigator.locks){notice('This project is running in another tab. Stop that queue first.',true);return;}
  busy=true;retry=retries;controller=new AbortController();started=Date.now();timer=setInterval(()=>{$('elapsed').textContent=Math.floor((Date.now()-started)/60000)+':'+String(Math.floor((Date.now()-started)/1000)%60).padStart(2,'0')+' elapsed';},1000);render();
  try{
   if(provider){if(!connection?.enabled)throw new Error('Check the backend connection first.');if(!connection.configured)throw new Error('Add your Runware API key in Admin, then check the connection.');await request('/api/documentary',{action:'check-access'},controller.signal);$('teamCodeStatus').textContent=connection.codeRequired?'Access code verified.':'';}
   await fn();
  }catch(e){if(e.accessDenied){$('teamCodeStatus').textContent='Code not accepted. Use the saved Team access code from Admin → Team access, then try again.';$('teamCode').focus();}notice(controller.signal.aborted?'Workflow stopped. Your work is saved. Resume checks existing requests.':e.message,!controller.signal.aborted);activity(controller.signal.aborted?'Stopped. Ready to resume.':'Needs attention. Your saved work is retained.');}
  finally{clearInterval(timer);busy=false;controller=null;retry=false;await save().catch(e=>notice(e.message,true));render();}
 };
 if(navigator.locks)await navigator.locks.request('craftush-documentary-narration',{ifAvailable:true},work);else await work(true);
}
async function guarded(fn){try{await fn();}catch(e){notice(e.message,true);}}
function changedScript(){const text=scriptText($('scriptText').value);if(text!==project.script)revision(text);}
$('backToIdea').onclick=()=>setStage('idea');
$('showTeamCode').onclick=()=>{const visible=$('teamCode').type==='password';$('teamCode').type=visible?'text':'password';$('showTeamCode').textContent=visible?'Hide code':'Show code';};
$('teamCode').oninput=()=>{$('teamCodeStatus').textContent='';};
$('writeScript').onclick=()=>run(()=>write(false));$('refineScript').onclick=()=>run(async()=>{changedScript();await write(true);});
$('saveScript').onclick=()=>guarded(async()=>{changedScript();await save();render();notice('Script saved. Approval is required after any change.');});
$('approveScript').onclick=()=>run(async()=>{changedScript();approveScript(project);await save();await continueProduction();});
$('generateVoice').onclick=()=>run(ensureVoice);$('analyzeAudio').onclick=()=>run(async()=>{await analyze();await ensurePlan();});$('planShots').onclick=()=>run(ensurePlan);
$('newPlanRequest').onclick=()=>run(async()=>{if(project.plan||!project.audio?.reviewed||!['uncertain','error'].includes(project.tasks.plan?.status))throw new Error('Resume the current shot request first.');const previous=project.tasks.plan;project.tasks['plan@'+previous.id]=previous;delete project.tasks.plan;await save();await ensurePlan();});
for(const id of ['continueVideos','generateVideos'])$(id).onclick=()=>run(async()=>{await generateVideos();await assemble();});
$('retryFailed').onclick=()=>run(async()=>{await continueProduction();},{retries:true});$('retryClip').onclick=()=>run(()=>generateVideos([selected]),{retries:true});
$('regenerateScene').onclick=()=>run(()=>regenerateScene(selected));
$('resumeStage').onclick=()=>run(async()=>{if(!scriptApproved(project)){await write(!!project.script&&!!project.feedback);}else await continueProduction();},{retries:true});
$('assemble').onclick=()=>run(assemble,{provider:false});$('stop').onclick=()=>{controller?.abort();if(project.mode==='chatgpt'&&token)session({action:'stop'}).catch(()=>{});render();};
$('savePlan').onclick=()=>guarded(async()=>{const plan=validatePlan($('planJson').value,project.audio?.duration);plan.requests.forEach(r=>videoPrompt(plan,r.index));if(JSON.stringify(plan)!==JSON.stringify(project.plan)){await store.put('narration-archive-'+project.id+'-'+Date.now(),structuredClone(project));project.plan=plan;project.clips={};project.final=null;finalBlob=null;}await save();render();});
$('applyTimings').onclick=()=>run(async()=>{if(!$('timingConfirmed').checked)throw new Error('Confirm that you checked these timings.');project.audio.words=validWords(JSON.parse($('wordTimings').value),project.audio.duration);project.audio.reviewed=true;project.plan=null;project.clips={};project.final=null;finalBlob=null;await save();await ensurePlan();});
$('srtFile').onchange=()=>guarded(async()=>{const file=$('srtFile').files[0];if(!file)return;if(!project.audio?.duration)throw new Error('Generate narration first.');if(file.size>2000000)throw new Error('SRT is too large.');project.audio.words=parseSRT(await file.text(),project.audio.duration);project.audio.reviewed=false;project.audio.source='srt';$('wordTimings').value=JSON.stringify(project.audio.words,null,2);$('transcriptReview').open=true;$('timingConfirmed').checked=false;await save();notice('SRT loaded. Review the imported timings, then apply them.');});
$('slotGrid').onclick=e=>{const button=e.target.closest('[data-slot]');if(button&&!button.disabled){selected=Number(button.dataset.slot);render();}};
$('saveClip').onclick=()=>guarded(async()=>download(await clipBlob(selected),filename(project.title,`-clip-${String(selected).padStart(3,'0')}.mp4`)));
$('downloadScript').onclick=()=>download(new Blob([project.script],{type:'text/plain;charset=utf-8'}),filename(project.title,'-script.txt'));
$('downloadPlan').onclick=()=>download(new Blob([JSON.stringify(project.plan,null,2)],{type:'application/json'}),filename(project.title,'-shot-plan.json'));
$('downloadAudio').onclick=()=>guarded(async()=>{const blob=await media(project.audio?.key);if(!blob)throw new Error('Resume voiceover to recover this file.');download(blob,filename(project.title,'-narration.wav'));});
$('downloadFinal').onclick=()=>{if(finalBlob)download(finalBlob,filename(project.title,'.mp4'));};
$('saveProject').onclick=()=>download(new Blob([JSON.stringify(restoreNarrationProject(project),null,2)],{type:'application/json'}),filename(project.title,'-project.json'));
$('revision').onchange=()=>guarded(async()=>{const index=$('revision').value;if(index==='')return;revision(project.revisions[Number(index)].text,'Restored earlier version');await save();render();});
$('projectFile').onchange=()=>guarded(async()=>{const file=$('projectFile').files[0];if(!file)return;if(file.size>3000000)throw new Error('Project file is too large.');const next=restoreNarrationProject(JSON.parse(await file.text()));await store.put('narration-archive-'+project.id,project);project=next;token='';finalBlob=null;syncInputs();await save();await showAudio();render();});
$('newProject').onclick=()=>guarded(async()=>{await store.put('narration-archive-'+project.id,project);project=newNarrationProject();token='';finalBlob=null;musicBlob=null;syncInputs();await save();await showAudio();render();notice('New project ready. The previous project is archived on this device.');});
$('replaceClip').onchange=()=>guarded(async()=>{const file=$('replaceClip').files[0];if(!file||!project.plan?.requests[selected-1])return;if(!file.size||file.size>160*1048576)throw new Error('Choose an MP4 below 160 MB.');if(!new TextDecoder().decode(await file.slice(4,12).arrayBuffer()).includes('ftyp'))throw new Error('Choose an MP4 file.');const key=newUUID();await cache(key,file);project.clips[selected]={key,url:'',taskUUID:''};project.final=null;finalBlob=null;await save();render();});
$('musicFile').onchange=()=>guarded(async()=>{const file=$('musicFile').files[0];if(!file)return;if(file.size>80*1048576)throw new Error('Use music below 80 MB.');musicBlob=file;await store.put('narration-music-'+project.id,file);$('musicName').textContent=file.name;project.final=null;finalBlob=null;await save();render();});
for(const id of ['musicVolume','narrationVolume'])$(id).onchange=()=>guarded(async()=>{project.final=null;finalBlob=null;await save();render();});
$('removeMusic').onclick=()=>guarded(async()=>{musicBlob=null;await store.delete('narration-music-'+project.id);$('musicName').textContent='No music selected.';project.final=null;finalBlob=null;await save();render();});
$('copyCommand').onclick=()=>guarded(async()=>{await navigator.clipboard.writeText($('projectCommand').value);notice('Private project command copied.');});
$('reconnect').onclick=()=>run(()=>connectSession(true),{provider:false});$('recheck').onclick=connectionCheck;
$('audioModel').onchange=()=>guarded(async()=>{project.audioModel=$('audioModel').value;project.voice=VOICES[project.audioModel].voice;project.audio=null;project.plan=null;project.clips={};project.final=null;finalBlob=null;voiceOptions();await save();render();});
$('voice').onchange=()=>guarded(async()=>{project.voice=$('voice').value;project.audio=null;project.plan=null;project.clips={};project.final=null;finalBlob=null;await save();render();});
for(const [id,field] of [['projectTitle','title'],['idea','idea'],['scriptFeedback','feedback']])$(id).oninput=()=>{project[field]=$(id).value;saveSoon();};
$('targetSeconds').onchange=()=>{project.targetSeconds=Math.max(30,Math.min(1200,Number($('targetSeconds').value)||156));saveSoon();};$('concurrency').onchange=()=>{project.concurrency=Number($('concurrency').value);saveSoon();};
document.querySelectorAll('[data-stage]').forEach(e=>e.onclick=()=>setStage(e.dataset.stage));
async function init(){try{const saved=await store.get('narration-project');if(saved)project=restoreNarrationProject(saved);const privateConnection=await store.get('narration-connection-'+project.id);token=privateConnection?.token||'';if(saved?.final?.key){finalBlob=await media(saved.final.key);if(finalBlob)project.final=saved.final;}musicBlob=await store.get('narration-music-'+project.id);if(musicBlob)$('musicName').textContent=musicBlob.name||'Saved background music';if(token)$('projectCommand').value=`Continue my narration-first Documentary Studio project using project code ${token}. Read the Craftush workflow and use craftush_project read/prepare/record without kind or scene. Preserve every prepared model and task UUID. Use my connected Runware account.`;syncInputs();if(project.audio?.words.length)$('wordTimings').value=JSON.stringify(project.audio.words,null,2);await showAudio();}catch(e){notice(e.message,true);}render();await connectionCheck();}
void init();

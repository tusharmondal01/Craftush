import {newUUID,VERSION,VOICES,MAX_REQUESTS,scriptText,audioChunks,object,validWords,validatePlan,videoPrompt,newNarrationProject,restoreNarrationProject,invalidateNarration,approveScript,scriptApproved} from './narration-core.js?v=20261027-voice-recovery';
import {DocumentaryStore} from './storage.js';
import {filename} from './core.js';
import {fetchMedia,joinNarration,recognizeAudio,parseSRT} from './narration-media.js';
import {assembleNarrated} from './narration-assemble.js';
const $=id=>document.getElementById(id),store=new DocumentaryStore(),memory=new Map(),urls=new Map();
let previewSequence=0;
let project=newNarrationProject(),connection=null,busy=false,controller=null,selected=1,started=0,timer,token='',retry=false,finalBlob=null,musicBlob=null,persistTimer;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const check=()=>{if(controller?.signal.aborted)throw new DOMException('Workflow stopped.','AbortError');};
const notice=(text,error=false)=>{$('notice').textContent=text;$('notice').hidden=!text;$('notice').className='notice'+(error?' error':'');};
function activity(text,progress){$('activity').textContent=text;$('workProgress').hidden=!busy;if(Number.isFinite(progress)){$('workProgress').value=progress;$('workProgress').max=1;}else $('workProgress').removeAttribute('value');}
function endpoint(path,options){return globalThis.craftushAPI?globalThis.craftushAPI(path,options):fetch(path,options);}
async function request(path,body,signal){
 let r;try{r=await endpoint(path,{method:'POST',headers:{'content-type':'application/json','x-team-code':$('teamCode').value.trim()},body:JSON.stringify(body),signal});}catch(e){if(signal?.aborted)throw e;throw Object.assign(new Error('Connection interrupted. Resume to check the existing task.'),{uncertain:true});}
 const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(data.errors?.[0]?.message||'The service could not complete this request.'),{uncertain:r.status>=500});return data;
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
 $('audioMeta').textContent=project.audio?.duration?`${project.audio.duration.toFixed(2)} seconds · ${VOICES[project.audioModel].label} · ${project.audio.words.length} timed words`:'Approve the script to generate narration.';
 $('planSummary').textContent=n?`${project.plan.shotCount} shots · ${n} requests`:'Waiting for audio';
 $('videoPercent').textContent=n?Math.round(count/n*100)+'%':'0%';$('videoProgress').value=n?count/n*100:0;
 $('slotSummary').textContent=n?`${n} active · ${100-n} disabled · ${count} ready. ${project.concurrency} requests can run at once.`:'All 100 slots are disabled until a timed plan is ready.';
 $('slotGrid').innerHTML=Array.from({length:100},(_,i)=>{const index=i+1,r=project.plan?.requests[i],task=project.tasks['video-'+index],clip=project.clips[index];const state=clip?'done':task?.status==='error'?'failed':['processing','submitted'].includes(task?.status)?'working':'';return `<button data-slot="${index}" ${r?'':'disabled'} class="${state} ${index===selected?'active':''}" aria-label="Video slot ${index}: ${!r?'disabled':clip?'saved':task?.status||'waiting'}">${String(index).padStart(2,'0')}<small>${r?(clip?'Saved':r.duration.toFixed(1)+'s'):'Off'}</small></button>`;}).join('');
 const r=project.plan?.requests[selected-1];$('selectedTitle').textContent=r?`Request ${selected} · ${r.shots.length} shots`:'Select an active slot';$('selectedShots').textContent=r?`${r.start.toFixed(2)} → ${r.end.toFixed(2)}s · Generate ${r.generationSeconds}s, use ${r.duration.toFixed(2)}s`:'';$('selectedPrompt').value=r?videoPrompt(project.plan,selected):'';
 $('exportSummary').textContent=n?`${count}/${n} required clips ready. Final duration: ${project.audio.duration.toFixed(2)} seconds. ${100-n} disabled slots will be ignored.`:'Create the timed shot plan first.';
 $('shotTimeline').innerHTML=project.plan?project.plan.requests.flatMap(r=>r.shots).map(s=>`<span title="Shot ${s.shot}: ${s.start.toFixed(2)}–${s.end.toFixed(2)}s" style="flex:${s.duration}"></span>`).join(''):'';
 $('shotList').innerHTML=project.plan?project.plan.requests.map(r=>`<div class="shot-row"><b>REQUEST ${r.index}<br>${r.duration.toFixed(2)}s</b><div>${r.shots.map(s=>`<p><strong>Shot ${s.shot}</strong> · ${s.start.toFixed(2)}–${s.end.toFixed(2)}s</p><p lang="hi">${esc(s.narration)}</p><small>${esc(s.visual)}</small>`).join('')}</div></div>`).join(''):'';
 if(document.activeElement!==$('planJson'))$('planJson').value=project.plan?JSON.stringify(project.plan,null,2):'';
 for(const id of ['writeScript','saveScript','refineScript','approveScript','generateVoice','analyzeAudio','applyTimings','planShots','continueVideos','generateVideos','retryFailed','savePlan','retryClip','replaceClip','newProject','projectFile','reconnect','projectTitle','idea','targetSeconds','concurrency','audioModel','voice','scriptText','scriptFeedback','revision','planJson','wordTimings','srtFile','resumeStage','musicFile','musicVolume','narrationVolume','removeMusic','timingConfirmed'])$(id).disabled=busy;
 $('refineScript').disabled=busy||!project.script;$('approveScript').disabled=busy||!project.script;
 $('generateVoice').disabled=busy||!scriptApproved(project);$('analyzeAudio').disabled=busy||!project.audio?.duration;$('planShots').disabled=busy||!project.audio?.words.length;
 for(const id of ['continueVideos','generateVideos','retryFailed','downloadPlan'])$(id).disabled=(id!=='downloadPlan'&&busy)||!n;
 $('assemble').disabled=busy||!n||count!==n;$('downloadFinal').disabled=!finalBlob;$('downloadScript').disabled=!project.script;$('downloadAudio').disabled=!project.audio?.key;$('saveClip').disabled=!project.clips[selected];$('retryClip').disabled=busy||project.tasks['video-'+selected]?.status!=='error';
 $('stop').hidden=!busy;$('stop').disabled=!!controller?.signal.aborted;$('workProgress').hidden=!busy;
 $('handoff').hidden=true;void preview();
}
async function preview(){const sequence=++previewSequence;const clip=project.clips[selected],isFinal=project.stage==='export'&&finalBlob;const blob=isFinal?finalBlob:await media(clip?.key);if(sequence!==previewSequence)return;const url=blob?objectURL(isFinal?project.final.key:clip.key,blob):clip?.url;const player=$('previewVideo');$('previewEmpty').hidden=!!url;player.hidden=!url;$('previewHeading').textContent=isFinal?'Final documentary':`Video request ${selected}`;if(url&&player.getAttribute('src')!==url){player.src=url;player.load();}if(!url)player.removeAttribute('src');}
async function showAudio(){const blob=await media(project.audio?.key);$('audioPreview').hidden=!blob;if(blob)$('audioPreview').src=objectURL(project.audio.key,blob);}
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
 if(task?.status==='error'){if(!retry)throw new Error(task.error+' Use Retry failed tasks to submit a new attempt.');task=null;}
 if(!task)task={id:newUUID(),fingerprint:signature,status:'queued',started:new Date().toISOString()};
 project.tasks[slot]=task;
 const isNew=task.status==='queued';const signal=controller.signal;let dispatched=false;
 try{
  check();await save();check();const start=Date.now();let wait=2000,failures=0;
  while(Date.now()-start<3600000){
   check();let result;
   try{
    const recoverOnly=!isNew||dispatched;task.status=recoverOnly?'processing':'submitted';await save();check();dispatched=true;
    result=await request('/api/documentary',{...body,taskUUID:task.id,recoverOnly,...(token?{projectToken:token}:{})},signal);
    check();failures=0;
    const output=(result.data||[]).find(x=>x.taskUUID===task.id&&(type==='audio'?x.audioURL:type==='video'?x.videoURL:typeof x.text==='string'&&x.text));
    if(output){if(Number.isFinite(output.cost)&&output.cost>=0)project.ledger[task.id]=output.cost;task.status='complete';await save();if(output.finishReason==='length')throw new Error('The model response was truncated. Retry with a shorter documentary or script.');return output;}
    const error=(result.errors||[]).find(x=>!x.taskUUID||x.taskUUID===task.id);if(error&&!/not.?found|not.?ready|not.?available|processing/i.test(error.code+' '+error.message))throw new Error(error.message);
   }catch(e){if(!e.uncertain||signal.aborted)throw e;task.status='uncertain';task.error=e.message;if(++failures>=6)throw e;await save();}
   render();await sleep(wait,signal);wait=Math.min(10000,wait*1.3);
  }
  throw Object.assign(new Error('This task is still pending. Resume later to check its original task ID.'),{uncertain:true});
 }catch(e){task.status=signal.aborted?(dispatched?'paused':'queued'):e.uncertain?'uncertain':'error';task.error=e.message;await save();throw e;}
}
function base(){return {script:project.script,approvedScript:project.approvedScript};}
function revision(text,feedback=''){if(project.script&&project.revisions.at(-1)?.text!==project.script)project.revisions.push({text:project.script,feedback:project.feedback,date:new Date().toISOString()});project.script=scriptText(text);project.revisions.push({text:project.script,feedback,date:new Date().toISOString()});project.revisions=project.revisions.slice(-30);invalidateNarration(project);finalBlob=null;$('scriptText').value=project.script;}
async function write(refine=false){
 project.title=$('projectTitle').value.trim();project.idea=$('idea').value.trim();project.targetSeconds=Number($('targetSeconds').value)||156;project.feedback=$('scriptFeedback').value.trim();setStage('script');activity(refine?'Claude is revising your script…':'Claude is writing the full script…');
 const body={action:refine?'narration-refine':'narration-script',title:project.title,idea:project.idea,targetSeconds:project.targetSeconds,...(refine?{script:project.script,feedback:project.feedback}:{})};
 const output=await execute(refine?'refine':'script',body,'text');let parsed;try{parsed=object(output.text);scriptText(parsed.script);}catch(e){project.tasks[refine?'refine':'script'].status='error';project.tasks[refine?'refine':'script'].error=e.message;throw e;}revision(parsed.script,refine?project.feedback:'');await save();notice('Script saved. Review it, give feedback, or approve it to start production.');activity('Script ready for your approval.');await statusCheckpoint();
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
 for(let i=0;i<chunks.length;i++){check();activity(`Generating narration · part ${i+1}/${chunks.length}`);const out=await execute('voice-'+i,{action:'narration-voice',...base(),audioModel:project.audioModel,voice:project.voice,chunk:i},'audio');audioURLs.push(out.audioURL);const key=project.tasks['voice-'+i].id;let blob=await media(key);if(!blob){blob=await fetchMedia(out.audioURL,{type:'audio',teamCode:$('teamCode').value,signal:controller.signal});await cache(key,blob);}blobs.push(blob);}
 activity('Joining and measuring the narration…');const joined=await joinNarration(blobs,controller.signal),key=newUUID();await cache(key,joined.blob);project.audio={key,duration:joined.duration,urls:audioURLs,words:[],reviewed:false,source:'audio'};project.plan=null;project.clips={};project.final=null;finalBlob=null;await save();await showAudio();render();
}
async function analyze(){
 if(!project.audio)throw new Error('Generate the narration first.');if(project.audio.words.length&&project.audio.reviewed)return;
 const blob=await media(project.audio.key);if(!blob)throw new Error('The narration is missing from this device. Resume voiceover to download it again.');
 activity('Analyzing the actual narration…');const found=await recognizeAudio(blob,{signal:controller.signal,onProgress:text=>{activity(text);$('analysisStatus').textContent=text;}});
 project.audio.words=found.words;project.audio.source='audio';$('wordTimings').value=JSON.stringify(found.words,null,2);
 const normalized=globalThis.CraftushAlignment.fromWords(found.words.map(w=>({text:w.text,timestamp:[w.start,w.end]})),project.audio.duration);
 const match=globalThis.CraftushAlignment.align([{text:project.script}],normalized,{duration:project.audio.duration});
 project.audio.coverage=match.coverage;project.audio.reviewed=match.coverage>=.9;
 await save();$('analysisStatus').textContent=`${found.words.length} timestamped words · ${Math.round(match.coverage*100)}% script match.`;
 if(!project.audio.reviewed){$('transcriptReview').open=true;throw new Error('Some narration words did not match the script. Review the transcript, correct timings or import an SRT before continuing.');}
}
async function ensurePlan(){
 if(project.plan)return;
 if(!project.audio?.words.length||!project.audio.reviewed)throw new Error('Analyze the audio and review any timing warnings first.');
 setStage('plan');await statusCheckpoint();activity('Claude is choosing shot boundaries from the narration timestamps…');
 const output=await execute('plan',{action:'narration-plan',...base(),audioDuration:project.audio.duration,words:project.audio.words,timingReviewed:project.audio.reviewed},'text');
 let plan;try{plan=validatePlan(output.text,project.audio.duration);plan.requests.forEach(r=>videoPrompt(plan,r.index));}catch(e){project.tasks.plan.status='error';project.tasks.plan.error=e.message;throw e;}project.plan=plan;project.clips={};project.final=null;finalBlob=null;await save();render();await statusCheckpoint();
}
async function clipBlob(index){
 const clip=project.clips[index];if(!clip)throw new Error(`Video ${index} is not ready.`);let blob=await media(clip.key);if(blob)return blob;if(!clip.url)throw new Error(`Video ${index} must be uploaded again.`);
 blob=await fetchMedia(clip.url,{teamCode:$('teamCode').value,signal:controller?.signal});clip.key||=newUUID();await cache(clip.key,blob);await save();return blob;
}
async function generateVideos(indices){
 if(!project.plan)throw new Error('Create the timed shot plan first.');setStage('videos');await statusCheckpoint();const slots=indices||project.plan.requests.map(r=>r.index);let cursor=0;const problems=[];
 const worker=async()=>{while(cursor<slots.length&&!controller.signal.aborted){const i=slots[cursor++];try{
  if(!project.clips[i]){activity(`Generating planned clips · ${ready()} of ${project.plan.requestCount} ready`);const out=await execute('video-'+i,{action:'narration-video',...base(),audioDuration:project.audio.duration,plan:project.plan,scene:i},'video');project.clips[i]={url:out.videoURL,taskUUID:project.tasks['video-'+i].id,key:project.tasks['video-'+i].id};await save();}
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
   if(provider){if(!connection?.enabled)throw new Error('Check the backend connection first.');if(!connection.configured)throw new Error('Add your Runware API key in Admin, then check the connection.');}
   await fn();
  }catch(e){notice(controller.signal.aborted?'Workflow stopped. Your work is saved. Resume checks existing requests.':e.message,!controller.signal.aborted);activity(controller.signal.aborted?'Stopped. Ready to resume.':'Needs attention. Your saved work is retained.');}
  finally{clearInterval(timer);busy=false;controller=null;retry=false;await save().catch(e=>notice(e.message,true));render();}
 };
 if(navigator.locks)await navigator.locks.request('craftush-documentary-narration',{ifAvailable:true},work);else await work(true);
}
async function guarded(fn){try{await fn();}catch(e){notice(e.message,true);}}
function changedScript(){const text=scriptText($('scriptText').value);if(text!==project.script)revision(text);}
$('writeScript').onclick=()=>run(()=>write(false));$('refineScript').onclick=()=>run(async()=>{changedScript();await write(true);});
$('saveScript').onclick=()=>guarded(async()=>{changedScript();await save();render();notice('Script saved. Approval is required after any change.');});
$('approveScript').onclick=()=>run(async()=>{changedScript();approveScript(project);await save();await continueProduction();});
$('generateVoice').onclick=()=>run(ensureVoice);$('analyzeAudio').onclick=()=>run(async()=>{await analyze();await ensurePlan();});$('planShots').onclick=()=>run(ensurePlan);
for(const id of ['continueVideos','generateVideos'])$(id).onclick=()=>run(async()=>{await generateVideos();await assemble();});
$('retryFailed').onclick=()=>run(async()=>{await continueProduction();},{retries:true});$('retryClip').onclick=()=>run(()=>generateVideos([selected]),{retries:true});
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

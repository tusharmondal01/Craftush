import { DEFAULTS, choices } from './automation-config.mjs';
const panel=document.createElement('section');panel.className='automation-panel';panel.setAttribute('aria-label','Sheet automation');
panel.innerHTML=`<div class="automation-top"><div><span class="eyebrow">From your sheet to your timeline</span><h3>Start with one episode.</h3></div><a href="../admin/#admin-visuals-automation">Shared settings ↗</a></div><div class="fields"><label class="field span2">Google Sheet link<input id="autoSheet" type="url" placeholder="https://docs.google.com/spreadsheets/d/…"></label><label class="field">Tab name<input id="autoTab" type="text" placeholder="Rare &amp; Endangered Animals"></label><label class="field">Row number<input id="autoRow" type="number" min="2" max="100000" value="2"></label></div><p class="note">Reads Track, Subtrack, Category, Sub Category and Episode Name from C–G. Start here, then run the copied project command in ChatGPT. Keep this tab open so results advance automatically. Your original four steps remain available below.</p><div class="bar"><button class="primary" id="autoStart">Start automation</button><button id="autoResume" hidden>Resume saved run</button><button id="autoStop" hidden>Stop</button></div><div id="autoHandoff" hidden><label class="field">Continue this run in ChatGPT<textarea id="autoCommand" rows="4" readonly spellcheck="false" aria-label="Private ChatGPT project command"></textarea></label><button id="autoCopy">Copy ChatGPT command</button><p class="note">Uses your connected Google Drive and Runware accounts. This private project command expires in 24 hours; Resume creates a fresh one.</p></div><ol id="autoStages" class="automation-stages"><li>Research</li><li>Script</li><li>Scenes</li><li>Prompts</li><li>Images</li><li>Voiceover</li><li>Sync &amp; export</li></ol><progress id="autoProgress" aria-label="Completed automation stages" max="7" value="0"></progress><p id="autoStatus" class="status" role="status">Loading shared settings…</p><p id="autoCost" class="meta"></p><details id="autoSources" hidden><summary>Research sources</summary><ul></ul></details>`;
document.querySelector('.workflow-head').after(panel);
const css=document.createElement('style');css.textContent=`.automation-panel{background:#fffaf5;border:1px solid #ead8ca;border-radius:20px;padding:24px;margin:20px 0 32px;color:#29231f}.automation-top{display:flex;justify-content:space-between;align-items:center;gap:16px}.automation-top h3{font-size:26px;margin:8px 0 22px}.automation-top a{color:#c65040;font-size:13px}.automation-panel input{box-sizing:border-box;width:100%;min-width:0;font:inherit;font-size:14px;color:#29231f;background:#fffdf9;border:1px solid #dfcec0;border-radius:14px;padding:12px 14px;min-height:48px}.automation-panel input:focus-visible{border-color:#ef705d;outline:3px solid #ef705d22}.automation-panel progress{width:100%;height:8px;accent-color:#ef705d;margin-top:15px;border:0;border-radius:8px;overflow:hidden;appearance:none}.automation-panel progress::-webkit-progress-bar{background:#f0e5dc;border-radius:8px}.automation-panel progress::-webkit-progress-value{background:#ef705d;border-radius:8px;transition:width .5s}.automation-panel progress::-moz-progress-bar{background:#ef705d;border-radius:8px}.automation-stages{display:flex;gap:10px;flex-wrap:wrap;list-style:none;padding:0;font-size:12px}.automation-stages li{padding:7px 10px;border:1px solid #ead8ca;border-radius:30px}.automation-stages .done{background:#f6e1d5}.automation-stages .active{border-color:#ef705d;color:#b33f30;animation:automation-pulse 1.7s ease-in-out infinite}.automation-panel #autoStatus{display:block;min-height:24px}.shared-setting-note{font-size:12px;color:#9b6650}.automation-running .step{pointer-events:none}.automation-running .step .next{pointer-events:none}@keyframes automation-pulse{50%{background:#ffe4d8}}@media(prefers-reduced-motion:reduce){.automation-stages .active{animation:none}}@media(max-width:650px){.automation-panel{padding:16px}.automation-top{align-items:flex-start;flex-direction:column}}`;
document.head.append(css);
const el=id=>document.getElementById(id),sharedKeys=[...Object.keys(choices),'notes','steps','conc','qcOn','autoStrong','fill','zero'];
let config=null,job=null,projectToken='',running=false,stopped=false,retry=false,lastCheckpoint=Promise.resolve();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const display=(message,error=false)=>{el('autoStatus').textContent=message;el('autoStatus').className='status '+(error?'err':'');};
const storageKey='craftush-visuals-automation-v1';
const inputData=()=>({sheetURL:el('autoSheet').value.trim(),tab:el('autoTab').value.trim(),row:Number(el('autoRow').value),textModel:TEXT_MODEL||el('textModelSel').value,splitMode:el('splitMode').value,imageModel:imageModel(),pace:el('pace').value,minImg:el('minImg').value,maxImg:el('maxImg').value});
async function api(action,data={}){
 const response=await (window.craftushAPI||fetch)('/api/visuals-automation',{method:'POST',headers:{'content-type':'application/json','x-team-code':teamCode()},body:JSON.stringify({action,jobId:job?.id,...data})});
 const result=await response.json();if(!response.ok)throw new Error(result.errors?.[0]?.message||'Automation request failed.');return result;
}
async function loadConfig(){
 const response=await (window.craftushAPI||fetch)('/api/visuals-automation',{cache:'no-store'});if(!response.ok)throw new Error('Automation needs the updated backend.');
 const result=await response.json();config=result.config;
 if(config.enabled)applySettings(config,true);
 el('autoStart').disabled=running||!config.enabled;
 display(!config.enabled?'An admin needs to save and enable the shared automation settings.':'Ready. Choose your models and split method, start, then copy the command into ChatGPT.');
}
function applySettings(cfg,hide=false){
 for(const key of sharedKeys){const input=el(key);if(!input)continue;if(input.type==='checkbox')input.checked=cfg[key];else input.value=cfg[key];
  if(hide){const label=input.closest('label');if(label)label.hidden=true;}
 }
 applyModelRules();renderGrid();refreshTimeline();
 if(hide&&!document.querySelector('.shared-setting-note')){const note=document.createElement('p');note.className='shared-setting-note';note.textContent='Frame shape, quality, motion and export settings are managed in Admin → Visuals automation.';el('st3').querySelector('.lede').after(note);}
}
function lock(){
 document.body.classList.toggle('automation-running',running);
 document.querySelectorAll('.step').forEach(s=>{s.inert=running;});
 for(const id of ['autoSheet','autoTab','autoRow','autoStart','autoResume'])el(id).disabled=running;
 el('autoStop').hidden=!running;el('autoStop').disabled=stopped;
}
function stage(index,message){el('autoProgress').value=index;[...el('autoStages').children].forEach((li,i)=>{li.className=i<index?'done':i===index&&index<7?'active':'';});display(message);}
function checkStop(){if(stopped)throw new Error('Stopped. Resume to continue from saved work.');}
async function task(action,extra={}){
 let result,first=true;const deadline=Date.now()+30*60*1000;
 do{
  checkStop();result=await api(action,{...extra,retry:retry&&first});first=false;
  if(result.pending){display('Waiting for your ChatGPT run. Keep this tab open; completed results appear here automatically.');await pause(3500);}
 }while(result.pending&&Date.now()<deadline);
 if(result.pending)throw new Error('This task is still pending. Resume later to check its existing result.');
 return result;
}
async function relayAutomation(tasks){
 const data=[];let model;
 for(const original of tasks){checkStop();if(original.taskType==='getResponse')throw new Error('Unexpected provider polling request.');const result=await task('task',{task:original});data.push(...result.data);if(result.model)model=result.model;await checkpoint();}
 return {data,model};
}
function snapshot(){return {phase:job.phase||0,script:el('script').value,title:el('videoTitle').value,bible:el('bible').value,
 items:state.items.map(({url,b64,generationTicket,...it})=>it),cost:state.cost,transitionSeed:state.transitionSeed,
 controls:Object.fromEntries(['splitMode','pace','minImg','maxImg','imgModel','customModel','textModelSel'].map(k=>[k,el(k).value])),speech:job.speech||null};}
function checkpoint(){
 if(!job)return Promise.resolve();const data=snapshot();
 // Serialize checkpoints so a slow earlier response cannot overwrite later work.
 lastCheckpoint=lastCheckpoint.catch(()=>{}).then(()=>api('checkpoint',{checkpoint:data})).then(result=>{if(result.job&&job?.id===result.job.id)job.cost=result.job.cost;return result;});return lastCheckpoint;
}
function remember(){try{localStorage.setItem(storageKey,JSON.stringify({...inputData(),jobId:job.id,projectToken}));}catch{}el('autoResume').hidden=false;}
function showHandoff(token){
 projectToken=token||projectToken;el('autoHandoff').hidden=false;
 el('autoCommand').value=`Continue my Stunning Visuals automation in Craftush using project code ${projectToken}. Read the Craftush workflow, then use craftush_project read/prepare/record with this projectToken. Read the exact requested Google Sheet row through my Google Drive connection and run the prepared tasks through my connected Runware account. Preserve every model and task UUID. Keep going through script, prompts, images and male narration until the website is ready for timing review and Premiere export. Never send either provider credential to Craftush.`;
}
async function waitForSheet(){
 const deadline=Date.now()+30*60*1000;
 while(!job.episode){
  checkStop();stage(0,'Copy the project command into ChatGPT to read your selected sheet row.');
  if(Date.now()>deadline)throw new Error('The sheet handoff is waiting. Resume and send the new command in ChatGPT.');
  await pause(2500);checkStop();job=(await api('get')).job;
 }
}
async function restore(saved){
 const cp=saved.checkpoint;
 if(!cp){
  for(const key of ['splitMode','pace','minImg','maxImg'])if(saved[key]!==undefined)el(key).value=saved[key];
  if(saved.imageModel){const input=el('imgModel');if(![...input.options].some(o=>o.value===saved.imageModel))input.add(new Option(saved.imageModel,saved.imageModel));input.value=saved.imageModel;}
  applyModelRules();return;
 }
 job.phase=cp.phase||0;job.speech=cp.speech;el('script').value=cp.script||saved.script||'';el('videoTitle').value=cp.title||saved.episode.title;el('bible').value=cp.bible||'';
 for(const [key,value] of Object.entries(cp.controls||{})){const input=el(key);if(input){if(input.tagName==='SELECT'&&![...input.options].some(o=>o.value===value))input.add(new Option(value,value));input.value=value;}}
 TEXT_MODEL=saved.textModel;state.cost=cp.cost||{images:0,prompts:0,per:{}};state.transitionSeed=cp.transitionSeed||uuidSeed();
 state.items=cp.items||[];
 for(const it of state.items){if(it.imageSourceURL&&!(saved.config.qcOn&&!it.qc)){const response=await fetch(it.imageSourceURL);if(!response.ok)throw new Error('A saved image URL expired. Export each completed episode promptly.');const blob=await response.blob();it.b64=await blobToB64(blob);it.url=URL.createObjectURL(blob);it.status='done';}else {it.status='idle';it.b64=null;it.url=null;}}
 renderAll();
}
function researchLinks(research){el('autoSources').hidden=false;const list=el('autoSources').querySelector('ul');list.replaceChildren();for(const source of research.sources){const li=document.createElement('li'),a=document.createElement('a');a.textContent=source.title;a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';li.append(a);list.append(li);}}
async function run(resume){
 if(running)return;
 running=true;stopped=false;state.cancel=false;retry=resume;lock();
 let timer=setInterval(()=>{if(!job)return;const done=state.items.filter(it=>it.b64).length;el('autoCost').textContent=`${state.items.length?`${done}/${state.items.length} images ready · `:''}Runware reported cost is saved with this run.`;},2000);
 try{
  if(resume){const saved=JSON.parse(localStorage.getItem(storageKey)||'{}');job={id:saved.jobId};const result=await api('resume');job=result.job;showHandoff(result.projectToken);remember();applySettings(job.config);await restore(job);}
  else{
   await loadConfig();if(!config.enabled)throw new Error('Enable automation in admin first.');
   const result=await api('start',inputData());job=result.job;showHandoff(result.projectToken);
   state.items.forEach(it=>it.url&&URL.revokeObjectURL(it.url));state.items=[];state.cost={images:0,prompts:0,per:{}};el('bible').value='';state.directorBible=null;state.cancel=false;
   stopNarrationWorker();voiceLoadTicket++;if(state.vo?.url)URL.revokeObjectURL(state.vo.url);state.vo=null;state.cues=[];state.narrationKey=null;resetNarrationReview();
   applySettings(job.config);if(result.existing)await restore(job);remember();
  }
  await waitForSheet();
  if(!job.checkpoint){el('videoTitle').value=job.episode.title;el('seqName').value=job.episode.title;}
  checkStop();
  if(!job.research){stage(0,'Researching the episode with current sources…');const result=await task('research');job.research=result.research;}
  researchLinks(job.research);job.phase=Math.max(job.phase||0,1);await checkpoint();
  if(!job.script){stage(1,'Writing your Hinglish script with '+job.textModel+'…');const result=await task('script');job.script=result.script;job.hookType=result.hookType;}
  el('script').value=job.script;el('videoTitle').value=job.episode.title;el('seqName').value=job.episode.title;TEXT_MODEL=job.textModel;saveScriptDraft();job.phase=Math.max(job.phase,2);await checkpoint();checkStop();
  if(!state.items.length){stage(2,'Creating scenes with your selected split method…');showStep(0);await createVisualScenes();if(!state.items.length)throw new Error('No scenes were created.');}
  job.phase=Math.max(job.phase,3);await checkpoint();checkStop();
  if(state.items.some(it=>!it.prompt?.trim())){stage(3,'Writing contextual prompts in story order…');showStep(1);await writeVisualPrompts();if(state.items.some(it=>!it.prompt?.trim()))throw new Error('Some prompts are unfinished. Resume to retry before generating images.');}
  job.phase=Math.max(job.phase,4);await checkpoint();checkStop();
  if(state.items.some(it=>!it.b64)){stage(4,'Generating images and checking their relevance…');showStep(2);await generateVisualImages();await checkpoint();checkStop();if(state.items.some(it=>!it.b64))throw new Error('Some images failed. Resume to retry only unfinished images.');}
  job.phase=Math.max(job.phase,5);await checkpoint();checkStop();
  if(!job.speech){stage(5,'Generating the complete narration with your shared MiniMax voice…');const result=await task('speech');const audio=result.data.find(d=>d.audioURL);if(!audio)throw new Error('Runware returned no audio URL.');job.speech={url:audio.audioURL,cost:audio.cost||0};await checkpoint();}
  job.phase=6;await checkpoint();checkStop();stage(6,'Syncing the generated narration to your images…');showStep(3);
  const response=await fetch(job.speech.url);if(!response.ok)throw new Error('Generated audio could not be downloaded. Resume to try its existing URL again.');
  const narration=await response.blob();checkStop();
  await loadVoice(new File([narration],'runware-narration.mp3',{type:'audio/mpeg'}));checkStop();
  while(state.transcribing||state.voiceLoading){await pause(700);checkStop();}
  if(state.vo?.duration>=180)throw new Error('Narration exceeds 180 seconds. Adjust the script instructions and rerun with a shorter script before publishing.');
  if(!state.timeline.length||state.timingErrors?.length||state.timingNeedsReview){display('Generated images and narration are ready. Check the highlighted timing matches in Export before downloading.',true);}
  else {stage(7,'Generation complete. Preview the narration once, then use Download Premiere package.');}
  const refreshed=(await api('get')).job;el('autoCost').textContent='Runware reported cost for this run: $'+Number(refreshed.cost||0).toFixed(3);
  job.phase=7;await checkpoint();
 }catch(error){if(job)await api('stop').catch(()=>{});display(stopped?'Stopped. Submitted tasks can still finish; Resume retrieves their existing results.':error.message,true);}
 finally{clearInterval(timer);running=false;state.running=false;lock();updateButtons();if(job)el('autoResume').hidden=false;}
}
el('autoStart').onclick=()=>run(false);el('autoResume').onclick=()=>run(true);
el('autoStop').onclick=()=>{stopped=true;if(job)api('stop').catch(error=>display('Stop could not reach the server. Stop the ChatGPT run too. '+error.message,true));state.cancel=true;voiceLoadTicket++;state.voiceLoading=false;stopNarrationWorker();lock();display('Stopping after the current submitted task. Saved work will be retained.');};
el('autoCopy').onclick=async()=>{try{await navigator.clipboard.writeText(el('autoCommand').value);el('autoCopy').textContent='Copied — paste in ChatGPT';}catch{el('autoCommand').focus();el('autoCommand').select();display('Select and copy the project command, then paste it into ChatGPT.');}};
window.addEventListener('beforeunload',e=>{if(running){e.preventDefault();e.returnValue='';}});
window.CraftushAutomation={get running(){return running;},get sharedSettings(){return running&&job?job.config:config;},relay:relayAutomation,lock,checkpoint,reportedCost:()=>job&&el('script').value===job.script?Number(job.cost||0):null,metadata:()=>job&&el('script').value===job.script?{episode:job.episode,research:job.research,script:job.script,hookType:job.hookType,settings:job.config}:null};
try{const saved=JSON.parse(localStorage.getItem(storageKey)||'{}');el('autoSheet').value=saved.sheetURL||'';el('autoTab').value=saved.tab||'';el('autoRow').value=saved.row||2;el('autoResume').hidden=!saved.jobId;projectToken=saved.projectToken||'';}catch{}
loadConfig().catch(error=>{display(error.message,true);el('autoStart').disabled=true;});

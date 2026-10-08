/* Page adapter for word alignment, review, audio preview and a narration track in Premiere XML. */
let narrationWorker=null,narrationTicket=0,voiceLoadTicket=0,narrationPreviewLimit=null,narrationWatchdog=null;
function ensureSceneIds(){
  const seen=new Set();
  state.items.forEach(it=>{if(typeof it.id!=='string'||!it.id||seen.has(it.id))it.id=uuid();seen.add(it.id);});
}
function narrationKey(){ensureSceneIds();return JSON.stringify([state.items.map(it=>[it.id,it.text]),state.cues,state.vo?.identity,$('#mode').value,$('#syncOffset').value,$('#zero').checked]);}
function syncStatus(phase,message){state.syncPhase=phase;state.syncMessage=message;$('#alignmentStatus').textContent=message;}
function syncFailure(message){stopNarrationWorker();syncStatus('error',message);$('#syncRecovery').open=true;refreshTimeline();}
function armNarrationWatchdog(ticket){
  clearTimeout(narrationWatchdog);
  narrationWatchdog=setTimeout(()=>{if(ticket===narrationTicket&&state.transcribing)syncFailure('Sync stopped responding. Retry automatic sync, or add an SRT from this exact narration below.');},300000);
}
function resetNarrationReview(){state.cutOverrides=new Map();state.cutReviewed=new Set();state.timingConfirmed=false;$('#confirmTiming').checked=false;state.xmlDone=false;}
function ensureNarrationState(){
  const key=narrationKey();
  if(state.narrationKey!==key){state.narrationKey=key;resetNarrationReview();}
}
function hasExportTiming(){return state.timeline.length===state.items.length&&state.items.length>0&&state.timingConfirmed&&!state.timingNeedsReview&&!state.voiceLoading&&!state.transcribing&&!state.timingErrors?.length;}
function stopNarrationWorker({keepModel=false}={}){
  clearTimeout(narrationWatchdog);narrationWatchdog=null;
  narrationTicket++;if(narrationWorker&&!keepModel){narrationWorker.terminate();narrationWorker=null;}state.transcribing=false;
}
async function analyseVoice(file){
  const Ctx=window.AudioContext||window.webkitAudioContext;
  if(!Ctx)throw new Error('This browser cannot decode narration. Use a current Chrome or Edge browser.');
  const ctx=new Ctx(),Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(!Offline){await ctx.close();throw new Error('This browser cannot prepare narration for speech recognition.');}
  try{
    const buffer=await ctx.decodeAudioData(await file.arrayBuffer());
    if(!buffer.length||buffer.numberOfChannels>2)throw new Error('Use mono or stereo narration.');
    const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i).slice());
    const blob=new Blob([CraftushAlignment.wav(channels,buffer.sampleRate)],{type:'audio/wav'});
    const offline=new Offline(1,Math.ceil(buffer.duration*16000),16000),source=offline.createBufferSource();
    source.buffer=buffer;source.connect(offline.destination);source.start();
    const resampled=await offline.startRendering();
    return {name:file.name,identity:[file.name,file.size,file.lastModified,buffer.duration],duration:buffer.duration,sampleRate:buffer.sampleRate,channels:channels.length,blob,url:URL.createObjectURL(blob),samples:resampled.getChannelData(0).slice(),words:null};
  }finally{await ctx.close().catch(()=>{});}
}
async function loadVoice(file){
  if(!file)return;
  stopNarrationWorker({keepModel:!state.transcribing});const ticket=++voiceLoadTicket;
  ++subtitleTicket;state.cues=[];$('#srtFile').value='';$('#dropTitle').textContent='Use an SRT from this narration';$('#dropSub').textContent='Optional: replaces automatic word recognition with your subtitle timings.';
  $('#mode').value='audio';syncStatus('reading','Reading your narration. Images will sync automatically.');
  narrationPreviewLimit=null;$('#narrationImage').hidden=true;
  $('#narrationAudio').pause();if(state.vo?.url)URL.revokeObjectURL(state.vo.url);
  state.vo=null;state.voiceLoading=true;resetNarrationReview();state.timeline=[];
  $('#narrationAudio').removeAttribute('src');$('#narrationAudio').load();
  $('#voTitle').textContent=file.name;$('#voSub').textContent='Reading narration audio…';updateButtons();
  try{
    const vo=await analyseVoice(file);
    if(ticket!==voiceLoadTicket){URL.revokeObjectURL(vo.url);return;}
    state.vo=vo;$('#narrationAudio').src=vo.url;
    $('#voSub').textContent=`${fmtClock(vo.duration)} · Each image will follow its own spoken line.`;
  }catch(error){if(ticket===voiceLoadTicket){$('#voSub').textContent='Could not read this audio. Try a WAV or MP3 file.';syncStatus('error',$('#voSub').textContent+' '+error.message);}}
  finally{if(ticket===voiceLoadTicket){state.voiceLoading=false;if(state.vo&&state.items.length&&$('#mode').value==='audio')transcribeNarration();else refreshTimeline();}}
}
function transcribeNarration(){
  if(!state.vo?.samples||state.transcribing||!state.items.length)return;
  stopNarrationWorker({keepModel:true});const ticket=narrationTicket,vo=state.vo;
  vo.words=null;state.narrationKey=null;$('#mode').value='audio';state.transcribing=true;state.timingConfirmed=false;$('#confirmTiming').checked=false;
  syncStatus('syncing','Syncing automatically. The first use downloads a speech model; keep this tab open.');refreshTimeline();armNarrationWatchdog(ticket);
  try{
    narrationWorker=narrationWorker||new Worker('voice-worker.mjs?v=19',{type:'module'});
    narrationWorker.onmessage=({data})=>{
      if(ticket!==narrationTicket||state.vo!==vo||(data.ticket!==undefined&&data.ticket!==ticket))return;
      armNarrationWatchdog(ticket);
      if(data.type==='progress'){
        syncStatus('syncing',data.status==='progress'?`Preparing automatic sync · ${Math.round(data.progress||0)}% of ${String(data.file||'model').split('/').pop()}`:'Preparing automatic sync on this device…');
      }else if(data.type==='listening'||data.type==='chunk'){
        syncStatus('syncing',data.phase==='recovering'?`Recovering speech timings · section ${data.count} of ${data.total}…`:'Matching your spoken narration'+(data.count?` · ${data.count}${data.total?' of '+data.total:''} sections processed`:'')+'…');
      }else if(data.type==='complete'){
        try{
          vo.words=CraftushAlignment.fromWords(data.chunks,vo.duration);vo.transcript=String(data.text||'');vo.syncIssues=Array.isArray(data.issues)?data.issues:[];
          if(!vo.words.length)throw new Error('No words were recognized.');
          $('#mode').value='audio';state.narrationKey=null;
          const uncertain=vo.words.filter(word=>word.timingUncertain).length;
          syncStatus('matched',`Matched ${vo.words.length} spoken words.${uncertain||vo.syncIssues.length?' Some timings need a listening check below.':''} Preview the images below.`);
          $('#syncRecovery').open=false;
        }catch(error){syncStatus('error','Automatic sync could not find usable word timings. Retry sync or add an SRT below. '+error.message);$('#syncRecovery').open=true;vo.words=null;}
        stopNarrationWorker({keepModel:true});refreshTimeline();
      }else if(data.type==='error'){
        syncFailure('Automatic sync could not finish. Retry sync, or add an SRT from this exact narration below. '+String(data.message||''));
      }
    };
    narrationWorker.onerror=()=>{
      if(ticket!==narrationTicket)return;
      syncFailure('Your browser could not load automatic sync. Retry with a working internet connection, or add an SRT from this narration below.');
    };
    const samples=vo.samples.slice();narrationWorker.postMessage({type:'transcribe',ticket,audio:samples,language:$('#voiceLanguage').value},[samples.buffer]);
  }catch(error){syncFailure('Automatic sync could not start. Retry sync or use an SRT below. '+error.message);}
}
function computeStarts(){
  ensureNarrationState();
  const mode=$('#mode').value,offset=Number($('#syncOffset').value||0),duration=state.vo?.duration;
  if(state.voiceLoading||state.transcribing)return null;
  if(mode==='manual'){
    if(!duration)throw new Error('Add the narration audio to set its scene starts manually.');
    return {rows:state.items.map((it,i)=>({i,start:null,coverage:0,matched:'',reasons:['Set the start while listening'],confidence:'review'})),end:duration,coverage:0,manual:true};
  }
  if(mode==='audio'){
    if(!state.vo||!state.vo.words)return null;
    return CraftushAlignment.align(state.items,state.vo.words,{duration,offset:0,issues:state.vo.syncIssues||[]});
  }
  if(!state.cues.length)return null;
  const words=CraftushAlignment.fromCues(state.cues);
  const r=CraftushAlignment.align(state.items,words,{duration,offset,onePerCue:mode==='cues',cues:state.cues});
  if(duration&&state.cues[state.cues.length-1].end+offset>duration+.1)throw new Error('The SRT extends past this audio. Use subtitles from the exact narration or correct the explicit subtitle offset. The site will not stretch their times.');
  return r;
}
function refreshTimeline(){
  stopTransitionPreview();state.xmlDone=false;state.timeline=[];state.timingErrors=[];state.timingNeedsReview=true;
  $('#track').innerHTML='';$('#ruler').innerHTML='';$('#tlMeta').textContent='';$('#timeline').hidden=true;
  let r=null;
  try{if(state.items.length)r=computeStarts();}catch(error){state.timingErrors=[error.message];}
  state.alignment=r;
  if(!r){
    $('#alignmentRows').innerHTML='';$('#alignmentReview').hidden=true;
    const message=state.timingErrors[0]||(!state.items.length?'Create your script scenes first.':state.voiceLoading?'Reading your narration…':state.transcribing?state.syncMessage:state.syncPhase==='error'||state.syncPhase==='stopped'?state.syncMessage:state.vo?'Ready to retry automatic sync.':'Add your final audio. Sync starts automatically.');
    $('#timingSummary').textContent=message;
    $('#confirmTiming').disabled=true;state.timingConfirmed=false;$('#confirmTiming').checked=false;
    setStatus('#s4',message,state.timingErrors.length||state.syncPhase==='error'?'err':'');
    updateButtons();return;
  }
  const rows=r.rows.map(row=>({...row,start:state.cutOverrides.has(row.i)?state.cutOverrides.get(row.i):row.start,
    reasons:state.cutOverrides.has(row.i)?[...row.reasons,'Manually set start; check while listening']:row.reasons,reviewed:state.cutReviewed.has(row.i)}));
  if($('#zero').checked&&rows.length&&!state.cutOverrides.has(0))rows[0].start=0;
  const {fps}=rateInfo(),built=CraftushAlignment.buildTimeline(rows,r.end,fps);
  state.timeline=built.clips;state.timingErrors=built.errors;
  const unresolved=rows.filter(row=>row.reasons.length&&!row.reviewed);
  state.timingNeedsReview=unresolved.length>0;
  $('#alignmentReview').hidden=false;
  $('#alignmentRows').innerHTML=rows.map((row,k)=>{
    const it=state.items[row.i],end=k+1<rows.length?rows[k+1].start:r.end;
    return `<li class="alignment-row${row.reasons.length&&!row.reviewed?' needs-review':''}" data-scene="${row.i}">
      ${it.url?`<img alt="Image ${numStr(row.i)}" src="${esc(it.url)}" loading="lazy"/>`:'<span class="alignment-number">'+numStr(row.i)+'</span>'}
      <div><strong>${fname(row.i)}</strong>${it.url?` <a class="image-link" href="${esc(it.url)}" target="_blank" rel="noopener">Open image</a>`:''}<p>${esc(spoken(it.text))}</p>
      <small class="timing-reason">${esc(row.reviewed?'Start checked':row.reasons.length?'Check this start: '+row.reasons.join('. '):'✓ Spoken line matched')}</small></div>
      <div class="alignment-start"><strong>${CraftushAlignment.formatTime(row.start)||'Start needed'} → ${CraftushAlignment.formatTime(end)||'next image'}</strong>
      <div class="bar"><button data-listen="${row.i}" type="button" ${state.vo?'':'disabled'}>▶ Listen to this line</button></div>
      <details ${row.reasons.length&&!row.reviewed?'open':''}><summary>Adjust start</summary><label>Start <input aria-label="Start for image ${numStr(row.i)}" data-cut="${row.i}" type="text" inputmode="decimal" value="${CraftushAlignment.formatTime(row.start)}" placeholder="0:00.000"/></label>
      <button data-mark="${row.i}" type="button" ${state.vo?'':'disabled'}>Use playhead</button><label class="check"><input data-review="${row.i}" type="checkbox" ${row.reviewed?'checked':''}/> Start checked</label>
      <small>${row.matched?`Matched ${Math.round(row.coverage*100)}%: ${esc(row.matched)}`:'No automatic transcript match'}</small></details></div></li>`;
  }).join('');
  const ready=!unresolved.length&&!built.errors.length;
  $('#confirmTiming').disabled=!ready;
  if(!ready){state.timingConfirmed=false;$('#confirmTiming').checked=false;}
  $('#timingSummary').textContent=built.errors[0]||`${rows.length} lines linked to ${rows.length} images · ${r.manual?'manual starts':Math.round(r.coverage*100)+'% of script words matched'}${unresolved.length?` · Check ${unresolved.length} highlighted starts`:' · Ready to preview'}.`;
  if(!state.timeline.length){setStatus('#s4',built.errors[0]||'Set the missing scene starts before exporting.','err');updateButtons();return;}
  $('#timeline').hidden=false;
  const total=state.timeline[state.timeline.length-1].end,lens=state.timeline.map(c=>(c.end-c.start)/fps);
  $('#tlMeta').textContent=`${rows.length} images, ${fmtClock(total/fps)} total, ${Math.min(...lens).toFixed(1)}s to ${Math.max(...lens).toFixed(1)}s each`;
  const transitions=/^(auto|gentle|reference)$/.test($('#trans').value)?getAutoTransitions():[];
  $('#track').innerHTML=state.timeline.map((c,k)=>`<div class="clip" style="flex:${c.end-c.start} 0 0;${state.items[c.i].url?`background-image:url('${esc(state.items[c.i].url)}')`:''}" title="${esc(fname(c.i)+' '+CraftushAlignment.formatTime(c.start/fps)+' to '+CraftushAlignment.formatTime(c.end/fps)+(transitions[k]?' • '+transitions[k].preset.name:''))}"><b>${numStr(c.i)}</b></div>`).join('');
  const seconds=total/fps,step=seconds>600?60:seconds>240?30:seconds>90?15:10;
  for(let s=0;s<seconds;s+=step)$('#ruler').innerHTML+=`<span style="left:${s/seconds*100}%">${fmtClock(s)}</span>`;
  setStatus('#s4',ready?(state.timingConfirmed?'Ready. Download one package with your images, narration and Premiere timeline.':'Preview the narration, then tick “Preview checked” to download the complete package.'):'Check the highlighted starts, then tick Start checked. Your image order is preserved.',ready&&state.timingConfirmed?'ok':'');
  updateButtons();
}
function narrationAudioXML(rate){
  const vo=state.vo;if(!vo?.blob)return '';
  const {fps}=rateInfo(),duration=Math.round(vo.duration*fps),file='narration.wav',sample=`<samplecharacteristics><depth>16</depth><samplerate>${vo.sampleRate}</samplerate></samplecharacteristics>`;
  const links=Array.from({length:vo.channels},(_,k)=>`<link><linkclipref>narration-${k+1}</linkclipref><mediatype>audio</mediatype><trackindex>${k+1}</trackindex><clipindex>1</clipindex><groupindex>1</groupindex></link>`).join('');
  const tracks=Array.from({length:vo.channels},(_,k)=>`<track><clipitem id="narration-${k+1}"><name>${file}</name><enabled>TRUE</enabled><duration>${duration}</duration>${rate}<start>0</start><end>${duration}</end><in>0</in><out>${duration}</out>
    ${k===0?`<file id="narration-file"><name>${file}</name><pathurl>${xesc(pathUrl($('#folder').value,file))}</pathurl>${rate}<duration>${duration}</duration><media><audio>${sample}<layout>${vo.channels===2?'stereo':'mono'}</layout><channelcount>${vo.channels}</channelcount></audio></media></file>`:'<file id="narration-file"/>'}
    <sourcetrack><mediatype>audio</mediatype><trackindex>${k+1}</trackindex></sourcetrack>${links}</clipitem><enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${k+1}</outputchannelindex></track>`).join('');
  const outputs=`<outputs><group><index>1</index><numchannels>${vo.channels}</numchannels><downmix>0</downmix>${Array.from({length:vo.channels},(_,k)=>`<channel><index>${k+1}</index></channel>`).join('')}</group></outputs>`;
  return `<audio><numOutputChannels>${vo.channels}</numOutputChannels><format>${sample}</format>${outputs}${tracks}</audio>`;
}
function narrationTimingData(){
  ensureSceneIds();return {version:17,source:$('#mode').value,narration:state.vo?{name:'narration.wav',originalName:state.vo.name,duration:state.vo.duration}:null,fps:rateInfo().fps,confirmed:state.timingConfirmed,
    images:state.timeline.map(c=>({sceneId:state.items[c.i].id,image:fname(c.i),imageSourceURL:state.items[c.i].imageSourceURL||null,text:state.items[c.i].text,startFrame:c.start,endFrame:c.end,start:c.start/rateInfo().fps,end:c.end/rateInfo().fps}))};
}
function initNarrationSync(){
  state.vo=null;state.voiceLoading=false;state.transcribing=false;state.narrationKey=null;syncStatus('idle','Add audio to start automatic sync. The first use needs an internet connection to download the speech model.');resetNarrationReview();
  $('#voFile').addEventListener('change',e=>loadVoice(e.target.files[0]));
  const area=$('#voDrop');['dragenter','dragover'].forEach(ev=>area.addEventListener(ev,e=>{e.preventDefault();area.classList.add('over');}));
  ['dragleave','drop'].forEach(ev=>area.addEventListener(ev,e=>{e.preventDefault();area.classList.remove('over');}));area.addEventListener('drop',e=>loadVoice(e.dataTransfer.files[0]));
  $('#alignNarration').addEventListener('click',transcribeNarration);
  $('#cancelAlignment').addEventListener('click',()=>{stopNarrationWorker();syncStatus('stopped','Sync paused. Choose Retry sync to continue, or add an SRT below.');refreshTimeline();});
  $('#voiceLanguage').addEventListener('change',()=>{stopNarrationWorker({keepModel:!state.transcribing});if(state.vo)state.vo.words=null;state.narrationKey=null;if(state.vo&&state.items.length)transcribeNarration();else refreshTimeline();});
  $('#syncOffset').addEventListener('change',refreshTimeline);
  $('#alignmentRows').addEventListener('change',e=>{
    const i=Number(e.target.dataset.cut??e.target.dataset.review);if(!Number.isInteger(i))return;
    if(e.target.dataset.cut!==undefined){const t=CraftushAlignment.parseTime(e.target.value);state.cutOverrides.set(i,t);state.cutReviewed.delete(i);}
    else if(e.target.checked)state.cutReviewed.add(i);else state.cutReviewed.delete(i);
    state.timingConfirmed=false;$('#confirmTiming').checked=false;refreshTimeline();
  });
  $('#alignmentRows').addEventListener('click',e=>{
    const button=e.target.closest('button');if(!button||!state.vo)return;
    const audio=$('#narrationAudio');
    if(button.dataset.mark!==undefined){const i=Number(button.dataset.mark);state.cutOverrides.set(i,audio.currentTime);state.cutReviewed.add(i);state.timingConfirmed=false;$('#confirmTiming').checked=false;refreshTimeline();}
    if(button.dataset.listen!==undefined){const i=Number(button.dataset.listen),row=state.alignment?.rows.find(r=>r.i===i),clip=state.timeline.find(c=>c.i===i),start=clip?clip.start/rateInfo().fps:state.cutOverrides.get(i)??row?.start;
      if(!Number.isFinite(start)){setStatus('#s4','Play the narration, then choose Use playhead at this scene’s first word.','err');return;}
      const next=clip?clip.end/rateInfo().fps:state.cutOverrides.get(i+1)??state.alignment?.rows.find(r=>r.i===i+1)?.start;
      audio.currentTime=Math.max(0,start-.25);narrationPreviewLimit=Number.isFinite(next)?Math.min(state.vo.duration,next):state.vo.duration;audio.play().catch(()=>{});
    }
  });
  $('#narrationAudio').addEventListener('timeupdate',()=>{
    const audio=$('#narrationAudio');$('#audioPlayhead').textContent='Playhead '+CraftushAlignment.formatTime(audio.currentTime);
    const at=state.timeline.find(c=>audio.currentTime>=c.start/rateInfo().fps&&audio.currentTime<c.end/rateInfo().fps),it=at&&state.items[at.i];
    $('#narrationImage').hidden=!it?.url;if(it?.url){$('#narrationImage').src=it.url;$('#narrationImage').alt=fname(at.i);}
    $('#narrationImageCaption').textContent=it?fname(at.i)+' · '+spoken(it.text):'No image at this playhead position.';
    if(narrationPreviewLimit!==null&&audio.currentTime>=narrationPreviewLimit){audio.pause();narrationPreviewLimit=null;}
  });
  $('#narrationAudio').addEventListener('play',()=>{if(narrationPreviewLimit!==null&&$('#narrationAudio').currentTime>narrationPreviewLimit)narrationPreviewLimit=null;});
  ['pointerdown','keydown'].forEach(event=>$('#narrationAudio').addEventListener(event,()=>{narrationPreviewLimit=null;}));
  $('#confirmTiming').addEventListener('change',()=>{state.timingConfirmed=$('#confirmTiming').checked;state.xmlDone=false;refreshTimeline();});
}

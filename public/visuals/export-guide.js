/* Explain export blockers and provide recovery without guessing image cuts. */
let restoreImageTicket=0;
function exportReadiness(){
  const total=state.items.length,images=state.items.filter(it=>it.b64).length;
  const audio=!!state.vo?.blob,subtitles=state.cues.length>0;
  const pending=(state.alignment?.rows||[]).filter(row=>(row.reasons.length||state.cutOverrides.has(row.i))&&!state.cutReviewed.has(row.i));
  let blocker='';
  if(!total)blocker='Create your script scenes in step 1.';
  else if(state.voiceLoading)blocker='Reading your audio. Keep this tab open.';
  else if(state.transcribing)blocker='Audio is loaded. Automatic sync is still running.';
  else if(!audio&&!subtitles)blocker='Add your final audio or the SRT from this exact narration.';
  else if(!state.alignment)blocker='Sync needs help. Open Fix audio sync to retry, add your HeyGen SRT, or set cuts while listening.';
  else if(state.timingErrors.length)blocker=state.timingErrors[0];
  else if(pending.length)blocker=`Check ${pending.length} highlighted image start${pending.length===1?'':'s'}. Use the audio playhead to correct only these cuts.`;
  else if(!state.timingConfirmed)blocker='Play the narration, then tick Preview checked to enable both downloads.';
  else if(images<total&&!$('#useExistingImages').checked)blocker=`XML is ready. The full ZIP needs ${total-images} more image file${total-images===1?'':'s'}. Return to step 3 or restore your numbered images below.`;
  else if(state.packing)blocker='Preparing your ZIP. Wait for the download to finish.';
  else blocker=$('#useExistingImages').checked&&images<total?'Ready. This ZIP uses the numbered image files you already have.':'Ready. Download the full ZIP and the separate XML below.';
  return {total,images,audio,subtitles,pending,blocker};
}
function updateExportGuide(){
  const r=exportReadiness();
  $('#exportChecks').innerHTML=[
    [r.images===r.total&&r.total,`${r.images} / ${r.total} image files ready`],
    [r.audio||r.subtitles,r.audio?'Narration audio loaded':r.subtitles?'Exact subtitle timings loaded':'Narration audio needed'],
    [hasExportTiming(),state.transcribing?'Matching narration…':hasExportTiming()?'Image cuts checked':r.pending.length?`${r.pending.length} image starts need a check`:'Preview and confirm your image cuts']
  ].map(([ready,text])=>`<li>${ready?'✓':'○'} ${esc(text)}</li>`).join('');
  $('#exportBlocker').textContent=r.blocker;
  $('#manualSyncBtn').disabled=!state.vo||state.voiceLoading;
  $('#restoreImages').disabled=state.running||state.packing;
  const next=r.pending[0];
  $('#guidedCuts').hidden=!next||!state.vo;
  $('#guidedCutLine').textContent=next?`Next to check: ${fname(next.i)} · ${spoken(state.items[next.i].text)}`:'';
  $('#markNextCut').textContent=next?`Set image ${numStr(next.i)} here`:'All starts checked';
  if(typeof visibleStep!=='undefined'&&visibleStep===3)$('#workflowHint').textContent='Step 4 of 4 · '+r.blocker;
  $('#step4Guide').textContent=state.transcribing?'1. Audio loaded → 2. Matching spoken lines → 3. Download XML + ZIP':'1. Add audio → 2. Preview image cuts → 3. Download XML + ZIP';
}
function markNextNarrationCut(){
  const r=exportReadiness(),row=r.pending[0];if(!row||!state.vo)return;
  const time=$('#narrationAudio').currentTime,fps=rateInfo().fps;
  const previous=state.alignment.rows.find(item=>item.i===row.i-1);
  const previousStart=previous&&(state.cutOverrides.get(previous.i)??previous.start);
  if(!Number.isFinite(time)||time<0||Math.round(time*fps)>=Math.round(state.vo.duration*fps)||(row.i&&Number.isFinite(previousStart)&&Math.round(time*fps)<=Math.round(previousStart*fps))){
    setStatus('#s4','Play to this line’s first spoken word, after the previous image start, then set the cut.','err');return;
  }
  state.cutOverrides.set(row.i,time);state.cutReviewed.add(row.i);state.timingConfirmed=false;$('#confirmTiming').checked=false;refreshTimeline();
}
async function localImage(file){
  const bytes=new Uint8Array(await file.arrayBuffer()),source=URL.createObjectURL(file),image=new Image();
  try{
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error(`Could not read ${file.name}. Choose a JPG, PNG or WebP image.`));image.src=source;});
    if(!image.naturalWidth||!image.naturalHeight)throw new Error(`No image pixels were found in ${file.name}.`);
    let b64;
    if(bytes[0]===255&&bytes[1]===216){
      let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));b64=btoa(binary);
    }else{
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0);
      b64=canvas.toDataURL('image/jpeg',.96).split(',')[1];
    }
    return {b64,url:'data:image/jpeg;base64,'+b64};
  }finally{URL.revokeObjectURL(source);}
}
async function restoreNumberedImages(files){
  if(!files?.length)return;
  const ticket=++restoreImageTicket,target=state.items,seen=new Set(),staged=[];
  try{
    setStatus('#s4','Restoring your image files…');
    for(const file of files){
      const match=String(file.name).match(/^(\d+)\.(?:jpe?g|png|webp)$/i),index=match?Number(match[1])-1:-1;
      if(index<0||index>=target.length)throw new Error(`Name each image by its scene number: 001.jpg, 002.jpg… (${file.name} could not be matched).`);
      if(seen.has(index))throw new Error(`Two files use image number ${numStr(index)}. Choose one file per scene.`);
      seen.add(index);staged.push({index,...await localImage(file)});
    }
    if(ticket!==restoreImageTicket||target!==state.items)return;
    staged.forEach(({index,b64,url})=>{Object.assign(target[index],{b64,url,status:'done',imageSourceURL:null,err:''});});
    state.timingConfirmed=false;$('#confirmTiming').checked=false;state.xmlDone=false;renderGrid();refreshTimeline();
    setStatus('#s4',`Restored ${staged.length} images. Preview once, then download your XML and ZIP.`,'ok');
  }catch(error){if(ticket===restoreImageTicket)setStatus('#s4',error.message,'err');}
}
function initExportGuide(){
$('#manualSyncBtn').addEventListener('click',()=>{
  if(!state.vo)return;stopNarrationWorker();$('#mode').value='manual';state.narrationKey=null;
  syncStatus('manual','Play the narration. At each line’s first word, choose Set image here.');$('#syncRecovery').open=false;refreshTimeline();
});
$('#markNextCut').addEventListener('click',markNextNarrationCut);
$('#useExistingImages').addEventListener('change',updateButtons);
$('#restoreImages').addEventListener('change',event=>restoreNumberedImages(event.target.files));
}

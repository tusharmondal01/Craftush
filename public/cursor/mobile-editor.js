import {cameraAt, createCameraSampler, normalizeEvents, screenPointToSource} from './camera.js?v=20261013-touch1';
import {analyseVideoTouches} from './touch-analysis.js?v=20261013-touch1';
import {buildTouchMotion, insertCameraMove} from './touch-motion.js?v=20261013-touch1';
import {createMotionTimeline} from './motion-timeline.js?v=20261013-touch1';

const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,v));
const timeLabel=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
const neutral={x:.5,y:.5,zoom:1};

export function createMobileEditor({canvas,video,state,toast,onChange,onImport,onSeek,onStatus=()=>{},analyseTouches=analyseVideoTouches}) {
  const $=id=>document.getElementById(id);
  let focus={x:.5,y:.5}, transient=null, drag=null, dragHeld=false, panMode=false, binding=null;
  let history=[], loadGeneration=0, analysisGeneration=0, analysisAbort=null, footageInfo=null, calibrating=false;
  let samplerReference=null, samplerEnabled=null, sampler=null;
  let keys={zoom:'z',drag:'d',full:'f'};
  try {const saved=JSON.parse(localStorage.getItem('cursor-studio-shortcuts')||'null');if(saved&&/^[a-z0-9]$/.test(saved.zoom)&&/^[a-z0-9]$/.test(saved.drag)&&saved.zoom!==saved.drag){keys.zoom=saved.zoom;keys.drag=saved.drag;keys.full=/^[a-z0-9]$/.test(saved.full)&&saved.full!==saved.zoom&&saved.full!==saved.drag?saved.full:['f','g','r','v'].find(key=>key!==saved.zoom&&key!==saved.drag);}}catch{}
  const active=()=>state.isImported&&state.mode==='recorded'&&!state.exporting&&!state.starting&&!state.analyzingTouches;
  const cameraEvents=()=>$('touch-follow-enabled').checked?state.cameraEvents:(state.cameraEvents||[]).filter(event=>event.origin!=='touch');
  const timeline=createMotionTimeline({document,video,state,active,captureUndo,onChange,onSeek,clearTransient,getCameraEvents:cameraEvents});
  function settings() {return {zoom:+$('mobile-zoom').value,duration:+$('transition-duration').value*($('motion-easing').value==='glide'?1.35:1),easing:$('motion-easing').value};}
  function captureUndo(){history.push(structuredClone(state.cameraEvents||[]));if(history.length>50)history.shift();}
  function clearTransient(){transient=null;drag=null;canvas.classList.remove('is-dragging');}
  function poseAt(t,now=performance.now()) {
    if(!state.exporting&&drag){const dt=clamp((now-drag.updated)/1000,0,.1),amount=1-Math.exp(-dt*20);drag.updated=now;drag.preview={x:drag.preview.x+(drag.target.x-drag.preview.x)*amount,y:drag.preview.y+(drag.target.y-drag.preview.y)*amount,zoom:drag.target.zoom};return drag.preview;}
    if(!state.exporting&&video.paused&&transient) return cameraAt(transient.events,(now-transient.started)/1000,transient.from);
    const enabled=$('touch-follow-enabled').checked;
    if(samplerReference!==state.cameraEvents||samplerEnabled!==enabled){sampler=createCameraSampler(cameraEvents());samplerReference=state.cameraEvents;samplerEnabled=enabled;}
    return sampler(t);
  }
  function targetAt(t=video.currentTime) {
    const list=normalizeEvents(cameraEvents()||[]);return [...list].reverse().find(e=>e.time<=t+.002)||neutral;
  }
  function animateTarget(from,to,duration) {if(video.paused)transient={from,started:performance.now(),events:[{time:0,duration,...to}]};else transient=null;}
  function addMove(pose,{time=video.currentTime,duration=settings().duration,kind='Focus',previewFrom=null}={}) {
    if(!active())return;
    const from=previewFrom||poseAt(video.currentTime);
    captureUndo();const start=clamp(time,0,Math.max(0,state.duration-.15));const event={id:crypto.randomUUID(),time:start,duration:clamp(Math.min(duration,state.duration-start),.15,2.5),x:clamp(pose.x),y:clamp(pose.y),zoom:clamp(pose.zoom,1,5),easing:settings().easing};
    // Replacing an edit at the same paused playhead preserves one clear focus point.
    event.kind=kind;
    state.cameraEvents=insertCameraMove(state.cameraEvents||[],event,state.duration);
    animateTarget(from,event,event.duration);focus={x:event.x,y:event.y};
    $('mobile-camera-status').textContent=`${kind} at ${timeLabel(event.time)} · ${event.duration.toFixed(2)}s transition. Play to see the saved move.`;
    renderTimeline();timeline.choose(event.id,false);onChange();
  }
  function zoomIn(){addMove({...focus,zoom:settings().zoom},{kind:'Zoom in'});}
  function zoomOut(){addMove({...focus,zoom:1},{kind:'Zoom out'});}
  function toggleZoom(){targetAt().zoom>1.02?zoomOut():zoomIn();}
  function resetView(){addMove(neutral,{kind:'Full frame'});}
  function point(e) {
    const r=canvas.getBoundingClientRect(),s=Math.min(r.width/canvas.width,r.height/canvas.height);
    const px=(e.clientX-r.left-(r.width-canvas.width*s)/2)/s,py=(e.clientY-r.top-(r.height-canvas.height*s)/2)/s;
    return {px,py,s,source:screenPointToSource(px,py,state.geometry)};
  }
  function renderTimeline() {
    const list=normalizeEvents(state.cameraEvents||[]);
    timeline.render();
    $('undo-camera').disabled=!history.length||!active();$('clear-camera').disabled=!list.length||!active();
    $('timeline-info').textContent=`${list.length} camera keys · Scale, Pan X and Pan Y are editable below`;
  }
  function controls() {
    const imported=state.isImported&&state.mode==='recorded',locked=state.exporting||state.starting||state.analyzingTouches||state.mode==='processing'||state.mode==='capture'||state.mode==='demoRecording';
    $('upload-btn').disabled=locked;$('upload-drop-zone').hidden=imported||locked;$('upload-drop-zone').disabled=locked;
    $('mobile-editor').hidden=!imported;$('camera-timeline').hidden=!imported;$('cursor-settings').hidden=imported;$('capture-settings').hidden=imported;
    canvas.classList.toggle('mobile-editing',imported);canvas.classList.toggle('drag-ready',imported&&(dragHeld||panMode));
    $('stage').classList.toggle('portrait-editing',imported&&video.videoHeight>video.videoWidth);
    $('mobile-editor').dataset.touchAnalyzing=String(!!state.analyzingTouches);
    $('touch-analysis-panel').hidden=!state.analyzingTouches;
    $('stop-touch-analysis').disabled=!state.analyzingTouches;
    $('mobile-touch-demo-btn').disabled=locked;
    for(const el of $('mobile-editor').querySelectorAll('button,input,select'))el.disabled=locked;
    for(const el of $('camera-events').querySelectorAll('button,input'))el.disabled=locked;
    for(const el of $('motion-tracks').querySelectorAll('button'))el.disabled=locked||!imported;
    $('timeline-zoom').disabled=locked||!imported;$('timeline-fit').disabled=locked||!imported;
    if(imported){$('undo-camera').disabled=locked||!history.length;$('clear-camera').disabled=locked||!(state.cameraEvents||[]).length;}
  }
  function shortcuts() {
    $('zoom-key-bind').textContent=keys.zoom.toUpperCase();$('drag-key-bind').textContent=keys.drag.toUpperCase();$('full-key-bind').textContent=keys.full.toUpperCase();
    $('mobile-full-screen-hint').replaceChildren();const key=document.createElement('kbd');key.textContent=keys.full.toUpperCase();$('mobile-full-screen-hint').append(key,document.createTextNode(' Full frame at the playhead'));
    $('mobile-shortcuts').textContent=`${keys.full.toUpperCase()}: full frame · ${keys.zoom.toUpperCase()}: zoom in/out · Hold ${keys.drag.toUpperCase()} + drag: pan · Space: play`;
  }
  function rebuildTouchMotion() {
    const manual=(state.cameraEvents||[]).filter(event=>event.origin!=='touch');
    let events=buildTouchMotion(state.touchSamples||[],state.duration,{zoom:settings().zoom,smooth:settings().duration});
    for(const event of normalizeEvents(manual))events=insertCameraMove(events,event,state.duration);
    state.cameraEvents=events;clearTransient();renderTimeline();onChange();
  }
  async function runTouchAnalysis(hint=null) {
    if(!footageInfo||!active())return;
    const generation=++analysisGeneration;analysisAbort?.abort();analysisAbort=new AbortController();
    state.analyzingTouches=true;calibrating=false;$('stage').classList.remove('calibrating-touch');
    video.pause();state.playing=false;clearTransient();$('touch-analysis-progress').value=0;$('touch-analysis-status').textContent='Following your touches · 0%';$('touch-analysis-estimate').textContent='Scanning the full recording. You can stop and edit manually.';onStatus('Following touches · 0%');onChange();
    try {
      const result=await analyseTouches({...footageInfo,url:state.rawUrl,signal:analysisAbort.signal,hint,onProgress:progress=>{
        if(generation!==analysisGeneration)return;
        $('touch-analysis-progress').value=progress.percent;$('touch-analysis-status').textContent=`Following your touches · ${progress.percent}%`;
        $('touch-analysis-estimate').textContent=progress.frames<5?'Estimating scan time…':`About ${progress.remaining} sec remaining · ${progress.frames} frames checked`;
        onStatus(`Following touches · ${progress.percent}%`);
      }});
      if(generation!==analysisGeneration)return;
      captureUndo();state.touchSamples=result.samples;state.touchAnalysis=result;
      rebuildTouchMotion();
      const gestures=new Set(state.cameraEvents.filter(event=>event.origin==='touch'&&event.gesture>0).map(event=>event.gesture)).size;
      $('touch-result').textContent=gestures?`${gestures} touch ${gestures===1?'gesture':'gestures'} found. Smooth zoom and drag following are ready.`:'No reliable touch path found. Use Set touch dot or add camera moves manually.';
      $('mobile-camera-status').textContent=gestures?'Press '+keys.full.toUpperCase()+' whenever you want the full frame. All moves are on the timeline.':'Your video is ready for manual editing. No automatic zoom was added.';
      onStatus(gestures?'Touch tracking ready':'Mobile editor · ready');
    } catch(error) {
      if(generation!==analysisGeneration)return;
      $('touch-result').textContent=error.name==='AbortError'?'Scan stopped. Your video and existing moves are kept. Re-scan when ready.':`Touch scan failed: ${error.message} Your video is still editable.`;
      onStatus(error.name==='AbortError'?'Touch scan stopped':'Mobile editor · ready');
    } finally {
      if(generation===analysisGeneration){state.analyzingTouches=false;analysisAbort=null;onChange();renderTimeline();}
    }
  }
  async function readVideo(file) {
    const probe=document.createElement('video');probe.muted=true;probe.playsInline=true;probe.preload='auto';const url=URL.createObjectURL(file);
    const wait=(success)=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('This video could not be opened. Try MP4 with H.264 video.')),18000);
      const ok=()=>finish(),fail=()=>finish(new Error('The video codec is not supported in this browser. Export H.264 MP4 from your phone, then try again.'));
      function finish(error){clearTimeout(timer);probe.removeEventListener(success,ok);probe.removeEventListener('error',fail);error?reject(error):resolve();}
      probe.addEventListener(success,ok,{once:true});probe.addEventListener('error',fail,{once:true});
    });
    try {
      const ready=wait('loadeddata');probe.src=url;await ready;
      if(!Number.isFinite(probe.duration)){const sought=wait('seeked');probe.currentTime=1e10;await sought;}
      if(!Number.isFinite(probe.duration)||probe.duration<=0||!probe.videoWidth||!probe.videoHeight)throw new Error('The video has no readable duration or picture. Try exporting it as H.264 MP4.');
      return {url,duration:probe.duration,width:probe.videoWidth,height:probe.videoHeight};
    }catch(e){URL.revokeObjectURL(url);throw e;}
    finally {probe.removeAttribute('src');probe.load();}
  }
  async function importFile(file) {
    if(!file||state.exporting||state.starting||state.mode==='capture'||state.mode==='demoRecording'||state.mode==='processing')return;
    if(!(file.type.startsWith('video/')||/\.(mp4|mov|webm|m4v)$/i.test(file.name))){toast('Choose a video file such as MP4, MOV, or WebM.');return;}
    const generation=++loadGeneration;state.starting=true;onChange();$('mobile-camera-status').textContent='Opening your video…';
    let loaded=false;
    try {
      const info=await readVideo(file);if(generation!==loadGeneration){URL.revokeObjectURL(info.url);return;}
      await onImport(file,info);
      footageInfo=info;
      history=[];focus={x:.5,y:.5};clearTransient();state.cameraEvents=[];
      $('mobile-footage-info').textContent=`${info.width} × ${info.height} · ${timeLabel(info.duration)} · Original audio preserved on export`;
      $('mobile-camera-status').textContent='Following visible touch dots will create smooth camera moves.';
      loaded=true;renderTimeline();
    }catch(e){$('mobile-camera-status').textContent=state.isImported?'Could not open that video. Your current edit is still available.':'Choose a compatible video to start editing.';toast(e.message);}
    finally {state.starting=false;onChange();$('video-upload').value='';}
    if(loaded&&generation===loadGeneration&&$('touch-follow-enabled').checked)await runTouchAnalysis();
  }
  canvas.addEventListener('pointerdown',e=>{
    if(!active()||e.button!==0)return;const p=point(e);if(!p.source)return;canvas.focus({preventScroll:true});
    if(calibrating){calibrating=false;runTouchAnalysis({x:p.source.x,y:p.source.y,time:video.currentTime});return;}
    if(dragHeld||panMode){e.preventDefault();const g=state.geometry,pose={...poseAt(video.currentTime),x:(g.sx+g.cropW/2)/g.sw,y:(g.sy+g.cropH/2)/g.sh};drag={id:e.pointerId,startX:p.px,startY:p.py,geometry:{...g},from:pose,preview:pose,target:pose,time:video.currentTime,updated:performance.now()};canvas.setPointerCapture(e.pointerId);canvas.classList.add('is-dragging');return;}
    focus=p.source;
    if(targetAt().zoom>1.02)addMove({...focus,zoom:targetAt().zoom},{kind:'Click focus'});
    else $('mobile-camera-status').textContent='Focus selected. Press '+keys.zoom.toUpperCase()+' to zoom here.';
  });
  canvas.addEventListener('pointermove',e=>{
    if(!drag||!active())return;const p=point(e),g=drag.geometry;
    const mx=g.cropW/g.sw/2,my=g.cropH/g.sh/2;
    drag.target={x:clamp(drag.from.x-(p.px-drag.startX)/g.fw*g.cropW/g.sw,mx,1-mx),y:clamp(drag.from.y-(p.py-drag.startY)/g.fh*g.cropH/g.sh,my,1-my),zoom:drag.from.zoom};
    focus={x:drag.target.x,y:drag.target.y};
  });
  function finishDrag(e) {
    if(!drag)return;const d=drag;drag=null;canvas.classList.remove('is-dragging');if(canvas.hasPointerCapture(d.id))canvas.releasePointerCapture(d.id);
    if(e?.type==='pointercancel')return;
    addMove(d.target,{time:d.time,duration:video.paused?settings().duration:Math.max(.2,video.currentTime-d.time),kind:'Pan',previewFrom:d.preview});
  }
  canvas.addEventListener('pointerup',finishDrag);canvas.addEventListener('pointercancel',finishDrag);
  window.addEventListener('blur',()=>{dragHeld=false;finishDrag();canvas.classList.remove('drag-ready');binding=null;shortcuts();});
  document.addEventListener('keydown',e=>{
    if(calibrating&&e.key==='Escape'){calibrating=false;$('stage').classList.remove('calibrating-touch');$('mobile-camera-status').textContent='Touch dot selection cancelled.';e.preventDefault();return;}
    if(binding){e.preventDefault();if(e.key==='Escape'){binding=null;shortcuts();return;}const key=e.key.toLowerCase();if(!/^[a-z0-9]$/.test(key)){toast('Choose a single letter or number. Escape cancels.');return;}if(Object.entries(keys).some(([name,value])=>name!==binding&&value===key)){toast('Choose different keys for zoom, drag and full frame.');return;}keys[binding]=key;binding=null;try{localStorage.setItem('cursor-studio-shortcuts',JSON.stringify(keys));}catch{}shortcuts();return;}
    if(!active()||e.ctrlKey||e.metaKey||e.altKey||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||e.target.isContentEditable||$('help-dialog').open)return;
    const key=e.key.toLowerCase();
    if(key===keys.zoom){e.preventDefault();if(!e.repeat)toggleZoom();}
    if(key===keys.full){e.preventDefault();if(!e.repeat)resetView();}
    if(key===keys.drag){e.preventDefault();dragHeld=true;canvas.classList.add('drag-ready');}
  },{capture:true});
  document.addEventListener('keyup',e=>{if(e.key.toLowerCase()===keys.drag){dragHeld=false;finishDrag();if(!panMode)canvas.classList.remove('drag-ready');}});
  $('mobile-pan-toggle').addEventListener('click',()=>{panMode=!panMode;$('mobile-pan-toggle').setAttribute('aria-pressed',String(panMode));controls();});
  $('zoom-key-bind').addEventListener('click',()=>{binding='zoom';$('zoom-key-bind').textContent='Press key…';});$('drag-key-bind').addEventListener('click',()=>{binding='drag';$('drag-key-bind').textContent='Press key…';});
  $('full-key-bind').addEventListener('click',()=>{binding='full';$('full-key-bind').textContent='Press key…';});
  $('mobile-zoom-in').addEventListener('click',zoomIn);$('mobile-zoom-out').addEventListener('click',zoomOut);$('mobile-reset-view').addEventListener('click',resetView);$('add-camera-point').addEventListener('click',zoomIn);
  $('mobile-zoom').addEventListener('input',()=>{$('mobile-zoom-value').textContent=(+$('mobile-zoom').value).toFixed(1)+'×';});
  $('mobile-zoom').addEventListener('change',()=>{if(!active())return;if(state.touchSamples?.length&&$('touch-follow-enabled').checked){captureUndo();rebuildTouchMotion();}else if(targetAt().zoom>1.02)zoomIn();});
  $('transition-duration').addEventListener('input',()=>{$('transition-value').textContent=(+$('transition-duration').value).toFixed(1)+'s';});
  for(const id of ['transition-duration','motion-easing'])$(id).addEventListener('change',()=>{if(active()&&state.touchSamples?.length&&$('touch-follow-enabled').checked){captureUndo();rebuildTouchMotion();}});
  $('touch-follow-enabled').addEventListener('change',()=>{if(!active())return;clearTransient();renderTimeline();onChange();if($('touch-follow-enabled').checked&&!state.touchSamples?.length)runTouchAnalysis();});
  $('rescan-touches').addEventListener('click',()=>runTouchAnalysis());
  $('stop-touch-analysis').addEventListener('click',()=>analysisAbort?.abort());
  $('calibrate-touch').addEventListener('click',()=>{if(!active())return;video.pause();state.playing=false;clearTransient();calibrating=true;$('stage').classList.add('calibrating-touch');$('mobile-camera-status').textContent='Click the visible touch dot in the preview to scan with that reference.';onChange();});
  $('undo-camera').addEventListener('click',()=>{if(!active()||!history.length)return;state.cameraEvents=history.pop();clearTransient();renderTimeline();onChange();$('mobile-camera-status').textContent='Last camera edit undone.';});
  $('clear-camera').addEventListener('click',()=>{if(!active())return;captureUndo();state.cameraEvents=[];clearTransient();focus={x:.5,y:.5};renderTimeline();onChange();$('mobile-camera-status').textContent='All camera moves cleared. Your original footage is unchanged.';});
  for(const id of ['upload-btn','upload-drop-zone'])$(id).addEventListener('click',()=>$('video-upload').click());
  $('video-upload').addEventListener('change',e=>importFile(e.target.files[0]));
  $('mobile-touch-demo-btn').addEventListener('click',async()=>{
    if(state.mode!=='idle'||state.starting)return;
    state.starting=true;onStatus('Opening touch demo…');onChange();
    let file;
    try {const response=await fetch(new URL('./Examples/mobile-touch-demo.mp4',import.meta.url));if(!response.ok)throw new Error('Demo could not be loaded.');file=new File([await response.blob()],'Mobile touch demo.mp4',{type:'video/mp4'});}
    catch(error){toast(error.message);onStatus('Ready to record');}
    finally {state.starting=false;onChange();}
    if(file)await importFile(file);
  });
  const stage=$('stage');stage.addEventListener('dragover',e=>{if(!state.exporting&&!state.starting){e.preventDefault();stage.classList.add('drag-over');}});stage.addEventListener('dragleave',()=>stage.classList.remove('drag-over'));stage.addEventListener('drop',e=>{e.preventDefault();stage.classList.remove('drag-over');importFile(e.dataTransfer.files[0]);});
  video.addEventListener('seeked',()=>{if(!state.exporting){state.smooth.zoom=1;}});
  shortcuts();
  function updatePlayhead(time) {
    if(!state.isImported)return;
    timeline.updatePlayhead(time);
    const marker=$('touch-point-marker');marker.hidden=!$('show-touch-detection').checked||state.exporting||!state.touchSamples?.length;
    if(marker.hidden)return;
    const samples=state.touchSamples;let lo=0,hi=samples.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(samples[mid].time<=time)lo=mid;else hi=mid-1;}const sample=samples[lo],g=state.geometry;
    if(!g||Math.abs(sample.time-time)>.17){marker.hidden=true;return;}
    const rect=canvas.getBoundingClientRect(),stage=$('stage').getBoundingClientRect(),scale=Math.min(rect.width/canvas.width,rect.height/canvas.height);
    const x=g.fx+(sample.x*g.sw-g.sx)/g.cropW*g.fw,y=g.fy+(sample.y*g.sh-g.sy)/g.cropH*g.fh;
    marker.style.left=`${rect.left-stage.left+(rect.width-canvas.width*scale)/2+x*scale}px`;marker.style.top=`${rect.top-stage.top+(rect.height-canvas.height*scale)/2+y*scale}px`;
  }
  return {poseAt,controls,clearTransient,renderTimeline,importFile,runTouchAnalysis,updatePlayhead,reset(){analysisGeneration++;analysisAbort?.abort();analysisAbort=null;state.analyzingTouches=false;state.touchSamples=[];state.touchAnalysis=null;footageInfo=null;calibrating=false;$('stage').classList.remove('calibrating-touch');$('touch-point-marker').hidden=true;timeline.reset();clearTransient();history=[];state.cameraEvents=[];state.isImported=false;focus={x:.5,y:.5};dragHeld=false;panMode=false;$('mobile-pan-toggle').setAttribute('aria-pressed','false');binding=null;$('touch-result').textContent='Touch tracking starts when you upload a video.';},summary(){return {events:structuredClone(state.cameraEvents||[]),keys:{...keys},touches:state.touchSamples?.length||0,analysis:state.touchAnalysis?{frames:state.touchAnalysis.frames,complete:state.touchAnalysis.complete}:null};}};
}

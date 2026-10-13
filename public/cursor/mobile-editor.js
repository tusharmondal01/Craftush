import {cameraAt, normalizeEvents, screenPointToSource} from './camera.js';

const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,v));
const timeLabel=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
const neutral={x:.5,y:.5,zoom:1};

export function createMobileEditor({canvas,video,state,toast,onChange,onImport,onSeek}) {
  const $=id=>document.getElementById(id);
  let focus={x:.5,y:.5}, transient=null, drag=null, dragHeld=false, panMode=false, binding=null;
  let history=[], loadGeneration=0;
  let keys={zoom:'z',drag:'d'};
  try {const saved=JSON.parse(localStorage.getItem('cursor-studio-shortcuts')||'null');if(saved&&/^[a-z0-9]$/.test(saved.zoom)&&/^[a-z0-9]$/.test(saved.drag)&&saved.zoom!==saved.drag)keys=saved;}catch{}
  const active=()=>state.isImported&&state.mode==='recorded'&&!state.exporting&&!state.starting;
  function settings() {return {zoom:+$('mobile-zoom').value,duration:+$('transition-duration').value*($('motion-easing').value==='glide'?1.35:1),easing:$('motion-easing').value};}
  function captureUndo(){history.push(structuredClone(state.cameraEvents||[]));if(history.length>50)history.shift();}
  function clearTransient(){transient=null;drag=null;canvas.classList.remove('is-dragging');}
  function poseAt(t,now=performance.now()) {
    if(!state.exporting&&drag){const dt=clamp((now-drag.updated)/1000,0,.1),amount=1-Math.exp(-dt*20);drag.updated=now;drag.preview={x:drag.preview.x+(drag.target.x-drag.preview.x)*amount,y:drag.preview.y+(drag.target.y-drag.preview.y)*amount,zoom:drag.target.zoom};return drag.preview;}
    if(!state.exporting&&video.paused&&transient) return cameraAt(transient.events,(now-transient.started)/1000,transient.from);
    return cameraAt(state.cameraEvents||[],t);
  }
  function targetAt(t=video.currentTime) {
    const list=normalizeEvents(state.cameraEvents||[]);return [...list].reverse().find(e=>e.time<=t+.002)||neutral;
  }
  function animateTarget(from,to,duration) {if(video.paused)transient={from,started:performance.now(),events:[{time:0,duration,...to}]};else transient=null;}
  function addMove(pose,{time=video.currentTime,duration=settings().duration,kind='Focus',previewFrom=null}={}) {
    if(!active())return;
    const from=previewFrom||poseAt(video.currentTime);
    captureUndo();const start=clamp(time,0,Math.max(0,state.duration-.15));const event={id:crypto.randomUUID(),time:start,duration:clamp(Math.min(duration,state.duration-start),.15,2.5),x:clamp(pose.x),y:clamp(pose.y),zoom:clamp(pose.zoom,1,5),easing:settings().easing};
    // Replacing an edit at the same paused playhead preserves one clear focus point.
    state.cameraEvents=normalizeEvents([...(state.cameraEvents||[]).filter(e=>Math.abs(e.time-event.time)>.025),event]);
    animateTarget(from,event,event.duration);focus={x:event.x,y:event.y};
    $('mobile-camera-status').textContent=`${kind} at ${timeLabel(event.time)} · ${event.duration.toFixed(2)}s transition. Play to see the saved move.`;
    renderTimeline();onChange();
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
    const container=$('camera-events');container.replaceChildren();
    const list=normalizeEvents(state.cameraEvents||[]);
    if(!list.length){const p=document.createElement('p');p.className='camera-empty';p.textContent='No camera moves yet. Click a focus point and press '+keys.zoom.toUpperCase()+'.';container.append(p);}
    list.forEach(event=>{
      const row=document.createElement('div');row.className='camera-event';row.dataset.eventId=event.id;
      const jump=document.createElement('button');jump.className='camera-jump';jump.textContent=`↗ ${timeLabel(event.time)}`;jump.title='Jump to the beginning of this move';jump.addEventListener('click',()=>{clearTransient();video.pause();state.playing=false;video.currentTime=event.time;focus={x:event.x,y:event.y};onSeek();});row.append(jump);
      const field=(label,value,min,max,step,property)=>{
        const wrap=document.createElement('label');wrap.className='camera-event-field';wrap.append(document.createTextNode(label));
        const input=document.createElement('input');input.type='number';input.min=min;input.max=max;input.step=step;input.value=value;input.setAttribute('aria-label',`${label} for move at ${timeLabel(event.time)}`);input.disabled=state.exporting;
        let editing=false;
        input.addEventListener('input',()=>{const n=Number(input.value);if(input.value===''||!Number.isFinite(n))return;if(!editing){captureUndo();editing=true;}state.cameraEvents=normalizeEvents(state.cameraEvents.map(e=>e.id===event.id?{...e,[property]:clamp(n,+min,+max)}:e));clearTransient();onChange();});
        input.addEventListener('blur',()=>{if(editing)renderTimeline();});wrap.append(input);row.append(wrap);
      };
      field('Start (s)',event.time.toFixed(2),0,Math.max(0,state.duration-.02),.05,'time');field('Zoom',event.zoom.toFixed(1),1,5,.1,'zoom');field('Ease (s)',event.duration.toFixed(2),.15,2.5,.05,'duration');
      const remove=document.createElement('button');remove.className='camera-remove';remove.textContent='×';remove.setAttribute('aria-label',`Delete move at ${timeLabel(event.time)}`);remove.disabled=state.exporting;remove.addEventListener('click',()=>{captureUndo();state.cameraEvents=state.cameraEvents.filter(e=>e.id!==event.id);clearTransient();renderTimeline();onChange();});row.append(remove);container.append(row);
    });
    $('undo-camera').disabled=!history.length||state.exporting;$('clear-camera').disabled=!list.length||state.exporting;
    $('timeline-info').textContent=`${list.length} saved camera ${list.length===1?'move':'moves'} · click, zoom, and drag to direct the video`;
  }
  function controls() {
    const imported=state.isImported&&state.mode==='recorded',locked=state.exporting||state.starting||state.mode==='processing'||state.mode==='capture'||state.mode==='demoRecording';
    $('upload-btn').disabled=locked;$('upload-drop-zone').hidden=imported||locked;$('upload-drop-zone').disabled=locked;
    $('mobile-editor').hidden=!imported;$('camera-timeline').hidden=!imported;$('cursor-settings').hidden=imported;$('capture-settings').hidden=imported;
    canvas.classList.toggle('mobile-editing',imported);canvas.classList.toggle('drag-ready',imported&&(dragHeld||panMode));
    $('stage').classList.toggle('portrait-editing',imported&&video.videoHeight>video.videoWidth);
    for(const el of $('mobile-editor').querySelectorAll('button,input,select'))el.disabled=locked;
    for(const el of $('camera-events').querySelectorAll('button,input'))el.disabled=locked;
    if(imported){$('undo-camera').disabled=locked||!history.length;$('clear-camera').disabled=locked||!(state.cameraEvents||[]).length;}
  }
  function shortcuts() {
    $('zoom-key-bind').textContent=keys.zoom.toUpperCase();$('drag-key-bind').textContent=keys.drag.toUpperCase();
    $('mobile-shortcuts').textContent=`${keys.zoom.toUpperCase()}: zoom in/out · Hold ${keys.drag.toUpperCase()} + drag: pan · Click: focus · Space: play`;
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
    try {
      const info=await readVideo(file);if(generation!==loadGeneration){URL.revokeObjectURL(info.url);return;}
      await onImport(file,info);
      history=[];focus={x:.5,y:.5};clearTransient();state.cameraEvents=[];
      $('mobile-footage-info').textContent=`${info.width} × ${info.height} · ${timeLabel(info.duration)} · Original audio preserved on export`;
      $('mobile-camera-status').textContent='Click a focus point, then press '+keys.zoom.toUpperCase()+' to zoom. No cursor is added.';
      renderTimeline();toast('Footage loaded. Click to choose focus; '+keys.zoom.toUpperCase()+' zooms, and '+keys.drag.toUpperCase()+' + drag pans.');
    }catch(e){$('mobile-camera-status').textContent=state.isImported?'Could not open that video. Your current edit is still available.':'Choose a compatible video to start editing.';toast(e.message);}
    finally {state.starting=false;onChange();$('video-upload').value='';}
  }
  canvas.addEventListener('pointerdown',e=>{
    if(!active()||e.button!==0)return;const p=point(e);if(!p.source)return;canvas.focus({preventScroll:true});
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
    if(binding){e.preventDefault();if(e.key==='Escape'){binding=null;shortcuts();return;}const key=e.key.toLowerCase();if(!/^[a-z0-9]$/.test(key)){toast('Choose a single letter or number. Escape cancels.');return;}if(key===keys[binding==='zoom'?'drag':'zoom']){toast('Choose different keys for zoom and drag.');return;}keys[binding]=key;binding=null;try{localStorage.setItem('cursor-studio-shortcuts',JSON.stringify(keys));}catch{}shortcuts();return;}
    if(!active()||e.ctrlKey||e.metaKey||e.altKey||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||e.target.isContentEditable||$('help-dialog').open)return;
    const key=e.key.toLowerCase();
    if(key===keys.zoom){e.preventDefault();if(!e.repeat)toggleZoom();}
    if(key===keys.drag){e.preventDefault();dragHeld=true;canvas.classList.add('drag-ready');}
  },{capture:true});
  document.addEventListener('keyup',e=>{if(e.key.toLowerCase()===keys.drag){dragHeld=false;finishDrag();if(!panMode)canvas.classList.remove('drag-ready');}});
  $('mobile-pan-toggle').addEventListener('click',()=>{panMode=!panMode;$('mobile-pan-toggle').setAttribute('aria-pressed',String(panMode));controls();});
  $('zoom-key-bind').addEventListener('click',()=>{binding='zoom';$('zoom-key-bind').textContent='Press key…';});$('drag-key-bind').addEventListener('click',()=>{binding='drag';$('drag-key-bind').textContent='Press key…';});
  $('mobile-zoom-in').addEventListener('click',zoomIn);$('mobile-zoom-out').addEventListener('click',zoomOut);$('mobile-reset-view').addEventListener('click',resetView);$('add-camera-point').addEventListener('click',zoomIn);
  $('mobile-zoom').addEventListener('input',()=>{$('mobile-zoom-value').textContent=(+$('mobile-zoom').value).toFixed(1)+'×';});
  $('mobile-zoom').addEventListener('change',()=>{if(active()&&targetAt().zoom>1.02)zoomIn();});
  $('transition-duration').addEventListener('input',()=>{$('transition-value').textContent=(+$('transition-duration').value).toFixed(1)+'s';});
  $('undo-camera').addEventListener('click',()=>{if(!active()||!history.length)return;state.cameraEvents=history.pop();clearTransient();renderTimeline();onChange();$('mobile-camera-status').textContent='Last camera edit undone.';});
  $('clear-camera').addEventListener('click',()=>{if(!active())return;captureUndo();state.cameraEvents=[];clearTransient();focus={x:.5,y:.5};renderTimeline();onChange();$('mobile-camera-status').textContent='All camera moves cleared. Your original footage is unchanged.';});
  for(const id of ['upload-btn','upload-drop-zone'])$(id).addEventListener('click',()=>$('video-upload').click());
  $('video-upload').addEventListener('change',e=>importFile(e.target.files[0]));
  const stage=$('stage');stage.addEventListener('dragover',e=>{if(!state.exporting&&!state.starting){e.preventDefault();stage.classList.add('drag-over');}});stage.addEventListener('dragleave',()=>stage.classList.remove('drag-over'));stage.addEventListener('drop',e=>{e.preventDefault();stage.classList.remove('drag-over');importFile(e.dataTransfer.files[0]);});
  video.addEventListener('seeked',()=>{if(!state.exporting){state.smooth.zoom=1;}});
  shortcuts();
  return {poseAt,controls,clearTransient,renderTimeline,importFile,reset(){clearTransient();history=[];state.cameraEvents=[];state.isImported=false;focus={x:.5,y:.5};dragHeld=false;panMode=false;$('mobile-pan-toggle').setAttribute('aria-pressed','false');binding=null;},summary(){return {events:structuredClone(state.cameraEvents||[]),keys:{...keys}};}};
}

import {createMobileEditor} from './mobile-editor.js?v=20261013-touch2';
import {cropForCamera} from './camera.js?v=20261013-touch2';
const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d', { alpha: false });
const demo = document.createElement('canvas');
demo.width = 1280; demo.height = 720;
const dc = demo.getContext('2d');
const video = document.createElement('video');
video.playsInline = true; video.muted = true; video.preload = 'auto';
const state = {
  mode: 'idle', theme: 'lilac', duration: 0, elapsed: 0, started: 0,
  pausedAt: 0, pausedTotal: 0, paused: false, samples: [], clicks: [],
  pointer: { x: .63, y: .5, time: -100, clickTime: -100, valid: false },
  smooth: { x: .5, y: .5, zoom: 1 }, camera: { x: .5, y: .5 },
  rawBlob: null, rawUrl: null, recorder: null, source: null, mic: null,
  audioContext: null, exportContext: null, extension: false,
  targetTitle: '', targetTabId: null, nonce: '', playing: false, exporting: false,
  demoStart: performance.now(), hasTracking: false, isDemo: false,
  isImported:false, cameraEvents:[], geometry:null, analyzingTouches:false, touchSamples:[],
};
let mobile;
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const lerp = (a, b, t) => a + (b - a) * t;
const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
const themes = { lilac: ['#ebe4ff', '#bdcbf7'], midnight: ['#172537', '#3d447a'], peach: ['#ffdfcc', '#f2b8b3'], mint: ['#d5eee1', '#a9d4d7'] };
let toastTimer, lastFrame = performance.now();
function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 5500); }
function status(text) { $('status-text').textContent = text; }
function rounded(context, x, y, w, h, radius, fill) { context.beginPath(); context.roundRect(x, y, w, h, radius); if (fill) { context.fillStyle = fill; context.fill(); } }
function text(context, str, x, y, size = 16, color = '#222b3a', weight = 400) { context.fillStyle = color; context.font = `${weight} ${size}px Arial, sans-serif`; context.fillText(str, x, y); }
function demoPointer(time) {
  time=Math.max(0,time);
  const points = [{x:.49,y:.32}, {x:.76,y:.49}, {x:.56,y:.76}, {x:.34,y:.55}];
  const cycle = Math.floor(time / 2.5); const p = points[cycle % points.length]; const old = points[(cycle + 3) % points.length];
  const t = clamp((time % 2.5) / .8); const ease = t * t * (3 - 2 * t);
  return {x:lerp(old.x,p.x,ease), y:lerp(old.y,p.y,ease), time, clickTime: cycle * 2.5 + .85, valid:true};
}
function paintDemo(time) {
  dc.fillStyle = '#f7f8fc'; dc.fillRect(0,0,1280,720);
  dc.fillStyle = '#fff'; dc.fillRect(0,0,1280,62);
  dc.fillStyle = '#e7eaf1'; dc.fillRect(0,61,1280,1);
  rounded(dc, 26,19,24,24,7,'#4763ee'); text(dc,'o',33,37,21,'#fff',700); text(dc,'orbit',62,40,24,'#182133',700);
  text(dc,'Workspace',245,38,14,'#6c7586'); text(dc,'Overview',365,38,14,'#4763ee',700); text(dc,'Projects',485,38,14,'#6c7586');
  rounded(dc,1110,16,135,32,8,'#edf0ff'); text(dc,'+ New project',1125,37,13,'#4763ee',700);
  text(dc,'Good morning, Alex',44,114,27,'#202b40',700); text(dc,'A clear view of everything you are building.',44,142,15,'#8a92a1');
  text(dc,'THIS MONTH',1015,117,12,'#7b8498',700);
  const metrics = [{label:'Total revenue',value:'$48,250',trend:'+18.6%',color:'#4c68ea'}, {label:'Active customers',value:'2,840',trend:'+12.4%',color:'#47a482'}, {label:'Conversion rate',value:'6.82%',trend:'+2.1%',color:'#8f70cb'}];
  metrics.forEach((m,i) => { const x=44+i*407; rounded(dc,x,169,382,130,12,'#fff'); text(dc,m.label,x+22,200,14,'#818a9d'); text(dc,m.value,x+22,244,31,'#202b40',700); rounded(dc,x+272,219,84,26,8,'#eef8f1'); text(dc,m.trend,x+285,237,13,'#369a70',700); text(dc,'Compared to last month',x+22,275,12,'#a0a6b1'); });
  rounded(dc,44,322,774,342,12,'#fff'); text(dc,'Revenue overview',68,354,17,'#202b40',700); text(dc,'Monthly performance',68,380,13,'#8a92a1');
  for(let i=0;i<4;i++) { let y=414+i*55; dc.strokeStyle='#edf0f5';dc.beginPath();dc.moveTo(107,y);dc.lineTo(790,y);dc.stroke(); text(dc,`${30-i*10}k`,68,y+4,11,'#9ca4b4'); }
  const vals=[.65,.57,.6,.42,.5,.31,.34,.24,.27,.09,.16,.07];
  const graph=()=>{dc.moveTo(111,414+vals[0]*170); vals.forEach((v,i)=>dc.lineTo(111+i*59.5,414+v*170));};
  const g=dc.createLinearGradient(0,414,0,615);g.addColorStop(0,'#c8d4ff');g.addColorStop(1,'#fff');dc.beginPath();graph();dc.lineTo(765,617);dc.lineTo(111,617);dc.closePath();dc.fillStyle=g;dc.fill();
  dc.beginPath();graph();dc.strokeStyle='#5677ef';dc.lineWidth=4;dc.lineJoin='round';dc.stroke();
  ['Jan','Mar','May','Jul','Sep','Nov'].forEach((s,i)=>text(dc,s,104+i*129,642,12,'#98a0ae'));
  rounded(dc,840,322,394,342,12,'#fff');text(dc,'Launch checklist',864,357,17,'#202b40',700);text(dc,'Your next big thing starts here.',864,383,13,'#8a92a1');
  ['Polish the product experience','Prepare the launch assets','Send the early access invites','Share it with the world'].forEach((s,i)=>{let y=423+i*53; rounded(dc,864,y-13,19,19,6,i<2?'#edf1ff':'#f4f5f9');text(dc,i<2?'✓':'○',868,y+2,13,i<2?'#5872ed':'#b1b6c1',700);text(dc,s,898,y+2,14,'#596377');if(i<3){dc.fillStyle='#f2f4f7';dc.fillRect(864,y+25,346,1);}});
  rounded(dc,865,622,346,25,7,'#f4f6fd');text(dc,'Product launch',880,640,11,'#6d7da5',700);text(dc,'4 tasks',1141,640,11,'#8692ad');
  text(dc,'ORBIT / OVERVIEW',46,701,11,'#a2a9b8',600); text(dc,'A Cursor Studio demo',1090,701,11,'#a2a9b8');
  if (time >= 0) { const p=demoPointer(time); if(time-p.clickTime>=0 && time-p.clickTime<.45) {dc.beginPath();dc.arc(p.x*1280,p.y*720,20,0,Math.PI*2);dc.fillStyle='#5872ed18';dc.fill();} }
}
function options() { return {auto:$('auto-zoom').checked, follow:$('follow-cursor').checked, cursor:$('show-cursor').checked, strength:+$('zoom-strength').value, padding:+$('padding').value, radius:+$('radius').value}; }
function resolution() {
  const ratio=$('aspect-ratio').value.split(':').map(Number); const h=+$('export-quality').value;
  if(ratio[0]<ratio[1]) { canvas.width=h;canvas.height=Math.round(h*ratio[1]/ratio[0]/2)*2; }
  else {canvas.height=h;canvas.width=Math.round(h*ratio[0]/ratio[1]/2)*2;}
  canvas.style.aspectRatio=`${ratio[0]}/${ratio[1]}`;
  state.smooth.zoom=1;
}
function sampleAt(time) {
  if (!state.samples.length) return {x:.5,y:.5,time:-100,clickTime:-100,valid:false};
  let lo=0,hi=state.samples.length-1;
  while(lo<hi) {const mid=Math.ceil((lo+hi)/2);if(state.samples[mid].t<=time)lo=mid;else hi=mid-1;}
  const a=state.samples[lo];
  let clickTime=-100;for(let i=state.clicks.length-1;i>=0;i--)if(state.clicks[i].t<=time){clickTime=state.clicks[i].t;break;}
  return {x:a.x,y:a.y,time:a.movedAt??a.t,clickTime,valid:a.valid};
}
function render(now, schedule=true) {
  // Export owns its frame clock so compositor throttling cannot reduce saved motion to one frame per second.
  if(state.exporting&&schedule){requestAnimationFrame(render);return;}
  const dt=clamp((now-lastFrame)/1000,0,.1);lastFrame=now;
  const live=state.mode==='capture' || state.mode==='demoRecording';
  if(live && !state.paused) state.elapsed=(now-state.started-state.pausedTotal)/1000;
  let source, time, pointer;
  if(state.mode==='idle' || state.mode==='demoRecording') {
    time=state.mode==='idle'?(now-state.demoStart)/1000:state.elapsed;paintDemo(time);source=demo;
    pointer=state.mode==='demoRecording'?demoPointer(time):((state.pointer.valid&&(now-state.pointer.wall)<2500)?state.pointer:demoPointer(time));
  } else if(state.mode==='capture') {source=video;time=state.elapsed;pointer=state.pointer;}
  else {source=video;time=video.currentTime;pointer=sampleAt(time);}
  if(state.mode==='demoRecording' && !state.paused) {state.pointer={...pointer}; if(!state.samples.length||time-state.samples.at(-1).t>.033) {state.samples.push({t:time,x:pointer.x,y:pointer.y,valid:true,movedAt:time});const click=pointer.clickTime;if(click<=time&&!state.clicks.some(c=>Math.abs(c.t-click)<.01))state.clicks.push({t:click,x:pointer.x,y:pointer.y});} }
  const o=options(); const sinceClick=time-pointer.clickTime; const moving=time-pointer.time<1.7;
  if(state.isImported) {
    const pose=mobile.poseAt(time,now);state.smooth.zoom=pose.zoom;state.camera.x=pose.x;state.camera.y=pose.y;
  } else {
  const targetZoom=o.auto&&pointer.valid&&(moving||(sinceClick>=0&&sinceClick<1.8))?o.strength:1;
  const speed=1-Math.exp(-dt*7);state.smooth.zoom=lerp(state.smooth.zoom,targetZoom,speed);
  state.smooth.x=lerp(state.smooth.x,pointer.x,speed);state.smooth.y=lerp(state.smooth.y,pointer.y,speed);
  if(o.follow&&pointer.valid){state.camera.x=lerp(state.camera.x,pointer.x,speed);state.camera.y=lerp(state.camera.y,pointer.y,speed);}
  else if(sinceClick>=0&&sinceClick<.5&&pointer.valid){state.camera.x=lerp(state.camera.x,pointer.x,speed);state.camera.y=lerp(state.camera.y,pointer.y,speed);}
  }
  const W=canvas.width,H=canvas.height,scale=H/720,pad=o.padding*scale;
  const colors=themes[state.theme];const gradient=ctx.createLinearGradient(0,0,W,H);gradient.addColorStop(0,colors[0]);gradient.addColorStop(1,colors[1]);ctx.fillStyle=gradient;ctx.fillRect(0,0,W,H);
  const sw=source.videoWidth||source.width||1280,sh=source.videoHeight||source.height||720;
  const fit=Math.min((W-2*pad)/sw,(H-2*pad)/sh);
  const importedGeometry=state.isImported?cropForCamera(sw,sh,W-2*pad,H-2*pad,{...state.camera,zoom:state.smooth.zoom,fit:'contain'}):null;
  const cropped=W<=H,fw=importedGeometry?.fw??(cropped?W-2*pad:sw*fit),fh=importedGeometry?.fh??(cropped?H-2*pad:sh*fit),fx=(W-fw)/2,fy=(H-fh)/2;
  ctx.save();ctx.shadowColor='#111b3940';ctx.shadowBlur=32*scale;ctx.shadowOffsetY=14*scale;rounded(ctx,fx,fy,fw,fh,o.radius*scale,'#fff');ctx.restore();
  ctx.save();rounded(ctx,fx,fy,fw,fh,o.radius*scale);ctx.clip();
  const z=state.smooth.zoom;
  const cropW=importedGeometry?.cropW??(cropped?Math.min(sw,sh*fw/fh):sw)/z,cropH=importedGeometry?.cropH??(cropped?Math.min(sh,sw*fh/fw):sh)/z;
  const sx=importedGeometry?.sx??clamp(state.camera.x*sw-cropW/2,0,sw-cropW),sy=importedGeometry?.sy??clamp(state.camera.y*sh-cropH/2,0,sh-cropH);
  state.geometry={sx,sy,cropW,cropH,sw,sh,fx,fy,fw,fh};
  if(source===demo||source.readyState>=2)ctx.drawImage(source,sx,sy,cropW,cropH,fx,fy,fw,fh);
  if(o.cursor&&pointer.valid&&!state.isImported) {
    const x=fx+(state.smooth.x*sw-sx)/cropW*fw,y=fy+(state.smooth.y*sh-sy)/cropH*fh;
    if(sinceClick>=0&&sinceClick<.6){ctx.beginPath();ctx.arc(x,y,(12+sinceClick*55)*scale,0,2*Math.PI);ctx.strokeStyle=`rgba(74,102,235,${1-sinceClick/.6})`;ctx.lineWidth=3*scale;ctx.stroke();}
    ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);ctx.shadowColor='#15203340';ctx.shadowBlur=8;ctx.shadowOffsetY=3;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,24);ctx.lineTo(6,18);ctx.lineTo(11,30);ctx.lineTo(16,27);ctx.lineTo(10,16);ctx.lineTo(19,16);ctx.closePath();ctx.fillStyle='#172134';ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#fff';ctx.stroke();ctx.restore();
  }
  ctx.restore();$('zoom-value').textContent=`${z.toFixed(1)}×`;
  if(live) $('duration').textContent=clock(state.elapsed);
  if(state.mode==='recorded') {$('duration').textContent=`${clock(video.currentTime)} / ${clock(state.duration)}`;if(!state.exporting)$('seek').value=state.duration?Math.round(video.currentTime/state.duration*1000):0;}
  mobile?.updatePlayhead(time);
  if(state.mode==='demoRecording'&&state.elapsed>=8) stopRecording();
  if(schedule)requestAnimationFrame(render);
}
function setControls() {
  const live=state.mode==='capture'||state.mode==='demoRecording';const recorded=state.mode==='recorded';
  const busy=state.mode==='processing'||state.starting||state.exporting||state.analyzingTouches;
  $('record-btn').disabled=busy;$('demo-btn').disabled=busy;
  $('mobile-touch-demo-btn').hidden=live||recorded;
  $('record-btn').hidden=live||recorded; $('demo-btn').hidden=live||recorded;
  $('stop-btn').hidden=!live;$('pause-btn').hidden=!live;$('new-btn').hidden=!recorded;
  $('play-btn').disabled=!recorded||busy;$('export-btn').disabled=!recorded||busy;$('seek').disabled=!recorded||busy;
  $('pause-btn').textContent=state.paused?'Resume':'Pause';
  $('play-btn').innerHTML=state.playing?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" stroke="currentColor" stroke-width="3"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z" fill="currentColor"/></svg>';
  $('play-btn').setAttribute('aria-label',state.playing?'Pause preview':'Play preview');
  $('export-btn').textContent=state.exporting?'Rendering…':'Export video';
  $('export-quality').disabled=live||state.exporting||state.analyzingTouches;$('aspect-ratio').disabled=live||state.exporting||state.analyzingTouches;
  $('source-mode').disabled=live||state.exporting;$('mic-enabled').disabled=live;$('system-audio').disabled=live;
  $('new-btn').disabled=busy;
  for(const id of ['auto-zoom','follow-cursor','show-cursor','zoom-strength','padding','radius'])$(id).disabled=state.exporting;
  document.querySelectorAll('.background-swatch').forEach(el=>el.disabled=state.exporting);
  document.body.classList.toggle('is-recording',live&&!state.paused);
  mobile?.controls();
}
function mimeType() {
  return ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'].find(m=>MediaRecorder.isTypeSupported(m))||'';
}
function reset() {
  if(state.exporting)return;
  video.pause();video.removeAttribute('src');video.load();
  if(state.rawUrl)URL.revokeObjectURL(state.rawUrl);state.rawUrl=null;state.rawBlob=null;
  mobile?.reset();
  Object.assign(state,{mode:'idle',elapsed:0,duration:0,playing:false,samples:[],clicks:[],isDemo:false});
  state.pointer={x:.5,y:.5,time:-100,clickTime:-100,valid:false};state.smooth={x:.5,y:.5,zoom:1};state.demoStart=performance.now();
  $('recording-name').textContent='Untitled recording';$('source-name').textContent='Interactive demo';$('timeline-info').textContent='Record a take to make it yours.';$('zoom-markers').replaceChildren();$('seek').value=0;$('duration').textContent='00:00';status('Ready to record');setControls();
}
function begin(stream, isDemo) {
  state.isDemo=isDemo;state.source=stream;state.samples=[{t:0,x:.5,y:.5,valid:false,movedAt:-100}];state.clicks=[];state.elapsed=0;state.pausedTotal=0;state.paused=false;state.started=performance.now();state.pointer={x:.5,y:.5,time:-100,clickTime:-100,valid:false};
  const chunks=[];const mime=mimeType();
  const rec=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:12000000});state.recorder=rec;
  rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  rec.onerror=e=>{toast('The recording stopped unexpectedly. Try a shorter take.');stopRecording();};
  rec.onstop=()=>finishRecording(new Blob(chunks,{type:rec.mimeType}));
  rec.start(500);state.mode=isDemo?'demoRecording':'capture';
  updateTracker();
  $('recording-name').textContent=isDemo?'Orbit — product walkthrough':`Recording ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
  $('source-name').textContent=isDemo?'8-second product demo':stream.getVideoTracks()[0]?.label||'Shared screen';
  status(isDemo?'Recording a demo · stops after 8 seconds':'Recording');setControls();
}
async function startRecording() {
  if(state.mode!=='idle'||state.starting)return;
  if(!navigator.mediaDevices?.getDisplayMedia||!window.MediaRecorder){toast('Screen capture needs a desktop browser. Open this site in Chrome or Edge.');return;}
  state.starting=true;setControls();status('Choose a screen to record');let source,mic,audioContext;
  try {
    source=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:30,displaySurface:$('source-mode').value==='tab'?'browser':'monitor'},audio:$('system-audio').checked, selfBrowserSurface:'include',surfaceSwitching:'include'});
    const track=source.getVideoTracks()[0];
    if(state.extension) { try {await track.applyConstraints({cursor:'never'});}catch{} }
    if($('mic-enabled').checked)mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    const audioTracks=[...source.getAudioTracks(),...(mic?.getAudioTracks()||[])];
    const mixed=new MediaStream(source.getVideoTracks());
    if(audioTracks.length){audioContext=new AudioContext();await audioContext.resume();const dest=audioContext.createMediaStreamDestination();audioTracks.forEach(t=>audioContext.createMediaStreamSource(new MediaStream([t])).connect(dest));dest.stream.getAudioTracks().forEach(t=>mixed.addTrack(t));}
    state.mic=mic;state.audioContext=audioContext;state.captureStream=source;
    video.srcObject=source;await video.play();state.nonce=crypto.randomUUID()+crypto.randomUUID();
    begin(mixed,false);track.onended=()=>{if(state.mode==='capture')stopRecording();};
    window.postMessage({type:'CURSOR_STUDIO_START_TRACKING',nonce:state.nonce},location.origin);
    if(!state.extension)toast('Recording started. For automatic focus across websites, install the companion extension and record a browser tab.');
    else toast('On the shared browser tab, open Cursor Studio’s extension and select “Track this tab”.');
    if($('system-audio').checked&&!source.getAudioTracks().length)toast('Your selected source did not provide system audio. Video recording is running.');
  } catch(e) {
    source?.getTracks().forEach(t=>t.stop());mic?.getTracks().forEach(t=>t.stop());await audioContext?.close();
    status('Ready to record');toast(e.name==='NotAllowedError'?'Sharing was cancelled or permission was not granted. Choose Record to try again.':`Could not start recording: ${e.message}`);
  } finally {state.starting=false;setControls();}
}
function startDemo() {
  if(state.mode!=='idle'||state.starting)return;
  if(!window.MediaRecorder||!demo.captureStream){toast('Use a desktop Chrome or Edge browser to record and export.');return;}
  reset();paintDemo(0);begin(demo.captureStream(30),true);status('Recording an 8-second demo');
}
function pauseRecording() {
  if(!state.recorder||state.recorder.state==='inactive')return;
  if(state.paused){state.pausedTotal+=performance.now()-state.pausedAt;state.paused=false;state.recorder.resume();status('Recording');}
  else {state.paused=true;state.pausedAt=performance.now();state.recorder.pause();status('Recording paused');}
  setControls();
}
function stopRecording() {
  if(!state.recorder||state.recorder.state==='inactive')return;
  if(state.paused)state.pausedTotal+=performance.now()-state.pausedAt;
  state.elapsed=(performance.now()-state.started-state.pausedTotal)/1000;
  state.recorder.stop();state.mode='processing';status('Preparing your recording…');
  window.postMessage({type:'CURSOR_STUDIO_STOP_TRACKING',nonce:state.nonce},location.origin);
  state.captureStream?.getTracks().forEach(t=>t.stop());state.source?.getTracks().forEach(t=>t.stop());state.mic?.getTracks().forEach(t=>t.stop());state.captureStream=null;state.source=null;state.mic=null;
  state.audioContext?.close();state.audioContext=null;video.pause();video.srcObject=null;setControls();
}
async function finishRecording(blob) {
  if(!blob.size){reset();toast('No frames were captured. Please try again.');return;}
  state.rawBlob=blob;state.rawUrl=URL.createObjectURL(blob);state.duration=state.elapsed;
  video.src=state.rawUrl;video.currentTime=0;video.muted=true;
  try {
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('The browser could not read this take.')),15000);video.onloadeddata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(new Error('The recorded video could not be decoded.'));};if(video.readyState>=2){clearTimeout(timer);resolve();}});
  }catch(e){video.onloadeddata=null;video.onerror=null;reset();toast(e.message+' Please try a new recording.');return;}
  video.onloadeddata=null;video.onerror=null;
  state.mode='recorded';state.playing=false;state.paused=false;state.smooth.zoom=1;
  $('timeline-info').textContent=state.clicks.length?`${state.clicks.length} focus moments · adjust the look, then export`:'Your take is ready · adjust the look, then export';
  $('zoom-markers').replaceChildren();
  state.clicks.slice(0,12).forEach((c,i)=>{const b=document.createElement('button');b.className='zoom-marker';b.textContent=`↗ ${clock(c.t)}`;b.title=`Jump to focus moment ${i+1}`;b.addEventListener('click',()=>{if(!state.exporting){video.currentTime=clamp(c.t,0,state.duration);state.smooth.zoom=1;}});$('zoom-markers').append(b);});
  status('Ready to export');setControls();toast('Your recording is ready. Change the background, framing, or zoom before exporting.');
}
async function togglePlayback() {
  if(state.mode!=='recorded'||state.exporting||state.starting||state.analyzingTouches)return;
  if(state.playing){video.pause();state.playing=false;}else {mobile.clearTransient();if(video.currentTime>=state.duration-.1)video.currentTime=0;await video.play();state.playing=true;}
  setControls();
}
video.addEventListener('ended',()=>{state.playing=false;setControls();});
async function exportVideo() {
  if(state.mode!=='recorded'||state.exporting||state.starting||state.analyzingTouches)return;
  state.exporting=true;state.playing=false;mobile.clearTransient();video.pause();video.currentTime=0;state.smooth={x:.5,y:.5,zoom:1};state.camera={x:.5,y:.5};setControls();status('Rendering your video · 0%');
  let output,rec,ac,timeout,progress,frameTicker,visibilityHandler;
  try {
    if(video.seeking)await new Promise(resolve=>video.addEventListener('seeked',resolve,{once:true}));
    render(performance.now(),false);
    output=canvas.captureStream(0);
    let frameTrack=output.getVideoTracks()[0];
    if(typeof frameTrack.requestFrame!=='function'){
      output.getTracks().forEach(track=>track.stop());output=canvas.captureStream(60);frameTrack=output.getVideoTracks()[0];
    }
    const captureFrame=()=>{render(performance.now(),false);frameTrack.requestFrame?.();};
    // Route the saved recording's audio directly to the export, without playing it through the speakers.
    if(!state.isDemo){
      ac=state.exportContext||(state.exportContext=new AudioContext());await ac.resume();
      if(!state.videoAudioNode)state.videoAudioNode=ac.createMediaElementSource(video);
      const dest=ac.createMediaStreamDestination();state.videoAudioNode.disconnect();state.videoAudioNode.connect(dest);video.muted=false;dest.stream.getAudioTracks().forEach(t=>output.addTrack(t));
    }
    const mime=mimeType();const chunks=[];rec=new MediaRecorder(output,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:canvas.height>=1440?16000000:10000000});
    const done=new Promise((resolve,reject)=>{rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};rec.onstop=()=>resolve(new Blob(chunks,{type:rec.mimeType}));rec.onerror=e=>reject(e.error||new Error('Video encoding failed.'));});
    rec.start(500);captureFrame();await video.play();state.playing=true;
    frameTicker=setInterval(captureFrame,1000/60);
    const ended=new Promise(resolve=>video.addEventListener('ended',resolve,{once:true}));
    const reachedEnd=new Promise(resolve=>{progress=setInterval(()=>{const pct=clamp(video.currentTime/state.duration)*100;status(`Rendering your video · ${Math.round(pct)}%`);if(video.currentTime>=state.duration-.03){resolve();}},100);});
    const stalled=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Rendering took too long. Please try exporting again.')),(state.duration+35)*1000);});
    const hidden=new Promise((_,reject)=>{visibilityHandler=()=>{if(document.hidden)reject(new Error('Keep this tab visible while exporting, then try again. Your recording is still here.'));};document.addEventListener('visibilitychange',visibilityHandler);});
    await Promise.race([ended,reachedEnd,stalled,hidden]);clearInterval(frameTicker);captureFrame();clearInterval(progress);clearTimeout(timeout);await new Promise(r=>setTimeout(r,150));video.pause();rec.stop();
    const blob=await done;if(blob.size<1000)throw new Error('The exported video was empty. Try again.');
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`cursor-studio-${new Date().toISOString().slice(0,10)}.${blob.type.includes('mp4')?'mp4':'webm'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    state.lastExport={bytes:blob.size,type:blob.type,width:canvas.width,height:canvas.height,duration:state.duration,requestedFps:60,cameraMoves:state.cameraEvents.length};
    status('Video exported');toast(`Exported ${canvas.width} × ${canvas.height} video. Your download is ready.`);
  }catch(e){if(rec&&rec.state!=='inactive')rec.stop();toast(`Export failed: ${e.message}`);status('Ready to export');}
  finally {clearInterval(frameTicker);clearInterval(progress);clearTimeout(timeout);document.removeEventListener('visibilitychange',visibilityHandler);video.pause();video.muted=true;state.videoAudioNode?.disconnect();output?.getTracks().forEach(t=>t.stop());state.exporting=false;state.playing=false;video.currentTime=0;setControls();}
}
function updateTracker() {
  const surface=state.captureStream?.getVideoTracks()[0]?.getSettings().displaySurface;
  $('tracker-status').textContent=state.mode==='capture'&&surface!=='browser'?'For cursor tracking, share a browser tab':state.targetTitle?`Tracking: ${state.targetTitle}`:state.extension?'Extension connected · select a tab':'For website cursor tracking, get the extension';
}
window.addEventListener('message',e=>{
  if(e.source!==window||e.origin!==location.origin||!e.data||typeof e.data!=='object')return;const m=e.data;
  if(m.type==='CURSOR_STUDIO_EXTENSION_READY'){state.extension=true;updateTracker();return;}
  if(!state.nonce||m.nonce!==state.nonce)return;
  if(m.type==='CURSOR_STUDIO_TRACKER_STATUS'){state.targetTitle=m.active?m.targetTitle||'': '';state.targetTabId=m.targetTabId;updateTracker();return;}
  if(m.type==='CURSOR_STUDIO_POINTER'&&state.mode==='capture'&&!state.paused){
    if(!Number.isFinite(m.x)||!Number.isFinite(m.y))return;
    if(state.captureStream?.getVideoTracks()[0]?.getSettings().displaySurface!=='browser'){return;}
    const t=(performance.now()-state.started-state.pausedTotal)/1000;state.pointer={x:clamp(m.x),y:clamp(m.y),time:t,clickTime:m.click?t:state.pointer.clickTime,valid:true,wall:performance.now()};
    state.samples.push({t,x:state.pointer.x,y:state.pointer.y,valid:true,movedAt:t});
    state.hasTracking=true;if(m.click)state.clicks.push({t,x:state.pointer.x,y:state.pointer.y});
  }
});
// The interactive canvas also provides a useful instant demonstration of cursor following.
canvas.addEventListener('pointermove',e=>{
  if(state.mode!=='idle')return;const r=canvas.getBoundingClientRect();
  state.pointer={x:clamp((e.clientX-r.left)/r.width),y:clamp((e.clientY-r.top)/r.height),time:(performance.now()-state.demoStart)/1000,clickTime:state.pointer.clickTime,wall:performance.now(),valid:true};
});
canvas.addEventListener('pointerdown',()=>{if(state.mode==='idle')state.pointer.clickTime=(performance.now()-state.demoStart)/1000;});
document.addEventListener('pointermove',e=>{
  if(state.mode!=='capture'||state.paused||state.targetTitle)return;
  // Page coordinates are only valid if the user selected this recorder's own browser tab.
  const track=state.captureStream?.getVideoTracks()[0],settings=track?.getSettings();
  if(settings?.displaySurface!=='browser'||!track?.label?.toLowerCase().includes('cursor studio'))return;
  const t=(performance.now()-state.started-state.pausedTotal)/1000;
  state.pointer={x:clamp(e.clientX/innerWidth),y:clamp(e.clientY/innerHeight),time:t,clickTime:state.pointer.clickTime,valid:true};
  state.samples.push({t,x:state.pointer.x,y:state.pointer.y,valid:true,movedAt:t});
});
$('record-btn').addEventListener('click',startRecording);$('demo-btn').addEventListener('click',startDemo);$('stop-btn').addEventListener('click',stopRecording);$('pause-btn').addEventListener('click',pauseRecording);$('new-btn').addEventListener('click',reset);$('play-btn').addEventListener('click',togglePlayback);$('export-btn').addEventListener('click',exportVideo);
$('seek').addEventListener('input',e=>{if(state.mode==='recorded'&&!state.exporting){mobile.clearTransient();video.currentTime=+e.target.value/1000*state.duration;state.smooth.zoom=1;}});
for(const id of ['aspect-ratio','export-quality'])$(id).addEventListener('change',resolution);
document.querySelectorAll('.background-swatch').forEach(b=>b.addEventListener('click',()=>{if(state.exporting)return;state.theme=b.dataset.theme;$('stage').style.background=`linear-gradient(135deg,${themes[state.theme][0]},${themes[state.theme][1]})`;document.querySelectorAll('.background-swatch').forEach(el=>{el.classList.toggle('selected',el===b);el.setAttribute('aria-pressed',String(el===b));});}));
for(const id of ['zoom-strength','padding','radius']) { const el=$(id);el.addEventListener('input',()=>{const output=document.querySelector(`[data-value-for="${id}"]`);if(output)output.textContent=id==='zoom-strength'?`${Number(el.value).toFixed(1)}×`:`${el.value}px`;});}
$('help-btn').addEventListener('click',()=>$('help-dialog').showModal());$('close-help').addEventListener('click',()=>$('help-dialog').close());$('help-dialog').addEventListener('click',e=>{if(e.target===$('help-dialog'))$('help-dialog').close();});
document.addEventListener('keydown',e=>{if(e.defaultPrevented||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||$('help-dialog').open)return;if(e.code==='Space'&&state.mode==='recorded'){e.preventDefault();togglePlayback();}if(e.key==='Escape'&&(state.mode==='capture'||state.mode==='demoRecording'))stopRecording();});
window.addEventListener('beforeunload',e=>{if(state.mode==='capture'||state.mode==='demoRecording'||state.exporting){e.preventDefault();e.returnValue='';}});
window.postMessage({type:'CURSOR_STUDIO_EXTENSION_PING'},location.origin);setTimeout(()=>window.postMessage({type:'CURSOR_STUDIO_EXTENSION_PING'},location.origin),1500);
async function importFootage(file,info) {
  reset();state.isImported=true;state.isDemo=false;state.rawBlob=file;state.rawUrl=info.url;state.duration=info.duration;
  video.src=info.url;video.currentTime=0;video.muted=true;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Video loading timed out.')),15000);video.onloadeddata=()=>{clearTimeout(timer);video.onloadeddata=null;video.onerror=null;resolve();};video.onerror=()=>{clearTimeout(timer);video.onerror=null;reject(new Error('This video could not be decoded.'));};if(video.readyState>=2){clearTimeout(timer);resolve();}});
  state.mode='recorded';$('recording-name').textContent=file.name;$('source-name').textContent='Imported mobile footage';
  $('aspect-ratio').value=info.height>info.width?'9:16':info.width===info.height?'1:1':'16:9';$('padding').value='0';$('radius').value='0';resolution();status('Mobile editor · ready');setControls();
}
mobile=createMobileEditor({canvas,video,state,toast,onChange:setControls,onImport:importFootage,onSeek:setControls,onStatus:status});
resolution();reset();updateTracker();requestAnimationFrame(render);
// Read-only diagnostics support checking the complete recording and export flow.
window.cursorStudioDiagnostics=()=>({mode:state.mode,duration:state.duration,samples:state.samples.length,clicks:state.clicks.length,rawBytes:state.rawBlob?.size||0,export:state.lastExport||null,extension:state.extension,imported:state.isImported,camera:mobile.summary()});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {createMobileEditor} from '../public/cursor/mobile-editor.js';

const samples=()=>Array.from({length:32},(_,i)=>({time:1+i/12,x:.25+i*.008,y:.65-i*.003,confidence:.96,gesture:1}));
const turn=()=>new Promise(resolve=>setImmediate(resolve));

async function setup({respectAbort=true}={}){
  const {document,window,Event}=parseHTML(await readFile(new URL('../public/cursor/index.html',import.meta.url),'utf8'));
  const prior={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage};
  globalThis.document=document;globalThis.window=window;globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
  const $=id=>document.getElementById(id);
  for(const input of document.querySelectorAll('input[type="checkbox"]'))input.checked=input.hasAttribute('checked');
  const create=document.createElement.bind(document);
  const videoElement=()=>{
    const node=create('video');
    Object.assign(node,{duration:8,videoWidth:540,videoHeight:960,readyState:4,currentTime:0,muted:true,paused:true});
    node.pause=()=>{node.paused=true;};node.load=()=>{};
    Object.defineProperty(node,'src',{get(){return node.getAttribute('src');},set(value){node.setAttribute('src',value);queueMicrotask(()=>node.dispatchEvent(new Event('loadeddata')));}});
    return node;
  };
  document.createElement=tag=>tag==='video'?videoElement():create(tag);
  const video=videoElement(),canvas=$('preview'),jobs=[];
  const state={mode:'idle',isImported:false,exporting:false,starting:false,analyzingTouches:false,cameraEvents:[],smooth:{zoom:1},duration:0,touchSamples:[]};
  let editor;
  const onChange=()=>{
    const recorded=state.mode==='recorded',busy=state.starting||state.exporting||state.analyzingTouches;
    $('new-btn').hidden=!recorded;$('record-btn').hidden=recorded;$('demo-btn').hidden=recorded;$('record-btn').disabled=busy;$('export-btn').disabled=!recorded||busy;$('play-btn').disabled=!recorded||busy;$('seek').disabled=!recorded||busy;
    editor?.controls();
  };
  editor=createMobileEditor({canvas,video,state,toast:()=>{},onChange,onSeek:onChange,onStatus:text=>{$('status-text').textContent=text;},onImport:async(file,info)=>{editor.reset();state.isImported=true;state.mode='recorded';state.rawBlob=file;state.rawUrl=info.url;state.duration=info.duration;video.src=info.url;video.currentTime=0;},analyseTouches:options=>new Promise((resolve,reject)=>{jobs.push({options,resolve,reject});if(respectAbort)options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true});})});
  onChange();
  const file=new File(['test video'],'phone.mp4',{type:'video/mp4'});
  const key=(target,name,extra={})=>{const event=new Event('keydown',{bubbles:true});Object.assign(event,{key:name,code:name==='f'?'KeyF':'KeyZ',repeat:false,ctrlKey:false,metaKey:false,altKey:false,...extra});target.dispatchEvent(event);};
  const cleanup=()=>{editor.reset();if(state.rawUrl)URL.revokeObjectURL(state.rawUrl);for(const [name,value] of Object.entries(prior)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}};
  return{document,Event,$,video,canvas,state,editor,jobs,file,key,onChange,cleanup};
}

test('upload automatically scans the full clip, locks export and creates all three editable tracks',async()=>{
  const context=await setup();const {editor,file,jobs,state,$,document,cleanup}=context;
  try{
    const importing=editor.importFile(file);await turn();
    assert.equal(jobs.length,1);assert.equal(state.analyzingTouches,true);assert.equal($('export-btn').disabled,true);assert.equal($('stop-touch-analysis').disabled,false);
    jobs[0].options.onProgress({percent:50,frames:48,total:96,remaining:3});
    assert.match($('touch-analysis-status').textContent,/50%/);assert.match($('touch-analysis-estimate').textContent,/About 3 sec/);
    jobs[0].resolve({samples:samples(),frames:96,duration:8,complete:true});await importing;
    assert.equal(state.analyzingTouches,false);assert.equal($('export-btn').disabled,false);assert.equal(state.rawBlob,file);
    assert(state.cameraEvents.length>5);assert(editor.poseAt(3).zoom>1.99);
    for(const track of ['zoom','x','y'])assert(document.querySelector(`.motion-row-${track}`));
    assert(document.querySelectorAll('.motion-key').length===state.cameraEvents.length*3);
    assert.match($('touch-result').textContent,/1 touch gesture found/);
  }finally{cleanup();}
});

test('full-frame shortcut adds an editable zoom-out key and does not fire in text inputs or with Ctrl',async()=>{
  const context=await setup();const {editor,file,jobs,video,state,canvas,key,document,$,cleanup}=context;
  try{
    const importing=editor.importFile(file);await turn();jobs[0].resolve({samples:samples(),frames:96,complete:true});await importing;
    video.currentTime=4.5;key(canvas,'f');
    const full=state.cameraEvents.find(event=>event.kind==='Full frame'&&event.origin!=='touch');
    assert(full);assert.equal(full.time,4.5);editor.clearTransient();assert.equal(editor.poseAt(6).zoom,1);
    const count=state.cameraEvents.length;
    key(document.querySelector('#camera-events input'),'f');key(canvas,'f',{ctrlKey:true});
    assert.equal(state.cameraEvents.length,count);
    assert.match($('selected-motion-heading')?.textContent||document.querySelector('.selected-motion-heading').textContent,/Full frame/);
    $('undo-camera').click();assert(editor.poseAt(6).zoom>1.99,'Undo restores automatic motion');
  }finally{cleanup();}
});

test('stopping a scan preserves the clip and permits a full retry without another upload',async()=>{
  const {editor,file,jobs,state,$,cleanup}=await setup();
  try{
    const importing=editor.importFile(file);await turn();
    $('stop-touch-analysis').click();await importing;
    assert.equal(state.rawBlob,file);assert.equal(state.analyzingTouches,false);assert.equal($('export-btn').disabled,false);assert.equal(state.cameraEvents.length,0);
    assert.match($('touch-result').textContent,/Scan stopped/);
    const retry=editor.runTouchAnalysis();await turn();assert.equal(jobs.length,2);
    jobs[1].resolve({samples:samples(),frames:96,complete:true});await retry;
    assert(state.cameraEvents.length>5);assert.equal(state.rawBlob,file);
  }finally{cleanup();}
});

test('reset invalidates late detection results so they cannot populate a new recording',async()=>{
  const {editor,file,jobs,state,onChange,cleanup}=await setup({respectAbort:false});
  try{
    const importing=editor.importFile(file);await turn();
    editor.reset();state.mode='idle';onChange();
    jobs[0].resolve({samples:samples(),frames:96,complete:true});await importing;
    assert.equal(state.isImported,false);assert.equal(state.analyzingTouches,false);assert.equal(state.touchSamples.length,0);assert.equal(state.cameraEvents.length,0);
  }finally{cleanup();}
});

test('no-dot recordings keep full-frame playback and leave manual editing available',async()=>{
  const {editor,file,jobs,state,$,cleanup}=await setup();
  try{
    const importing=editor.importFile(file);await turn();jobs[0].resolve({samples:[],frames:96,complete:true});await importing;
    assert.equal(state.cameraEvents.length,0);assert.equal(editor.poseAt(3).zoom,1);assert.equal($('export-btn').disabled,false);
    assert.match($('touch-result').textContent,/No reliable touch path/);
  }finally{cleanup();}
});

test('timeline scale, pan and time fields edit the selected key; time collisions never delete another key',async()=>{
  const {editor,file,jobs,state,document,Event,$,cleanup}=await setup();
  try{
    const importing=editor.importFile(file);await turn();jobs[0].resolve({samples:samples(),frames:96,complete:true});await importing;
    const marker=document.querySelectorAll('.motion-row-zoom .motion-key')[5];marker.click();
    const id=marker.dataset.eventId,count=state.cameraEvents.length;
    let scale=document.querySelector('[aria-label="Scale (×) for selected move"]');scale.value='3.5';scale.dispatchEvent(new Event('change'));
    assert.equal(state.cameraEvents.find(event=>event.id===id).zoom,3.5);
    const x=document.querySelector('[aria-label="Pan X (%) for selected move"]');x.value='75';x.dispatchEvent(new Event('change'));
    assert.equal(state.cameraEvents.find(event=>event.id===id).x,.75);
    const time=document.querySelector('[aria-label="Time (s) for selected move"]');time.value=String(state.cameraEvents.find(event=>event.id!==id).time);time.dispatchEvent(new Event('change'));
    assert.equal(state.cameraEvents.length,count);assert(state.cameraEvents.some(event=>event.id===id));
    $('undo-camera').click();assert.equal(state.cameraEvents.length,count);
  }finally{cleanup();}
});

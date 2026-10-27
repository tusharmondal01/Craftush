import { mediaURL, validWords } from './narration-core.js';
import {cleanRecognition} from './narration-recognition.mjs?v=20261027-audio-recovery2';
const stopped=signal=>{if(signal?.aborted)throw new DOMException('Stopped.','AbortError');};
export async function fetchMedia(url,{type='video',teamCode='',signal}={}){
 mediaURL(url,type);stopped(signal);
 try{const r=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(35000)]):AbortSignal.timeout(35000)});if(!r.ok)throw new Error();const blob=await r.blob();if(!blob.size||blob.size>160*1048576)throw new Error();return blob;}catch(e){stopped(signal);}
 const pieces=[];let offset=0,total=null;
 do{const r=await fetch('/api/documentary-media',{method:'POST',headers:{'content-type':'application/json','x-team-code':teamCode},body:JSON.stringify({url,start:offset}),signal});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).errors?.[0]?.message||'Media download failed. Resume to retry its existing URL.');
  const next=Number(r.headers.get('x-media-next')),length=Number(r.headers.get('x-media-total')),bytes=await r.arrayBuffer();
  if(!Number.isInteger(next)||!Number.isInteger(length)||length<=0||length>160*1048576||next!==offset+bytes.byteLength||next>length||!bytes.byteLength||(total!==null&&total!==length))throw new Error('Incomplete media download. Resume to retry.');
  total=length;pieces.push(bytes);offset=next;
 }while(offset<total);
 return new Blob(pieces,{type:type==='video'?'video/mp4':'audio/wav'});
}
export async function joinNarration(blobs,signal){
 const Context=globalThis.AudioContext||globalThis.webkitAudioContext,Offline=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;
 if(!Context||!Offline)throw new Error('Use a current Chrome or Edge browser for narration analysis.');
 const ctx=new Context(),buffers=[];
 try{for(const blob of blobs){stopped(signal);buffers.push(await ctx.decodeAudioData(await blob.arrayBuffer()));}
  const seconds=buffers.reduce((n,b)=>n+b.duration,0);if(!seconds||seconds>1200)throw new Error('Narration exceeds the 20-minute project limit.');
  const offline=new Offline(1,Math.ceil(seconds*24000),24000);let offset=0;
  for(const buffer of buffers){const source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start(offset);offset+=buffer.duration;}
  const rendered=await offline.startRendering();stopped(signal);
  return {blob:new Blob([globalThis.CraftushAlignment.wav([rendered.getChannelData(0)],24000)],{type:'audio/wav'}),duration:rendered.duration};
 }finally{await ctx.close();}
}
export async function recognizeAudio(blob,{signal,onProgress=()=>{}}={}){
 const ctx=new AudioContext();let samples,duration;
 try{const buffer=await ctx.decodeAudioData(await blob.arrayBuffer());duration=buffer.duration;const offline=new OfflineAudioContext(1,Math.ceil(duration*16000),16000),source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();samples=(await offline.startRendering()).getChannelData(0).slice();}finally{await ctx.close();}
 stopped(signal);
 return new Promise((resolve,reject)=>{
  let worker,timer,retryTimer,finished=false,attempt=0,phase='starting';
  const stop=()=>finish(new DOMException('Stopped.','AbortError'));
  const finish=(error,data)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(retryTimer);worker?.terminate();signal?.removeEventListener('abort',stop);error?reject(error):resolve(data);};
  const failed=(message,retryable=true)=>{
   if(finished)return;clearTimeout(timer);worker?.terminate();worker=null;
   if(retryable&&attempt<2){onProgress('Recovering speech analysis · retrying with a fresh engine…');retryTimer=setTimeout(start,600);return;}
   const detail=String(message||'The speech engine stopped.').slice(0,240);
   finish(new Error(`Audio analysis could not ${phase==='starting'?'start':'finish'} after recovery. Your narration is saved; do not generate it again. ${detail}`));
  };
  const reset=(ms=300000)=>{clearTimeout(timer);timer=setTimeout(()=>failed(phase==='starting'?'The speech worker did not start.':'The speech engine stopped responding.',phase!=='recognizing'),ms);};
  const start=()=>{
   if(finished||signal?.aborted){stop();return;}attempt++;phase='starting';
   try{
    const url=new URL('./narration-worker.mjs?v=20261027-speech-load3',import.meta.url);url.searchParams.set('attempt',String(attempt));
    const active=new Worker(url,{type:'module'});worker=active;reset(45000);
    active.onerror=event=>{event.preventDefault?.();if(worker===active)failed(event.message||'The speech worker could not load.');};
    active.onmessageerror=()=>{if(worker===active)failed('The speech worker could not read its response.');};
    active.onmessage=({data})=>{
     if(finished||worker!==active)return;
     if(data.type==='ready'){
      phase='loading';reset();onProgress('Preparing speech model · first use downloads the model…');
      // Keep the original samples for bounded recovery; transfer only a copy.
      const copy=samples.slice();active.postMessage({type:'transcribe',audio:copy,language:'hi',recoverIncomplete:true,fresh:attempt>1},[copy.buffer]);return;
     }
     reset();if(data.type==='error'){failed(data.message,data.retryable===true);return;}
     if(data.type==='complete'){try{const cleaned=cleanRecognition(data,duration),words=globalThis.CraftushAlignment.fromWords(cleaned.chunks,duration);finish(null,{words:words.length?validWords(words,duration):[],transcript:cleaned.text,requiresReview:cleaned.requiresReview,issues:cleaned.issues});}catch(e){finish(e);}return;}
     if(data.type==='listening')phase='recognizing';
     onProgress(data.type==='progress'?`Preparing speech model${data.progress?` · ${Math.round(data.progress)}% of ${String(data.file||'file').split('/').pop()}`:''}`:data.type==='chunk'?(data.retrying?`Rechecking word timings near ${Math.floor(data.start)} seconds…`:`Listening · ${data.count} of ${data.total} sections`):data.type==='listening'?'Listening to the narration…':'Loading the speech engine…');
    };
   }catch(e){failed(e.message);}
  };
  signal?.addEventListener('abort',stop,{once:true});start();
 });
}
export function parseSRT(text,duration){
 const cues=[];for(const block of text.replace(/\r/g,'').trim().split(/\n\s*\n/)){const lines=block.split('\n');const i=lines.findIndex(l=>l.includes('-->'));if(i<0)continue;const [a,b]=lines[i].split('-->').map(x=>globalThis.CraftushAlignment.parseTime(x.trim()));if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b>duration+.1)throw new Error('This SRT does not fit the narration.');cues.push({start:a,end:b,text:lines.slice(i+1).join(' ')});}
 if(!cues.length)throw new Error('No valid SRT cues found.');return validWords(globalThis.CraftushAlignment.fromCues(cues),duration);
}

import { mediaURL, validWords } from './narration-core.js';
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
  const worker=new Worker(new URL('../visuals/voice-worker.mjs?v=20261027-timestamps',import.meta.url),{type:'module'});let timer;
  const finish=(error,data)=>{clearTimeout(timer);worker.terminate();signal?.removeEventListener('abort',stop);error?reject(error):resolve(data);};
  const stop=()=>finish(new DOMException('Stopped.','AbortError'));
  const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(new Error('Audio analysis stopped responding. Retry analysis or import an SRT from this exact narration.')),300000);};
  signal?.addEventListener('abort',stop,{once:true});reset();
  worker.onerror=()=>finish(new Error('Speech recognition could not load. Check the connection or import narration SRT.'));
  worker.onmessage=({data})=>{
   reset();if(data.type==='error')finish(new Error(data.message));
   else if(data.type==='complete'){try{const words=globalThis.CraftushAlignment.fromWords(data.chunks,duration);finish(null,{words:validWords(words,duration),transcript:data.text,requiresReview:data.requiresReview===true,issues:data.issues||[]});}catch(e){finish(e);}}
   else onProgress(data.type==='progress'?`Preparing speech model${data.progress?` · ${Math.round(data.progress)}% of ${String(data.file||'file').split('/').pop()}`:''}`:data.type==='chunk'?(data.retrying?`Rechecking word timings near ${Math.floor(data.start)} seconds…`:`Listening · ${data.count} of ${data.total} sections`):'Listening to the narration…');
  };
  worker.postMessage({type:'transcribe',audio:samples,language:'hi',recoverIncomplete:true},[samples.buffer]);
 });
}
export function parseSRT(text,duration){
 const cues=[];for(const block of text.replace(/\r/g,'').trim().split(/\n\s*\n/)){const lines=block.split('\n');const i=lines.findIndex(l=>l.includes('-->'));if(i<0)continue;const [a,b]=lines[i].split('-->').map(x=>globalThis.CraftushAlignment.parseTime(x.trim()));if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b>duration+.1)throw new Error('This SRT does not fit the narration.');cues.push({start:a,end:b,text:lines.slice(i+1).join(' ')});}
 if(!cues.length)throw new Error('No valid SRT cues found.');return validWords(globalThis.CraftushAlignment.fromCues(cues),duration);
}

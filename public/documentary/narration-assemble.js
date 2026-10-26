import { validatePlan, normalizationCommand, FPS } from './narration-core.js';
import { musicCommand,cleanMusic } from './core.js';
export async function assembleNarrated(clips,narration,plan,{musicBlob=null,music={},signal,onProgress=()=>{}}={}){
 plan=validatePlan(plan,plan?.audioDuration);
 if(!Array.isArray(clips)||clips.length!==plan.requestCount||clips.some(b=>!(b instanceof Blob)||!b.size)||!(narration instanceof Blob)||!narration.size)throw new Error('Every active clip and the saved narration are required. Disabled slots are ignored.');
 if(clips.reduce((n,b)=>n+b.size,narration.size+(musicBlob?.size||0))>512*1048576)throw new Error('These media exceed the 512 MB browser assembly limit. Your individual clips remain saved.');
 const {FFmpeg}=await import('./vendor/ffmpeg/dist/esm/index.js'),engine=new FFmpeg(),files=new Set(),logs=[];
 const stop=()=>engine.terminate(),check=()=>{if(signal?.aborted)throw new DOMException('Assembly stopped.','AbortError');};
 check();signal?.addEventListener('abort',stop,{once:true});let phase='Loading video engine',completed=0,seq=0;
 engine.on('log',({message})=>{logs.push(message);if(logs.length>10)logs.shift();});
 engine.on('progress',({progress})=>onProgress(`${phase} · ${completed}/${plan.requestCount} clips`,Math.min(.99,(completed+Math.max(0,Math.min(1,progress)))/(plan.requestCount+3))));
 const write=async(name,data)=>{files.add(name);await engine.writeFile(name,data);};
 const exec=async args=>{check();if(await engine.exec(args)!==0)throw new Error('Assembly failed: '+logs.slice(-3).join(' ').slice(0,250));};
 const probe=async name=>{const output=`probe-${++seq}.json`;files.add(output);const code=await engine.ffprobe(['-v','error','-show_streams','-show_format','-of','json',name,'-o',output]);const data=JSON.parse(await engine.readFile(output,'utf8'));if(![0,-1].includes(code)||data.format?.filename!==name||!data.streams?.length)throw new Error('Media verification failed.');return data;};
 try{
  onProgress(phase,0);const root=new URL('./vendor/',import.meta.url);await engine.load({coreURL:new URL('core/dist/esm/ffmpeg-core.js',root).href,wasmURL:new URL('core/dist/esm/ffmpeg-core.wasm',root).href});
  const names=[];
  for(let i=0;i<clips.length;i++){
   check();phase=`Trimming clip ${i+1} to narration`;onProgress(phase,i/(clips.length+3));
   const input=`input-${i}.mp4`,out=`clip-${i}.mp4`;await write(input,new Uint8Array(await clips[i].arrayBuffer()));
   const p=await probe(input),v=p.streams.find(s=>s.codec_type==='video'),seconds=Number(v?.duration||p.format?.duration),need=plan.requests[i].frames/FPS;
   if(!v||!Number.isFinite(seconds)||seconds+.055<need)throw new Error(`Clip ${i+1} is shorter than its planned narration. Replace it before assembly.`);
   files.add(out);await exec(normalizationCommand(input,out,plan.requests[i].frames));
   const checked=await probe(out);if(Math.abs(Number(checked.format.duration)-need)>.07)throw new Error(`Clip ${i+1} duration does not match the shot plan.`);
   await engine.deleteFile(input);files.delete(input);names.push(out);completed=i+1;
  }
  await write('clips.txt',new TextEncoder().encode(names.map(n=>`file '${n}'`).join('\n')));files.add('joined.mp4');phase='Joining active clips';onProgress(phase,.91);
  await exec(['-y','-f','concat','-safe','0','-i','clips.txt','-map','0:v:0','-an','-c','copy','joined.mp4']);
  for(const name of names){await engine.deleteFile(name);files.delete(name);}
  await write('narration.wav',new Uint8Array(await narration.arrayBuffer()));const audioProbe=await probe('narration.wav');
  if(!audioProbe.streams.some(s=>s.codec_type==='audio')||Math.abs(Number(audioProbe.format.duration)-plan.audioDuration)>.06)throw new Error('Saved narration does not match this shot plan. Analyze it again.');
  phase='Adding the full narration';onProgress(phase,.95);files.add('narrated.mp4');
  await exec(['-y','-i','joined.mp4','-i','narration.wav','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-t',String(plan.audioDuration),'-movflags','+faststart','narrated.mp4']);
  let output='narrated.mp4';const mix=cleanMusic(music);
  if(musicBlob||mix.narrationVolumeDb!==0){if(musicBlob)await write('music.bin',new Uint8Array(await musicBlob.arrayBuffer()));output='final.mp4';files.add(output);phase='Mixing background music';await exec(musicCommand('narrated.mp4',musicBlob?'music.bin':null,output,plan.audioDuration,mix));}
  const final=await probe(output),duration=Number(final.format.duration);
  if(!final.streams.some(s=>s.codec_type==='video')||!final.streams.some(s=>s.codec_type==='audio')||Math.abs(duration-plan.audioDuration)>.15)throw new Error('Final duration verification failed. No incomplete video was saved.');
  const blob=new Blob([await engine.readFile(output)],{type:'video/mp4'});onProgress('Final video ready',1);return {blob,duration,engine:'FFmpeg · narration-timed clips'};
 }finally{signal?.removeEventListener('abort',stop);if(!signal?.aborted)for(const file of files)try{await engine.deleteFile(file);}catch{}engine.terminate();}
}

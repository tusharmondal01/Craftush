import {recognizeNarration} from './narration-recognition.mjs?v=20261027-audio-recovery2';
let transcriber;
self.onmessage=async({data})=>{
 if(data.type!=='transcribe')return;
 try{
  const {pipeline,env}=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
  env.allowLocalModels=false;env.backends.onnx.wasm.numThreads=1;env.backends.onnx.wasm.proxy=false;
  if(!transcriber)transcriber=await pipeline('automatic-speech-recognition','onnx-community/whisper-small_timestamped',{
   revision:'65caa70f294b46e1c33ff820aae6b16d048ab818',device:'wasm',dtype:'q8',
   progress_callback:p=>self.postMessage({type:'progress',status:p.status,file:p.file,progress:p.progress})
  });
  self.postMessage({type:'listening'});
  const result=await recognizeNarration(transcriber,data.audio,data.language,p=>self.postMessage({type:'chunk',...p}));
  self.postMessage({type:'complete',...result});
 }catch(error){self.postMessage({type:'error',message:error?.message||'Speech recognition could not finish.'});}
};

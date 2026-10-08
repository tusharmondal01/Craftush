// Audio samples stay in this worker. Only model files are downloaded; no inference API is called.
let transcriber=null;
const MODEL='onnx-community/whisper-small_timestamped';
const REVISION='65caa70f294b46e1c33ff820aae6b16d048ab818';
self.onmessage=async ({data})=>{
  if(data.type!=='transcribe')return;
  const send=message=>self.postMessage({...message,ticket:data.ticket});
  try{
    const {transcribeWindows}=await import('./transcription-windows.mjs?v=19');
    const {pipeline,env}=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
    env.allowLocalModels=false;
    env.backends.onnx.wasm.numThreads=1;
    env.backends.onnx.wasm.proxy=false;
    if(!transcriber) transcriber=await pipeline('automatic-speech-recognition',MODEL,{
      revision:REVISION,device:'wasm',dtype:'q8',
      progress_callback:p=>send({type:'progress',status:p.status,file:p.file,progress:p.progress})
    });
    send({type:'listening'});
    const result=await transcribeWindows(transcriber,data.audio,data.language,{onChunk:p=>send({type:'chunk',...p})});
    send({type:'complete',text:result.text,chunks:result.chunks||[],issues:result.issues||[],recovered:result.recovered||0});
  }catch(error){send({type:'error',message:error?.message||'Speech recognition could not finish.'});}
};

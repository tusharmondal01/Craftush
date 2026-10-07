// Audio samples stay in this worker. Only model files are downloaded; no inference API is called.
let transcriber=null;
const MODEL='onnx-community/whisper-small_timestamped';
const REVISION='65caa70f294b46e1c33ff820aae6b16d048ab818';
self.onmessage=async ({data})=>{
  if(data.type!=='transcribe')return;
  try{
    const {pipeline,env}=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
    env.allowLocalModels=false;
    env.backends.onnx.wasm.numThreads=1;
    env.backends.onnx.wasm.proxy=false;
    if(!transcriber) transcriber=await pipeline('automatic-speech-recognition',MODEL,{
      revision:REVISION,device:'wasm',dtype:'q8',
      progress_callback:p=>self.postMessage({type:'progress',status:p.status,file:p.file,progress:p.progress})
    });
    self.postMessage({type:'listening'});
    const result=await transcriber(data.audio,{
      task:'transcribe',...(data.language!=='auto'?{language:data.language}:{}),
      return_timestamps:'word',chunk_length_s:30,stride_length_s:5
    });
    self.postMessage({type:'complete',text:result.text,chunks:result.chunks||[]});
  }catch(error){self.postMessage({type:'error',message:error?.message||'Speech recognition could not finish.'});}
};

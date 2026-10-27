let transcriber;
// Keep bootstrap free of static imports. A missing/cached module is reported
// to the page with its stage instead of an opaque, uncaught Worker error.
self.postMessage({type:'ready'});
self.onmessage=async({data})=>{
 if(data.type!=='transcribe')return;
 let stage='loading';
 try{
  self.postMessage({type:'loading'});
  const {recognizeNarration}=await import('./narration-recognition.mjs?v=20261027-speech-load3');
  const {pipeline,env}=await import('./vendor/speech-3.8.1/transformers.min.js');
  env.allowLocalModels=false;env.backends.onnx.wasm.numThreads=1;env.backends.onnx.wasm.proxy=false;
  env.backends.onnx.wasm.wasmPaths=new URL('./vendor/speech-3.8.1/',import.meta.url).href;
  // A second fresh worker bypasses a potentially incomplete model cache only
  // for this load. It never deletes another tool's cache or changes the model.
  env.useBrowserCache=data.fresh!==true;
  if(!transcriber)transcriber=await pipeline('automatic-speech-recognition','onnx-community/whisper-small_timestamped',{
   revision:'65caa70f294b46e1c33ff820aae6b16d048ab818',device:'wasm',dtype:'q8',
   progress_callback:p=>self.postMessage({type:'progress',status:p.status,file:p.file,progress:p.progress})
  });
  stage='recognizing';self.postMessage({type:'listening'});
  const result=await recognizeNarration(transcriber,data.audio,data.language,p=>self.postMessage({type:'chunk',...p}));
  self.postMessage({type:'complete',...result});
 }catch(error){self.postMessage({type:'error',stage,retryable:stage==='loading',message:error?.message||'Speech recognition could not finish.'});}
};

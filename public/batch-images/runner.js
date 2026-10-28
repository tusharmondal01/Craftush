import {CHUNK_SIZE,imageTask,acceptResults,imageURL} from './core.js?v=20261028-batch1';
const stop=signal=>{if(signal?.aborted)throw new DOMException('Batch stopped.','AbortError');};
export const chunk=list=>Array.from({length:Math.ceil(list.length/CHUNK_SIZE)},(_,i)=>list.slice(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE));
export async function runImages(batch,{relay,save,saveImage,uuid=()=>crypto.randomUUID(),signal,onChange=()=>{},wait=(ms)=>new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(new DOMException('Batch stopped.','AbortError'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);signal?.addEventListener('abort',stop,{once:true});}),maxWait=15*60000,retryFailed=false}={}){
 const changed=async()=>{await save(batch);onChange(batch);};
 // Assign every ID and validate every prompt before the first paid request.
 if(retryFailed)for(const item of batch.items.filter(i=>i.status==='failed')){item.history.push(item.taskUUID);item.taskUUID='';item.status='queued';item.error='';delete item.imageURL;}
 for(const item of batch.items){if(!item.taskUUID)item.taskUUID=uuid();imageTask(item,batch.settings);}
 batch.started||=new Date().toISOString();
 await changed();
 const recover=async items=>{
  try{const reply=await relay(items.map(i=>({taskType:'getResponse',taskUUID:i.taskUUID})),signal);acceptResults(batch,items,reply);}
  catch(error){stop(signal);for(const item of items){item.error=error.message;if(error.rateLimited)item.retryAt=Date.now()+(error.retryAfter||30)*1000;}}
  await changed();
 };
 const submit=async items=>{
  stop(signal);items.forEach(i=>{i.status='submitted';i.error='';});await changed();let dispatched=false;
  try{stop(signal);dispatched=true;const reply=await relay(items.map(i=>imageTask(i,batch.settings)),signal);acceptResults(batch,items,reply);}
  catch(error){
   // Only a rejection before provider forwarding may be submitted again.
   for(const item of items){item.status=error.notSubmitted||!dispatched?'queued':'uncertain';item.error=error.message;if(error.notSubmitted)item.retryAt=Date.now()+(error.retryAfter||30)*1000;}
   await changed();stop(signal);if(error.accessDenied)throw error;
  }
  await changed();
 };
 const downloads=async()=>{
  const pending=batch.items.filter(i=>i.status==='download');let cursor=0;
  const results=await Promise.allSettled(Array.from({length:Math.min(4,pending.length)},async()=>{while(cursor<pending.length){stop(signal);const item=pending[cursor++];try{await saveImage(item,signal);stop(signal);item.status='ready';delete item.base64;item.error='';}catch(error){stop(signal);item.error='Image generated. Download needs retry: '+error.message;}await changed();}}));
  const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
 };
 // All chunks are dispatched together, not a one-image-at-a-time queue.
 const submissions=await Promise.allSettled(chunk(batch.items.filter(i=>i.status==='queued'&&(!i.retryAt||i.retryAt<=Date.now()))).map(submit));
 const failed=submissions.find(r=>r.status==='rejected');if(failed)throw failed.reason;
 await downloads();const started=Date.now();let first=true;
 while(batch.items.some(i=>['queued','submitted','uncertain','processing'].includes(i.status))){
  stop(signal);if(Date.now()-started>=maxWait){batch.message='Waiting paused after 15 minutes. Resume checks the same request IDs. Saved images will not be generated again.';await changed();return;}
  await wait(first?8000:30000);first=false;stop(signal);
  const queued=batch.items.filter(i=>i.status==='queued'&&(!i.retryAt||i.retryAt<=Date.now()));
  const sent=await Promise.allSettled(chunk(queued).map(submit));const rejected=sent.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
  const pending=batch.items.filter(i=>['submitted','uncertain','processing'].includes(i.status)&&(!i.retryAt||i.retryAt<=Date.now()));
  await Promise.all(chunk(pending).map(recover));await downloads();
 }
 await downloads();batch.message=batch.items.every(i=>i.status==='ready')?'All images saved. Your ZIP is ready.':'Completed images are saved. Retry failed images or resume downloads.';await changed();
}
export async function jpegBlob(blob){
 if(!blob.size||blob.size>20*1048576)throw new Error('The generated image is empty or exceeds 20 MB.');
 const bytes=new Uint8Array(await blob.slice(0,12).arrayBuffer());
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return new Blob([blob],{type:'image/jpeg'});
 const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71,webp=new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
 if(!png&&!webp)throw new Error('The download is not a valid image.');
 const bitmap=await createImageBitmap(blob);
 try{const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0);const jpg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.95));if(!jpg)throw new Error('JPEG conversion failed.');return jpg;}finally{bitmap.close();}
}
export async function downloadImage(item,{endpoint,signal,code=''}){
 if(item.base64){const raw=atob(item.base64.replace(/^data:image\/[^;]+;base64,/,''));return jpegBlob(new Blob([Uint8Array.from(raw,c=>c.charCodeAt(0))]));}
 const url=imageURL(item.imageURL);
 try{const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000)});if(!response.ok)throw new Error('Image download failed.');return await jpegBlob(await response.blob());}catch(error){stop(signal);}
 const response=await endpoint('/api/batch-image-media',{method:'POST',headers:{'content-type':'application/json','x-team-code':code},body:JSON.stringify({url}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(55000)]):AbortSignal.timeout(55000)});
 if(!response.ok)throw new Error((await response.json().catch(()=>({}))).errors?.[0]?.message||'Image download failed.');return jpegBlob(await response.blob());
}

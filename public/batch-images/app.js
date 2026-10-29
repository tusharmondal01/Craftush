import {parseImages,imageSettings,imageZip} from './core.js?v=20261029-storyboard1';
import {runImages,downloadImage} from './runner.js?v=20261029-storyboard1';
import {DocumentaryStore} from '../documentary/storage.js';
const $=id=>document.getElementById(id),store=new DocumentaryStore(),objectURLs=new Map();
let batch=null,busy=false,packing=false,controller=null,connected=false,enabled=true,index=[];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const endpoint=(...args)=>globalThis.craftushAPI?globalThis.craftushAPI(...args):fetch(...args);
const notice=(text,error=false)=>{$('notice').hidden=!text;$('notice').textContent=text;$('notice').className='notice'+(error?' error':'');};
const message=text=>{$('activity').textContent=text;};
const mediaKey=item=>`batch-image-${batch.id}-${item.index}`;
const settings=()=>imageSettings({model:$('model').value,shape:$('shape').value,quality:$('quality').value});
async function save(value=batch){if(value)await store.put('image-batch-'+value.id,structuredClone(value));}
function savedList(){const selected=batch?.id||'';$('savedBatches').innerHTML='<option value="">Choose a saved batch</option>'+index.map(b=>`<option value="${b.id}">${esc(b.title)} · ${b.count} images</option>`).join('');$('savedBatches').value=selected;}
function render(){
 const items=batch?.items||[],ready=items.filter(i=>i.status==='ready').length,failed=items.filter(i=>i.status==='failed').length,all=items.length&&ready===items.length,working=items.filter(i=>['submitted','processing','uncertain','download'].includes(i.status)).length;
 $('batchTitle').textContent=batch?`${batch.title} · ${items.length} images`:'Your next batch starts here.';$('readyCount').textContent=ready;$('workingCount').textContent=working;$('failedCount').textContent=failed;$('percentage').textContent=(items.length?Math.round(ready/items.length*100):0)+'%';$('progress').value=items.length?ready/items.length*100:0;
 $('cost').textContent='$'+Object.values(batch?.costs||{}).reduce((a,b)=>a+b,0).toFixed(4)+' reported';
 $('start').disabled=busy||packing||!items.length||!connected||!enabled||!!all;$('start').textContent=all?'All images saved':batch?.started?'Resume generation / downloads ↗':'Generate all images ↗';$('stop').disabled=!busy;
 $('retry').disabled=busy||packing||!failed||!connected||!enabled;$('downloadZip').disabled=busy||packing||!all;$('partialZip').disabled=busy||packing||!ready||!!all;
 for(const id of ['jsonFile','jsonText','useJSON','savedBatches'])$(id).disabled=busy||packing;
 for(const id of ['model','shape','quality'])$(id).disabled=busy||packing||!!batch?.started;
 const c=batch?.started?batch.settings:settings();$('dimensions').textContent=`${c.width} × ${c.height} px · JPEG · one image per prompt`;
 if(!items.length)return;
 $('grid').innerHTML=items.map(item=>{
  const url=objectURLs.get(mediaKey(item)),state={queued:'Ready to start',submitted:'Submitted',processing:'Generating',uncertain:'Checking original request',download:'Saving image',ready:'Saved',failed:'Needs retry'}[item.status];
  return `<article class="image-card"><div class="image-preview ${['submitted','processing','uncertain','download'].includes(item.status)&&busy?'working':''}">${url?`<img src="${esc(url)}" alt="${esc(item.name)}" loading="lazy" decoding="async">`:`<span>${String(item.index).padStart(2,'0')}</span>`}</div><div class="image-copy"><h3>${esc(item.filename)}</h3><p>${esc(item.name)}</p><p class="status ${item.status}">${state}</p>${item.error?`<p class="help">${esc(item.error)}</p>`:''}<details><summary>Image prompt</summary><p>${esc(item.prompt)}</p></details>${item.status==='ready'?`<button data-download="${item.index}">Download JPG ↗</button>`:''}</div></article>`;
 }).join('');
}
async function relay(tasks,signal){
 let response,data;
 try{const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(65000)]):AbortSignal.timeout(65000);response=await endpoint('/api/runware',{method:'POST',headers:{'content-type':'application/json','x-team-code':$('teamCode').value.trim()},body:JSON.stringify(tasks),signal:bounded});data=await response.json();}
 catch(error){if(signal?.aborted)throw error;throw new Error('The connection was interrupted. Resume checks the same request IDs.');}
 if(!response.ok){
  const first=data.errors?.[0]||{},accessDenied=response.status===401||response.status===403,rateLimited=first.code==='RATE_LIMITED',notSubmitted=accessDenied||rateLimited||first.code==='RATE_LIMIT_UNAVAILABLE';
  // A provider's explicit task error is recorded per row. Server/transport
  // failures remain uncertain and are checked without a duplicate generation.
  if(!notSubmitted&&response.status<500&&response.status!==429&&data.errors?.length)return data;
  throw Object.assign(new Error(first.message||'Runware could not answer this request.'),{accessDenied,rateLimited,notSubmitted,retryAfter:Number(response.headers.get('retry-after')||data.retryAfter)||30});
 }
 return data;
}
async function connection(){
 try{const [response,cards]=await Promise.all([endpoint('/api/runware',{cache:'no-store'}),endpoint('/api/tools?view=dashboard',{cache:'no-store'})]);const data=await response.json(),tools=cards.ok?await cards.json():null;connected=response.ok&&data.configured===true;enabled=tools?.cards?.batch?.enabled!==false;$('codeField').hidden=!data.codeRequired;$('connection').textContent=!enabled?'Batch Images is disabled in Admin.':connected?'Runware connected · key stays on the backend':'Add a Runware key in Admin to generate images.';}
 catch{connected=false;$('connection').textContent='Connection unavailable. Saved images and ZIP downloads remain available.';}
 render();
}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function loadJSON(text,name){
 if(busy||packing)return;const items=parseImages(text);for(const url of objectURLs.values())URL.revokeObjectURL(url);objectURLs.clear();batch={id:crypto.randomUUID(),title:String(name||'Image collection').replace(/\.json$/i,'').slice(0,100),items,settings:settings(),costs:{},created:new Date().toISOString(),message:''};
 await save();await store.put('image-batch-active',batch.id);index=[{id:batch.id,title:batch.title,count:items.length},...index];await store.put('image-batch-index',index);savedList();render();notice('JSON loaded. Review the prompts and settings, then generate all images.');message(`${items.length} prompts ready. Every filename follows the JSON order.`);
}
async function selectBatch(id){
 if(!id)return;const saved=await store.get('image-batch-'+id);if(!saved)throw new Error('This saved batch is unavailable.');if(batch?.id!==id){for(const url of objectURLs.values())URL.revokeObjectURL(url);objectURLs.clear();}batch=saved;
 $('model').value=batch.settings.model;$('shape').value=batch.settings.shape;$('quality').value=batch.settings.quality;
 for(const item of batch.items.filter(i=>i.status==='ready')){const key=mediaKey(item),blob=await store.get(key);if(blob){if(!objectURLs.has(key))objectURLs.set(key,URL.createObjectURL(blob));}else{item.status=item.imageURL?'download':'uncertain';item.error='The saved image is missing. Resume to retrieve its original result.';}}
 await store.put('image-batch-active',id);await save();savedList();render();message(batch.message||'Saved batch restored. Resume checks existing requests.');
}
async function zip(partial=false){
 if(!batch||packing)return;const items=batch.items.filter(i=>i.status==='ready');if(!items.length||!partial&&items.length!==batch.items.length)throw new Error('Finish every image before downloading the complete ZIP.');
 packing=true;render();
 try{const entries=[];for(const item of items){const blob=await store.get(mediaKey(item));if(!blob)throw new Error(`${item.filename} is missing from browser storage. Resume to restore it.`);entries.push({index:item.index,blob});}
  const blob=await imageZip(entries,(done,total)=>message(`Packing your ZIP · ${done} / ${total} images`));const title=batch.title.replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-|-$/g,'')||'craftush';download(blob,title+(partial?'-completed':'-images')+'.zip');message(`${items.length} numbered JPEGs packed in one ZIP.`);
 }finally{packing=false;render();}
}
async function start(retryFailed=false){
 if(!batch||busy)return;notice('');
 const work=async lock=>{
  if(!lock&&navigator.locks){notice('A Batch Images workflow is running in another tab. Use that tab or stop it first.',true);return;}
  busy=true;controller=new AbortController();if(!batch.started)batch.settings=settings();render();message('Submitting your image requests in parallel…');
  try{
   await runImages(batch,{relay,save,signal:controller.signal,retryFailed,onChange:()=>{render();const count=batch.items.filter(i=>i.status==='ready').length;message(`${count} / ${batch.items.length} images saved · ${batch.message||'Results arrive as Runware completes them.'}`);},saveImage:async(item,signal)=>{
    const key=mediaKey(item),blob=await store.get(key)||await downloadImage(item,{endpoint,signal,code:$('teamCode').value.trim()});await store.put(key,blob);if(!objectURLs.has(key))objectURLs.set(key,URL.createObjectURL(blob));
   }});
   message(batch.message);if(batch.items.every(i=>i.status==='ready')&&$('autoZip').checked)await zip();
  }catch(error){notice(controller.signal.aborted?'Stopped. Your saved work is retained. Resume checks submitted tasks using the same IDs.':error.message,!controller.signal.aborted);message('Your batch is saved. Resume when ready.');}
  finally{busy=false;controller=null;await save();render();}
 };
 if(navigator.locks)await navigator.locks.request('craftush-batch-images',{ifAvailable:true},work);else await work(true);
}
const guarded=fn=>async(...args)=>{try{await fn(...args);}catch(error){notice(error.message,true);}};
$('jsonFile').onchange=guarded(async()=>{const file=$('jsonFile').files[0];if(!file)return;if(file.size>8*1048576)throw new Error('Choose a JSON file smaller than 8 MB.');await loadJSON(await file.text(),file.name);});
$('useJSON').onclick=guarded(()=>loadJSON($('jsonText').value,'Pasted prompts'));
$('example').onclick=()=>download(new Blob([JSON.stringify({images:[{name:'Mountain morning',prompt:'A wide natural photograph of a Himalayan valley at sunrise, precise mountain geology, soft early light, realistic colour and fine detail.'},{name:'Forest stream',prompt:'A clear forest stream between mossy rocks, filtered daylight, detailed foliage, realistic water and natural photographic colour.'}]},null,2)],{type:'application/json'}),'craftush-image-prompts-example.json');
$('start').onclick=guarded(()=>start());$('retry').onclick=guarded(()=>start(true));$('stop').onclick=()=>controller?.abort();$('downloadZip').onclick=guarded(()=>zip());$('partialZip').onclick=guarded(()=>zip(true));$('recheck').onclick=connection;
$('savedBatches').onchange=guarded(()=>selectBatch($('savedBatches').value));
for(const id of ['model','shape','quality'])$(id).onchange=()=>render();
$('grid').onclick=guarded(async event=>{const button=event.target.closest('[data-download]');if(!button)return;const item=batch.items.find(i=>i.index===Number(button.dataset.download));const blob=await store.get(mediaKey(item));if(!blob)throw new Error('Resume to recover this image from its existing result.');download(blob,item.filename);});
addEventListener('beforeunload',event=>{if(busy||packing){event.preventDefault();event.returnValue='';}});
async function init(){try{index=await store.get('image-batch-index')||[];const active=await store.get('image-batch-active');if(active)await selectBatch(active);else savedList();}catch(error){notice(error.message,true);}render();await connection();}
void init();

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseImages,imageTask,imageSettings,acceptResults,imageZip,crc32} from '../public/batch-images/core.js';
import {runImages,jpegBlob} from '../public/batch-images/runner.js';
import {batchImageURL,createBatchImageMedia} from '../netlify/lib/batch-image-media.js';
const jpg=new Blob([new Uint8Array([255,216,255,224,1,2,3,4,255,217])],{type:'image/jpeg'});
const batchOf=(count=3)=>({id:crypto.randomUUID(),settings:imageSettings(),costs:{},items:parseImages(Array.from({length:count},(_,i)=>({name:`Image name ${i+1}`,prompt:`Exact relevant prompt ${i+1}.`})))});
const result=tasks=>({data:[...tasks].reverse().map(t=>({taskUUID:t.taskUUID,imageURL:`https://im.runware.ai/image/${t.taskUUID}.jpg`,cost:.01}))});
const opts=()=>({save:async()=>{},saveImage:async()=>{},wait:async()=>{}});
test('name/prompt arrays, common field spellings, dictionaries and parallel lists preserve JSON order',()=>{
 for(const data of [[{image_name:'Sun',image_prompt:'A bright sun.'}],{images:[{name:'Sun',prompt:'A bright sun.'}]},{items:[{filename:'Sun',positivePrompt:'A bright sun.'}]},{Sun:'A bright sun.'},{image_names:['Sun'],image_prompts:['A bright sun.']},{prompts:['A bright sun.']}]){
  const items=parseImages(JSON.stringify(data));assert.equal(items[0].filename,'1.jpg');assert.equal(items[0].prompt,'A bright sun.');
 }
 assert.equal(parseImages({images:Array.from({length:100},(_,i)=>({name:String(i),prompt:'Three or more words'}))}).at(-1).filename,'100.jpg');
});
test('invalid or oversized JSON is rejected completely before generation',()=>{
 for(const data of ['not json',[],{images:[{name:'Missing prompt'}]},Array(101).fill('A clear image'),{names:['A','B'],prompts:['Only one prompt']}])assert.throws(()=>parseImages(data));
 const b=batchOf(2);b.items[1].prompt='a'.repeat(32001);let calls=0;
 return assert.rejects(()=>runImages(b,{...opts(),relay:async()=>{calls++;}}),/Image 2/).then(()=>assert.equal(calls,0));
});
test('a 135-entry converted storyboard imports its 43 prompts without headings or motion notes',()=>{
 const lines=[],names=[],prompts=[];
 for(let i=1;i<=43;i++){
  if([1,9,25,27,38,42].includes(i))lines.push('SECTION '+i);
  const name=`S${i} · Seg ${i}–${i+1} · 0:03–0:06.5 · Wide establishing`,prompt=`Exact image ${i}: natural light, visible subject and accurate setting.`,motion='Motion: slow push-in · In: cross-dissolve · Overlay: drifting mist · SFX: wind';
  names.push(name);prompts.push(prompt);lines.push(name,'Prompt: '+prompt,motion);
 }
 assert.equal(lines.length,135);const items=parseImages(JSON.stringify(lines));assert.equal(items.length,43);assert.deepEqual(items.map(i=>i.name),names);assert.deepEqual(items.map(i=>i.prompt),prompts);assert.deepEqual(items.map(i=>i.filename),Array.from({length:43},(_,i)=>`${i+1}.jpg`));
 assert(items.every(i=>!i.prompt.includes('Motion:')&&!i.name.startsWith('SECTION')));
});
test('storyboard import rejects missing or ambiguous prompts instead of silently dropping scenes',()=>{
 for(const lines of [
  ['S1 · Seg 1 · wide','S2 · Seg 2 · close','Prompt: A detailed second scene.'],
  ['S1 · Seg 1 · wide','Prompt: A detailed first scene.','S2 · Seg 2 · close','Motion: pan up'],
  ['S1 · Seg 1 · wide','Prompt: A detailed first scene.','Prompt: Another image without a title.'],
  ['S1 · Seg 1 · wide','Prompt: A detailed first scene.','An unlabeled second image description that must not silently disappear.']
 ])assert.throws(()=>parseImages(lines),/missing|without a scene|Unrecognized/);
 const tooMany=Array.from({length:101},(_,i)=>[`S${i+1} · Seg ${i+1} · wide`,'Prompt: A precise scene description.','Motion: pan up']).flat();assert.throws(()=>parseImages(tooMany),/Found 101 image prompts/);
 assert.deepEqual(parseImages(['A clear natural photograph.','A second relevant image.']).map(i=>i.prompt),['A clear natural photograph.','A second relevant image.']);
});
test('image tasks keep exact prompts, unique UUIDs and native model settings; credentials cannot come from JSON',()=>{
 const i=parseImages([{name:'Name',prompt:'Keep this exact prompt.',apiKey:'do-not-use',model:'untrusted:123@1',uploadEndpoint:'https://evil.test'}])[0];i.taskUUID=crypto.randomUUID();
 const t=imageTask(i,imageSettings({model:'openai:gpt-image@2',shape:'vertical'}));assert.equal(t.positivePrompt,'Keep this exact prompt.');assert.equal(t.model,'openai:gpt-image@2');assert.equal(t.taskUUID,i.taskUUID);assert.equal(t.outputFormat,'JPG');assert.equal(t.outputType,'URL');assert.equal(t.deliveryMethod,'async');assert.deepEqual(t.settings,{quality:'high',background:'opaque'});assert.equal(t.apiKey,undefined);assert.equal(t.uploadEndpoint,undefined);assert.deepEqual([t.width,t.height],[1024,1536]);
 const flux=imageTask(i,imageSettings({model:'runware:101@1'}));assert.equal(flux.steps,28);assert.equal(flux.settings,undefined);
 const banana=imageTask(i,imageSettings({model:'google:4@2'}));assert.deepEqual([banana.width,banana.height],[2752,1536]);assert.equal(banana.settings,undefined);
});
test('100 images are submitted concurrently in nine provider-safe chunks and saved in original order',async()=>{
 const b=batchOf(100),calls=[],pending=[],images=[];let generations=0;
 const running=runImages(b,{...opts(),relay:async tasks=>{calls.push(tasks);if(tasks[0].taskType==='imageInference'){generations++;return new Promise(resolve=>pending.push(()=>resolve(result(tasks))));}return result(tasks);},saveImage:async i=>images.push(i.index)});
 for(let n=0;n<20&&pending.length<9;n++)await new Promise(r=>setImmediate(r));assert.equal(pending.length,9,'all chunks in flight before any result');assert(calls.every(c=>c.length<=12));assert.equal(new Set(calls.flat().map(t=>t.taskUUID)).size,100);
 pending.reverse().forEach(resolve=>resolve());await running;assert.equal(generations,9);assert.equal(images.length,100);assert(b.items.every(i=>i.status==='ready'));assert.deepEqual(b.items.map(i=>i.filename),Array.from({length:100},(_,i)=>`${i+1}.jpg`));assert(Math.abs(Object.values(b.costs).reduce((a,c)=>a+c,0)-1)<1e-10);
});
test('lost submission response resumes by polling the same UUID, without another paid task',async()=>{
 const b=batchOf(3),calls=[];await runImages(b,{...opts(),relay:async tasks=>{calls.push(tasks);if(tasks[0].taskType==='imageInference')throw new Error('Connection dropped');return result(tasks);}});
 assert.equal(calls.filter(c=>c[0].taskType==='imageInference').length,1);assert.deepEqual(calls[1].map(t=>t.taskUUID),calls[0].map(t=>t.taskUUID));assert(b.items.every(i=>i.status==='ready'));
});
test('Stop after dispatch retains task IDs and a restored batch polls rather than resubmits',async()=>{
 const b=batchOf(2),control=new AbortController();let ids;
 await assert.rejects(()=>runImages(b,{...opts(),signal:control.signal,relay:async tasks=>{ids=tasks.map(t=>t.taskUUID);control.abort();throw new DOMException('Stopped','AbortError');}}),{name:'AbortError'});
 const restored=structuredClone(b),calls=[];await runImages(restored,{...opts(),relay:async tasks=>{calls.push(tasks);return result(tasks);}});assert(calls.flat().every(t=>t.taskType==='getResponse'));assert.deepEqual(calls[0].map(t=>t.taskUUID),ids);
});
test('Stop before dispatch leaves rows queued and does not pretend a request was sent',async()=>{
 const b=batchOf(1),control=new AbortController();let calls=0,saves=0;
 await assert.rejects(()=>runImages(b,{...opts(),signal:control.signal,save:async()=>{if(++saves===2)control.abort();},relay:async()=>calls++}),{name:'AbortError'});assert.equal(calls,0);assert.equal(b.items[0].status,'queued');
});
test('only explicit failed rows receive fresh task IDs; ready and uncertain rows retain their IDs',async()=>{
 const b=batchOf(3);b.items.forEach(i=>i.taskUUID=crypto.randomUUID());b.items[0].status='ready';b.items[1].status='failed';b.items[2].status='uncertain';const ids=b.items.map(i=>i.taskUUID),calls=[];
 await runImages(b,{...opts(),retryFailed:true,relay:async tasks=>{calls.push(tasks);return result(tasks);}});assert.equal(calls.filter(c=>c[0].taskType==='imageInference').flat().length,1);assert.equal(b.items[0].taskUUID,ids[0]);assert.notEqual(b.items[1].taskUUID,ids[1]);assert.deepEqual(b.items[1].history,[ids[1]]);assert.equal(b.items[2].taskUUID,ids[2]);
});
test('image-download failure keeps generation result and retry performs no generation or polling',async()=>{
 const b=batchOf(1);await runImages(b,{...opts(),relay:async tasks=>result(tasks),saveImage:async()=>{throw new Error('Offline');}});assert.equal(b.items[0].status,'download');const id=b.items[0].taskUUID;
 await runImages(b,{...opts(),relay:async()=>{throw new Error('Must not contact provider');}});assert.equal(b.items[0].taskUUID,id);assert.equal(b.items[0].status,'ready');
});
test('unknown request IDs are never treated as permission to create another paid image',()=>{
 const b=batchOf(1);b.items[0].taskUUID=crypto.randomUUID();acceptResults(b,b.items,{errors:[{taskUUID:b.items[0].taskUUID,code:'taskNotFound',message:'Unknown'}]});assert.equal(b.items[0].status,'uncertain');
 acceptResults(b,b.items,{errors:[{code:'invalidModel',message:'Invalid image model'}]});assert.equal(b.items[0].status,'failed');
});
test('ZIP contains all 100 numbered JPEGs with valid CRCs and central-directory entries',async()=>{
 const zip=await imageZip(Array.from({length:100},(_,i)=>({index:i+1,blob:jpg}))),bytes=Buffer.from(await zip.arrayBuffer()),end=bytes.length-22;assert.equal(bytes.readUInt32LE(end),0x06054b50);assert.equal(bytes.readUInt16LE(end+10),100);let at=bytes.readUInt32LE(end+16);
 for(let i=0;i<100;i++){assert.equal(bytes.readUInt32LE(at),0x02014b50);const len=bytes.readUInt16LE(at+28),name=bytes.subarray(at+46,at+46+len).toString(),offset=bytes.readUInt32LE(at+42),size=bytes.readUInt32LE(at+24),start=offset+30+len;assert.equal(name,`${i+1}.jpg`);assert.equal(crc32(bytes.subarray(start,start+size)),bytes.readUInt32LE(at+16));at+=46+len;}
 assert.equal(at,end);assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
 await assert.rejects(()=>imageZip([{index:1,blob:new Blob(['not JPEG'])}]),/not a JPEG/);
});
test('JPEG handling checks real format instead of renaming a PNG or a failed HTML download',async()=>{
 assert.equal((await jpegBlob(jpg)).type,'image/jpeg');await assert.rejects(()=>jpegBlob(new Blob(['<html>error</html>'])),/not a valid image/);
});
test('Runware image URLs cannot redirect credentials or act as an arbitrary-file proxy',()=>{
 for(const value of ['https://im.runware.ai.evil.test/image/a','https://user:secret@im.runware.ai/image/a','http://im.runware.ai/image/a','https://im.runware.ai:8443/image/a','https://im.runware.ai/other/a','https://im.runware.ai/image/a?api_key=secret','https://127.0.0.1/image/a'])assert.throws(()=>batchImageURL(value));assert.equal(batchImageURL('https://im.runware.ai/image/a.jpg'),'https://im.runware.ai/image/a.jpg');
});
test('image fallback checks team access and forwards no provider or team credential',async()=>{
 let calls=0;const handler=createBatchImageMedia({openStore:()=>({}),readSettings:async()=>({}),teamCodeOk:async req=>req.headers.get('x-team-code')==='team',dashboardView:()=>({cards:{batch:{enabled:true}}}),fail:(message,status)=>Response.json({errors:[{message}]},{status}),fetch:async(url,opts)=>{calls++;assert.equal(opts.redirect,'manual');assert.equal(opts.headers,undefined);return new Response(jpg,{headers:{'content-type':'image/jpeg','content-length':String(jpg.size)}});}});
 const request=code=>new Request('https://site.test/api/batch-image-media',{method:'POST',headers:{'x-team-code':code},body:JSON.stringify({url:'https://im.runware.ai/image/a.jpg'})});
 assert.equal((await handler(request('wrong'))).status,401);assert.equal(calls,0);const response=await handler(request('team'));assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');assert.equal((await response.blob()).size,jpg.size);assert.equal(calls,1);
});
test('Documentary Studio 04 and Image Generator 06 panels remain byte-for-byte identical',async()=>{
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 for(const [id,expected] of [['documentary','434ce8a79a7f2c75ae09a94783341e0cd87818df90d6794f1f92e49fd00c56d4'],['images','1a4fa8a1854efd7da8834b86c1fabdea9a0d7528318cfbb0feabbf2026cf7d92']]){
  const block=html.match(new RegExp('<article class="slide" data-id="'+id+'"[\\s\\S]*?</article>'))?.[0];assert(block);assert.equal(createHash('sha256').update(block).digest('hex'),expected);
 }
 assert(!html.includes('data-id="thumbnail"'));assert(!html.includes('data-id="cursor"'));assert(html.includes('href="/batch-images/"'));
});

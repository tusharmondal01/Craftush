import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {parseImages,imageSettings,imageTask} from '../public/batch-images/core.js';
import {chunk} from '../public/batch-images/runner.js';

test('compiled Worker relays 100 image tasks through the existing private Runware key and serves protected image downloads',{timeout:45000},async()=>{
 const calls=[],jpg=new Uint8Array([255,216,255,224,255,217]),providerKey='batch-fixture-secret-provider-key';
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:fileURLToPath(new URL('../dist-worker/worker.js',import.meta.url)),compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{CRAFTUSH_DATA:{className:'CraftushStorage',useSQLite:true}},bindings:{ADMIN_PASSWORD:'batch-fixture-admin',RUNWARE_API_KEY:providerKey,ALLOWED_ORIGINS:'https://tusharmondal01.github.io'},outboundService:async request=>{
  if(new URL(request.url).hostname==='im.runware.ai'){assert.equal(request.headers.get('x-team-code'),null);assert.equal(request.headers.get('authorization'),null);return new Response(jpg,{headers:{'content-length':String(jpg.length)}});}
  assert.equal(new URL(request.url).hostname,'api.runware.ai');const tasks=await request.json();assert.equal(tasks[0].apiKey,providerKey);calls.push(tasks.slice(1));return Response.json({data:tasks.slice(1).map(t=>({taskType:t.taskType,taskUUID:t.taskUUID,imageURL:'https://im.runware.ai/image/'+t.taskUUID+'.jpg',cost:.01}))});
 }}));
 const call=(path,body,headers={})=>runtime.dispatchFetch('https://site.test'+path,{method:body===undefined?'GET':'POST',headers:{origin:'https://tusharmondal01.github.io','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try{
  assert.equal((await call('/api/admin',{action:'saveCode',code:'batch-team'},{'x-admin-password':'batch-fixture-admin'})).status,200);
  const items=parseImages(Array.from({length:100},(_,i)=>({name:`Name ${i+1}`,prompt:`A precise photo for image ${i+1}.`})));items.forEach(i=>i.taskUUID=crypto.randomUUID());const tasks=items.map(i=>imageTask(i,imageSettings()));
  const denied=await call('/api/runware',tasks.slice(0,12));assert.equal(denied.status,401);assert.equal(calls.length,0);
  const responses=await Promise.all(chunk(tasks).map(c=>call('/api/runware',c,{'x-team-code':'batch-team'})));assert(responses.every(r=>r.status===200));for(const r of responses){const data=await r.json();assert(!JSON.stringify(data).includes(providerKey));assert.equal(data.errors,undefined);}
  assert.equal(calls.length,9);assert.equal(new Set(calls.flat().map(t=>t.taskUUID)).size,100);assert(calls.flat().every(t=>t.outputFormat==='JPG'&&t.deliveryMethod==='async'));
  const config=await (await call('/api/tools?view=dashboard')).json();assert.equal(config.cards.batch.title,'Batch Images');assert.equal(config.cards.documentary.title,'Documentary Studio');assert.equal(config.cards.images.title,'Image Generator');
  const response=await call('/api/batch-image-media',{url:'https://im.runware.ai/image/a.jpg'},{'x-team-code':'batch-team'});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');assert.equal((await response.arrayBuffer()).byteLength,jpg.length);
  assert.equal((await call('/api/batch-image-media',{url:'https://evil.test/image/a.jpg'},{'x-team-code':'batch-team'})).status,400);
 }finally{await runtime.dispose();}
});

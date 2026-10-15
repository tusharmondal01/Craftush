import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {ImageBatchQueue} from '../scripts/imagegen-batch.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUq7jEwMDAxAAGABBWAWw4iy1UAAAAAElFTkSuQmCC','base64');
const config={version:1,backendURL:'https://batch.craftush.test',apiPath:'/api/image-requests',runnerId:randomUUID(),runnerToken:'ir_'+'c'.repeat(64)};
async function fixture(t,count=10,options={}){
  const directory=await mkdtemp(join(tmpdir(),'craftush-batch-'));
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const requestId=randomUUID(),batchId=randomUUID(),referenceId=randomUUID();
  const jobs=Array.from({length:count},(_,i)=>({jobId:randomUUID(),requestId,itemId:String(i+1),title:'Episode '+(i+1),prompt:'Image content only',state:'claimed',filename:'episode-'+(i+1)+'.png',references:[{assetId:referenceId}]}));
  const calls=[],results=new Set();let started=false,uploadLost=false;
  const fetchImpl=async(url,init)=>{
    assert.equal(init.headers['X-Image-Runner'],config.runnerToken);assert.equal(new URL(url).origin,config.backendURL);
    const body=init.body?JSON.parse(init.body):null,action=body?.action||new URL(url).searchParams.get('action');calls.push({action,body});
    const brief=()=>({batchId:body?.batchId||batchId,requestId,requestStatus:results.size===count?'completed':'in_progress',itemCount:count,resultCount:results.size,jobs:jobs.map(j=>({...j,state:results.has(j.jobId)?'completed':started?'started':'claimed'})),canGenerate:false});
    if(action==='claimBatch')return Response.json(brief());
    if(action==='runnerAsset')return new Response(png);
    if(action==='startBatch'){
      if(started)return Response.json({...brief(),duplicate:true});
      started=true;if(options.lostStart)throw Error('lost start acknowledgement');
      return Response.json({...brief(),canGenerate:true,duplicate:false});
    }
    if(action==='complete'){
      const duplicate=results.has(body.jobId);results.add(body.jobId);
      if(options.lostUpload&&!uploadLost&&results.size===4){uploadLost=true;throw Error('lost upload acknowledgement');}
      return Response.json({job:{...jobs.find(j=>j.jobId===body.jobId),state:'completed'},request:{id:requestId,status:results.size===count?'completed':'in_progress',items:jobs,results:[...results].map(assetId=>({assetId}))},duplicate});
    }
    if(action==='report')return Response.json({job:{jobId:body.jobId,state:body.state}});
    assert.fail('Unexpected group operation '+action);
  };
  const make=()=>new ImageBatchQueue(config,directory,{fetchImpl,uploadPolicy:'after_group',resultDirectory:join(directory,'original-images')});
  return {directory,requestId,jobs,calls,results,make};
}
async function nativeManifest(f,prepared){
  const images=[];
  for(const job of prepared.jobs){const imagePath=join(f.directory,job.jobId+'-native.png');await writeFile(imagePath,png);images.push({jobId:job.jobId,imagePath});}
  return {batchId:prepared.batchId,images};
}
test('ten-image group prepares one shared reference and uploads nothing until every native result is staged',async t=>{
  const f=await fixture(t),q=f.make(),prepared=await q.prepare();
  assert.equal(prepared.state,'prepared');assert.equal(prepared.canGenerate,false);assert.equal(prepared.jobs.length,10);
  assert.equal(f.calls.filter(c=>c.action==='claimBatch').length,1);assert.equal(f.calls.filter(c=>c.action==='runnerAsset').length,1);
  const ack=await q.start(prepared.batchId);assert.equal(ack.canGenerate,true);assert.equal(ack.jobs.length,10);assert(ack.jobs.every(job=>job.state==='started'));
  assert.equal((await q.start(prepared.batchId)).canGenerate,false);
  const manifest=await nativeManifest(f,prepared);await q.stage(manifest);
  assert.equal(f.calls.filter(c=>c.action==='complete').length,0,'generation window contains no image uploads');
  const sent=await q.flush();assert.equal(sent.delivered,10);assert.equal(sent.requestStatus,'completed');
  assert.equal((await q.flush()).duplicate,true);assert.equal(f.calls.filter(c=>c.action==='complete').length,10);
  assert.equal(f.calls.filter(c=>c.action==='startBatch').length,1);
  for(const entry of (await q.state()).batch.jobs)assert.deepEqual(await readFile(entry.result.path),png);
  assert.equal((await q.prepare(f.requestId)).state,'completed','completed target never claims the next request');
});
test('a lost group-start acknowledgement cannot authorize a replacement attempt',async t=>{
  const f=await fixture(t,3,{lostStart:true}),q=f.make(),prepared=await q.prepare();
  await assert.rejects(q.start(prepared.batchId),/lost start/);
  assert.equal((await f.make().start(prepared.batchId)).canGenerate,false);
  assert.equal((await f.make().prepare(f.requestId)).state,'needs_attention');
  assert.equal(f.calls.filter(c=>c.action==='startBatch').length,1);
  assert.equal(f.calls.filter(c=>c.action==='claimBatch').length,1);
});
test('partial group upload retries only saved identical bytes without another native start',async t=>{
  const f=await fixture(t,10,{lostUpload:true}),q=f.make(),prepared=await q.prepare();
  await q.start(prepared.batchId);await q.stage(await nativeManifest(f,prepared));
  await assert.rejects(q.flush(),/lost upload/);
  const recovered=f.make();assert.equal((await recovered.prepare(f.requestId)).state,'saved_upload_pending');
  const sent=await recovered.flush();assert.equal(sent.delivered,10);assert.equal(f.results.size,10);
  const retried=f.calls.filter(c=>c.action==='complete'&&c.body.jobId===prepared.jobs[3].jobId);
  assert.equal(retried.length,2);assert.deepEqual(retried[0].body,retried[1].body);
  assert.equal(f.calls.filter(c=>c.action==='startBatch').length,1);
});
test('a wrong result set or changed saved result cannot replace a started group',async t=>{
  const f=await fixture(t,2),q=f.make(),prepared=await q.prepare();await q.start(prepared.batchId);
  const manifest=await nativeManifest(f,prepared);
  await assert.rejects(q.stage({...manifest,images:[manifest.images[0]]}),/every started/);
  await assert.rejects(q.stage({...manifest,images:[manifest.images[0],{...manifest.images[1],jobId:randomUUID()}]}),/every started/);
  await q.stage(manifest);const state=await q.state();await writeFile(state.batch.jobs[0].result.path,Buffer.concat([png,Buffer.from('changed')]));
  await assert.rejects(q.flush(),/saved group image changed/);assert.equal(f.calls.filter(c=>c.action==='complete').length,0);
});
test('a partial native group delivers the saved success and reports uncertainty without regenerating',async t=>{
  const f=await fixture(t,2),q=f.make(),prepared=await q.prepare();await q.start(prepared.batchId);
  const manifest=await nativeManifest(f,prepared);manifest.images[1]={jobId:prepared.jobs[1].jobId,state:'needs_attention'};
  await q.stage(manifest);const sent=await q.flush();assert.equal(sent.state,'needs_attention');assert.equal(sent.delivered,1);
  assert.equal(f.calls.filter(c=>c.action==='report').length,1);assert.equal((await q.prepare(f.requestId)).state,'needs_attention');
  assert.equal(f.calls.filter(c=>c.action==='startBatch').length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {ImageBatchQueue} from '../scripts/imagegen-batch.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUq7jEwMDAxAAGABBWAWw4iy1UAAAAAElFTkSuQmCC','base64');
async function fixture(t,{count=13,lostStage=false,lostUpload=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'craftush-request-spool-'));
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const requestId=randomUUID(),config={version:1,backendURL:'https://delivery.craftush.test',apiPath:'/api/image-requests',runnerId:randomUUID(),runnerToken:'ir_'+'c'.repeat(64)};
  const jobs=Array.from({length:count},(_,i)=>({jobId:randomUUID(),requestId,itemId:String(i+1),filename:'episode-'+(i+1)+'.png',title:'Episode '+(i+1),prompt:'Fixture art',references:[],state:'pending'}));
  const groups=new Map(),calls=[];let stageLost=false,uploadLost=false,cancelled=false,deliveryStarted=false;
  const progress=()=>({requestId,requestStatus:cancelled?'cancelled':jobs.every(job=>job.state==='completed')?'completed':'in_progress',itemCount:count,resultCount:jobs.filter(job=>job.state==='completed').length,stagedCount:jobs.filter(job=>job.state==='staged').length,readyToUpload:jobs.every(job=>['staged','completed'].includes(job.state)),jobs:jobs.map(job=>({jobId:job.jobId,itemId:job.itemId,state:job.state}))});
  const fetchImpl=async(url,init)=>{
    assert.equal(init.headers['X-Image-Runner'],config.runnerToken);
    const body=init.body?JSON.parse(init.body):null,action=body?.action||new URL(url).searchParams.get('action');calls.push({action,body});
    const fail=(code,status=409)=>Response.json({error:{code,message:code}},{status});
    const brief=ids=>({batchId:body.batchId,...progress(),jobs:ids.map(jobId=>({...jobs.find(job=>job.jobId===jobId)})),canGenerate:false});
    if(action==='claimBatch'){
      assert.equal(body.uploadPolicy,'after_request');
      if(body.requestId)assert.equal(body.requestId,requestId);
      if(cancelled)return Response.json({...progress(),jobs:[]});
      let ids=groups.get(body.batchId);if(!ids){ids=jobs.filter(job=>job.state==='pending').slice(0,10).map(job=>job.jobId);groups.set(body.batchId,ids);for(const id of ids)jobs.find(job=>job.jobId===id).state='claimed';}
      return Response.json(brief(ids));
    }
    if(action==='startBatch'){
      if(cancelled)return fail('REQUEST_CANCELLED');
      const ids=groups.get(body.batchId),duplicate=ids.some(id=>jobs.find(job=>job.jobId===id).state!=='claimed');
      if(!duplicate)for(const id of ids)jobs.find(job=>job.jobId===id).state='started';
      return Response.json({...brief(ids),duplicate,canGenerate:!duplicate});
    }
    if(action==='stageBatch'){
      assert.equal('base64' in body,false,'staging is metadata only');assert(body.images.every(image=>!('base64' in image)));
      if(cancelled)return fail('REQUEST_CANCELLED');
      const ids=groups.get(body.batchId);assert.deepEqual(new Set(body.images.map(image=>image.jobId)),new Set(ids));
      for(const id of ids)if(jobs.find(job=>job.jobId===id).state!=='completed')jobs.find(job=>job.jobId===id).state='staged';
      if(lostStage&&!stageLost){stageLost=true;throw Error('lost stage acknowledgement');}
      return Response.json({...brief(ids),staged:true,requestProgress:progress()});
    }
    if(action==='beginRequestUpload'){
      assert.equal(body.requestId,requestId);
      if(cancelled)return fail('REQUEST_CANCELLED');if(!progress().readyToUpload)return fail('REQUEST_NOT_READY');
      deliveryStarted=true;return Response.json(progress());
    }
    if(action==='complete'){
      assert(deliveryStarted,'no upload before final delivery');assert(progress().readyToUpload,'every request item must already be saved');
      const job=jobs.find(job=>job.jobId===body.jobId);job.state='completed';
      if(lostUpload&&!uploadLost&&progress().resultCount===4){uploadLost=true;throw Error('lost upload acknowledgement');}
      return Response.json({job:{...job},request:{id:requestId,status:progress().requestStatus,items:jobs,results:jobs.filter(job=>job.state==='completed').map(job=>({assetId:job.jobId}))}});
    }
    assert.fail('Unexpected operation '+action);
  };
  const make=()=>new ImageBatchQueue(config,directory,{fetchImpl,resultDirectory:join(directory,'originals')});
  return {directory,requestId,jobs,calls,make,cancel:()=>{cancelled=true;}};
}
async function saveGroup(f,q){
  const prepared=await q.prepare(f.requestId),ack=await q.start(prepared.batchId);assert.equal(ack.canGenerate,true);
  const images=[];for(const job of prepared.jobs){const imagePath=join(f.directory,job.jobId+'-native.png');await writeFile(imagePath,png);images.push({jobId:job.jobId,imagePath});}
  const result=await q.stage({batchId:prepared.batchId,images});return {prepared,result};
}
test('all thirteen images are saved across ten plus three before the single final delivery pass',async t=>{
  const f=await fixture(t),q=f.make();
  const first=await saveGroup(f,q);assert.equal(first.prepared.jobs.length,10);assert.equal(first.result.state,'stage_acknowledged');assert.equal(first.result.request.phase,'collecting');
  assert.equal(f.calls.filter(call=>call.action==='complete').length,0);assert.equal(f.calls.filter(call=>call.action==='beginRequestUpload').length,0);
  await assert.rejects(q.flushRequest(f.requestId),/every requested image/);await assert.rejects(q.flush(),/deferred delivery/);
  const second=await saveGroup(f,f.make());assert.equal(second.prepared.jobs.length,3);assert.equal(second.result.request.phase,'ready_to_upload');
  const status=await q.requestStatus();assert.equal(status.batches.length,2);assert.equal(status.request.stagedCount,13);
  assert.equal(f.calls.filter(call=>call.action==='complete').length,0);
  const sent=await q.flushRequest(f.requestId);assert.equal(sent.state,'completed');assert.equal(sent.resultCount,13);
  assert.equal(f.calls.filter(call=>call.action==='beginRequestUpload').length,1);assert.equal(f.calls.filter(call=>call.action==='complete').length,13);
  assert.equal((await q.flushRequest(f.requestId)).duplicate,true);assert.equal((await q.prepare(f.requestId)).state,'completed');
});
test('a lost staging acknowledgement retries only metadata and preserves the original native start',async t=>{
  const f=await fixture(t,{lostStage:true}),q=f.make();await assert.rejects(saveGroup(f,q),/lost stage acknowledgement/);
  assert.equal((await q.prepare(f.requestId)).nextAction,'defer-batch');
  const recovered=await f.make().defer();assert.equal(recovered.state,'stage_acknowledged');assert.equal(recovered.request.phase,'collecting');
  assert.equal(f.calls.filter(call=>call.action==='startBatch').length,1);assert.equal(f.calls.filter(call=>call.action==='stageBatch').length,2);assert.equal(f.calls.filter(call=>call.action==='complete').length,0);
});
test('interrupted final delivery resumes exact saved bytes without any native generation or new request',async t=>{
  const f=await fixture(t,{lostUpload:true}),q=f.make();await saveGroup(f,q);await saveGroup(f,q);
  await assert.rejects(q.flushRequest(f.requestId),/lost upload acknowledgement/);
  const recovered=f.make(),status=await recovered.requestStatus();assert.equal(status.state,'uploading');
  assert.equal(status.request.resultCount+status.request.stagedCount,13);
  assert.equal((await recovered.prepare(f.requestId)).nextAction,'flush-request');
  const sent=await recovered.flushRequest(f.requestId);assert.equal(sent.state,'completed');assert.equal(sent.resultCount,13);
  const fourth=f.jobs[3].jobId,retries=f.calls.filter(call=>call.action==='complete'&&call.body.jobId===fourth);assert.equal(retries.length,2);assert.deepEqual(retries[0].body,retries[1].body);
  assert.equal(f.calls.filter(call=>call.action==='claimBatch').length,2);assert.equal(f.calls.filter(call=>call.action==='startBatch').length,2);
});
test('cancelled requests preserve their originals and cannot begin final delivery',async t=>{
  const f=await fixture(t,{count:2}),q=f.make();await saveGroup(f,q);f.cancel();
  await assert.rejects(q.flushRequest(f.requestId),/REQUEST_CANCELLED/);assert.equal((await q.requestStatus()).state,'cancelled');assert.equal(f.calls.filter(call=>call.action==='complete').length,0);
  const state=await q.state();for(const job of state.batch.jobs)assert.deepEqual(await readFile(job.result.path),png);
});
test('a stop between generation groups preserves the spool and prevents another native group',async t=>{
  const f=await fixture(t),q=f.make();await saveGroup(f,q);f.cancel();
  assert.equal((await q.prepare(f.requestId)).state,'cancelled');assert.equal((await q.requestStatus()).state,'cancelled');
  assert.equal(f.calls.filter(call=>call.action==='startBatch').length,1);assert.equal(f.calls.filter(call=>call.action==='complete').length,0);
});
test('a changed original or a different request never passes final delivery preflight',async t=>{
  const f=await fixture(t,{count:2}),q=f.make();await saveGroup(f,q);
  await assert.rejects(q.flushRequest(randomUUID()),/exact pinned/);await assert.rejects(q.prepare(randomUUID()),/Another request/);
  const saved=(await q.state()).batch.jobs[0].result.path;await writeFile(saved,Buffer.concat([png,Buffer.from('changed')]));
  await assert.rejects(q.flushRequest(f.requestId),/saved group image changed/);assert.equal(f.calls.filter(call=>call.action==='beginRequestUpload').length,0);
});
test('a 132-image request stages thirteen groups of ten and a final pair before uploading any image',async t=>{
  const f=await fixture(t,{count:132}),q=f.make(),sizes=[];
  for(let offset=0;offset<132;offset+=10){const saved=await saveGroup(f,q);sizes.push(saved.prepared.jobs.length);assert.equal(f.calls.filter(call=>call.action==='complete').length,0);}
  assert.deepEqual(sizes,[10,10,10,10,10,10,10,10,10,10,10,10,10,2]);
  const ready=await q.requestStatus();assert.equal(ready.request.itemCount,132);assert.equal(ready.request.stagedCount,132);assert.equal(ready.state,'ready_to_upload');
  const delivered=await q.flushRequest(f.requestId);assert.equal(delivered.resultCount,132);assert.equal(delivered.state,'completed');
  assert.equal(f.calls.filter(call=>call.action==='beginRequestUpload').length,1);assert.equal(f.calls.filter(call=>call.action==='claimBatch').length,14);assert.equal(f.calls.filter(call=>call.action==='startBatch').length,14);
});
test('a legacy partly delivered group can defer its remaining originals without regenerating or uploading',async t=>{
  const f=await fixture(t),q=f.make(),first=await saveGroup(f,q),state=await q.state();
  // A prior-version interruption left two delivered jobs plus eight originals.
  state.batch.phase='uploading';delete state.batch.uploadPolicy;state.batch.resultCount=2;
  for(const job of state.batch.jobs.slice(0,2)){job.phase='completed';f.jobs.find(remote=>remote.jobId===job.jobId).state='completed';}
  await q.save(state);await rm(q.requestPath);
  const recovered=await f.make().defer();assert.equal(recovered.state,'stage_acknowledged');assert.equal(recovered.request.resultCount,2);assert.equal(recovered.request.stagedCount,8);assert.equal(recovered.request.phase,'collecting');
  assert.equal(f.calls.filter(call=>call.action==='complete').length,0);assert.equal(f.calls.filter(call=>call.action==='startBatch').length,1);
  const next=await f.make().prepare(f.requestId);assert.equal(next.jobs.length,3);assert.equal(next.requestId,f.requestId);assert.notEqual(next.batchId,first.prepared.batchId);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageBatchQueue} from '../scripts/imagegen-batch.mjs';
import {localName,saveLocalFolder} from '../scripts/imagegen-local-folder.mjs';
import {atomicJSON} from '../scripts/imagegen-queue.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUq7jEwMDAxAAGABBWAWw4iy1UAAAAAElFTkSuQmCC','base64');
const fingerprint=createHash('sha256').update(png).digest('hex');
async function fixture(t,{count=132,uploaded=0,lostFinish=false,legacyRemotePolicy=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'craftush-local-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const requestId=randomUUID(),config={version:1,backendURL:'https://local.craftush.test',apiPath:'/api/image-requests',runnerId:randomUUID(),runnerToken:'ir_'+'b'.repeat(64)};
  const jobs=Array.from({length:count},(_,i)=>({jobId:randomUUID(),requestId,itemId:String(i+1),title:`Track ${i+1}`,filename:`track-${i+1}.png`,state:i<uploaded?'completed':'pending',references:[]}));
  const batches=new Map(),calls=[];let localDelivery=null,lost=false;
  const progress=()=>({requestId,title:'Stock market',uploadPolicy:legacyRemotePolicy&&!localDelivery?'after_request':'local_folder',requestStatus:localDelivery?'completed':'in_progress',itemCount:count,resultCount:localDelivery?count:uploaded,uploadedCount:uploaded,stagedCount:jobs.filter(job=>job.state==='staged').length,readyToFinishLocal:jobs.every(job=>['staged','completed'].includes(job.state)),items:jobs.map(job=>({id:job.itemId,title:job.title,filename:job.filename,jobId:job.jobId,state:job.state})),jobs:jobs.map(job=>({jobId:job.jobId,itemId:job.itemId,state:job.state})),localDelivery});
  const fetchImpl=async(url,init)=>{
    const body=init.body?JSON.parse(init.body):null,action=body?.action||new URL(url).searchParams.get('action');calls.push({action,body});
    assert(!init.body?.includes('base64'),'no image-byte network body');
    if(action==='runnerRequest')return Response.json(progress());
    if(action==='claimBatch'){
      assert.equal(body.uploadPolicy,'local_folder');assert.equal(body.generationConcurrency,1);
      const group=jobs.filter(job=>job.state==='pending').slice(0,10);group.forEach(job=>job.state='claimed');batches.set(body.batchId,group);
      return Response.json({batchId:body.batchId,...progress(),jobs:group});
    }
    if(action==='startBatch'){
      const group=batches.get(body.batchId);group.forEach(job=>job.state='started');
      return Response.json({batchId:body.batchId,...progress(),jobs:group,canGenerate:true,duplicate:false});
    }
    if(action==='stageBatch'){
      const group=batches.get(body.batchId);group.forEach(job=>{if(job.state!=='completed')job.state='staged';});
      return Response.json({batchId:body.batchId,...progress(),jobs:group,staged:true,requestProgress:progress()});
    }
    if(action==='finishLocalRequest'){
      assert.equal(body.files.length,count);assert(body.files.every(file=>!('source' in file)&&!('path' in file)&&file.fingerprint===fingerprint));
      const duplicate=!!localDelivery;localDelivery={folderName:body.folderName,itemCount:count,manifestFingerprint:'a'.repeat(64),completedAt:new Date().toISOString()};
      if(lostFinish&&!lost){lost=true;throw Error('lost metadata acknowledgement');}
      return Response.json({...progress(),duplicate});
    }
    assert.fail('An image upload or unexpected action was attempted: '+action);
  };
  const make=()=>new ImageBatchQueue(config,dir,{fetchImpl,uploadPolicy:'local_folder',resultDirectory:join(dir,'originals')});
  return {dir,requestId,jobs,calls,make,batches};
}
async function group(f,q){const prepared=await q.prepare(f.requestId);await q.start(prepared.batchId);const images=[];for(const job of prepared.jobs){const path=join(f.dir,job.jobId+'-native.png');await writeFile(path,png);images.push({jobId:job.jobId,imagePath:path});}return q.stage({batchId:prepared.batchId,images});}
test('132 originals become one exact-title folder with metadata only and no uploads',async t=>{
  const f=await fixture(t),q=f.make();for(let offset=0;offset<132;offset+=10)await group(f,q);
  assert.equal((await q.requestStatus()).state,'ready_to_finalize');
  await assert.rejects(q.flushRequest(f.requestId),/never upload/);await assert.rejects(q.flush(),/never upload/);
  const done=await q.finalizeFolder(f.requestId,join(f.dir,'output'));assert.equal(done.localCount,132);assert.equal(done.folderPath,join(await realpath(join(f.dir,'output')),'Stock market'));
  const names=await readdir(done.folderPath);assert.equal(names.filter(name=>name.endsWith('.png')).length,132);assert(names.includes('Track 132.png'));assert(!names.includes('132-Track 132.png'));
  assert.deepEqual(await readFile(join(done.folderPath,'Track 1.png')),png);assert.equal(f.calls.filter(call=>call.action==='finishLocalRequest').length,1);
  assert.equal(f.calls.filter(call=>['complete','beginRequestUpload'].includes(call.action)).length,0);
});
test('legacy 34 uploaded plus 98 saved originals are adopted once without regeneration or upload',async t=>{
  const f=await fixture(t,{uploaded:34,legacyRemotePolicy:true}),q=f.make();await mkdir(q.results,{recursive:true});let current;
  for(let offset=0;offset<132;offset+=10){
    const batch={batchId:randomUUID(),requestId:f.requestId,uploadPolicy:'after_request',phase:offset<30?'completed':'stage_acknowledged',itemCount:132,resultCount:34,jobs:[]};
    for(const job of f.jobs.slice(offset,offset+10)){const path=join(q.results,job.jobId+'.png');await writeFile(path,png);if(job.state!=='completed')job.state='staged';batch.jobs.push({...job,phase:job.state==='completed'?'completed':'result_saved',attemptAt:123,result:{path,fingerprint,mime:'image/png',bytes:png.length,name:job.filename}});}
    f.batches.set(batch.batchId,f.jobs.slice(offset,offset+10));await atomicJSON(join(q.history,batch.batchId+'.json'),batch);current=batch;
  }
  await q.save({version:1,batch:current});await atomicJSON(q.requestPath,{version:1,request:{requestId:f.requestId,uploadPolicy:'after_request',phase:'uploading',itemCount:132,resultCount:34,stagedCount:98,batchIds:[...f.batches.keys()].slice(3)}});
  const adopted=await q.adoptLocalRequest(f.requestId);assert.equal(adopted.state,'ready_to_finalize');assert.equal(adopted.request.localCount,132);assert.equal(adopted.request.stagedCount,98);
  const done=await q.finalizeFolder(f.requestId,join(f.dir,'output'));assert.equal(done.localCount,132);assert.equal(f.calls.filter(call=>['claimBatch','startBatch','complete','beginRequestUpload'].includes(call.action)).length,0);
  assert.equal((await q.requestBatches((await q.requestState()).request))[0].jobs[0].attemptAt,123);
});
test('lost completion metadata resumes identical folder bytes without new calls or generation',async t=>{
  const f=await fixture(t,{count:2,lostFinish:true}),q=f.make();await group(f,q);
  await assert.rejects(q.finalizeFolder(f.requestId,join(f.dir,'output')),/lost metadata/);
  const recovered=await f.make().finalizeFolder(f.requestId,join(f.dir,'output'));assert.equal(recovered.duplicate,true);
  const attempts=f.calls.filter(call=>call.action==='finishLocalRequest');assert.deepEqual(attempts[0].body,attempts[1].body);assert.equal(f.calls.filter(call=>call.action==='startBatch').length,1);
});
test('Windows invalid characters are mapped explicitly; reserved and traversal names stay inside the folder',()=>{
  assert.equal(localName('NUL'),'_NUL');assert.equal(localName('COM¹'),'_COM¹');assert.equal(localName('../a:b?'),'.._a_b_');assert.equal(localName('..finance'),'..finance');assert.equal(localName('Revenue growth'),'Revenue growth');assert.equal(localName('Title. '),'Title__');assert.throws(()=>localName('a'.repeat(201)),/too long/);
});
test('duplicate and sanitized-colliding track names fail before any image is copied',async t=>{
  const f=await fixture(t,{count:2}),q=f.make();await group(f,q);f.jobs[0].title='same/name';f.jobs[1].title='same:name';
  await assert.rejects(q.finalizeFolder(f.requestId,join(f.dir,'output')),/collide/);assert.equal(f.calls.filter(call=>call.action==='finishLocalRequest').length,0);
});
test('changed originals and an occupied exact folder never overwrite files or mark delivery',async t=>{
  const f=await fixture(t,{count:1}),q=f.make();await group(f,q);const root=join(f.dir,'output');await mkdir(join(root,'Stock market'),{recursive:true});await writeFile(join(root,'Stock market','Track 1.png'),'other');
  await assert.rejects(q.finalizeFolder(f.requestId,root),/other files/);assert.equal(await readFile(join(root,'Stock market','Track 1.png'),'utf8'),'other');
  const saved=(await q.state()).batch.jobs[0].result.path;await writeFile(saved,Buffer.concat([png,Buffer.from('changed')]));await assert.rejects(q.finalizeFolder(f.requestId,root),/original changed/);assert.equal(f.calls.filter(call=>call.action==='finishLocalRequest').length,0);
});

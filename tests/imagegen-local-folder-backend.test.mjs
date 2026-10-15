import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { CraftushStorage, cloudflareStore } from '../cloudflare/storage.js';
import { createImageRequestsHandler } from '../cloudflare/image-requests.js';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUq7jEwMDAxAAGABBWAWw4iy1UAAAAAElFTkSuQmCC';
const OWNER={'x-admin-password':'fixture-owner'},TEAM={'x-team-code':'fixture-team'},image={name:'original.png',mime:'image/png',base64:PNG};
const receipt={name:image.name,mime:image.mime,bytes:Buffer.from(PNG,'base64').length,fingerprint:createHash('sha256').update(Buffer.from(PNG,'base64')).digest('hex')};
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const state={storage:{sql:{exec(query,...args){const statement=db.prepare(query),rows=query.startsWith('SELECT')?statement.all(...args):(statement.run(...args),[]);return{toArray:()=>rows};}},transactionSync(callback){db.exec('BEGIN');try{const value=callback();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}}};
 const object=new CraftushStorage(state),store=cloudflareStore({idFromName:value=>value,get:()=>object});
 const handler=createImageRequestsHandler({openStore:()=>store,readSettings:async()=>({teamCode:TEAM['x-team-code']}),env:key=>key==='ADMIN_PASSWORD'?OWNER['x-admin-password']:'',safeEqual:(a,b)=>a===b,json:(data,status=200)=>Response.json(data,{status}),now:()=> '2026-10-15T17:00:00.000Z'});
 const call=(body,headers=OWNER,query='')=>handler(new Request('https://fixture/api/image-requests'+query,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const value=async(body,headers=OWNER,query='',status=200)=>{const response=await call(body,headers,query);assert.equal(response.status,status,await response.clone().text());return response.json();};
 const brief=(count=2)=>({action:'create',submissionId:crypto.randomUUID(),title:'Share market',name:'Editor',width:1080,height:864,items:Array.from({length:count},(_,i)=>({title:'Exact track '+(i+1),prompt:'Sensitive fixture prompt',filename:'episode.png'}))});
 const create=async(count=2)=>(await value(brief(count),OWNER,'',201)).request;
 const pair=async()=>({'x-image-runner':(await value({action:'pair'})).runnerToken});
 const group=async(requestId,runner)=>{const result=await value({action:'claimBatch',batchId:crypto.randomUUID(),requestId},runner);await value({action:'startBatch',batchId:result.batchId},runner);return result;};
 const stage=async(batch,runner)=>value({action:'stageBatch',batchId:batch.batchId,images:batch.jobs.map(job=>({jobId:job.jobId,...receipt}))},runner);
 const files=jobs=>jobs.map(job=>({jobId:job.jobId,itemId:job.itemId,...receipt,name:job.title+'.png'}));
 return{db,call,value,brief,create,pair,group,stage,files};
}
test('team acknowledgement, duplicates, Stop and signed-in access never disclose owner history',async t=>{
 const f=fixture(t),body=f.brief(1),accepted=await f.value(body,TEAM,'',201);assert.deepEqual(accepted,{acknowledgement:{id:body.submissionId,accepted:true},duplicate:false});
 await f.value({action:'deliver',id:body.submissionId,notes:'Private owner note',images:[{...image,assetId:crypto.randomUUID(),itemId:'1'}]});
 const duplicate=await f.value(body,TEAM,'',201);assert.equal(duplicate.request,undefined);assert.equal(duplicate.duplicate,true);
 assert.deepEqual(await f.value({action:'cancel',id:body.submissionId},TEAM),{acknowledgement:{id:body.submissionId,stopped:true}});
 const archive=(await f.value(undefined,OWNER,'?action=detail&id='+body.submissionId)).request;assert.equal(archive.notes,'Private owner note');assert.equal(archive.results.length,1);
 assert.deepEqual(await f.value(undefined,TEAM,'?action=list'),{requests:[],total:0,limit:50,offset:0,historyRestricted:true});
 for(const query of ['?action=detail&id='+archive.id,'?action=asset&id='+archive.id+'&assetId='+archive.results[0].assetId])assert.equal((await f.call(undefined,TEAM,query)).status,403);
 const asset=await f.call(undefined,OWNER,'?action=asset&id='+archive.id+'&assetId='+archive.results[0].assetId);assert.equal(Buffer.from(await asset.arrayBuffer()).toString('base64'),PNG);
 assert.equal((await f.value(undefined,OWNER,'?action=list')).total,1);assert.equal((await f.call(undefined,{},'?action=access')).status,401);assert.equal((await f.value(undefined,TEAM,'?action=access')).role,'team');
});
test('full local folder completion is metadata only, exact, idempotent and retains the owner archive',async t=>{
 const f=fixture(t),request=await f.create(13),runner=await f.pair(),first=await f.group(request.id,runner);assert.equal(first.generationConcurrency,1);assert.equal(first.uploadPolicy,'local_folder');await f.stage(first,runner);
 const partial=await f.value(undefined,runner,'?action=runnerRequest&requestId='+request.id);assert.equal(partial.title,'Share market');assert.equal(partial.items[0].title,'Exact track 1');assert.equal(partial.readyToFinishLocal,false);
 const payload={action:'finishLocalRequest',requestId:request.id,folderName:'Share market',files:f.files(first.jobs)};assert.equal((await f.call(payload,runner)).status,409);
 const last=await f.group(request.id,runner);await f.stage(last,runner);payload.files=f.files([...first.jobs,...last.jobs]);const ready=await f.value(undefined,runner,'?action=runnerRequest&requestId='+request.id);assert.equal(ready.readyToFinishLocal,true);assert.equal(ready.readyToUpload,false);assert.equal(ready.deliveryPhase,'ready_to_finish');
 const done=await f.value(payload,runner);assert.equal(done.requestStatus,'completed');assert.equal(done.resultCount,13);assert.equal(done.uploadedCount,0);assert.equal(done.localDelivery.itemCount,13);assert.equal(done.duplicate,false);
 assert.equal((await f.value({...payload,files:[...payload.files].reverse()},runner)).duplicate,true);
 for(const table of ['image_request_assets','image_request_asset_chunks'])assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM '+table).get().total,0);
 assert.equal((await f.value(undefined,OWNER,'?action=list')).requests[0].localResultCount,13);await f.value({action:'status',id:request.id,notes:'Owner folder retained'});
 assert.equal((await f.call({...payload,folderName:'Different'},runner)).status,409);assert.equal((await f.call({...payload,files:payload.files.map((file,i)=>i?file:{...file,fingerprint:'a'.repeat(64)})},runner)).status,409);
});
test('legacy uploaded and staged originals migrate once without byte writes or attempt resets',async t=>{
 const f=fixture(t),request=await f.create(3),runner=await f.pair(),batch=await f.group(request.id,runner);await f.stage(batch,runner);await f.value({action:'deliver',id:request.id,images:[{...image,assetId:batch.jobs[0].jobId,itemId:'1'}]});
 const legacy=JSON.parse(f.db.prepare('SELECT document FROM image_request_records WHERE id = ?').get(request.id).document);delete legacy.uploadPolicy;f.db.prepare('UPDATE image_request_records SET document = ? WHERE id = ?').run(JSON.stringify(legacy),request.id);f.db.prepare("UPDATE image_request_deliveries SET phase = 'uploading' WHERE request_id = ?").run(request.id);
 const before=f.db.prepare('SELECT COUNT(*) AS total FROM image_request_asset_chunks').get().total;const done=await f.value({action:'finishLocalRequest',requestId:request.id,folderName:'Share market',files:f.files(batch.jobs)},runner);assert.equal(done.resultCount,3);assert.equal(done.uploadedCount,1);assert.equal(done.uploadPolicy,'local_folder');assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM image_request_asset_chunks').get().total,before);
 const detail=(await f.value(undefined,OWNER,'?action=detail&id='+request.id)).request;assert.equal(detail.results.length,1);assert(detail.items.every(item=>item.generation.state==='completed'&&item.generation.startedAt));
});
test('uncertainty, partial coverage, cancellation and foreign runner block completion; image upload is disabled',async t=>{
 const f=fixture(t),request=await f.create(),runner=await f.pair(),batch=await f.group(request.id,runner),payload={action:'finishLocalRequest',requestId:request.id,folderName:'Share market',files:f.files(batch.jobs)};assert.equal((await f.call(payload,runner)).status,409);await f.stage(batch,runner);assert.equal((await f.call({...payload,files:payload.files.slice(0,1)},runner)).status,409);
 for(const body of [{action:'complete',jobId:batch.jobs[0].jobId,image},{action:'beginRequestUpload',requestId:request.id}]){const response=await f.call(body,runner);assert.equal(response.status,409);assert.equal((await response.json()).errors[0].code,'LOCAL_FOLDER_ONLY');}
 await f.value({action:'cancel',id:request.id},TEAM);assert.equal((await f.call(payload,runner)).status,409);const replacement=await f.pair();assert.equal((await f.call(payload,replacement)).status,403);assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM image_request_asset_chunks').get().total,0);
 const meta=await f.value(undefined,{},'?action=meta');assert.equal(meta.uploadPolicy,'local_folder');assert.equal(meta.generationConcurrency,1);assert.equal(meta.generationBatchSize,10);
});
test('local completion preserves long Unicode track filenames and rejects filesystem or collision names',async t=>{
 const f=fixture(t),request=await f.create(2),runner=await f.pair(),batch=await f.group(request.id,runner);await f.stage(batch,runner);
 const files=f.files(batch.jobs);files[0].name='शेयर मार्केट '+ 'A'.repeat(180)+'.png';
 const payload={action:'finishLocalRequest',requestId:request.id,folderName:'Share market',files};
 for(const bad of ['../outside.png','CON.png','trailing.png.'])assert.equal((await f.call({...payload,files:[{...files[0],name:bad},files[1]]},runner)).status,400);
 assert.equal((await f.call({...payload,files:[{...files[0],name:'SAME.png'},{...files[1],name:'same.PNG'}]},runner)).status,400);
 const done=await f.value(payload,runner),canonical=files.map(({jobId,itemId,name,fingerprint,mime,bytes})=>({jobId,itemId,name,fingerprint,mime,bytes}));
 assert.equal(done.localDelivery.manifestFingerprint,createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
});

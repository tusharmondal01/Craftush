import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const image={name:'episode.png',mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOUq7jEwMDAxAAGABBWAWw4iy1UAAAAAElFTkSuQmCC'};
test('compiled SQLite queue reserves ten at once, authorizes a group exactly once and preserves request boundaries',{timeout:45000},async t=>{
  const origin='https://tusharmondal01.github.io',owner={'x-admin-password':'fixture-batch-owner'},team={'x-team-code':'fixture-batch-team'};
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:fileURLToPath(new URL('../dist-worker/worker.js',import.meta.url)),compatibilityDate:'2026-10-09',compatibilityFlags:['nodejs_compat'],durableObjects:{CRAFTUSH_DATA:{className:'CraftushStorage',useSQLite:true}},bindings:{ADMIN_PASSWORD:owner['x-admin-password'],ALLOWED_ORIGINS:origin,PUBLIC_SITE_URL:origin+'/Craftush',RATE_LIMIT_REQUESTS_MINUTE:'10000'},outboundService:()=>{throw Error('No provider calls permitted');}}));
  const call=(body,headers={},query='')=>runtime.dispatchFetch('https://fixture/api/image-requests'+query,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=async(body,headers,query='',status=200)=>{const response=await call(body,headers,query);assert.equal(response.status,status,await response.clone().text());return response.json();};
  const create=async(count,title)=> (await value({action:'create',submissionId:crypto.randomUUID(),name:'Fixture team',title,width:1080,height:864,styleNotes:'brown',items:Array.from({length:count},(_,i)=>({title:'Episode '+(i+1),prompt:'Native image content',filename:'episode-'+(i+1)+'.png'}))},team,'',201)).request;
  try{
    const setup=await runtime.dispatchFetch('https://fixture/api/admin',{method:'POST',headers:{origin,'content-type':'application/json',...owner},body:JSON.stringify({action:'saveCode',code:team['x-team-code']})});assert.equal(setup.status,200);
    const paired=await value({action:'pair',name:'Fixture'},owner),runner={'x-image-runner':paired.runnerToken};
    const first=await create(13,'Thirteen episodes'),other=await create(1,'Unrelated request'),batchId=crypto.randomUUID();
    let group;
    await t.test('batch claims are bounded, scoped and idempotent',async()=>{
      group=await value({action:'claimBatch',batchId},runner);assert.equal(group.jobs.length,10);assert.equal(group.requestId,first.id);assert.equal(group.canGenerate,false);
      assert.deepEqual(group.jobs.map(j=>j.itemId),Array.from({length:10},(_,i)=>String(i+1)));
      const repeated=await value({action:'claimBatch',batchId},runner);assert.equal(repeated.duplicate,true);assert.deepEqual(repeated.jobs.map(j=>j.jobId),group.jobs.map(j=>j.jobId));
      assert.equal((await call({action:'claimBatch',batchId:crypto.randomUUID()},runner)).status,409);
      assert.equal((await call(undefined,runner,'?action=runnerBatch&batchId='+crypto.randomUUID())).status,403);
      assert.equal((await call({action:'claimBatch',batchId},team)).status,401);
      const metadata=await value(undefined,{},'?action=meta');assert.equal(metadata.generationBatchSize,10);assert(!JSON.stringify(metadata).includes(paired.runnerToken));
    });
    await t.test('one fresh group-start authorizes all ten while duplicate starts authorize none',async()=>{
      const started=await value({action:'startBatch',batchId},runner);assert.equal(started.canGenerate,true);assert(started.jobs.every(j=>j.state==='started'));
      const duplicate=await value({action:'startBatch',batchId},runner);assert.equal(duplicate.canGenerate,false);assert.equal(duplicate.duplicate,true);
      const detail=(await value(undefined,team,'?action=detail&id='+first.id)).request;assert.equal(detail.results.length,0,'no upload is needed between native generations');
    });
    const stage=async current=>value({action:'stageBatch',batchId:current.batchId,images:current.jobs.map(job=>({jobId:job.jobId,name:image.name,mime:image.mime,bytes:Buffer.from(image.base64,'base64').length,fingerprint:createHash('sha256').update(Buffer.from(image.base64,'base64')).digest('hex')}))},runner);
    await t.test('the first ten originals are acknowledged without uploading before the entire request is saved',async()=>{
      assert.equal((await call({action:'complete',jobId:group.jobs[0].jobId,image},runner)).status,409);
      const staged=await stage(group);assert.equal(staged.requestProgress.stagedCount,10);assert.equal(staged.resultCount,0);
      assert.equal((await call({action:'beginRequestUpload',requestId:first.id},runner)).status,409);
    });
    await t.test('the final short group never takes an item from another request',async()=>{
      const id=crypto.randomUUID(),last=await value({action:'claimBatch',batchId:id,requestId:first.id},runner);assert.equal(last.jobs.length,3);assert(last.jobs.every(j=>j.requestId===first.id));
      assert.equal((await value({action:'startBatch',batchId:id},runner)).canGenerate,true);
      await stage(last);await value({action:'beginRequestUpload',requestId:first.id},runner);
      let result;for(const job of [...group.jobs,...last.jobs])result=await value({action:'complete',jobId:job.jobId,image},runner);
      assert.equal(result.request.status,'completed');assert.equal(result.request.results.length,13);
      const none=await value({action:'claimBatch',batchId:crypto.randomUUID(),requestId:first.id},runner);assert.deepEqual(none.jobs,[]);
      const untouched=(await value(undefined,team,'?action=detail&id='+other.id)).request;assert.equal(untouched.items[0].generation.state,'pending');
    });
    await t.test('cancellation and pairing rotation do not allow stale group starts',async()=>{
      const id=crypto.randomUUID();await value({action:'claimBatch',batchId:id},runner);
      await value({action:'status',id:other.id,status:'cancelled'},owner);
      assert.equal((await call({action:'startBatch',batchId:id},runner)).status,409);
      const replacement=await value({action:'pair',name:'Replacement'},owner);
      assert.equal((await call({action:'startBatch',batchId:id},runner)).status,401);
      assert.equal((await call(undefined,{'x-image-runner':replacement.runnerToken},'?action=runnerBatch&batchId='+id)).status,403);
    });
  }finally{await runtime.dispose();}
});

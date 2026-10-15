// Queue transport and durable original-byte staging only. No image generator.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {ImageQueue,atomicJSON,imageType} from './imagegen-queue.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprint=bytes=>createHash('sha256').update(bytes).digest('hex');
export class ImageBatchQueue {
  constructor(config,directory,{resultDirectory=join(directory,'batch-results'),uploadPolicy='after_request',...options}={}) {
    this.queue=new ImageQueue(config,directory,options);
    this.path=join(resolve(directory),'batch-state.json');
    this.history=join(resolve(directory),'batch-history');
    this.requestPath=join(resolve(directory),'request-state.json');
    this.results=resolve(resultDirectory);
    if(!['after_request','after_group'].includes(uploadPolicy))throw Error('Invalid image delivery policy');
    this.uploadPolicy=uploadPolicy;
  }
  async state(){try{return JSON.parse(await readFile(this.path,'utf8'));}catch(error){if(error.code==='ENOENT')return {version:1,batch:null};throw error;}}
  async save(state){await atomicJSON(this.path,state);}
  async requestState(){try{return JSON.parse(await readFile(this.requestPath,'utf8'));}catch(error){if(error.code==='ENOENT')return {version:1,request:null};throw error;}}
  async requestBatches(request){
    if(!request||!uuid.test(request.requestId)||!Array.isArray(request.batchIds)||new Set(request.batchIds).size!==request.batchIds.length||request.batchIds.some(id=>!uuid.test(id)))throw Error('Invalid saved request spool');
    const current=(await this.state()).batch,batches=[];
    for(const batchId of request.batchIds){const batch=current?.batchId===batchId?current:JSON.parse(await readFile(join(this.history,batchId+'.json'),'utf8'));this.validate(batch,request.requestId,batchId);batches.push(batch);}
    if(new Set(batches.flatMap(batch=>batch.jobs.map(job=>job.jobId))).size!==batches.reduce((count,batch)=>count+batch.jobs.length,0))throw Error('A request spool repeats a native job');
    return batches;
  }
  async updateRequest(batch,progress={}){
    const state=await this.requestState();let request=state.request;
    if(request&&request.requestId!==batch.requestId&&!['completed','cancelled'].includes(request.phase))throw Error('Another request already has saved native images');
    if(!request||request.requestId!==batch.requestId)request=state.request={requestId:batch.requestId,uploadPolicy:'after_request',phase:'collecting',itemCount:batch.itemCount,resultCount:batch.resultCount||0,stagedCount:0,batchIds:[]};
    if(!request.batchIds.includes(batch.batchId))request.batchIds.push(batch.batchId);
    if(Number.isSafeInteger(progress.itemCount||batch.itemCount))request.itemCount=progress.itemCount||batch.itemCount;
    request.resultCount=Math.max(request.resultCount||0,progress.resultCount||batch.resultCount||0);
    const batches=await this.requestBatches(request),jobs=batches.flatMap(group=>group.jobs);
    request.stagedCount=jobs.filter(job=>job.result&&job.phase!=='completed').length;
    if(progress.requestStatus==='cancelled')request.phase='cancelled';
    else if(jobs.some(job=>['failed','needs_attention'].includes(job.phase))||batches.some(group=>group.phase==='needs_attention'))request.phase='needs_attention';
    else if(request.resultCount===request.itemCount&&jobs.every(job=>job.phase==='completed'))request.phase='completed';
    else if(request.phase!=='uploading')request.phase=request.resultCount+request.stagedCount===request.itemCount&&batches.every(group=>['stage_acknowledged','completed'].includes(group.phase))?'ready_to_upload':'collecting';
    request.updatedAt=new Date().toISOString();await atomicJSON(this.requestPath,state);return request;
  }
  async requestStatus(){const state=await this.requestState();return {state:state.request?.phase||'missing',request:state.request,batches:state.request?await this.requestBatches(state.request):[],canGenerate:false};}
  validate(group,requestId,batchId){
    if(group.batchId!==batchId||!uuid.test(group.requestId)||(requestId&&requestId!==group.requestId)||!Array.isArray(group.jobs)||group.jobs.length<1||group.jobs.length>10||new Set(group.jobs.map(j=>j.jobId)).size!==group.jobs.length||group.jobs.some(j=>!uuid.test(j.jobId)||j.requestId!==group.requestId))throw Error('Invalid or out-of-request image group');
  }
  async prepare(requestId){
    if(requestId&&!uuid.test(requestId))throw Error('Invalid target request ID');
    const spool=(await this.requestState()).request;
    if(spool&&!['completed','cancelled'].includes(spool.phase)){
      if(requestId&&requestId!==spool.requestId)throw Error('Another request already has saved native images');
      requestId=spool.requestId;
      if(['ready_to_upload','uploading'].includes(spool.phase))return {state:'saved_upload_pending',requestId,request:spool,canGenerate:false,nextAction:'flush-request'};
      if(spool.phase==='needs_attention')return {state:'needs_attention',requestId,canGenerate:false};
    }else if(spool&&requestId===spool.requestId)return {state:spool.phase,requestId,canGenerate:false};
    const legacy=await this.queue.state();
    if(legacy.active){
      if(legacy.active.phase!=='completed')return {state:'needs_attention',canGenerate:false,message:'Resolve the existing single-image receipt before a new group.'};
      const cleaned=await this.queue.next();
      if(cleaned.state!=='completed')return {...cleaned,canGenerate:false};
    }
    const state=await this.state();let batch=state.batch;
    if(batch&&batch.phase!=='completed'&&requestId&&batch.requestId&&batch.requestId!==requestId)throw Error('Another request already has an unfinished group');
    if(batch?.phase==='completed'||batch?.phase==='stage_acknowledged'){
      if(requestId&&batch.requestId===requestId&&batch.requestStatus==='completed')return {state:'completed',requestId,requestStatus:'completed',canGenerate:false};
      await atomicJSON(join(this.history,batch.batchId+'.json'),batch);state.batch=null;batch=null;
    }
    if(batch&&['start_requested','generating','needs_attention'].includes(batch.phase))return {state:'needs_attention',batchId:batch.batchId,requestId:batch.requestId,canGenerate:false,message:'A previous native group attempt exists. Never generate it again.'};
    if(batch?.phase==='staged'||batch?.phase==='uploading')return {state:'saved_upload_pending',batchId:batch.batchId,requestId:batch.requestId,canGenerate:false,nextAction:batch.uploadPolicy==='after_request'?'defer-batch':'flush-batch'};
    if(!batch){batch={batchId:randomUUID(),requestId:requestId||null,phase:'claim_requested',uploadPolicy:this.uploadPolicy,jobs:[]};state.batch=batch;await this.save(state);}
    const result=await this.queue.api({action:'claimBatch',batchId:batch.batchId,...(batch.requestId?{requestId:batch.requestId}:{}),...(batch.uploadPolicy==='after_request'?{uploadPolicy:'after_request'}:{})});
    if(!result.jobs?.length){
      state.batch=null;await this.save(state);
      if(result.requestStatus==='cancelled'){
        const saved=await this.requestState();if(saved.request?.requestId===batch.requestId){saved.request.phase='cancelled';await atomicJSON(this.requestPath,saved);}
        return {state:'cancelled',requestId:batch.requestId,canGenerate:false};
      }
      return {state:result.blocked?'needs_attention':'idle',requestId:batch.requestId,canGenerate:false};
    }
    this.validate(result,batch.requestId,batch.batchId);
    if(result.jobs.some(job=>job.state!=='claimed')){batch.phase='needs_attention';await this.save(state);return {state:'needs_attention',canGenerate:false,batchId:batch.batchId};}
    batch.requestId=result.requestId;batch.requestStatus=result.requestStatus;batch.itemCount=result.itemCount;batch.resultCount=result.resultCount;
    const cache=new Map();
    batch.jobs=result.jobs.map(job=>({...job,phase:'claimed',referencePaths:[]}));await this.save(state);
    for(const job of batch.jobs)for(const reference of job.references||[]){
      if(!cache.has(reference.assetId)){const paths=await this.queue.references({...job,references:[reference]});cache.set(reference.assetId,paths[0]);}
      job.referencePaths.push(cache.get(reference.assetId));
    }
    batch.phase='prepared';await this.save(state);
    if(batch.uploadPolicy==='after_request')await this.updateRequest(batch);
    return {state:'prepared',...batch,canGenerate:false,nextAction:'start-batch'};
  }
  async start(batchId){
    const state=await this.state(),batch=state.batch;
    if(!uuid.test(batchId)||batch?.batchId!==batchId||batch.phase!=='prepared')return {state:batch?.phase||'missing',canGenerate:false};
    batch.phase='start_requested';batch.attemptAt=Date.now();await this.save(state);
    const result=await this.queue.api({action:'startBatch',batchId});
    this.validate(result,batch.requestId,batchId);
    const expected=new Set(batch.jobs.map(job=>job.jobId));
    if(result.canGenerate!==true||result.duplicate||result.jobs.length!==expected.size||result.jobs.some(job=>job.state!=='started'||!expected.has(job.jobId))){batch.phase='needs_attention';await this.save(state);return {state:'needs_attention',canGenerate:false};}
    batch.phase='generating';batch.jobs=batch.jobs.map(job=>({...job,...result.jobs.find(started=>started.jobId===job.jobId),referencePaths:job.referencePaths,phase:'generating'}));await this.save(state);
    return {state:'generating',batchId,requestId:batch.requestId,jobs:batch.jobs,canGenerate:true};
  }
  async stage(manifest){
    const state=await this.state(),batch=state.batch;
    if(!batch||manifest.batchId!==batch.batchId||!['generating','staged'].includes(batch.phase)||!Array.isArray(manifest.images)||manifest.images.length!==batch.jobs.length||new Set(manifest.images.map(i=>i.jobId)).size!==batch.jobs.length||manifest.images.some(i=>!batch.jobs.some(j=>j.jobId===i.jobId)))throw Error('The result manifest must match every started group item');
    // Save exact returned native paths before any copying; retry staging these
    // same bytes if interrupted. Never discover or infer a generated file.
    await atomicJSON(join(this.history,batch.batchId+'-native-paths.json'),manifest);
    await mkdir(this.results,{recursive:true});
    for(const input of manifest.images){
      const job=batch.jobs.find(j=>j.jobId===input.jobId);
      if(input.imagePath){
        if(!isAbsolute(input.imagePath))throw Error('Use the exact absolute native result path');
        const bytes=await readFile(input.imagePath),type=imageType(bytes),hash=fingerprint(bytes);
        if(bytes.length>5*1024*1024)throw Error('A native result exceeds the existing 5 MiB limit; do not resize or regenerate automatically');
        if(job.result&&job.result.fingerprint!==hash)throw Error('A different result is already saved for this native attempt');
        const path=join(this.results,job.jobId+'.'+type.ext);
        try{await writeFile(path,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||fingerprint(await readFile(path))!==hash)throw error;}
        job.result={path,fingerprint:hash,mime:type.mime,bytes:bytes.length,name:(job.filename||job.itemId).replace(/\.(png|jpe?g|webp)$/i,'')+'.'+type.ext};job.phase='result_saved';
      }else{
        if(job.result)throw Error('A saved native result cannot be discarded');
        job.phase=input.state==='failed'?'failed':'needs_attention';
      }
      await this.save(state);
    }
    batch.phase='staged';await this.save(state);
    if(batch.uploadPolicy==='after_request')return this.defer();
    return {state:'staged',batchId:batch.batchId,requestId:batch.requestId,saved:batch.jobs.filter(j=>j.result).length,canGenerate:false};
  }
  async defer(){
    const state=await this.state(),batch=state.batch;
    if(!batch||!['staged','uploading','stage_acknowledged','completed'].includes(batch.phase))throw Error('Save exact native originals before deferring delivery');
    this.validate(batch,batch.requestId,batch.batchId);
    batch.uploadPolicy='after_request';await this.save(state);await this.updateRequest(batch);
    if(batch.jobs.some(job=>!job.result)){batch.phase='needs_attention';await this.save(state);await this.updateRequest(batch);return {state:'needs_attention',batchId:batch.batchId,requestId:batch.requestId,canGenerate:false,message:'A native result is missing. Preserve saved originals; never generate a replacement automatically.'};}
    const images=[];
    for(const job of batch.jobs){const bytes=await readFile(job.result.path);if(fingerprint(bytes)!==job.result.fingerprint)throw Error('The saved group image changed');job.result.bytes=bytes.length;images.push({jobId:job.jobId,fingerprint:job.result.fingerprint,mime:job.result.mime,name:job.result.name,bytes:bytes.length});}
    await this.save(state);
    // Metadata acknowledgement frees this group's start lock. No image bytes
    // leave the computer, and retrying an uncertain acknowledgement is safe.
    let result;try{result=await this.queue.api({action:'stageBatch',batchId:batch.batchId,images});}catch(error){if(error.code==='REQUEST_CANCELLED'){await this.updateRequest(batch,{requestStatus:'cancelled'});}throw error;}
    this.validate(result,batch.requestId,batch.batchId);
    if(result.staged!==true||result.jobs.length!==batch.jobs.length||result.jobs.some(job=>!batch.jobs.some(saved=>saved.jobId===job.jobId)||!['staged','completed'].includes(job.state)))throw Error('Saved image group acknowledgement did not match the original jobs');
    batch.requestStatus=result.requestStatus;batch.resultCount=result.resultCount;
    for(const remoteJob of result.jobs)if(remoteJob.state==='completed')batch.jobs.find(job=>job.jobId===remoteJob.jobId).phase='completed';
    batch.phase='stage_acknowledged';await this.save(state);await atomicJSON(join(this.history,batch.batchId+'.json'),batch);
    const request=await this.updateRequest(batch,result.requestProgress);
    return {state:'stage_acknowledged',batchId:batch.batchId,requestId:batch.requestId,saved:batch.jobs.filter(job=>job.result).length,request,canGenerate:false,nextAction:request.phase==='ready_to_upload'?'flush-request':'prepare-batch'};
  }
  async flushRequest(requestId){
    const state=await this.requestState(),request=state.request;
    if(!request||!uuid.test(request.requestId)||(requestId&&requestId!==request.requestId))throw Error('Use the exact pinned request ID');
    if(request.phase==='completed')return {state:'completed',duplicate:true,requestId:request.requestId,itemCount:request.itemCount,resultCount:request.resultCount,canGenerate:false};
    if(!['ready_to_upload','uploading'].includes(request.phase)||request.resultCount+request.stagedCount!==request.itemCount)throw Error('Generate and save every requested image before uploading');
    const batches=await this.requestBatches(request),savedJobs=batches.flatMap(batch=>batch.jobs);
    // Check the entire durable spool before the first upload. Never substitute
    // another image or discover a result by searching generated-image folders.
    for(const job of savedJobs){if(!job.result)throw Error('An original result is missing');if(fingerprint(await readFile(job.result.path))!==job.result.fingerprint)throw Error('The saved group image changed');}
    let remote;try{remote=await this.queue.api({action:'beginRequestUpload',requestId:request.requestId});}catch(error){if(error.code==='REQUEST_CANCELLED'){request.phase='cancelled';await atomicJSON(this.requestPath,state);}throw error;}
    const local=new Set(savedJobs.map(job=>job.jobId));
    if(remote.requestId!==request.requestId||remote.readyToUpload!==true||remote.itemCount!==request.itemCount||remote.jobs?.length!==request.itemCount||new Set(remote.jobs.map(job=>job.jobId)).size!==request.itemCount||remote.jobs.some(job=>!['staged','completed'].includes(job.state)||(job.state==='staged'&&!local.has(job.jobId))))throw Error('The whole-request delivery acknowledgement did not match the saved originals');
    request.phase='uploading';await atomicJSON(this.requestPath,state);
    for(const batch of batches){
      batch.phase='uploading';await this.saveRequestBatch(batch);
      for(const job of batch.jobs){
        if(job.phase==='completed')continue;
        const bytes=await readFile(job.result.path);if(fingerprint(bytes)!==job.result.fingerprint)throw Error('The saved group image changed');
        const result=await this.queue.api({action:'complete',jobId:job.jobId,image:{name:job.result.name,mime:job.result.mime,base64:bytes.toString('base64')}});
        if(result.job?.jobId!==job.jobId||result.request?.id!==request.requestId)throw Error('Completion belongs to another request item');
        job.phase='completed';batch.requestStatus=result.request.status;batch.itemCount=result.request.items.length;batch.resultCount=result.request.results.length;
        request.resultCount=batch.resultCount;request.stagedCount=savedJobs.filter(saved=>saved.phase!=='completed').length;
        if(result.request.status==='cancelled')request.phase='cancelled';
        await this.saveRequestBatch(batch);await atomicJSON(this.requestPath,state);
        if(request.phase==='cancelled')return {state:'cancelled',requestId:request.requestId,resultCount:request.resultCount,canGenerate:false};
      }
      batch.phase='completed';await this.saveRequestBatch(batch);
    }
    request.phase=request.resultCount===request.itemCount?'completed':'needs_attention';request.updatedAt=new Date().toISOString();await atomicJSON(this.requestPath,state);
    return {state:request.phase,requestId:request.requestId,itemCount:request.itemCount,resultCount:request.resultCount,delivered:savedJobs.filter(job=>job.phase==='completed').length,canGenerate:false};
  }
  async saveRequestBatch(batch){await atomicJSON(join(this.history,batch.batchId+'.json'),batch);const current=await this.state();if(current.batch?.batchId===batch.batchId){current.batch=batch;await this.save(current);}}
  async flush(){
    const state=await this.state(),batch=state.batch;
    if(batch?.uploadPolicy==='after_request')throw Error('This request uses deferred delivery. Save every image, then use flush-request.');
    if(!batch||!['staged','uploading','completed'].includes(batch.phase))throw Error('Save the group results before uploading; never regenerate to repair an upload');
    if(batch.phase==='completed')return {state:'completed',duplicate:true,batchId:batch.batchId,requestId:batch.requestId,requestStatus:batch.requestStatus,itemCount:batch.itemCount,resultCount:batch.resultCount,canGenerate:false};
    batch.phase='uploading';await this.save(state);
    for(const job of batch.jobs){
      if(job.phase==='completed'||job.phase==='reported')continue;
      if(job.result){
        const bytes=await readFile(job.result.path);if(fingerprint(bytes)!==job.result.fingerprint)throw Error('The saved group image changed');
        const result=await this.queue.api({action:'complete',jobId:job.jobId,image:{name:job.result.name,mime:job.result.mime,base64:bytes.toString('base64')}});
        if(result.job?.jobId!==job.jobId||result.request?.id!==batch.requestId)throw Error('Completion belongs to another group item');
        batch.requestStatus=result.request.status;batch.itemCount=result.request.items.length;batch.resultCount=result.request.results.length;job.phase='completed';
      }else{
        await this.queue.api({action:'report',jobId:job.jobId,state:job.phase==='failed'?'failed':'needs_attention',message:'The native group attempt did not return an accepted exact result. Do not generate this item again.'});job.phase='reported';
      }
      await this.save(state);
    }
    batch.phase=batch.jobs.some(job=>job.phase==='reported')?'needs_attention':'completed';await this.save(state);await atomicJSON(join(this.history,batch.batchId+'.json'),batch);
    return {state:batch.phase,batchId:batch.batchId,requestId:batch.requestId,requestStatus:batch.requestStatus,itemCount:batch.itemCount,resultCount:batch.resultCount,delivered:batch.jobs.filter(j=>j.phase==='completed').length,canGenerate:false};
  }
}

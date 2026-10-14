// Queue transport only. Images are created by Codex's native ImageGen tool.
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function connection(value) {
  const url = new URL(value.backendURL);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use a secure backend origin or a local test server.');
  if (value.version !== 1 || value.apiPath !== '/api/image-requests' || !uuid.test(value.runnerId) || !/^ir_[a-f0-9]{64}$/.test(value.runnerToken)) throw new Error('Invalid Craftush connection file.');
  return { version: 1, backendURL: url.origin, apiPath: value.apiPath, runnerId: value.runnerId, runnerToken: value.runnerToken };
}
export async function atomicJSON(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
async function optionalJSON(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime:'image/png', ext:'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime:'image/jpeg', ext:'jpg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime:'image/webp', ext:'webp' };
  throw new Error('ImageGen result must be a PNG, JPG or WebP image.');
}
export class ImageQueue {
  constructor(config, directory, { fetchImpl=fetch, now=()=>Date.now() }={}) {
    this.config = connection(config);
    this.directory = resolve(directory);
    this.statePath = join(this.directory, 'state.json');
    this.fetch = fetchImpl;
    this.now = now;
  }
  async api(body, query) {
    const url = new URL(this.config.apiPath, this.config.backendURL);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.fetch(url, { method:body ? 'POST' : 'GET', redirect:'error', signal:AbortSignal.timeout(20000),
      headers:{ 'X-Image-Runner':this.config.runnerToken, ...(body ? {'Content-Type':'application/json'} : {}) },
      ...(body ? {body:JSON.stringify(body)} : {}) });
    const result = await response.json();
    if (!response.ok) {
      const error=new Error(result.errors?.[0]?.message || result.error?.message || 'Craftush generator request failed.');
      error.code=result.errors?.[0]?.code || result.error?.code; error.status=response.status; throw error;
    }
    return result;
  }
  async state() { return await optionalJSON(this.statePath) || {version:1, claimId:null, active:null}; }
  async save(state) { await atomicJSON(this.statePath, state); }
  async references(job) {
    if (!uuid.test(job.jobId)) throw new Error('Invalid image job identifier.');
    const paths = [];
    for (const asset of job.references || []) {
      if (!uuid.test(asset.assetId)) throw new Error('Invalid reference identifier.');
      const url = new URL(this.config.apiPath, this.config.backendURL);
      url.searchParams.set('action','runnerAsset'); url.searchParams.set('jobId',job.jobId); url.searchParams.set('assetId',asset.assetId);
      const response = await this.fetch(url, { headers:{'X-Image-Runner':this.config.runnerToken}, redirect:'error', signal:AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('The job reference could not be downloaded.');
      const declaredSize = Number(response.headers.get('content-length'));
      if (declaredSize > 5*1024*1024) throw new Error('The reference is too large.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 5*1024*1024) throw new Error('The reference is too large.');
      const type = imageType(bytes);
      const directory = join(this.directory,'references',job.jobId);
      await mkdir(directory, {recursive:true});
      const path = join(directory,asset.assetId+'.'+type.ext);
      await writeFile(path,bytes,{mode:0o600}); paths.push(path);
    }
    return paths;
  }
  async next() {
    const state = await this.state();
    const status = await this.api({action:'runnerHeartbeat'});
    if (state.active) {
      const active = state.active;
      if (!uuid.test(active.job.jobId)) throw new Error('Invalid saved image job identifier.');
      let remote;
      try { remote = await this.api(null,{action:'runnerJob',jobId:active.job.jobId}); }
      catch(error) {
        if(active.phase !== 'claimed' || error.code !== 'RUNNER_SCOPE_DENIED') throw error;
        // Only an unstarted expired claim can be released automatically.
        state.active=null; state.claimId=null; await this.save(state);
        return {state:'claim_expired',canGenerate:false};
      }
      if (remote.job?.requestStatus === 'cancelled' || ['completed','failed'].includes(remote.job?.state)) {
        state.active = null; state.claimId = null; await this.save(state);
        return {state:remote.job.requestStatus === 'cancelled' ? 'cancelled' : remote.job.state,jobId:active.job.jobId};
      }
      if (active.phase === 'result_saved') return this.complete(active.job.jobId);
      if (active.phase === 'completed') {
        state.active = null; state.claimId = null; await this.save(state);
      } else if (['start_requested','generating','needs_attention','failed'].includes(active.phase)) {
        if (['start_requested','generating'].includes(active.phase) && this.now()-active.attemptAt > 30*60*1000) {
          return this.report(active.job.jobId,'needs_attention','Generation outcome is uncertain. Do not generate this item again automatically.');
        }
        return {state:active.phase,jobId:active.job.jobId,canGenerate:false,message:'A previous native generation attempt exists. Do not repeat it.'};
      } else if (active.phase === 'claimed') {
        if (remote.job?.state !== 'claimed') {
          state.active = null; state.claimId = null; await this.save(state);
        } else {
          const referencePaths = await this.references(active.job);
          return {state:'claimed',job:active.job,referencePaths,canGenerate:false,nextAction:'start'};
        }
      }
    }
    if (status.generator?.needsAttention) return {state:'needs_attention',canGenerate:false,generator:status.generator};
    if (status.job && status.job.requestStatus !== 'cancelled' && ['started','needs_attention'].includes(status.job.state)) return {state:'needs_attention',canGenerate:false,jobId:status.job.jobId,message:'The server has a previous generation attempt. Do not repeat it.'};
    state.claimId ||= randomUUID(); await this.save(state);
    const result = await this.api({action:'claim',claimId:state.claimId});
    if (!result.job) {state.claimId=null; await this.save(state); return {state:'idle',generator:result.generator};}
    if (!uuid.test(result.job.jobId)) throw new Error('Invalid image job identifier.');
    if (result.job.state !== 'claimed') return {state:result.job.state,jobId:result.job.jobId,canGenerate:false};
    state.active = {phase:'claimed',job:result.job}; await this.save(state);
    const referencePaths = await this.references(result.job);
    return {state:'claimed',job:result.job,referencePaths,canGenerate:false,nextAction:'start'};
  }
  async start(jobId) {
    if (!uuid.test(jobId)) throw new Error('Invalid image job identifier.');
    const state = await this.state(); const active = state.active;
    if (!active || active.job.jobId !== jobId || active.phase !== 'claimed') return {state:active?.phase || 'missing',canGenerate:false};
    active.phase='start_requested'; active.attemptAt=this.now(); await this.save(state);
    const result = await this.api({action:'start',jobId});
    if (!result.canGenerate || result.duplicate || result.job?.state !== 'started') {
      active.phase='needs_attention'; await this.save(state);
      return {state:'needs_attention',canGenerate:false};
    }
    active.phase='generating'; active.job=result.job; await this.save(state);
    return {state:'generating',canGenerate:true,job:result.job};
  }
  async complete(jobId, imagePath) {
    if (!uuid.test(jobId)) throw new Error('Invalid image job identifier.');
    const state = await this.state(); const active = state.active;
    if (!active || active.job.jobId !== jobId) throw new Error('This is not the locally active image job.');
    if (active.phase === 'completed') return {state:'completed',duplicate:true,jobId};
    if (imagePath) {
      if (!['generating','needs_attention','result_saved'].includes(active.phase)) throw new Error('This job has no acknowledged native generation attempt.');
      const source=resolve(imagePath), info=await stat(source);
      if (!info.isFile() || info.size > 5*1024*1024) throw new Error('The generated image must be at most 5 MiB.');
      const bytes=await readFile(source), type=imageType(bytes);
      const fingerprint=createHash('sha256').update(bytes).digest('hex');
      if (active.result && active.result.fingerprint !== fingerprint) throw new Error('A different result is already saved. Do not replace a generation attempt.');
      const directory=join(this.directory,'results'); await mkdir(directory,{recursive:true});
      const savedPath=join(directory,jobId+'.'+type.ext);
      await writeFile(savedPath,bytes,{mode:0o600});
      active.result={path:savedPath,mime:type.mime,name:(active.job.filename || active.job.itemId).replace(/\.(png|jpe?g|webp)$/i,'')+'.'+type.ext,fingerprint};
      active.phase='result_saved'; await this.save(state);
    }
    if (active.phase !== 'result_saved' || !active.result) throw new Error('No saved result is available. Do not regenerate to repair an upload.');
    const bytes=await readFile(active.result.path);
    if (createHash('sha256').update(bytes).digest('hex') !== active.result.fingerprint) throw new Error('The saved image changed.');
    const result=await this.api({action:'complete',jobId,image:{name:active.result.name,mime:active.result.mime,base64:bytes.toString('base64')}});
    active.phase='completed'; await this.save(state);
    await atomicJSON(join(this.directory,'history',jobId+'.json'),{jobId,requestId:active.job.requestId,itemId:active.job.itemId,completedAt:new Date(this.now()).toISOString(),imagePath:active.result.path,fingerprint:active.result.fingerprint});
    return {state:'completed',jobId,requestId:active.job.requestId,imagePath:active.result.path,duplicate:!!result.duplicate};
  }
  async report(jobId, phase, message) {
    if (!uuid.test(jobId)) throw new Error('Invalid image job identifier.');
    if (!['failed','needs_attention'].includes(phase)) throw new Error('Choose failed or needs_attention.');
    const state=await this.state();
    if (!state.active || state.active.job.jobId !== jobId) throw new Error('This is not the locally active image job.');
    state.active.phase=phase; await this.save(state);
    await this.api({action:'report',jobId,state:phase,message});
    return {state:phase,jobId,canGenerate:false};
  }
}

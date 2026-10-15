// No provider SDK or API key: a scheduled Codex turn invokes native ImageGen.
import { readFile, mkdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connection, atomicJSON, ImageQueue } from './imagegen-queue.mjs';
import { ImageBatchQueue } from './imagegen-batch.mjs';

function connectionIdentities() {
  if (process.platform !== 'win32') throw new Error('This connection helper currently supports Windows.');
  // Compiled Get-Acl works in constrained PowerShell; no reflection, new types,
  // profile decryption or security-policy changes are needed for this helper.
  const owner=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command','Get-Acl -LiteralPath $env:CRAFTUSH_ACL_PATH | Select-Object -ExpandProperty Sddl'],{env:{...process.env,CRAFTUSH_ACL_PATH:process.cwd()},encoding:'utf8',windowsHide:true});
  const identity=spawnSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
  const ownerSID=owner.stdout?.match(/^O:(S-1-\d+(?:-\d+)+)/)?.[1];
  const currentSID=identity.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if(owner.status!==0 || identity.status!==0 || !ownerSID || !currentSID) throw new Error('Windows could not identify the connection file owners.');
  return [...new Set([ownerSID,currentSID,'S-1-5-18'])];
}
function verifyConnection(path,identities) {
  const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command','Get-Acl -LiteralPath $env:CRAFTUSH_ACL_PATH | Select-Object -ExpandProperty Sddl'],{env:{...process.env,CRAFTUSH_ACL_PATH:path},encoding:'utf8',windowsHide:true});
  const dacl=result.stdout?.split('D:')[1]?.split('S:')[0] || '';
  const aces=[...dacl.matchAll(/\(([^()]+)\)/g)].map(match=>match[1].split(';'));
  const trustees=aces.map(ace=>ace[5]==='SY'?'S-1-5-18':ace[5]);
  if(result.status!==0 || !dacl.startsWith('P') || !aces.length || aces.some((ace,index)=>ace[0]!=='A' || !identities.includes(trustees[index])) || identities.some(sid=>!trustees.includes(sid))) throw new Error('The connection permissions are not private. Reconnect this computer.');
}
function restrictConnection(path,identities,isDirectory=false) {
  const result=spawnSync('icacls.exe',[path,'/inheritance:r','/grant:r',...identities.map(sid=>'*'+sid+(isDirectory?':(OI)(CI)F':':(F)'))],{encoding:'utf8',windowsHide:true});
  if(result.status!==0) throw new Error('Windows could not restrict the connection file.');
  verifyConnection(path,identities);
}
const [command,...args]=process.argv.slice(2);
const values={}; for(let index=0;index<args.length;index+=2) { if(!args[index]?.startsWith('--') || args[index+1] === undefined) throw new Error('Use named bridge arguments.'); values[args[index].slice(2)]=args[index+1]; }
const directory=resolve(values['state-dir'] || '.craftush-imagegen');
await mkdir(directory,{recursive:true});
const lock=join(directory,'operation.lock');
let locked=false;
async function acquireLock() {
  try { await mkdir(lock); }
  catch(error) {
    if(error.code !== 'EEXIST') throw error;
    let owner;
    try { owner=JSON.parse(await readFile(join(lock,'owner.json'),'utf8')); }
    catch {
      // A crash between mkdir and owner write is recoverable after a minute.
      if(Date.now()-(await stat(lock)).mtimeMs < 60000) throw error;
    }
    if(owner?.pid) {
      try { process.kill(owner.pid,0); throw error; }
      catch(check) { if(check.code !== 'ESRCH') throw error; }
    }
    // Only the lock is removed. Attempt/result receipts remain untouched.
    await rm(lock,{recursive:true}); await mkdir(lock);
  }
  await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});
}
try {
  await acquireLock(); locked=true;
  if (command === 'configure') {
    if (!values.file) throw new Error('Supply the downloaded Craftush connection file.');
    const config=connection(JSON.parse(await readFile(resolve(values.file),'utf8')));
    const identities=connectionIdentities();
    // A reconnect can use another protected Windows session. Create a fresh
    // private credential container instead of changing an earlier session's
    // permissions. The runner's job receipts/results remain in their old path.
    const credentialId=randomUUID();
    const credentialParent=join(directory,'credentials');
    await mkdir(credentialParent,{recursive:true});
    const credentialDirectory=join(credentialParent,credentialId);
    await mkdir(credentialDirectory); restrictConnection(credentialDirectory,identities,true);
    const secretPath=join(credentialDirectory,'connection.private.json');
    const temporary=secretPath+'.'+randomUUID()+'.tmp';
    // Apply the private ACL to an EMPTY file before any token is written.
    await writeFile(temporary,'',{flag:'wx',mode:0o600});
    restrictConnection(temporary,identities);
    await writeFile(temporary,JSON.stringify(config),{mode:0o600});
    await rename(temporary,secretPath);
    await atomicJSON(join(directory,'connection.json'),{version:1,runnerId:config.runnerId,credentialId});
    console.log(JSON.stringify({state:'configured',backendURL:config.backendURL,runnerId:config.runnerId}));
  } else {
    const pointer=JSON.parse(await readFile(join(directory,'connection.json'),'utf8'));
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pointer.runnerId)) throw new Error('Invalid connection identity.');
    if(pointer.credentialId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pointer.credentialId)) throw new Error('Invalid private connection identity.');
    const secretPath=join(directory,'credentials',pointer.credentialId || pointer.runnerId,'connection.private.json');
    verifyConnection(secretPath,connectionIdentities());
    const config=connection(JSON.parse(await readFile(secretPath,'utf8')));
    if(config.runnerId!==pointer.runnerId) throw new Error('The connection identity changed.');
    const queue=new ImageQueue(config,join(directory,config.runnerId));
    // The current owner policy is local folders. Even legacy upload receipts
    // cannot turn a later CLI call into an image-byte delivery operation.
    if(values['delivery-policy']&&values['delivery-policy']!=='local_folder')throw new Error('This bridge uses local-folder delivery only.');
    const batchQueue=new ImageBatchQueue(config,join(directory,config.runnerId),{uploadPolicy:'local_folder',resultDirectory:values['result-dir'] || resolve('../craftush-native-results')});
    let result;
    if(['flush-request','flush-batch','next','start','complete'].includes(command))throw new Error('Image uploads and legacy single-image recovery are disabled. Use local-folder request commands.');
    if(command === 'prepare-batch') result=await batchQueue.prepare(values.request);
    else if(command === 'start-batch') result=await batchQueue.start(values.batch);
    else if(command === 'stage-batch') result=await batchQueue.stage(JSON.parse(await readFile(resolve(values.manifest),'utf8')));
    else if(command === 'defer-batch') result=await batchQueue.defer();
    else if(command === 'request-status') result=await batchQueue.requestStatus();
    else if(command === 'adopt-local-request') result=await batchQueue.adoptLocalRequest(values.request);
    else if(command === 'finalize-folder') result=await batchQueue.finalizeFolder(values.request,resolve(values['output-root'] || '../../outputs'));
    else if(command === 'flush-request') result=await batchQueue.flushRequest(values.request);
    else if(command === 'flush-batch') result=await batchQueue.flush();
    else if(command === 'next') result=await queue.next();
    else if(command === 'start') result=await queue.start(values.job);
    else if(command === 'complete') result=await queue.complete(values.job,values['image-path']);
    else if(command === 'report') result=await queue.report(values.job,values.state,values.message);
    else if(command === 'status') result=await queue.api(null,{action:'runnerMeta'});
    else if(command === 'heartbeat') result=await queue.api({action:'runnerHeartbeat'});
    else throw new Error('Choose configure, status, heartbeat, prepare-batch, start-batch, stage-batch, defer-batch, request-status, adopt-local-request, finalize-folder or report.');
    console.log(JSON.stringify(result));
  }
} catch(error) {
  console.error(JSON.stringify({state:'error',message:error.code === 'EEXIST' ? 'Another bridge operation is running. Do not repeat generation.' : error.message}));
  process.exitCode=1;
} finally { if(locked) await rm(lock,{recursive:true}); }

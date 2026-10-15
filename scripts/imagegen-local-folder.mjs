// Durable local delivery only. Never generates or uploads image bytes.
import {readFile,writeFile,mkdir,realpath,lstat,readdir} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJSON,imageType} from './imagegen-queue.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function localName(value){
  if(typeof value!=='string'||!value.length)throw Error('A request and every track need an exact title');
  let name=value.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[ .]+$/g,match=>'_'.repeat(match.length));
  if(/^\.{1,2}$/.test(name))name='_'.repeat(name.length);
  if(/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name))name='_'+name;
  if(name.length>200)throw Error('A track title is too long for a safe exact Windows filename; shorten it explicitly');
  return name;
}
function child(parent,name){const path=resolve(parent,name),part=relative(resolve(parent),path);if(!part||part==='..'||isAbsolute(part)||dirname(path)!==resolve(parent))throw Error('A local delivery name escapes its folder');return path;}
async function noSymlink(path){try{if((await lstat(path)).isSymbolicLink())throw Error('A local delivery path cannot be a symbolic link');}catch(error){if(error.code!=='ENOENT')throw error;}}
export async function saveLocalFolder({request,jobs,outputRoot}){
  if(!uuid.test(request?.requestId)||!Array.isArray(request.items)||request.items.length!==request.itemCount||!Array.isArray(jobs))throw Error('Invalid exact request manifest');
  const byId=new Map(jobs.map(job=>[job.jobId,job]));if(byId.size!==jobs.length)throw Error('A local delivery repeats an image job');
  const seen=new Set(),files=[];
  // Validate all originals and names before making any user-visible copies.
  for(const item of request.items){
    if(!uuid.test(item.jobId)||!item.id||seen.has('job:'+item.jobId))throw Error('The exact request repeats an image job');
    const job=byId.get(item.jobId);if(!job||job.requestId!==request.requestId||job.itemId!==item.id||!job.result)throw Error('Every track needs its saved original before folder delivery');
    const bytes=await readFile(job.result.path),type=imageType(bytes),fingerprint=hash(bytes);
    if(fingerprint!==job.result.fingerprint||type.mime!==job.result.mime)throw Error('A saved original changed');
    const name=localName(item.title)+'.'+type.ext,key=name.normalize('NFC').toLowerCase();
    if(seen.has('name:'+key))throw Error('Track titles collide as Windows filenames; choose distinct track titles explicitly');
    seen.add('name:'+key);seen.add('job:'+item.jobId);
    files.push({jobId:item.jobId,itemId:item.id,title:item.title,name,fingerprint,mime:type.mime,bytes:bytes.length,source:job.result.path});
  }
  if(files.length!==jobs.length)throw Error('Saved originals contain tracks outside the pinned request');
  const folderName=localName(request.title),root=resolve(outputRoot);await mkdir(root,{recursive:true});
  const folderPath=child(await realpath(root),folderName);await noSymlink(folderPath);await mkdir(folderPath,{recursive:true});
  const manifestPath=child(folderPath,'_Craftush-Manifest.json');await noSymlink(manifestPath);
  let prior;try{prior=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!prior&&(await readdir(folderPath)).length)throw Error('This exact folder title already contains other files; nothing was overwritten');
  if(prior&&(prior.requestId!==request.requestId||prior.title!==request.title))throw Error('This exact folder title already belongs to another request');
  // The manifest is written before copying, so interrupted delivery resumes only
  // this exact request. Existing different files are never overwritten.
  const manifest={version:1,requestId:request.requestId,title:request.title,folderName,folderPath,state:'copying',files};
  await atomicJSON(manifestPath,manifest);
  for(const file of files){const target=child(folderPath,file.name);await noSymlink(target);const bytes=await readFile(file.source);if(hash(bytes)!==file.fingerprint)throw Error('A saved original changed');try{await writeFile(target,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||hash(await readFile(target))!==file.fingerprint)throw Error('An existing track file has different bytes; nothing was overwritten');}}
  manifest.state='saved';await atomicJSON(manifestPath,manifest);
  return {folderName,folderPath,manifestPath,files:files.map(({source,title,...file})=>file)};
}

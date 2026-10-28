import {storageErrorResponse} from './storage-errors.js';
export function batchImageURL(value){
 let url;try{url=new URL(value);}catch{throw new Error('Invalid image URL.');}
 if(url.protocol!=='https:'||url.hostname!=='im.runware.ai'||!url.pathname.startsWith('/image/')||url.port||url.username||url.password||[...url.searchParams.keys()].some(k=>/key|token|auth|secret/i.test(k)))throw new Error('Only Runware-generated image URLs are supported.');return url.href;
}
export function createBatchImageMedia({openStore,readSettings,teamCodeOk,dashboardView,fail,fetch:request}){
 return async req=>{
  try{
   if(req.method!=='POST')return fail('Method not allowed.',405);
   const settings=await readSettings(openStore());if(!await teamCodeOk(req,settings))return fail('Wrong team access code.',401);
   if(dashboardView(settings).cards.batch?.enabled===false)return fail('Batch Images is turned off in Admin.',403);
   const raw=await req.text();if(raw.length>8192)return fail('Image request is too large.',400);
   let url;try{url=batchImageURL(JSON.parse(raw).url);}catch(error){return fail(error.message,400);}
   // No provider key or team code is ever forwarded to image storage.
   const response=await request(url,{redirect:'manual',signal:AbortSignal.timeout(45000)});
   if(!response.ok)return fail('This image could not be downloaded. Resume to retry its existing result.',502);
   const max=20*1048576,length=Number(response.headers.get('content-length'));
   if(length>max){await response.body?.cancel();return fail('This image exceeds 20 MB.',502);}
   if(!response.body)return fail('Runware returned an empty image.',502);
   const reader=response.body.getReader(),parts=[];let count=0;
   while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>max){await reader.cancel();return fail('This image exceeds 20 MB.',502);}parts.push(value);}
   if(!count||(length>0&&length!==count))return fail('The image download was interrupted. Resume to retry.',502);
   const bytes=new Uint8Array(count);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
   const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71,webp=new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
   if(!jpeg&&!png&&!webp)return fail('Runware returned a file that is not an image.',502);
   return new Response(bytes,{headers:{'content-type':jpeg?'image/jpeg':png?'image/png':'image/webp','cache-control':'no-store','x-content-type-options':'nosniff'}});
  }catch(error){return storageErrorResponse(error)||fail('The image download could not finish. Resume to retry.',502);}
 };
}

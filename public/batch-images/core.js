export const MAX_IMAGES=100,CHUNK_SIZE=12;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const key=value=>String(value).toLowerCase().replace(/[\s_-]/g,'');
const field=(row,names)=>Object.entries(row).find(([k])=>names.includes(key(k)))?.[1];
const sceneTitle=/^\s*S\d+\s*[·|:.-]\s*Seg(?:ment)?\b/i;
const promptLine=/^\s*Prompt\s*:\s*([\s\S]*)$/i;
function storyboardImages(lines){
 const images=[];let title=null;
 for(const [index,line] of lines.entries()){
  const text=line.trim();if(!text)continue;
  if(sceneTitle.test(text)){
   if(title!==null)throw new Error(`Scene “${title}” is missing its Prompt: entry.`);
   title=text;continue;
  }
  const match=promptLine.exec(text);
  if(match){
   if(title===null)throw new Error(`Storyboard entry ${index+1} has a Prompt: without a scene title.`);
   images.push({name:title,prompt:match[1]});title=null;continue;
  }
  // Editing instructions and standalone section labels are not image prompts.
  if(/^(?:Motion|In|Out|Overlay|SFX|Text|Graphics)\s*:/i.test(text))continue;
  if(text.length<=100&&(/^[\p{L}\p{N}\s&/()+–-]+$/u.test(text)&&text===text.toUpperCase()||/^#{1,6}\s+/.test(text)))continue;
  throw new Error(`Unrecognized storyboard entry ${index+1}. Put each image description after Prompt: and editing notes after Motion:.`);
 }
 if(title!==null)throw new Error(`Scene “${title}” is missing its Prompt: entry.`);
 return images;
}
export function parseImages(input){
 let value=input;
 if(typeof value==='string'){if(value.length>8*1048576)throw new Error('Choose a JSON file smaller than 8 MB.');try{value=JSON.parse(value);}catch{throw new Error('This is not valid JSON. Download the example to see the format.');}}
 if(plain(value)){
  const names=field(value,['names','imagenames']),prompts=field(value,['prompts','imageprompts']);
  if(Array.isArray(names)&&Array.isArray(prompts)){
   if(names.length!==prompts.length)throw new Error('The image names and prompts lists must have the same length.');
   value=names.map((name,i)=>({name,prompt:prompts[i]}));
  }else if(Array.isArray(value.images))value=value.images;
  else if(Array.isArray(value.items))value=value.items;
  else if(Array.isArray(prompts))value=prompts;
  else if(typeof field(value,['prompt','imageprompt','positiveprompt'])==='string')value=[value];
  else if(Object.values(value).every(v=>typeof v==='string'))value=Object.entries(value).map(([name,prompt])=>({name,prompt}));
 }
 // A converted storyboard is a flat list of titles, Prompt: entries and motion
 // notes. Normalize it before applying the image count limit, never send the
 // notes or section headings to the provider as separate images.
 if(Array.isArray(value)&&value.every(row=>typeof row==='string')&&value.some(row=>sceneTitle.test(row))&&value.some(row=>promptLine.test(row)))value=storyboardImages(value);
 if(!Array.isArray(value)||!value.length||value.length>MAX_IMAGES)throw new Error(`Your JSON must contain 1–100 image prompts.${Array.isArray(value)&&value.length>MAX_IMAGES?` Found ${value.length} image prompts.`:''} Use an image list or a storyboard with scene titles and Prompt: entries.`);
 return value.map((row,i)=>{
  const prompt=typeof row==='string'?row:plain(row)?field(row,['prompt','imageprompt','positiveprompt']):null;
  const name=plain(row)?field(row,['name','imagename','filename','title']):null;
  if(typeof prompt!=='string'||prompt.trim().length<3||prompt.length>45000)throw new Error(`Image ${i+1} needs a prompt between 3 and 45,000 characters.`);
  if(name!==undefined&&name!==null&&typeof name!=='string')throw new Error(`Image ${i+1} has an invalid name.`);
  return {index:i+1,name:String(name||`Image ${i+1}`).slice(0,300),prompt:prompt.trim(),filename:`${i+1}.jpg`,status:'queued',taskUUID:'',history:[]};
 });
}
export const MODELS=[['openai:gpt-image@2','GPT Image 2'],['openai:gpt-image@2.5-sunburst','GPT Image 2.5 Sunburst'],['google:4@2','Nano Banana Pro'],['runware:101@1','FLUX.1 Dev']];
export function imageSettings({model=MODELS[0][0],shape='landscape',quality='high'}={}){
 if(!MODELS.some(([id])=>id===model))throw new Error('Choose an image model from the list.');
 if(!['landscape','vertical','square','classic'].includes(shape))throw new Error('Choose a frame shape.');
 if(!['high','medium'].includes(quality))throw new Error('Choose image quality.');
 const sizes=model==='google:4@2'?{landscape:[1376,768],vertical:[768,1376],square:[1024,1024],classic:[1200,896]}:model.startsWith('openai:')?{landscape:[1536,1024],vertical:[1024,1536],square:[1024,1024],classic:[1536,1024]}:{landscape:[1344,768],vertical:[768,1344],square:[1024,1024],classic:[1152,896]};
 let [width,height]=sizes[shape];if(model==='google:4@2'&&quality==='high'){width*=2;height*=2;}
 return {model,shape,quality,width,height};
}
export function imageTask(item,settings){
 const c=imageSettings(settings),max=c.model==='google:4@2'?45000:c.model.startsWith('openai:')?32000:3000;
 if(item.prompt.length>max)throw new Error(`Image ${item.index}: this model accepts at most ${max.toLocaleString()} prompt characters. Choose another model or shorten this prompt.`);
 if(!/^[a-f0-9-]{36}$/i.test(item.taskUUID))throw new Error('The original task ID is missing.');
 return {taskType:'imageInference',taskUUID:item.taskUUID,model:c.model,positivePrompt:item.prompt,width:c.width,height:c.height,numberResults:1,outputType:'URL',outputFormat:'JPG',outputQuality:95,includeCost:true,deliveryMethod:'async',...(c.model.startsWith('openai:')?{settings:{quality:c.quality,background:'opaque'}}:c.model==='runware:101@1'?{steps:28,CFGScale:3.5}:{})};
}
export function imageURL(value){
 const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='im.runware.ai'||!url.pathname.startsWith('/image/')||url.port||url.username||url.password||[...url.searchParams.keys()].some(k=>/key|token|auth|secret/i.test(k)))throw new Error('Runware returned an unsupported image URL.');return url.href;
}
export function acceptResults(batch,items,reply){
 for(const item of items){
  const result=(reply.data||[]).find(r=>r.taskUUID===item.taskUUID),error=(reply.errors||[]).find(e=>e.taskUUID===item.taskUUID)||(!result?(reply.errors||[]).find(e=>!e.taskUUID):null);
  if(result&&Number.isFinite(result.cost))batch.costs[item.taskUUID]=result.cost;
  if(result?.imageURL){item.imageURL=imageURL(result.imageURL);item.status='download';item.error='';}
  else if(result?.imageBase64Data){item.base64=result.imageBase64Data;item.status='download';item.error='';}
  else if(error){
   const code=String(error.code||'').replace(/[^a-z]/gi,'');
   if(/notfound|processing|notready|pending/i.test(code)){item.status='uncertain';item.error='Checking the original request ID. No new image has been ordered.';}
   else{item.status='failed';item.error=String(error.message||'Runware could not generate this image.').slice(0,400);}
  }else if(result?.status==='failed'||result?.status==='error'){item.status='failed';item.error=String(result.message||'Runware reported a failed image request.');}
  else {item.status='processing';item.error='';}
 }
}
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export async function imageZip(entries,onProgress=()=>{}){
 if(!entries.length||entries.length>MAX_IMAGES)throw new Error('Choose 1–100 saved images.');
 if(entries.reduce((n,e)=>n+e.blob.size,0)>512*1048576)throw new Error('This ZIP exceeds 512 MB. Download the images individually to avoid exhausting browser memory.');
 const files=[],directory=[];let offset=0,dirSize=0;
 for(let i=0;i<entries.length;i++){
  const {blob,index}=entries[i],name=new TextEncoder().encode(`${index}.jpg`),bytes=new Uint8Array(await blob.arrayBuffer());
  if(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw new Error(`Image ${index} is not a JPEG yet. Resume downloading it first.`);
  const crc=crc32(bytes),header=new Uint8Array(30),h=new DataView(header.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,blob.size,true);h.setUint32(22,blob.size,true);h.setUint16(26,name.length,true);files.push(header,name,blob);
  const central=new Uint8Array(46),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,33,true);c.setUint32(16,crc,true);c.setUint32(20,blob.size,true);c.setUint32(24,blob.size,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);directory.push(central,name);dirSize+=46+name.length;offset+=30+name.length+blob.size;onProgress(i+1,entries.length);
 }
 const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,dirSize,true);v.setUint32(16,offset,true);return new Blob([...files,...directory,end],{type:'application/zip'});
}

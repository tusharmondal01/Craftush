import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import * as core from '../public/batch-images/core.js';
import {runImages} from '../public/batch-images/runner.js';

async function browser({failure=0}={}){
 const {document}=parseHTML(await readFile(new URL('../public/batch-images/index.html',import.meta.url),'utf8'));
 for(const el of document.querySelectorAll('select')){let value=el.querySelector('option')?.value||'';Object.defineProperty(el,'value',{get:()=>value,set:v=>value=String(v)});}
 document.getElementById('autoZip').checked=true;
 const records=new Map(),calls=[],downloads=[],urls=new Map();let requests=0;
 class Store{async get(k){return structuredClone(records.get(k)||null)}async put(k,v){records.set(k,structuredClone(v))}}
 class TestURL extends URL{}TestURL.createObjectURL=blob=>{const id='blob:'+crypto.randomUUID();urls.set(id,blob);return id;};TestURL.revokeObjectURL=id=>urls.delete(id);
 document.createElement('a').constructor.prototype.click=function(){if(this.download)downloads.push({name:this.download,blob:urls.get(this.href)});};
 const context=vm.createContext({...core,DocumentaryStore:Store,document,crypto:webcrypto,structuredClone,URL:TestURL,Blob,TextEncoder,TextDecoder,Response,AbortSignal,AbortController,DOMException,console,addEventListener(){},navigator:{locks:{request:async(n,o,fn)=>fn({})}},setTimeout(fn,ms){if(ms!==30000)return setTimeout(fn,ms)},clearTimeout,
 runImages:(b,options)=>runImages(b,{...options,wait:async()=>{}}),downloadImage:async()=>new Blob([new Uint8Array([255,216,255,224,255,217])],{type:'image/jpeg'}),
 fetch:async(path,opts={})=>{
  if(!opts.method)return Response.json(path.includes('/api/tools')?{cards:{batch:{enabled:true}}}:{configured:true,codeRequired:true});
  assert.equal(path,'/api/runware');const tasks=JSON.parse(opts.body);calls.push(tasks);requests++;
  if(requests<=failure)throw new Error('Network failed');
  return Response.json({data:[...tasks].reverse().map(t=>({taskUUID:t.taskUUID,imageURL:'https://im.runware.ai/image/'+t.taskUUID+'.jpg',cost:.01}))});
 }});
 const source=(await readFile(new URL('../public/batch-images/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('void init();','globalThis.ready=init();');vm.runInContext(source,context);await context.ready;
 const $=id=>document.getElementById(id);
 return {$,records,calls,downloads,read:()=>JSON.parse(vm.runInContext('JSON.stringify(batch)',context)),async json(count){$('jsonText').value=JSON.stringify({images:Array.from({length:count},(_,i)=>({name:`Name ${i+1}`,prompt:`Precise image prompt ${i+1}.`}))});await $('useJSON').onclick();},async click(id){assert.equal($(id).disabled,false,id);await $(id).onclick();}};
}
test('actual page loads 100 JSON items, runs the provider batches and automatically downloads a 100-image ZIP',async()=>{
 const b=await browser();await b.json(100);assert.equal(b.$('grid').querySelectorAll('.image-card').length,100);assert.equal(b.calls.length,0);assert.equal(b.$('downloadZip').disabled,true);await b.click('start');assert.equal(b.calls.length,9);assert.equal(b.$('percentage').textContent,'100%');assert.equal(b.$('readyCount').textContent,'100');assert.equal(b.$('downloadZip').disabled,false);assert.equal(b.downloads.length,1);assert.equal(b.downloads[0].name,'Pasted-prompts-images.zip');const data=Buffer.from(await b.downloads[0].blob.arrayBuffer());assert.equal(data.readUInt16LE(data.length-12),100);assert.equal(b.read().items[99].filename,'100.jpg');assert(b.records.get('image-batch-'+b.read().id).items.every(i=>i.status==='ready'));
});
test('network recovery in the actual page uses the saved task UUIDs, not duplicate image orders',async()=>{
 const b=await browser({failure:1});await b.json(2);await b.click('start');assert.equal(b.calls.length,2);assert(b.calls[1].every(t=>t.taskType==='getResponse'));assert.deepEqual(b.calls[0].map(t=>t.taskUUID),b.calls[1].map(t=>t.taskUUID));assert.equal(b.$('percentage').textContent,'100%');
});
test('invalid JSON leaves the previous batch intact and never dispatches generation',async()=>{
 const b=await browser();await b.json(2);const id=b.read().id;b.$('jsonText').value='{"images":[{"name":"Missing prompt"}]}';await b.click('useJSON');assert.equal(b.read().id,id);assert.match(b.$('notice').textContent,/needs a prompt/);assert.equal(b.calls.length,0);
});

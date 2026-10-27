import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {parseHTML} from 'linkedom';
import * as core from '../../public/documentary/narration-core.js';
import {filename} from '../../public/documentary/core.js';
export async function narrationFixture({project,media={},reply,join,recognize,assemble,configured=true}={}){
 const html=await readFile(new URL('../../public/documentary/index.html',import.meta.url),'utf8');
 const source=await readFile(new URL('../../public/documentary/narration-studio.js',import.meta.url),'utf8');
 const {document}=parseHTML(html),records=new Map(Object.entries(media)),calls=[],requests=[],timers=new Set(),intervals=new Set();
 if(project)records.set('narration-project',structuredClone(project));
 for(const el of document.querySelectorAll('select')){let v=el.querySelector('option[selected]')?.value||el.querySelector('option')?.value||'';Object.defineProperty(el,'value',{get:()=>v,set:value=>{v=String(value)},configurable:true});}
 for(const e of document.querySelectorAll('audio,video')){e.pause=()=>{};e.load=()=>{};}
 class Store{async get(k){return structuredClone(records.get(k)||null)}async put(k,v){records.set(k,structuredClone(v))}async delete(k){records.delete(k)}}
 let replyHandler=reply;
 const transport=async(url,options={})=>{if(!options.method)return Response.json({configured,enabled:true});const body=JSON.parse(options.body);requests.push({url,body});if(url!=='/api/documentary')throw new Error('Unexpected ChatGPT dependency: '+url);calls.push(body);if(options.signal?.aborted)throw new DOMException('Stopped','AbortError');let stop;const aborted=new Promise((_,reject)=>{stop=()=>reject(new DOMException('Stopped','AbortError'));options.signal?.addEventListener('abort',stop,{once:true})});try{const value=await Promise.race([Promise.resolve(replyHandler?.(body)||{data:[]}),aborted]);return value instanceof Response?value:Response.json(value)}finally{options.signal?.removeEventListener('abort',stop)}};
 const context=vm.createContext({...core,filename,DocumentaryStore:Store,document,fetch:transport,crypto:webcrypto,console,structuredClone,URL,Blob,Response,TextEncoder,TextDecoder,DOMException,AbortController,AbortSignal,
 fetchMedia:async()=>new Blob(['fixture media']),joinNarration:join||asyncJoin,recognizeAudio:recognize||asyncRecognize,parseSRT:()=>[],assembleNarrated:assemble||asyncAssemble,
 navigator:{locks:{request:async(n,o,fn)=>fn({name:n})}},history:{replaceState(){}},
 setTimeout(fn,ms){const t=setTimeout(()=>{timers.delete(t);fn()},ms>=1800?2:ms);timers.add(t);return t},clearTimeout(t){timers.delete(t);clearTimeout(t)},setInterval(fn,ms){const t=setInterval(fn,ms);intervals.add(t);return t},clearInterval(t){intervals.delete(t);clearInterval(t)}});
 vm.runInContext(await readFile(new URL('../../public/visuals/narration-alignment.js',import.meta.url),'utf8'),context);
 vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('void init();','globalThis.studioReady=init();'),context);await context.studioReady;
 return {calls,requests,records,document,el:id=>document.getElementById(id),read:()=>JSON.parse(vm.runInContext('JSON.stringify(project)',context)),busy:()=>vm.runInContext('busy',context),reply(fn){replyHandler=fn},input(id,value){const el=this.el(id);el.value=value;el.oninput?.()},trigger(id){const el=this.el(id);if(el.disabled)throw new Error('Disabled: '+id);return el.onclick?.({target:el})},change(id,value){const el=this.el(id);el.value=value;return el.onchange?.()},close(){timers.forEach(clearTimeout);intervals.forEach(clearInterval)}};
}
async function asyncJoin(){return {blob:new Blob(['wav']),duration:6}}
async function asyncRecognize(){return {words:[{text:'Hello',start:0,end:1},{text:'world',start:1,end:2},{text:'Our',start:3,end:4},{text:'story',start:4,end:6}]}}
async function asyncAssemble(){return {blob:new Blob(['final mp4']),duration:6}}

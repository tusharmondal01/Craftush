import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { DEFAULTS,choices } from '../public/visuals/automation-config.mjs';
const html=readFileSync(new URL('../public/visuals/index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../public/visuals/automation.mjs',import.meta.url),'utf8').replace(/^import .*;\n/,'');
function setup({stopAtPrompts=false,failedImage=false,stopAtAudio=false}={}){
 const {window,document}=parseHTML(html);
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{get(){return this._value??this.querySelector('option[selected]')?.getAttribute('value')??this.querySelector('option')?.getAttribute('value')??'';},set(v){this._value=String(v);},configurable:true});
 const memory=new Map(),calls=[],stages=[];let savedJob=null;
 const state={items:[],cost:{images:0,prompts:0,per:{}},timeline:[],transitionSeed:1,cutOverrides:new Map(),cutReviewed:new Set()};
 const script='भारत के घास के मैदानों में एक खास पक्षी रहता है। इसकी कहानी जानना जरूरी है।';
 const config={...DEFAULTS,enabled:true};
 const ctx=vm.createContext({window,document,DEFAULTS,choices,console,setTimeout,clearTimeout,setInterval,clearInterval,URL,Blob,File,Response,Option:class {constructor(label,value){const e=document.createElement('option');e.textContent=label;e.value=value;return e;}},localStorage:{getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)},state,voiceLoadTicket:0,TEXT_MODEL:'anthropic:claude@sonnet-4.6',teamCode:()=>'',imageModel:()=>document.getElementById('imgModel').value,applyModelRules(){},renderGrid(){},renderAll(){},refreshTimeline(){},updateButtons(){},saveScriptDraft(){},uuidSeed:()=>1,stopNarrationWorker(){state.transcribing=false;},resetNarrationReview(){},blobToB64:async()=>Buffer.from('image').toString('base64'),showStep:i=>stages.push(i),createVisualScenes:async()=>{calls.push('split');state.items=[{text:'first line',prompt:''},{text:'second line',prompt:''}];},writeVisualPrompts:async()=>{calls.push('prompts');state.items.forEach(it=>it.prompt='relevant full script shot');if(stopAtPrompts)document.getElementById('autoStop').onclick();},generateVisualImages:async()=>{calls.push('images');state.items.forEach((it,i)=>{if(!failedImage||!i){it.b64='aW1hZ2U=';it.qc={pass:true,score:9};it.imageSourceURL='https://im.runware.ai/image/'+i+'.jpg';}});},loadVoice:async file=>{calls.push('sync');assert.equal(file.name,'runware-narration.mp3');state.vo={duration:120};state.transcribing=false;state.timeline=[{start:0,end:100}];state.timingNeedsReview=false;},fetch:async(url,opts)=>{
  if(String(url).startsWith('https://')){if(stopAtAudio&&String(url).includes('/audio/'))document.getElementById('autoStop').onclick();return new Response('audio-or-image');}
  if(!opts?.method)return Response.json({config,configured:true,googleConnected:true});
  const b=JSON.parse(opts.body);calls.push(b.action);
  if(b.action==='start'){savedJob={id:'a'.repeat(64),episode:{title:'Great Indian Bustard'},config,textModel:'anthropic:claude@sonnet-4.6',cost:1};return Response.json({job:savedJob});}
  if(b.action==='resume')return Response.json({job:savedJob,projectToken:'c'.repeat(64)});
  if(b.action==='stop')return Response.json({stopped:true});
  if(b.action==='get')return Response.json({job:savedJob});
  if(b.action==='checkpoint'){savedJob.checkpoint=b.checkpoint;return Response.json({job:savedJob});}
  if(b.action==='research'){savedJob.research={sources:[{title:'Conservation source',url:'https://example.org'}],facts:[]};return Response.json({research:savedJob.research});}
  if(b.action==='script'){savedJob.script=script;return Response.json({script,hookType:'Myth Buster'});}
  if(b.action==='speech')return Response.json({data:[{audioURL:'https://am.runware.ai/audio/example.mp3',cost:.1}]});
  throw new Error('Unexpected action: '+b.action);
 }});
 vm.runInContext(source,ctx);
 return {ctx,document,state,calls,stages,memory,async ready(){await new Promise(r=>setTimeout(r,0));},start(){return document.getElementById('autoStart').onclick();},resume(){return document.getElementById('autoResume').onclick();},job:()=>savedJob};
}
test('Start button walks every stage and places generated narration into existing sync with review intact',async()=>{const f=setup();await f.ready();await f.start();assert.deepEqual(f.calls.filter(c=>!['checkpoint','get'].includes(c)),['start','research','script','split','prompts','images','speech','sync']);assert.deepEqual(f.stages,[0,1,2,3]);assert.equal(f.document.getElementById('autoProgress').value,7);assert.match(f.document.getElementById('autoStatus').textContent,/Generation complete/);assert.equal(f.document.getElementById('confirmTiming').checked,undefined,'never silently confirms a manual timing review');assert.equal(f.ctx.window.CraftushAutomation.running,false);assert.equal(f.job().checkpoint.items.length,2);assert(f.job().checkpoint.items.every(it=>!('b64'in it)));});
test('Stop during prompts retains work and does not submit images or speech',async()=>{const f=setup({stopAtPrompts:true});await f.ready();await f.start();assert(!f.calls.includes('images'));assert(!f.calls.includes('speech'));assert.match(f.document.getElementById('autoStatus').textContent,/Stopped/);assert.equal(f.document.getElementById('autoResume').hidden,false);assert(f.job().checkpoint.items.every(it=>it.prompt));});
test('failed images hold the workflow before narration and preserve completed image references',async()=>{const f=setup({failedImage:true});await f.ready();await f.start();assert(!f.calls.includes('speech'));assert.match(f.document.getElementById('autoStatus').textContent,/images failed/);assert(f.job().checkpoint.items[0].imageSourceURL);assert(!f.job().checkpoint.items[1].imageSourceURL);});
test('Resume completed scene assets reuses research, script, prompts, images and existing audio URL',async()=>{const f=setup();await f.ready();await f.start();f.calls.length=0;await f.resume();assert(!f.calls.includes('research'));assert(!f.calls.includes('script'));assert(!f.calls.includes('prompts'));assert(!f.calls.includes('images'));assert(!f.calls.includes('speech'));assert(f.calls.includes('sync'));});

test('Stop during audio download never starts a new transcription worker',async()=>{const f=setup({stopAtAudio:true});await f.ready();await f.start();assert(f.calls.includes('speech'));assert(!f.calls.includes('sync'));assert.match(f.document.getElementById('autoStatus').textContent,/Stopped/);assert.equal(f.state.voiceLoading,false);});
test('manual script edits exclude stale automation metadata from export',async()=>{const f=setup();await f.ready();await f.start();assert(f.ctx.window.CraftushAutomation.metadata()?.episode);f.document.getElementById('script').value='A different manually entered episode.';assert.equal(f.ctx.window.CraftushAutomation.metadata(),null);});

test('Resume finishes an interrupted image review while keeping checked images',async()=>{const f=setup();await f.ready();await f.start();delete f.job().checkpoint.items[1].qc;f.calls.length=0;await f.resume();assert(f.calls.includes('images'));assert(!f.calls.includes('prompts'));assert(!f.calls.includes('speech'));assert(f.job().checkpoint.items.every(it=>it.qc?.pass));});

test('resumed automation reports the saved provider ledger rather than local replay counters',async()=>{const f=setup();await f.ready();await f.start();f.state.cost.images=99;await f.resume();assert.equal(f.ctx.window.CraftushAutomation.reportedCost(),1);f.document.getElementById('script').value='Another manual script.';assert.equal(f.ctx.window.CraftushAutomation.reportedCost(),null);});

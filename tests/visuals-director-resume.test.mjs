import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/visuals/director.js',import.meta.url),'utf8');
function fixture(running){
 const nodes={videoTitle:{value:'Habitat conservation'},script:{value:'A bird lives here. Its habitat is shrinking.'},notes:{value:''},bible:{value:'topic: conservation'},qcMin:{value:'7'},style:{selectedOptions:[{textContent:'Documentary'}]}};
 const state={items:[{text:'A bird lives here.',prompt:'One bustard crosses a sandy clearing.',scene:{text_in_image:false,line:1,people:'none',character_ids:[],main_subject:'bustard'}},{text:'Its habitat is shrinking.',prompt:'',scene:{line:2,people:'none',character_ids:[],main_subject:'grassland'}}],cost:{prompts:0}};
 const calls=[],checkpoints=[];
 const ctx=vm.createContext({state,window:{CraftushAutomation:{running,checkpoint:async()=>checkpoints.push(JSON.parse(JSON.stringify(state.items)))}},console,$:s=>nodes[s.slice(1)],TEXT_MODEL:'selected-model',uuid:()=>String(calls.length),cleanMsg:s=>s,renderPrompts(){},imgSize:()=>[1536,864],frameWords:()=> 'horizontal frame',strength:()=>({words:'80 to 120'}),relay:async tasks=>{
  calls.push(tasks[0]);const prompt=tasks[0].messages[0].content;let answer;
  if(prompt.includes('LINES TO PLAN:'))answer=state.items.map((it,i)=>({...it.scene,line:i+1,main_subject:'updated '+i}));
  else if(prompt.includes('Act as a documentary editor'))answer=[{line:2,meaning_ok:true,subject_ok:true,facts_ok:true,continuity_ok:true,score:9}];
  else answer=[{line:2,prompt:'Fresh tractor furrows interrupt an otherwise intact dry grassland at midday.',has_person:false}];
  return {data:[{taskType:'textInference',text:JSON.stringify(answer),cost:.01}]};
 }});
 vm.runInContext(source,ctx);return {ctx,state,calls,checkpoints};
}
test('automation Resume keeps accepted scene plans and writes only the unfinished prompt',async()=>{
 const f=fixture(true),accepted=JSON.parse(JSON.stringify(f.state.items[0]));
 const plan=await vm.runInContext('planScenes(()=>{})',f.ctx);
 assert.equal(plan.planned,2);assert.equal(f.calls.length,0,'saved planning must not create a paid request');
 const result=await vm.runInContext('writeScenePrompts(()=>{})',f.ctx);
 assert.equal(result.failed,0);assert.equal(f.calls.length,2,'one writer and one relevance review');
 assert.deepEqual(JSON.parse(JSON.stringify(f.state.items[0])),accepted);assert.match(f.state.items[1].prompt,/tractor furrows/);
 assert.equal(f.checkpoints.length,2);assert.match(f.checkpoints.at(-1)[1].prompt,/tractor furrows/);
 assert(f.calls.every(task=>task.model==='selected-model'));
});
test('manual scene planning still allows regeneration of saved plans',async()=>{
 const f=fixture(false);await vm.runInContext('planScenes(()=>{})',f.ctx);
 assert.equal(f.calls.length,1);assert.equal(f.state.items[0].scene.main_subject,'updated 0');assert.equal(f.checkpoints.length,0);
});

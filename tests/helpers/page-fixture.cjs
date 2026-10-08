const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const base=path.join(__dirname,'../../public/visuals');
function previewFixture({confirm=true}={}){
  const elements=new Map(), drawn=[];
  function el(id){
    if(!elements.has(id)){
      const canvasContext={setTransform(){},translate(){},rotate(){},fillRect(){},drawImage(...args){drawn.push(args);}};
      const node={currentTime:0,pause(){},play(){return Promise.resolve();},load(){},value:'',checked:true,hidden:true,textContent:'',innerHTML:'',options:[],selectedOptions:[{dataset:{},textContent:''}],style:{setProperty(){}},classList:{add(){},remove(){},toggle(){},contains(){return false}},events:{},children:[],setAttribute(){},removeAttribute(){},focus(){},querySelector(){return el('child');},getContext(){canvasContext.canvas=node;return canvasContext;},addEventListener(name,fn){node.events[name]=fn;}};
      elements.set(id,node);
    }
    return elements.get(id);
  }
  Object.assign(el('#aspect'),{value:'768x1344',selectedOptions:[{value:'768x1344',dataset:{gpt:'1024x1536',hi:'1088x1920',seq:'1080x1920'},textContent:'9:16 vertical'}]});
  for(const [id,value] of Object.entries({'#imgModel':'openai:gpt-image@2','#quality':'high','#fps':'30','#trans':'auto','#transitionEnergy':'high','#motion':'alt','#zoomAmt':'.06','#mode':'cues'})) el(id).value=value;
  el('#zero').checked=false;el('#confirmTiming').checked=false;el('#useExistingImages').checked=false;el('#syncOffset').value='0';
  let raf=0;
  const page=vm.createContext({document:{querySelector:el,querySelectorAll:()=>[],addEventListener(){},createElement(){return el('canvas'+Math.random());}},localStorage:{getItem(){return null;},setItem(){}},console,crypto:crypto.webcrypto,URL,Blob,setTimeout,clearTimeout,requestAnimationFrame(){return ++raf;},cancelAnimationFrame(){},navigator:{},matchMedia(){return {matches:true};},Image:class{set src(url){this.url=url;queueMicrotask(()=>this.onload());}}});
  for(const file of ['transitions.js','narration-alignment.js','narration-sync.js','export-guide.js','premiere-auto.js','transition-preview.js']) vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),page);
  const html=fs.readFileSync(path.join(base,'index.html'),'utf8');
  const main=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const state ='));
  vm.runInContext(main.slice(0,main.indexOf('updateButtons();\nshowStep(0, false);')),page);
  vm.runInContext(`state.items=Array.from({length:4},(_,i)=>({text:'Scene '+i,prompt:'test',scene:{beat_role:i===3?'ending':'action'},url:'fixture-'+i,b64:'fixture',status:'done'}));state.cues=state.items.map((it,i)=>({text:it.text,start:i*4,end:(i+1)*4}));state.transitionSeed=50;refreshTimeline();`,page);
  if(confirm) vm.runInContext('state.timingConfirmed=true;document.querySelector("#confirmTiming").checked=true;updateButtons()',page);
  return {page,el,drawn,run:code=>vm.runInContext(code,page)};
}

module.exports={previewFixture};

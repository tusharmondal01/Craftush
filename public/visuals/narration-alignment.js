/* Ordered transcript alignment. This module never derives cuts from audio length or silence. */
(function(root){
  'use strict';
  const vowels = { 'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au' };
  const marks = { 'ा':'aa','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ॅ':'e','ॉ':'o' };
  const consonants = { 'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny','ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n','प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'sh','ष':'sh','स':'s','ह':'h','ळ':'l','क़':'q','ख़':'kh','ग़':'g','ज़':'z','ड़':'d','ढ़':'dh','फ़':'f' };
  const aliases = { mein:'men',main:'men',mei:'men',me:'men',hain:'hen',hai:'he',hey:'he',yeh:'ye',yah:'ye',woh:'vo',voh:'vo',wo:'vo',kyunki:'kyonki',kyonki:'kyonki',kyu:'kyun',kyoon:'kyun',bahut:'bahut',bohot:'bahut',bohat:'bahut',nahi:'nahin',nahin:'nahin',kya:'kya' };
  const numbers = [
    ['zero','shunya'],['one','ek'],['two','do'],['three','teen'],['four','chaar','char'],['five','paanch','panch'],['six','chhe','cheh'],['seven','saat','sat'],['eight','aath','ath'],['nine','nau'],['ten','das'],['eleven','gyarah'],['twelve','barah'],['thirteen','terah'],['fourteen','chaudah'],['fifteen','pandrah'],['sixteen','solah'],['seventeen','satrah'],['eighteen','atharah'],['nineteen','unnis'],['twenty','bees']
  ];
  const stops = new Set(('a an the and or of to in on for as is are was were it its this that be with from so but i you we they ' +
    'ka ki ke ko se he hen men aur ye vo ek bhi hi toh to hai hain mein me main').split(/\s+/));
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const spoken = text => String(text || '').replace(/\[[^\]]*\]/g,' ');
  function romanize(word){
    let out='';
    for(let i=0;i<word.length;i++){
      const c=word[i], next=word[i+1];
      if(consonants[c]){ out+=consonants[c]; if(next==='्'){ i++; } else if(marks[next]){ out+=marks[next]; i++; } else out+='a'; }
      else if(vowels[c]) out+=vowels[c];
      else if(c==='ं'||c==='ँ') out+='n';
      else if(c==='ः') out+='h';
      else if(c==='़') continue;
      else if(/[०-९]/.test(c)) out+=String(c.charCodeAt(0)-0x966);
      else out+=c;
    }
    if(/[\u0900-\u097f]/.test(word)) out=out.replace(/([bcdfghjklmnpqrstvwxyz])a$/,'$1');
    return out;
  }
  function normalize(word){
    let w=romanize(String(word).toLowerCase().normalize('NFKC')).normalize('NFKD').replace(/[\u0300-\u036f']/g,'');
    w=w.replace(/aa/g,'a').replace(/ee/g,'i').replace(/oo/g,'u').replace(/w/g,'v');
    w=aliases[w] || w;
    if(/^\d+$/.test(w)) return '#'+String(Number(w));
    for(let i=0;i<numbers.length;i++) if(numbers[i].some(n=>n.replace(/aa/g,'a').replace(/ee/g,'i').replace(/oo/g,'u').replace(/w/g,'v')===w)) return '#'+i;
    return w;
  }
  function tokenize(text){ return (spoken(text).match(/[\p{L}\p{M}\p{N}']+/gu)||[]).map(raw=>({raw,key:normalize(raw)})).filter(t=>t.key); }
  function distance(a,b){
    let row=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){
      let prev=row[0]; row[0]=i;
      for(let j=1;j<=b.length;j++){ const old=row[j]; row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]!==b[j-1])); prev=old; }
    }
    return row[b.length];
  }
  function similarity(a,b){
    if(a===b) return 1;
    if(a.startsWith('#')||b.startsWith('#')||Math.min(a.length,b.length)<4) return 0;
    const soften=w=>w.replace(/ph/g,'f').replace(/([kgtdbj])h/g,'$1').replace(/q/g,'k').replace(/c(?=[aou])/g,'k').replace(/c(?=[ei])/g,'s');
    const x=soften(a),y=soften(b);
    if(x===y) return .94;
    const s=1-distance(x,y)/Math.max(x.length,y.length);
    return s>=.78?s:0;
  }
  function fromCues(cues){
    const words=[]; let previous=-Infinity;
    for(let i=0;i<cues.length;i++){
      const c=cues[i];
      if(!finite(c.start)||!finite(c.end)||c.start<0||c.end<=c.start||c.start<previous-.01) throw new Error('Subtitle timings overlap or are invalid. Use subtitles exported from this exact narration.');
      previous=c.end;
      const ts=tokenize(c.text);
      ts.forEach((t,j)=>words.push({...t,start:c.start+(c.end-c.start)*j/ts.length,end:c.start+(c.end-c.start)*(j+1)/ts.length,exact:j===0,cue:i,source:'srt'}));
    }
    return words;
  }
  function fromWords(chunks,duration){
    const words=[]; let previous=-Infinity;
    for(const c of chunks){
      const [start,end]=c.timestamp || [c.start,c.end];
      if(!finite(start)||!finite(end)||start<0||end<=start||start<previous-.04||(finite(duration)&&end>duration+.2)) throw new Error('Speech recognition returned incomplete or invalid word timestamps. Load an SRT or set the affected starts while listening.');
      previous=start;
      const ts=tokenize(c.text);
      ts.forEach((t,j)=>words.push({...t,start:start+(end-start)*j/ts.length,end:start+(end-start)*(j+1)/ts.length,exact:ts.length===1,cue:null,source:'audio'}));
    }
    return words;
  }
  function align(items,words,{duration,offset=0,onePerCue=false,cues=[]}={}){
    if(!items.length) throw new Error('Create scenes first.');
    if(!words.length) throw new Error('The transcript contains no spoken words.');
    if(!finite(offset)) throw new Error('The subtitle offset must be a number of seconds.');
    const script=[],ranges=[];
    items.forEach((item,scene)=>{ const start=script.length; tokenize(item.text).forEach(t=>script.push({...t,scene})); ranges.push([start,script.length]); });
    const n=script.length,m=words.length;
    if(!n) throw new Error('The scene lines contain no spoken words.');
    if((n+1)*(m+1)>18000000) throw new Error('This transcript is too long to align safely in one project. Split the narration into parts.');
    const trace=new Uint8Array((n+1)*(m+1)), previous=new Float64Array(m+1), row=new Float64Array(m+1), cache=new Map();
    for(let j=0;j<=m;j++){ previous[j]=j*.9; if(j)trace[j]=2; }
    const sim=(a,b)=>{const k=a+'\0'+b;if(!cache.has(k))cache.set(k,similarity(a,b));return cache.get(k);};
    for(let i=1;i<=n;i++){
      row[0]=i*.9; trace[i*(m+1)]=1;
      for(let j=1;j<=m;j++){
        const s=sim(script[i-1].key,words[j-1].key), diag=previous[j-1]+(s?1-s:2.1), del=previous[j]+.9, ins=row[j-1]+.9;
        let best=diag,dir=0;
        if(del<best-1e-8){best=del;dir=1;} if(ins<best-1e-8){best=ins;dir=2;}
        row[j]=best; trace[i*(m+1)+j]=dir;
      }
      previous.set(row);
    }
    const matches=new Map(),used=new Set(); let i=n,j=m;
    while(i||j){ const d=trace[i*(m+1)+j]; if(!i||d===2){j--;}else if(!j||d===1){i--;}else{ const s=sim(script[i-1].key,words[j-1].key);if(s){matches.set(i-1,{index:j-1,score:s});used.add(j-1);}i--;j--; } }
    const rows=ranges.map(([a,b],scene)=>{
      const hits=[]; for(let k=a;k<b;k++) if(matches.has(k)) hits.push({script:k,...matches.get(k)});
      const content=script.slice(a,b).filter(t=>!stops.has(t.key));
      const contentHits=hits.filter(h=>!stops.has(script[h.script].key));
      const coverage=hits.length/(b-a||1), meaningful=contentHits.length/(content.length||1), first=matches.get(a);
      const candidate=hits.length?words[hits[0].index].start+offset:null;
      const start=onePerCue&&cues[scene]?cues[scene].start+offset:candidate;
      const reasons=[];
      if(!hits.length) reasons.push('No spoken-word match');
      if(coverage<.82||content.length&&meaningful<.7) reasons.push('Transcript differs from this scene');
      if(!first) reasons.push('First word is missing');
      else if(!words[first.index].exact) reasons.push('Scene begins inside an SRT cue; start is interpolated');
      else if(first.score<.94) reasons.push('First spoken word is a phonetic match; check its start');
      if(first&&words[first.index].source==='audio'&&words[first.index].end-words[first.index].start>1.2)reasons.push('First word timestamp is unusually long; check the start');
      if(content.length&&contentHits.length<Math.min(2,content.length)) reasons.push('Not enough meaningful words matched');
      if(onePerCue){
        const ct=tokenize(cues[scene]?.text||'');
        if(cues.length!==items.length||hits.some(h=>words[h.index].cue!==scene)||ct.length!==b-a) reasons.push('One-per-subtitle mode requires the same scenes in the same order');
      }
      return {i:scene,start,coverage,meaningful,matched: hits.map(h=>words[h.index].raw).join(' '),reasons,confidence:reasons.length?'review':'matched',wordStart:hits[0]?.index??null,wordEnd:hits[hits.length-1]?.index??null};
    });
    let extra=[];
    function closeExtra(){
      const content=extra.filter(k=>!stops.has(words[k].key));
      if(content.length>=3 && words[extra[extra.length-1]].end-words[extra[0]].start>1){
        const at=rows.findIndex(r=>r.wordStart!==null&&r.wordStart>extra[0]); const r=rows[at<0?rows.length-1:at];
        r.reasons.push('Audio contains extra narration near this scene');r.confidence='review';
      }
      extra=[];
    }
    for(let k=0;k<m;k++){ if(!used.has(k))extra.push(k);else if(extra.length)closeExtra(); } if(extra.length)closeExtra();
    if(matches.size/n<.9)rows.forEach(r=>{r.reasons.push('Narration transcript is incomplete; verify every scene start');r.confidence='review';});
    const end=finite(duration)?duration:words.reduce((end,w)=>Math.max(end,w.end+offset),0);
    return {rows,end,coverage:matches.size/n,matched:matches.size,total:n,source:onePerCue?'cues':'words'};
  }
  function parseTime(value){
    const s=String(value).trim(); if(/^\d+(?:\.\d+)?$/.test(s))return Number(s);
    const m=s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
    if(!m||+m[3]>=60||(m[1]&&+m[2]>=60))return NaN;
    return +(m[1]||0)*3600+(+m[2])*60+(+m[3])+(m[4]?+m[4]/10**m[4].length:0);
  }
  function formatTime(value){
    if(!finite(value)||value<0)return '';
    const ms=Math.round(value*1000),s=Math.floor(ms/1000);
    return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0');
  }
  function buildTimeline(rows,end,fps){
    if(!finite(end)||end<=0||!finite(fps)||fps<=0)return {clips:[],errors:['Narration length or frame rate is invalid.']};
    const endF=Math.round(end*fps), starts=rows.map(r=>finite(r.start)?Math.round(r.start*fps):NaN), errors=[];
    rows.forEach((r,k)=>{
      if(!Number.isInteger(starts[k])||starts[k]<0||starts[k]>=endF) errors.push(`Image ${k+1}: set a start inside the narration.`);
      if(k&&Number.isInteger(starts[k])&&starts[k]<=starts[k-1]) errors.push(`Image ${k+1}: start must be after the previous image by at least one frame.`);
    });
    if(errors.length)return {clips:[],errors};
    return {clips:rows.map((r,k)=>({i:r.i,start:starts[k],end:k+1<rows.length?starts[k+1]:endF})),errors:[]};
  }
  function wav(channels,sampleRate){
    if(!Array.isArray(channels)||!channels.length||channels.length>2||!finite(sampleRate)||sampleRate<8000)throw new Error('Unsupported narration audio format.');
    const n=channels[0].length,count=channels.length;
    if(channels.some(c=>c.length!==n))throw new Error('Narration channels have different lengths.');
    const size=n*count*2, buffer=new ArrayBuffer(44+size),view=new DataView(buffer);
    const str=(at,s)=>{for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i));};
    str(0,'RIFF');view.setUint32(4,36+size,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,count,true);
    view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*count*2,true);view.setUint16(32,count*2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,size,true);
    let at=44;for(let i=0;i<n;i++)for(let c=0;c<count;c++){const s=Math.max(-1,Math.min(1,channels[c][i]));view.setInt16(at,Math.round(s*(s<0?32768:32767)),true);at+=2;}
    return buffer;
  }
  root.CraftushAlignment=Object.freeze({tokenize,normalize,romanize,similarity,fromCues,fromWords,align,parseTime,formatTime,buildTimeline,wav});
})(typeof globalThis!=='undefined'?globalThis:this);

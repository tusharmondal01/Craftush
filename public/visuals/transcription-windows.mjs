/* Stitch by audio position. A single bad Whisper token must not discard a recording. */
const lexical = text => (String(text||'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu)||[]).join(' ');
function inspect(result, offset, length, coreStart, coreEnd){
  const words=[],issues=[],signature=[];let previous=-Infinity,uncertain=0;
  for(const word of result.chunks||[]){
    const key=lexical(word.text);if(!key)continue; // Punctuation has no spoken start.
    signature.push(key);
    const [a,b]=word.timestamp||[],validStart=Number.isFinite(a)&&a>=0&&a<length;
    const validEnd=Number.isFinite(b)&&b>a&&b<=length+.2;
    const position=validStart?offset+(validEnd?(a+b)/2:a):null;
    if(position!==null&&(position<coreStart||position>=coreEnd))continue;
    if(!validStart||a<previous-.04){
      issues.push({start:coreStart,end:coreEnd,kind:'missing-word-timing'});continue;
    }
    previous=a;
    if(!validEnd){
      // Preserve an observed start as an explicitly uncertain POINT, never invent an end.
      uncertain++;
      words.push({...word,timestamp:[offset+a,offset+a],timingUncertain:true});
    }else words.push({...word,timestamp:[offset+a,offset+b]});
  }
  if(!signature.length&&lexical(result.text))issues.push({start:coreStart,end:coreEnd,kind:'missing-word-timing'});
  return {words,issues,uncertain,signature:signature.join(' ')||lexical(result.text)};
}
export async function transcribeWindows(transcriber,audio,language,{sampleRate=16000,coreSeconds=15,contextSeconds=4,onChunk=()=>{}}={}){
  if(!(audio instanceof Float32Array)||!audio.length)throw new Error('No narration samples were supplied.');
  const duration=audio.length/sampleRate,step=Math.round(coreSeconds*sampleRate),context=Math.round(contextSeconds*sampleRate);
  if(!Number.isFinite(duration)||sampleRate<=0||!Number.isInteger(step)||step<=0||!Number.isInteger(context)||context<0||coreSeconds+2*contextSeconds>30)throw new Error('Invalid speech-recognition window size.');
  const chunks=[],issues=[],owners=new WeakMap(),total=Math.ceil(audio.length/step);let count=0,recovered=0;
  const options={task:'transcribe',...(language!=='auto'?{language}:{}),return_timestamps:'word'};
  for(let core=0;core<audio.length;core+=step){
    const end=Math.min(audio.length,core+step),from=Math.max(0,core-context),to=Math.min(audio.length,end+context),offset=from/sampleRate;
    const samples=audio.subarray(from,to),length=samples.length/sampleRate,coreStart=core/sampleRate,coreEnd=end/sampleRate;
    const result=await transcriber(samples,options);
    let selected=inspect(result,offset,length,coreStart,coreEnd);
    if(selected.uncertain||selected.issues.length){
      onChunk({phase:'recovering',count:count+1,total});
      // A bounded second pass with trailing silence can finish a cut-off final word.
      // Padding belongs only to recognition; exported narration is never changed.
      const padding=Math.min(Math.round(sampleRate*.75),Math.max(0,Math.floor(sampleRate*30)-samples.length));
      if(padding){
        const padded=new Float32Array(samples.length+padding);padded.set(samples);
        try{
          const retry=inspect(await transcriber(padded,options),offset,length,coreStart,coreEnd);
          // Do not substitute a different transcript or silently drop a difficult phrase.
          if(retry.signature===selected.signature&&retry.issues.length+retry.uncertain<selected.issues.length+selected.uncertain){selected=retry;recovered++;}
        }catch{ /* Keep the first pass and its explicit review flags if recovery fails. */ }
      }
    }
    for(const word of selected.words){
      const previous=chunks[chunks.length-1];
      // The same cut-off word may reappear with a full span in the next overlap.
      // Compare its audio position; identical words elsewhere remain separate.
      if(previous&&owners.get(previous)!==core&&(previous.timingUncertain||word.timingUncertain)&&lexical(previous.text)===lexical(word.text)&&Math.abs(previous.timestamp[0]-word.timestamp[0])<.04){
        if(previous.timingUncertain&&!word.timingUncertain){chunks[chunks.length-1]=word;owners.set(word,core);}
        continue;
      }
      if(previous&&word.timestamp[0]<previous.timestamp[0]-.04){issues.push({start:coreStart,end:coreEnd,kind:'missing-word-timing'});continue;}
      chunks.push(word);owners.set(word,core);
    }
    issues.push(...selected.issues);
    onChunk({count:++count,total});
  }
  if(!chunks.length)throw new Error('No usable spoken-word timestamps were found. Your audio is still loaded; add its SRT or set starts while listening.');
  return {text:chunks.map(word=>word.text).join('').trim(),chunks,issues,recovered};
}

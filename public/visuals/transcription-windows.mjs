/* Stitch by audio position rather than repeated transcript text at chunk boundaries. */
export async function transcribeWindows(transcriber,audio,language,{sampleRate=16000,coreSeconds=15,contextSeconds=4,onChunk=()=>{},recoverIncomplete=false}={}){
  if(!(audio instanceof Float32Array)||!audio.length)throw new Error('No narration samples were supplied.');
  const duration=audio.length/sampleRate,step=Math.round(coreSeconds*sampleRate),context=Math.round(contextSeconds*sampleRate);
  if(!Number.isFinite(duration)||sampleRate<=0||!Number.isInteger(step)||step<=0||!Number.isInteger(context)||context<0||coreSeconds+2*contextSeconds>30)throw new Error('Invalid speech-recognition window size.');
  const chunks=[],issues=[],total=Math.ceil(audio.length/step);let count=0;
  for(let core=0;core<audio.length;core+=step){
    const end=Math.min(audio.length,core+step),from=Math.max(0,core-context),to=Math.min(audio.length,end+context);
    const read=async(left,right)=>{
      let result;
      try{result=await transcriber(audio.subarray(left,right),{task:'transcribe',...(language!=='auto'?{language}:{}),return_timestamps:'word'});}
      catch(error){
        // Some recognizers reject during timestamp extraction, before returning chunks.
        if(!recoverIncomplete||!/timestamp/i.test(error?.message||''))throw error;
        return {words:[],missing:[{text:`Speech near ${(core/sampleRate).toFixed(1)}s`,windowStart:core/sampleRate,windowEnd:end/sampleRate}]};
      }
      const words=[],missing=[],shift=left/sampleRate;
      for(const word of result.chunks||[]){
        if(!String(word?.text||'').trim())continue;
        const [a,b]=Array.isArray(word.timestamp)?word.timestamp:[];
        const invalid=!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>(right-left)/sampleRate+.2;
        if(invalid){
          if(recoverIncomplete&&!/[\p{L}\p{N}]/u.test(word.text))continue;
          // Truncated words wholly outside the owned core belong to another window.
          if(recoverIncomplete&&((Number.isFinite(a)&&shift+a>=end/sampleRate)||(Number.isFinite(b)&&shift+b<=core/sampleRate)))continue;
          if(!recoverIncomplete)throw new Error('Speech recognition returned an incomplete word timestamp.');
          missing.push({text:String(word.text).trim(),windowStart:core/sampleRate,windowEnd:end/sampleRate});continue;
        }
        const midpoint=shift+(a+b)/2;
        if(midpoint>=core/sampleRate&&midpoint<end/sampleRate)words.push({...word,timestamp:[shift+a,shift+b]});
      }
      if(recoverIncomplete&&!words.length&&!missing.length&&String(result.text||'').trim())missing.push({text:`Speech near ${(core/sampleRate).toFixed(1)}s`,windowStart:core/sampleRate,windowEnd:end/sampleRate});
      return {words,missing};
    };
    let section=await read(from,to);
    if(recoverIncomplete&&section.missing.length){
      onChunk({count,total,retrying:true,start:core/sampleRate});
      const extra=Math.min(5,(30-coreSeconds)/2),alternateFrom=Math.max(0,core-Math.round(extra*sampleRate)),alternateTo=Math.min(audio.length,end+Math.round(extra*sampleRate));
      // Even the same final bounds get one fresh decode; never invent timestamps.
      const retried=await read(alternateFrom,alternateTo);
      // An empty retry must never erase words already measured in the first pass.
      if(retried.words.length&&(retried.missing.length<section.missing.length||retried.missing.length===section.missing.length&&retried.words.length>=section.words.length))section=retried;
    }
    chunks.push(...section.words);issues.push(...section.missing);
    onChunk({count:++count,total});
  }
  return {text:chunks.map(word=>word.text).join('').trim(),chunks,...(recoverIncomplete?{requiresReview:issues.length>0,issues}:{})};
}

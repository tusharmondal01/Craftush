/* Stitch by audio position rather than repeated transcript text at chunk boundaries. */
export async function transcribeWindows(transcriber,audio,language,{sampleRate=16000,coreSeconds=15,contextSeconds=4,onChunk=()=>{}}={}){
  if(!(audio instanceof Float32Array)||!audio.length)throw new Error('No narration samples were supplied.');
  const duration=audio.length/sampleRate,step=Math.round(coreSeconds*sampleRate),context=Math.round(contextSeconds*sampleRate);
  if(!Number.isFinite(duration)||sampleRate<=0||!Number.isInteger(step)||step<=0||!Number.isInteger(context)||context<0||coreSeconds+2*contextSeconds>30)throw new Error('Invalid speech-recognition window size.');
  const chunks=[],total=Math.ceil(audio.length/step);let count=0;
  for(let core=0;core<audio.length;core+=step){
    const end=Math.min(audio.length,core+step),from=Math.max(0,core-context),to=Math.min(audio.length,end+context),offset=from/sampleRate;
    const result=await transcriber(audio.subarray(from,to),{task:'transcribe',...(language!=='auto'?{language}:{}),return_timestamps:'word'});
    for(const word of result.chunks||[]){
      if(!String(word.text||'').trim())continue;
      const [a,b]=word.timestamp||[];
      if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>(to-from)/sampleRate+.2)throw new Error('Speech recognition returned an incomplete word timestamp. Use an SRT or set the affected starts while listening.');
      const midpoint=offset+(a+b)/2;
      if(midpoint>=core/sampleRate&&midpoint<end/sampleRate)chunks.push({...word,timestamp:[offset+a,offset+b]});
    }
    onChunk({count:++count,total});
  }
  return {text:chunks.map(word=>word.text).join('').trim(),chunks};
}

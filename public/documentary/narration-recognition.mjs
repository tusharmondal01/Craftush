import {transcribeWindows} from '../visuals/transcription-windows.mjs?v=20261027-audio-recovery2';

// Documentary analysis always recovers incomplete windows. It does not depend on
// an optional message flag or the strict worker used by the other video tools.
export async function recognizeNarration(transcriber,audio,language,onChunk=()=>{}){
 const result=await transcribeWindows(transcriber,audio,language,{recoverIncomplete:true,onChunk});
 return cleanRecognition(result,audio.length/16000);
}
export function cleanRecognition(result,duration){
 const chunks=[],issues=[...(result.issues||[])];let previous=-Infinity;
 for(const chunk of result.chunks||[]){
  if(!/[\p{L}\p{N}]/u.test(String(chunk?.text||'')))continue;
  const [start,end]=Array.isArray(chunk.timestamp)?chunk.timestamp:[];
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||start>=duration||end<=start||start<previous||end>duration+.1){issues.push({text:String(chunk.text).trim(),windowStart:Number.isFinite(start)?Math.max(0,start):0,windowEnd:duration});continue;}
  chunks.push({...chunk,timestamp:[start,Math.min(end,duration)]});previous=Math.min(end,duration);
 }
 return {text:chunks.map(c=>c.text).join('').trim(),chunks,issues,requiresReview:result.requiresReview===true||issues.length>0||!chunks.length};
}

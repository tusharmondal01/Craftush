// Only unavailable task results are pending. Unavailable models and failed
// provider requests must be surfaced instead of being polled indefinitely.
export function pendingResult(error){
 if(!error)return false;
 const code=String(error.code||'').replace(/[^a-z]/gi,'');
 if(/^(?:(?:async)?task|response|result|generation)(?:notfound|notready|notavailable|processing|pending)$/i.test(code))return true;
 if(code&&!/^(notfound|notready|notavailable|processing|pending)$/i.test(code))return false;
 return /(?:task|result|response|generation).*(?:not (?:yet )?(?:found|ready|available)|still processing)/i.test(String(error.message||''));
}
export function taskFailure(result,id){
 const error=(result.errors||[]).find(e=>!e.taskUUID||e.taskUUID===id);
 if(error)return error;
 const truncated=(result.data||[]).find(e=>e.taskUUID===id&&['length','max_tokens','token_limit'].includes(e.finishReason));
 if(truncated)return {taskUUID:id,code:'textResponseTruncated',message:'Claude reached its response token limit before completing the text. Start a new shot plan request to use the corrected planner. Your saved narration can be reused.'};
 const failed=(result.data||[]).find(e=>e.taskUUID===id&&e.status==='error');
 return failed?{...(failed.error||{}),taskUUID:id,message:failed.error?.message||'Runware reported that this task failed.'}:null;
}
export function waitExpired(task,type,now=Date.now()){
 const start=Date.parse(task.started);
 return type==='text'&&Number.isFinite(start)&&now-start>=300000;
}

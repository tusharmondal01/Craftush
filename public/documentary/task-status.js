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
 const failed=(result.data||[]).find(e=>e.taskUUID===id&&e.status==='error');
 return failed?{...(failed.error||{}),taskUUID:id,message:failed.error?.message||'Runware reported that this task failed.'}:null;
}
export function waitExpired(task,type,now=Date.now()){
 const start=Date.parse(task.started);
 return type==='text'&&Number.isFinite(start)&&now-start>=300000;
}

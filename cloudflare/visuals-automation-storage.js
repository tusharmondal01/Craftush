// All claims and series-history updates execute atomically inside one Durable Object.
export function automationStorage(storage,sql,operation,payload){
 sql.exec('CREATE TABLE IF NOT EXISTS visuals_runs (id TEXT PRIMARY KEY, document TEXT NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS visuals_tasks (key TEXT PRIMARY KEY, job_id TEXT NOT NULL, document TEXT NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS visuals_sources (url TEXT PRIMARY KEY, job_id TEXT NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS visuals_tokens (hash TEXT PRIMARY KEY, job_id TEXT NOT NULL)');
 const read=id=>{const row=sql.exec('SELECT document FROM visuals_runs WHERE id = ?',id).toArray()[0];if(!row)throw new Error('Run not found.');return JSON.parse(row.document);};
 const write=job=>sql.exec('INSERT OR REPLACE INTO visuals_runs (id,document) VALUES (?,?)',job.id,JSON.stringify(job));
 return storage.transactionSync(()=>{
  if(operation==='usage'){
   const rows=sql.exec("SELECT json_extract(document, '$.taskType') AS type, SUM(json_extract(document, '$.cost')) AS cost, COUNT(*) AS count, MIN(json_extract(document, '$.completedAt')) AS first, MAX(json_extract(document, '$.completedAt')) AS last FROM visuals_tasks WHERE json_extract(document, '$.state') = 'done' AND json_extract(document, '$.taskType') != 'sheetRead' AND json_extract(document, '$.completedAt') > ? GROUP BY type",payload.since||'').toArray();
   const usage={images:0,prompts:0,audio:0,cost:0,first:null,last:null};
   for(const row of rows){usage.cost+=Number(row.cost)||0;usage[row.type==='imageInference'?'images':row.type==='audioInference'?'audio':'prompts']+=row.count;if(row.last>String(usage.last||''))usage.last=row.last;if(!usage.first||row.first<usage.first)usage.first=row.first;}
   return usage;
  }
  if(operation==='start'){
   const existing=sql.exec('SELECT document FROM visuals_runs WHERE id = ?',payload.id).toArray()[0];
   if(existing)return {job:JSON.parse(existing.document),existing:true};
   const previous=sql.exec('SELECT document FROM visuals_runs ORDER BY rowid DESC LIMIT 100').toArray().map(r=>JSON.parse(r.document)).find(j=>j.hookType);
   const usedSources=sql.exec('SELECT url FROM visuals_sources ORDER BY rowid DESC LIMIT 500').toArray().map(r=>r.url);
   const job={...payload,previousHook:previous?.hookType||'',usedSources,cost:0};write(job);
   if(job.tokenHash)sql.exec('INSERT INTO visuals_tokens (hash,job_id) VALUES (?,?)',job.tokenHash,job.id);
   return {job,existing:false};
  }
  if(operation==='connection'){
   const row=sql.exec('SELECT job_id FROM visuals_tokens WHERE hash = ?',payload.hash).toArray()[0];
   return {job:row?read(row.job_id):null};
  }
  if(operation==='resume'||operation==='stop'){
   const job=read(payload.id);job.stopped=operation==='stop';
   if(operation==='resume'&&payload.tokenHash){
    sql.exec('DELETE FROM visuals_tokens WHERE job_id = ?',job.id);
    job.tokenHash=payload.tokenHash;job.expiresAt=payload.expiresAt;
    sql.exec('INSERT INTO visuals_tokens (hash,job_id) VALUES (?,?)',job.tokenHash,job.id);
   }
   write(job);return {job};
  }
  if(operation==='sheet'){
   const job=read(payload.id);if(!job.episode){job.episode=payload.episode;write(job);}return {job};
  }
  if(operation==='queue'||operation==='dispatch'){
   const job=read(payload.id);
   const rows=sql.exec('SELECT key, document FROM visuals_tasks WHERE job_id = ? ORDER BY rowid',job.id).toArray();
   const tasks=rows.map(row=>({key:row.key,...JSON.parse(row.document)}));
   if(operation==='queue')return {tasks};
   if(job.stopped||Date.parse(job.expiresAt)<=Date.now())throw new Error('This project is stopped or its connection expired. Resume on Craftush.');
   const active=tasks.filter(t=>t.state==='pending'&&t.dispatchedAt);
   const limit=job.checkpoint?.phase===4?Math.min(8,Math.max(1,Number(job.config?.conc)||1)):1;
   const task=(active.length<limit&&tasks.find(t=>t.state==='pending'&&!t.dispatchedAt))||active[0];
   if(!task)return {task:null};
   const submissionRequired=!task.dispatchedAt;
   if(submissionRequired){task.dispatchedAt=new Date().toISOString();const {key,...record}=task;sql.exec('UPDATE visuals_tasks SET document = ? WHERE key = ?',JSON.stringify(record),key);}
   return {task,submissionRequired};
  }
  if(operation==='get')return {job:read(payload.id)};
  if(['checkpoint','research','script'].includes(operation)){
   const job=read(payload.id);
   if((operation==='research'&&job.research)||(operation==='script'&&job.script))return {job};
   if(operation==='checkpoint')job.checkpoint=payload.checkpoint;
   if(operation==='research'){
    for(const s of payload.research.sources){const row=sql.exec('SELECT job_id FROM visuals_sources WHERE url = ?',s.url).toArray()[0];if(row&&row.job_id!==job.id)throw new Error('A source was already used by another script.');}
    job.research=payload.research;
   }
   if(operation==='script'){
    for(const source of job.research.sources){const row=sql.exec('SELECT job_id FROM visuals_sources WHERE url = ?',source.url).toArray()[0];if(row&&row.job_id!==job.id)throw new Error('Another script already used this source. New research is needed.');}
    job.script=payload.script;job.hookType=payload.hookType;job.words=payload.words;job.claimChecks=payload.claimChecks||[];job.issuesRemoved=payload.issuesRemoved||[];
    for(const s of job.research.sources)sql.exec('INSERT OR IGNORE INTO visuals_sources (url,job_id) VALUES (?,?)',s.url,job.id);
   }
   write(job);return {job};
  }
  const row=sql.exec('SELECT document FROM visuals_tasks WHERE key = ?',payload.key).toArray()[0];let record=row?JSON.parse(row.document):null;
  if(operation==='claim'){
   if(record&&!(record.state==='error'&&payload.retry))return {record,created:false};
   const job=read(payload.jobId);if(job.stopped)throw new Error('Project stopped. Resume on Craftush.');
   if((record?.attempt||0)>=3)throw new Error('This task reached its three-attempt limit.');
   record={taskUUID:payload.taskUUID,jobId:payload.jobId,state:'pending',createdAt:new Date().toISOString(),attempt:(record?.attempt||0)+1,...(payload.task?{task:payload.task,kind:payload.kind}:{}),...(payload.existingSubmission?{dispatchedAt:new Date().toISOString()}:{})};
   sql.exec('INSERT OR REPLACE INTO visuals_tasks (key,job_id,document) VALUES (?,?,?)',payload.key,payload.jobId,JSON.stringify(record));return {record,created:true};
  }
  if(!record)throw new Error('Task not found.');
  if(payload.taskUUID&&record.taskUUID!==payload.taskUUID)throw new Error('Task UUID no longer matches.');
  if(operation==='complete'&&record.state==='done'&&JSON.stringify(record.result)!==JSON.stringify(payload.result))throw new Error('This task already has a different result.');
  if(operation==='failed'&&record.state!=='done'){record.state='error';record.message=payload.message;}
  else if(operation==='complete'&&record.state!=='done'){
   record.state='done';record.result=payload.result;record.cost=payload.cost;record.taskType=payload.taskType;record.completedAt=new Date().toISOString();
   const job=read(record.jobId);job.cost=(job.cost||0)+payload.cost;write(job);
  }
  sql.exec('UPDATE visuals_tasks SET document = ? WHERE key = ?',JSON.stringify(record),payload.key);return {record};
 });
}

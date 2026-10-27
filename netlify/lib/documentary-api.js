import { WORKFLOW } from './documentary-workflow.js';
import { storageErrorResponse } from './storage-errors.js';
import { parseMaster, validatePrompt, UUID } from '../../public/documentary/core.js';
import { buildNarrationTask, NARRATION_ACTIONS } from './narration-tasks.js';
import { recoverNarrationResult } from './narration-session.js';
import { pendingResult, taskFailure } from '../../public/documentary/task-status.js';
import { packPlanRequests } from '../../public/documentary/narration-core.js';

function fitPlanReply(result,body){
  if(body.action!=='narration-plan'||taskFailure(result,body.taskUUID))return result;
  const output=result.data?.find(item=>item.taskUUID===body.taskUUID&&item.text);
  if(!output)return result;
  try{const plan=packPlanRequests(output.text,body.audioDuration,body.words);return {...result,data:result.data.map(item=>item===output?{...item,text:JSON.stringify(plan)}:item)};}
  catch(error){return {...result,errors:[...(result.errors||[]),{taskUUID:body.taskUUID,code:'invalidShotPlan',message:error.message}]};}
}

export function buildDocumentaryTask(body,options) {
  if (NARRATION_ACTIONS.has(body?.action)) return buildNarrationTask(body,options);
  if (!body || !UUID.test(String(body.taskUUID || ''))) throw new Error('A unique task UUID is required.');
  const base = { taskUUID: body.taskUUID, numberResults: 1, deliveryMethod: 'async', includeCost: true };
  if (body.action === 'master') {
    if (typeof body.idea !== 'string' || !body.idea.trim() || body.idea.length > 20000) throw new Error('Enter a documentary idea of at most 20000 characters.');
    return { ...base, taskType: 'textInference', model: WORKFLOW.master.model, outputFormat: 'TEXT',
      messages: [{ role: 'user', content: body.idea }], settings: structuredClone(WORKFLOW.master.settings), includeUsage: false };
  }
  if (body.action === 'director') {
    parseMaster(body.master);
    if (!Number.isInteger(body.scene) || body.scene < 1 || body.scene > 13) throw new Error('Choose a scene from 1 to 13.');
    return { ...base, taskType: 'textInference', model: WORKFLOW.director.model, outputFormat: 'TEXT',
      messages: [{ role: 'user', content: body.master + '\n\nTARGET SCENE: scene' + body.scene }], settings: structuredClone(WORKFLOW.director.settings), includeUsage: false };
  }
  if (body.action === 'video') {
    validatePrompt(body.prompt);
    return { ...base, ...structuredClone(WORKFLOW.video), taskType: 'videoInference', positivePrompt: body.prompt };
  }
  throw new Error('Unknown documentary action.');
}

export function publicWorkflow() {
  return { version: WORKFLOW.version, sceneCount: WORKFLOW.sceneCount, sceneSeconds: WORKFLOW.sceneSeconds, totalSeconds: WORKFLOW.totalSeconds,
    width: WORKFLOW.width, height: WORKFLOW.height, models: { master: WORKFLOW.master.model, director: WORKFLOW.director.model, video: WORKFLOW.video.model }, music: WORKFLOW.music, sourceHashes: WORKFLOW.sourceHashes,
    narrationFirst: { version: 'documentary-narration-1', maxRequests: 100, maxRequestSeconds: 15, scriptApprovalRequired: true, textModel: 'anthropic:claude@sonnet-4.6', audioModels: ['google:gemini@3.1-flash-tts','fishaudio:s2.1@pro'] } };
}

export function sanitizeReply(data, secret = '') {
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['apiKey', 'connectionSessionUUID', 'reasoningContent', 'authentication'].includes(k)).map(([k, v]) => [k, clean(v)]));
    if (typeof value === 'string' && secret) return value.split(secret).join('[redacted]');
    return value;
  };
  const result = clean(data || {});
  if (Array.isArray(result.data)) result.data = result.data.filter(d => d && d.taskType !== 'authentication');
  return result;
}

// Dependency injection keeps authorization, resumable tasks and provider errors testable.
export function createDocumentaryHandler(deps) {
  const { openStore, readSettings, activeKey, teamCodeOk, dashboardView, json, fail, fetch: request, runwareURL, limitRunwareTasks = async () => null } = deps;
  return async req => {
    let receipt, receiptKey, store, secret;
    try {
      store = openStore();
      const settings = await readSettings(store);
      secret = activeKey(settings);
      const enabled = dashboardView(settings).cards.documentary.enabled !== false;
      if (req.method === 'GET') return json({ configured: !!secret, codeRequired: !!settings.teamCode, enabled, workflow: publicWorkflow(), version: '17' });
      if (req.method !== 'POST') return fail('Method not allowed', 405);
      if (!(await teamCodeOk(req, settings))) return fail('Wrong team access code. Ask your admin for the current code.', 401);
      if (!enabled) return fail('Documentary Studio is turned off by the admin.', 403);
      if (!secret) return fail('Add your Runware API key in /admin before generating a documentary.', 503);
      const raw = await req.text();
      if (raw.length > 240000) return fail('This documentary request is too large.', 413);
      let body;
      try { body = JSON.parse(raw); } catch { return fail('Invalid JSON request', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('A documentary request object is required.', 400);
      if (body.action === 'check-access') return json({ ok: true });
      if (!UUID.test(String(body.taskUUID || ''))) return fail('A valid task UUID is required.', 400);
      receiptKey = 'documentary-task-' + body.taskUUID;
      receipt = await store.get(receiptKey, { type: 'json' });
      const savedReply=async()=>{const result=fitPlanReply(receipt.result,body);if(JSON.stringify(result)!==JSON.stringify(receipt.result)){receipt.result=result;receipt.status=taskFailure(result,body.taskUUID)?'error':'complete';await store.setJSON(receiptKey,receipt);}return json(result);};
      let task;
      if (body.action === 'poll') {
        if (!receipt) return fail('This task is not registered with Documentary Studio. Restore the project on its original website.', 404);
        if (receipt.result) return savedReply();
        task = { taskType: 'getResponse', taskUUID: body.taskUUID };
      } else {
        try { task = buildDocumentaryTask(body); } catch (e) { return fail(e.message, 400); }
        const digestTask=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');
        const fingerprint = await digestTask(task);
        if (receipt) {
          // Existing jobs retain their exact old model settings and UUID. The
          // corrected planner settings apply only to a new paid submission.
          const legacyMatch=receipt.kind==='narration-plan'&&body.action==='narration-plan'&&receipt.fingerprint===await digestTask(buildDocumentaryTask(body,{legacyPlanner:true}));
          if (receipt.fingerprint !== fingerprint&&!legacyMatch) return fail('This task ID already belongs to a different request. Start a new task.', 409);
          // Never repeat a paid generation after a lost acknowledgement or page refresh.
          if (receipt.result) return savedReply();
          task = { taskType: 'getResponse', taskUUID: body.taskUUID };
        } else {
          if (body.recoverOnly === true) {
            let recovered;
            try{recovered=await recoverNarrationResult(store,body.projectToken,task);}
            catch(error){if(body.action!=='narration-plan')throw error;recovered=await recoverNarrationResult(store,body.projectToken,buildDocumentaryTask(body,{legacyPlanner:true}));}
            receipt = { id: body.taskUUID, fingerprint, kind: body.action, created: new Date().toISOString(), status: recovered ? 'complete' : 'submitted', ...(recovered ? { result: recovered } : {}) };
            await store.setJSON(receiptKey, receipt);
            if (recovered) return savedReply();
            task = { taskType: 'getResponse', taskUUID: body.taskUUID };
          } else {
          const blocked = await limitRunwareTasks([task]);
          if (blocked) return blocked;
          receipt = { id: body.taskUUID, fingerprint, kind: body.action, created: new Date().toISOString(), status: 'submitted' };
          await store.setJSON(receiptKey, receipt);
          }
        }
      }
      if (task.taskType === 'getResponse') {
        const blocked = await limitRunwareTasks([task]);
        if (blocked) return blocked;
      }
      const upstream = await request(runwareURL, { method: 'POST', signal: AbortSignal.timeout(48000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ taskType: 'authentication', apiKey: secret }, task]) });
      let result;
      try { result = sanitizeReply(await upstream.json(), secret); } catch { return fail('Runware returned an unreadable response. Resume this task to check its result.', 502); }
      result=fitPlanReply(result,body);
      if (Array.isArray(result.errors)) result.errors = result.errors.map(e => ({ ...e, message: String(e.message || 'Runware reported an error.').replace(/<[^>]*>/g, ' ').slice(0, 600) }));
      const items = Array.isArray(result.data) ? result.data : [];
      const failure = taskFailure(result,body.taskUUID);
      const terminal = failure && !pendingResult(failure);
      if(terminal&&!(result.errors||[]).some(e=>!e.taskUUID||e.taskUUID===body.taskUUID))result.errors=[...(result.errors||[]),failure];
      const output = !terminal&&items.find(d => d.taskUUID === body.taskUUID && (typeof d.text === 'string' && d.text.length || d.videoURL || d.audioURL));
      if (output || terminal) {
        receipt.status = output ? 'complete' : 'error'; receipt.result = result;
        await store.setJSON(receiptKey, receipt);
      }
      return json(result, upstream.ok || task.taskType==='getResponse' && failure && pendingResult(failure) ? 200 : upstream.status);
    } catch (e) {
      const storageFailure = storageErrorResponse(e);
      if (storageFailure) return storageFailure;
      // Keep a submitted receipt on transport failure; only polling can establish its outcome.
      return fail(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Runware has not acknowledged the task yet. Resume to check the same task; it will not be submitted twice.' : 'The documentary service could not complete the request. Check access and resume the existing task.', 502);
    }
  };
}


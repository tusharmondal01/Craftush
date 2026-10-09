import { buildDocumentaryTask, publicWorkflow } from './documentary-api.js';
import { storageErrorResponse } from './storage-errors.js';
import { newProject, restoreProject, parseMaster, validatePrompt, UUID } from '../../public/documentary/core.js';

const TOKEN = /^[0-9a-f]{64}$/;
const HOUR = 3600000;
const forbidden = /^(?:api.?key|runware.?key|authorization|authentication|connectionSessionUUID|password|secret|access.?token)$/i;
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
const freshToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
function rejectSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.test(key)) throw new Error('Provider credentials are not accepted here. Connect Runware in ChatGPT and enter the key only on Runware’s secure connection page.');
    rejectSecrets(child);
  }
}
function nextTask(record) {
  if (!record.project.master.text) return { kind: 'master' };
  for (const scene of record.project.scenes) {
    if (!scene.prompt) return { kind: 'director', scene: scene.index };
    if (!scene.videoURL) return { kind: 'video', scene: scene.index };
  }
  return null;
}
function summary(record) {
  return { projectId: record.project.id, title: record.project.title, expiresAt: record.expiresAt, revision: record.revision,
    masterReady: !!record.project.master.text, readyScenes: record.project.scenes.filter(s => s.videoURL).length, sceneCount: 13,
    next: nextTask(record), scenes: record.project.scenes.map(s => ({ scene: s.index, directionReady: !!s.prompt, videoReady: !!s.videoURL,
      directorTask: s.directorTask, videoTask: s.videoTask })), workflow: publicWorkflow() };
}
function taskState(job) {
  return { id: job.id, status: job.status, started: job.created, error: job.error || '', progress: job.status === 'complete' ? 100 : 0 };
}
function updateProjectTask(record, job) {
  const state = taskState(job);
  if (job.kind === 'master') record.project.master.task = state;
  else record.project.scenes[job.scene - 1][job.kind === 'director' ? 'directorTask' : 'videoTask'] = state;
}

// This receiver has no provider fetch dependency and never reads activeKey().
// ChatGPT calls Runware directly; only bounded, validated results enter this store.
export function createChatGPTBridge(deps) {
  const { openStore, readSettings, teamCodeOk, dashboardView, json, fail, now = () => Date.now() } = deps;
  return async req => {
    try {
      if (req.headers.has('authorization')) return fail('Set the Craftush connection authentication to None. Provider credentials must only be sent to Runware.', 400);
      if (req.method === 'GET') {
        const settings = await readSettings(openStore());
        return json({ enabled: dashboardView(settings).cards.documentary.enabled !== false, codeRequired: !!settings.teamCode,
          keyRequired: false, workflow: publicWorkflow(), version: 'chatgpt-mcp-1' });
      }
      if (req.method !== 'POST') return fail('Method not allowed', 405);
      const raw = await req.text();
      if (raw.length > 90000) return fail('Keep each project handoff below 90000 characters.', 413);
      let body;
      try { body = JSON.parse(raw); } catch { return fail('Invalid JSON request', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('A project request object is required.', 400);
      rejectSecrets(body);
      const store = openStore(), settings = await readSettings(store);
      if (dashboardView(settings).cards.documentary.enabled === false) return fail('Documentary Studio is disabled.', 403);
      if (body.action === 'create') {
        if (!(await teamCodeOk(req, settings))) return fail('Enter the correct team access code.', 401);
        if (req.headers.get('origin') !== new URL(req.url).origin) return fail('Create the connection from the Craftush website.', 403);
        if (typeof body.idea !== 'string' || !body.idea.trim() || body.idea.length > 20000) return fail('Enter an idea of at most 20000 characters.', 400);
        const period = Math.floor(now() / HOUR);
        const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
        const rateKey = 'chatgpt-create-' + await digest(ip + ':' + period);
        const count = Number(await store.get(rateKey, { type: 'json' })) || 0;
        if (count >= 20) return fail('The connection limit has been reached. Try again in an hour.', 429);
        await store.setJSON(rateKey, count + 1);
        const project = newProject(); project.generationSource = 'chatgpt'; project.title = String(body.title || '').slice(0, 120); project.idea = body.idea.trim();
        const token = freshToken(), expiresAt = new Date(now() + 24 * HOUR).toISOString();
        const record = { project, expiresAt, revision: 0, jobs: {} };
        await store.setJSON('chatgpt-project-' + await digest(token), record);
        return json({ ...summary(record), projectToken: token }, 201);
      }
      if (!TOKEN.test(String(body.projectToken || ''))) return fail('A valid project connection code is required.', 401);
      const key = 'chatgpt-project-' + await digest(body.projectToken);
      const record = await store.get(key, { type: 'json' });
      if (!record || record.revoked || Date.parse(record.expiresAt) <= now()) return fail('This project connection has expired or was ended. Create a new connection.', 410);
      const save = async () => { record.revision++; record.project.updated = new Date(now()).toISOString(); await store.setJSON(key, record); };
      if (body.action === 'read') return json(summary(record));
      if (body.action === 'project') return json({ ...summary(record), project: restoreProject(record.project) });
      if (body.action === 'revoke') { record.revoked = true; await save(); return json({ ended: true }); }
      if (body.action === 'prepare') {
        const target = body.kind ? { kind: body.kind, scene: body.scene } : nextTask(record);
        if (!target) return json({ complete: true, ...summary(record) });
        if (!['master', 'director', 'video'].includes(target.kind)) return fail('Choose master, director or video.', 400);
        if (target.kind === 'master') delete target.scene;
        if (target.kind !== 'master' && (!Number.isInteger(target.scene) || target.scene < 1 || target.scene > 13)) return fail('Choose a scene from 1 to 13.', 400);
        const scene = target.kind === 'master' ? null : record.project.scenes[target.scene - 1];
        if (target.kind !== 'master' && !record.project.master.text) return fail('Complete the master story plan first.', 409);
        if (target.kind === 'video' && !scene.prompt) return fail('Complete this scene direction first.', 409);
        const slot = target.kind + (target.scene || '');
        let job = record.jobs[slot];
        const alreadyReady = target.kind === 'master' ? !!record.project.master.text : target.kind === 'director' ? !!scene.prompt : !!scene.videoURL;
        if (alreadyReady) return json({ complete: true, taskUUID: job?.id, kind: target.kind, scene: target.scene, ...summary(record) });
        if (body.retry === true && job?.status !== 'error') return fail('Only an explicitly failed task can be retried. Poll uncertain tasks using their existing UUID.', 409);
        if (job && body.retry !== true) return json({ submissionRequired: false, kind: job.kind, scene: job.scene, taskUUID: job.id,
          status: job.status, error: job.error || '', pollRequest: [{ taskType: 'getResponse', taskUUID: job.id }] });
        if ((job?.attempt || 0) >= 3) return fail('This task has reached its retry limit. Start a new project after reviewing the failure.', 409);
        const id = crypto.randomUUID();
        const task = buildDocumentaryTask({ action: target.kind, taskUUID: id, idea: record.project.idea, master: record.project.master.text,
          scene: target.scene, prompt: scene?.prompt });
        const request = [task];
        if (JSON.stringify(request).length > 88000) return fail('The complete scene context exceeds the ChatGPT handoff limit. Save this project and review the story length.', 413);
        job = { id, kind: target.kind, ...(target.scene ? { scene: target.scene } : {}), created: new Date(now()).toISOString(),
          status: 'prepared', attempt: (job?.attempt || 0) + 1 };
        record.jobs[slot] = job; updateProjectTask(record, job); await save();
        return json({ submissionRequired: true, kind: job.kind, scene: job.scene, taskUUID: id, status: job.status, request,
          pollRequest: [{ taskType: 'getResponse', taskUUID: id }] });
      }
      if (body.action === 'record') {
        if (!UUID.test(String(body.taskUUID || ''))) return fail('A valid task UUID is required.', 400);
        const job = Object.values(record.jobs).find(j => j.id === body.taskUUID);
        if (!job) return fail('This task does not belong to this project.', 404);
        const result = body.result;
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.taskUUID !== job.id) return fail('The Runware result must match the prepared task UUID.', 400);
        const clean = { taskUUID: job.id };
        if (typeof result.error === 'string' && result.error) clean.error = result.error.replace(/<[^>]*>/g, ' ').slice(0, 600);
        else if (typeof result.text === 'string' && result.text) {
          if (job.kind === 'video') return fail('This task requires a video result.', 400);
          if (result.finishReason === 'length') clean.error = 'Runware truncated this response. Retry the failed task before continuing.';
          else {
            if (job.kind === 'master') parseMaster(result.text); else validatePrompt(result.text);
            clean.text = result.text;
          }
        } else if (typeof result.videoURL === 'string' && result.videoURL) {
          if (job.kind !== 'video') return fail('This task requires a text result.', 400);
          const candidate = newProject(); candidate.scenes[0].videoURL = result.videoURL;
          const url = restoreProject(candidate).scenes[0].videoURL;
          if (!url) return fail('Only HTTPS Runware video result URLs are accepted.', 400);
          if ([...new URL(url).searchParams.keys()].some(k => forbidden.test(k))) return fail('Provider credentials must not appear in result URLs.', 400);
          clean.videoURL = url;
        } else {
          if (!['processing', 'submitted', 'prepared'].includes(result.status)) return fail('Record an actual output, processing status or provider error.', 400);
          if (job.status === 'complete' || job.status === 'error') return json({ ...summary(record), recorded: false, taskStatus: job.status });
          job.status = 'processing'; updateProjectTask(record, job); await save();
          return json({ ...summary(record), recorded: true, taskStatus: job.status });
        }
        if (typeof result.cost === 'number' && Number.isFinite(result.cost) && result.cost >= 0) clean.cost = result.cost;
        const fingerprint = await digest(JSON.stringify(clean));
        if (job.resultHash) {
          if (job.resultHash !== fingerprint) return fail('This completed task already has a different result.', 409);
          return json({ ...summary(record), recorded: false, taskStatus: job.status });
        }
        job.resultHash = fingerprint; job.status = clean.error ? 'error' : 'complete'; job.error = clean.error || '';
        if (clean.text) {
          if (job.kind === 'master') { record.project.master.text = clean.text; record.project.master.idea = record.project.idea; }
          else record.project.scenes[job.scene - 1].prompt = clean.text;
        }
        if (clean.videoURL) record.project.scenes[job.scene - 1].videoURL = clean.videoURL;
        if (clean.cost !== undefined) record.project.ledger[job.id] = { kind: job.kind, cost: clean.cost };
        updateProjectTask(record, job); await save();
        return json({ ...summary(record), recorded: true, taskStatus: job.status });
      }
      return fail('Unknown project action.', 400);
    } catch (e) {
      const storageFailure = storageErrorResponse(e);
      if (storageFailure) return storageFailure;
      return fail(e?.message && /credential|master script|scene prompt|expected video prompt|at most 5000|invalid JSON/i.test(e.message)
        ? e.message : 'The project connection could not complete this request. Keep the existing task UUID and try reading the project again.', 400);
    }
  };
}

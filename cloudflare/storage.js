import { initializeRateLimits, consumeQuota } from './rate-limit.js';
import { IMAGE_REQUEST_LIMITS, IMAGE_RUNNER_LIMITS } from './image-requests.js';

// Private SQLite-backed Durable Object; only its Worker binding can access it.
// Chunks stay below SQLite's 2 MB row limit, including multibyte scripts.
export const CHUNK_BYTES = 512 * 1024;
export const MAX_STORE_BYTES = 24 * 1024 * 1024;
const encoder = new TextEncoder();
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const queueError = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const queueJSON = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const assetColumns = 'asset_id AS assetId, name, mime, bytes, item_id AS itemId, created_at AS createdAt';
function equalDigest(first = '', second = '') {
  let difference = first.length ^ second.length;
  for (let index = 0; index < Math.max(first.length, second.length); index++) difference |= (first.charCodeAt(index) || 0) ^ (second.charCodeAt(index) || 0);
  return difference === 0;
}

function assetBytes(asset) {
  const bytes = Uint8Array.from(atob(asset.base64), character => character.charCodeAt(0));
  if (!bytes.length || bytes.length !== asset.bytes || bytes.length > IMAGE_REQUEST_LIMITS.assetBytes) throw queueError('The image upload exceeds its size limit.', 413, 'ASSET_TOO_LARGE');
  return bytes;
}

export class CraftushStorage {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, parts INTEGER NOT NULL, bytes INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (key TEXT NOT NULL, part INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY (key, part))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_request_records (id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, item_count INTEGER NOT NULL, result_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, document TEXT NOT NULL, fingerprint TEXT NOT NULL, asset_bytes INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_request_assets (asset_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS image_request_asset_request ON image_request_assets (request_id, kind)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_request_asset_chunks (asset_id TEXT NOT NULL, part INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY (asset_id, part))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_request_runner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), token_digest TEXT NOT NULL, runner_id TEXT NOT NULL, name TEXT NOT NULL, paired_at TEXT NOT NULL, heartbeat_at TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_request_generation (job_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, item_id TEXT NOT NULL, state TEXT NOT NULL, runner_id TEXT, claim_id TEXT UNIQUE, claimed_at TEXT, started_at TEXT, updated_at TEXT NOT NULL, message TEXT NOT NULL DEFAULT \'\', UNIQUE(request_id, item_id))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS image_request_generation_state ON image_request_generation (state, request_id)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_request_generation_batches (batch_id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, request_id TEXT NOT NULL, job_ids TEXT NOT NULL, claimed_at TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_request_staged_results (job_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL, staged_at TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS image_request_deliveries (request_id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, phase TEXT NOT NULL, updated_at TEXT NOT NULL)');
    initializeRateLimits(this.sql);
  }

  async fetch(request) {
    if (new URL(request.url).pathname === '/image-requests') return this.imageRequests(request);
    if (new URL(request.url).pathname === '/image-request-asset') return this.imageRequestAsset(request);
    if (new URL(request.url).pathname === '/rate-limit') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const raw = await request.text();
      if (raw.length > 8192) return new Response('Invalid quota request', { status: 400 });
      try {
        return Response.json(consumeQuota(this.storage, JSON.parse(raw).rules), { headers: { 'cache-control': 'no-store' } });
      } catch { return new Response('Quota check failed', { status: 503 }); }
    }
    const key = new URL(request.url).searchParams.get('key');
    if (!key || encoder.encode(key).length > 512) return new Response('Invalid record key', { status: 400 });
    if (request.method === 'GET') {
      const meta = this.sql.exec('SELECT parts, bytes FROM records WHERE key = ?', key).toArray()[0];
      if (!meta) return new Response(null, { status: 404 });
      const rows = this.sql.exec('SELECT part, value FROM chunks WHERE key = ? ORDER BY part', key).toArray();
      if (meta.bytes > MAX_STORE_BYTES || rows.length !== meta.parts) throw new Error('Incomplete private record');
      const bytes = new Uint8Array(meta.bytes);
      let offset = 0;
      for (let i = 0; i < rows.length; i++) {
        const part = new Uint8Array(rows[i].value);
        if (rows[i].part !== i || offset + part.length > bytes.length) throw new Error('Invalid private record');
        bytes.set(part, offset); offset += part.length;
      }
      if (offset !== bytes.length) throw new Error('Incomplete private record');
      return new Response(decode(bytes), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (request.method !== 'PUT') return new Response(null, { status: 405 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_STORE_BYTES) return new Response('Private record exceeds the upload limit', { status: 413 });
    const parts = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    // Replacement is atomic. An interrupted upload cannot leave half a record
    // or replace valid saved settings with an incomplete value.
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM chunks WHERE key = ?', key);
      for (let part = 0; part < parts; part++) {
        this.sql.exec('INSERT INTO chunks (key, part, value) VALUES (?, ?, ?)', key, part, bytes.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
      }
      this.sql.exec('INSERT OR REPLACE INTO records (key, parts, bytes) VALUES (?, ?, ?)', key, parts, bytes.length);
    });
    return new Response(null, { status: 204 });
  }

  requestRecord(id) {
    const record = this.sql.exec('SELECT * FROM image_request_records WHERE id = ?', id).toArray()[0];
    if (!record) throw queueError('This image request was not found.', 404, 'REQUEST_NOT_FOUND');
    return record;
  }

  requestDetail(record) {
    const request = JSON.parse(record.document);
    this.ensureGenerationJobs(record);
    const generation = new Map(this.sql.exec('SELECT job_id AS jobId, item_id AS itemId, state, message, started_at AS startedAt FROM image_request_generation WHERE request_id = ?', record.id).toArray().map(job => [job.itemId, job]));
    request.items = request.items.map(item => ({ ...item, generation: generation.get(item.id) }));
    request.references = this.sql.exec(`SELECT ${assetColumns} FROM image_request_assets WHERE request_id = ? AND kind = ? ORDER BY created_at, asset_id`, record.id, 'reference').toArray();
    request.results = this.sql.exec(`SELECT ${assetColumns} FROM image_request_assets WHERE request_id = ? AND kind = ? ORDER BY created_at, asset_id`, record.id, 'result').toArray();
    return request;
  }

  ensureGenerationJobs(record) {
    const document = JSON.parse(record.document), existing = new Set(this.sql.exec('SELECT item_id FROM image_request_generation WHERE request_id = ?', record.id).toArray().map(row => row.item_id));
    const ready = new Set(this.sql.exec('SELECT item_id FROM image_request_assets WHERE request_id = ? AND kind = ?', record.id, 'result').toArray().map(row => row.item_id));
    for (const item of document.items) if (!existing.has(item.id)) this.sql.exec('INSERT INTO image_request_generation (job_id, request_id, item_id, state, updated_at) VALUES (?, ?, ?, ?, ?)', crypto.randomUUID(), record.id, item.id, ready.has(item.id) ? 'completed' : 'pending', record.updated_at);
  }

  expireGenerationJobs(stamp) {
    const time = Date.parse(stamp);
    for (const job of this.sql.exec("SELECT * FROM image_request_generation WHERE state IN ('claimed', 'started')").toArray()) {
      if (job.state === 'claimed' && time - Date.parse(job.claimed_at) > IMAGE_RUNNER_LIMITS.claimMs) this.sql.exec("UPDATE image_request_generation SET state = 'pending', runner_id = NULL, claim_id = NULL, claimed_at = NULL, updated_at = ?, message = '' WHERE job_id = ?", stamp, job.job_id);
      if (job.state === 'started' && time - Date.parse(job.started_at) > IMAGE_RUNNER_LIMITS.startedMs) this.sql.exec("UPDATE image_request_generation SET state = 'needs_attention', updated_at = ?, message = ? WHERE job_id = ?", stamp, 'The generator stopped after starting this image. Its outcome is uncertain; it will not be generated again automatically.', job.job_id);
    }
  }

  generatorMeta(stamp) {
    const runner = this.sql.exec('SELECT runner_id, heartbeat_at FROM image_request_runner WHERE singleton = 1').toArray()[0];
    const connected = !!runner?.heartbeat_at && Date.parse(stamp) - Date.parse(runner.heartbeat_at) <= IMAGE_RUNNER_LIMITS.heartbeatMs;
    const needsAttention = this.sql.exec("SELECT COUNT(*) AS total FROM image_request_generation j JOIN image_request_records r ON r.id = j.request_id WHERE j.state = 'needs_attention' AND r.status != 'cancelled'").toArray()[0].total;
    const busy = this.sql.exec("SELECT COUNT(*) AS total FROM image_request_generation j JOIN image_request_records r ON r.id = j.request_id WHERE j.state IN ('claimed', 'started', 'staged') AND r.status != 'cancelled'").toArray()[0].total > 0;
    return { paired: !!runner, connected, lastSeenAt: runner?.heartbeat_at || null,
      state: needsAttention ? 'needs_attention' : !connected ? 'offline' : busy ? 'busy' : 'connected', needsAttention };
  }

  scopedJob(jobId, runnerId) {
    const job = this.sql.exec('SELECT * FROM image_request_generation WHERE job_id = ?', jobId).toArray()[0];
    if (!job || job.runner_id !== runnerId) throw queueError('This image job does not belong to the paired generator.', 403, 'RUNNER_SCOPE_DENIED');
    return job;
  }

  jobBrief(job) {
    const record = this.requestRecord(job.request_id), document = JSON.parse(record.document), item = document.items.find(item => item.id === job.item_id);
    return { jobId: job.job_id, requestId: job.request_id, requestStatus: document.status, itemId: job.item_id, state: job.state, title: item.title, prompt: item.prompt, filename: item.filename,
      styleNotes: document.styleNotes, width: document.width, height: document.height, claimedAt: job.claimed_at, startedAt: job.started_at, message: job.message,
      references: this.sql.exec(`SELECT ${assetColumns} FROM image_request_assets WHERE request_id = ? AND kind = ?`, job.request_id, 'reference').toArray() };
  }

  saveRequestDocument(record, document, stamp) {
    document.updatedAt = stamp;
    this.sql.exec('UPDATE image_request_records SET status = ?, updated_at = ?, document = ? WHERE id = ?', document.status, stamp, JSON.stringify(document), record.id);
  }

  runnerBatch(batchId, runnerId) {
    const batch = this.sql.exec('SELECT * FROM image_request_generation_batches WHERE batch_id = ?', batchId).toArray()[0];
    if (!batch || batch.runner_id !== runnerId) throw queueError('This image group does not belong to the paired generator.', 403, 'RUNNER_SCOPE_DENIED');
    const jobs = JSON.parse(batch.job_ids).map(jobId => this.jobBrief(this.scopedJob(jobId, runnerId)));
    const record = this.requestRecord(batch.request_id);
    return { batchId, requestId: batch.request_id, requestStatus: record.status, itemCount: record.item_count, resultCount: record.result_count, jobs, canGenerate: false };
  }

  runnerRequest(requestId, runnerId) {
    const jobs = this.sql.exec('SELECT * FROM image_request_generation WHERE request_id = ?', requestId).toArray();
    if (!jobs.some(job => job.runner_id === runnerId)) throw queueError('This request does not belong to the paired generator.', 403, 'RUNNER_SCOPE_DENIED');
    const record = this.requestRecord(requestId), delivery = this.sql.exec('SELECT * FROM image_request_deliveries WHERE request_id = ?', requestId).toArray()[0];
    if (delivery && delivery.runner_id !== runnerId) throw queueError('This request belongs to another generator connection.', 403, 'RUNNER_SCOPE_DENIED');
    const stagedCount = jobs.filter(job => job.state === 'staged').length;
    return { requestId, requestStatus: record.status, itemCount: record.item_count, resultCount: record.result_count, stagedCount,
      uploadPolicy: delivery ? 'after_request' : 'after_group', deliveryPhase: delivery?.phase || null,
      readyToUpload: jobs.length === record.item_count && jobs.every(job => job.state === 'completed' || (job.state === 'staged' && job.runner_id === runnerId)),
      jobs: jobs.map(job => ({ jobId: job.job_id, itemId: job.item_id, state: job.state })), canGenerate: false };
  }

  runnerOperation(operation, payload) {
    const stamp = payload.now;
    this.expireGenerationJobs(stamp);
    if (operation === 'generator-meta') return { generator: this.generatorMeta(stamp) };
    if (operation === 'runner-pair' || operation === 'runner-revoke') {
      // Claimed jobs have not invoked ImageGen and can safely be picked up again.
      // Started jobs have an uncertain external outcome and must never be reset.
      this.sql.exec("UPDATE image_request_generation SET state = 'pending', runner_id = NULL, claim_id = NULL, claimed_at = NULL, updated_at = ?, message = '' WHERE state = 'claimed'", stamp);
      this.sql.exec("UPDATE image_request_generation SET state = 'needs_attention', updated_at = ?, message = ? WHERE state = 'started'", stamp, 'The generator connection changed after image generation started. Automatic retry is paused to prevent a duplicate image.');
      this.sql.exec('DELETE FROM image_request_runner WHERE singleton = 1');
      if (operation === 'runner-pair') this.sql.exec('INSERT INTO image_request_runner (singleton, token_digest, runner_id, name, paired_at) VALUES (1, ?, ?, ?, ?)', payload.tokenDigest, payload.runnerId, payload.name, stamp);
      return { generator: this.generatorMeta(stamp) };
    }
    const runner = this.sql.exec('SELECT * FROM image_request_runner WHERE singleton = 1').toArray()[0];
    if (!runner || !equalDigest(runner.token_digest, payload.tokenDigest)) throw queueError('The image generator connection has expired or was revoked. Pair this computer again.', 401, 'RUNNER_ACCESS_REQUIRED');
    const summary = () => {
      const active = this.sql.exec("SELECT * FROM image_request_generation WHERE runner_id = ? AND state IN ('claimed', 'started', 'needs_attention') ORDER BY updated_at LIMIT 1", runner.runner_id).toArray()[0];
      return { generator: this.generatorMeta(stamp), job: active ? this.jobBrief(active) : null };
    };
    if (operation === 'runner-meta') return summary();
    if (['runner-heartbeat', 'runner-claim', 'runner-claim-batch'].includes(operation)) this.sql.exec('UPDATE image_request_runner SET heartbeat_at = ? WHERE singleton = 1', stamp);
    if (operation === 'runner-heartbeat') return summary();
    if (operation === 'runner-batch') return this.runnerBatch(payload.batchId, runner.runner_id);
    if (operation === 'runner-request') return this.runnerRequest(payload.requestId, runner.runner_id);
    if (operation === 'runner-stage-batch') {
      const batch = this.runnerBatch(payload.batchId, runner.runner_id);
      if (batch.requestStatus === 'cancelled') throw queueError('This image request was cancelled.', 409, 'REQUEST_CANCELLED');
      const supplied = new Map(payload.images.map(image => [image.jobId, image]));
      if (supplied.size !== batch.jobs.length || payload.images.length !== batch.jobs.length || batch.jobs.some(job => !supplied.has(job.jobId) || !['started','needs_attention','staged','completed'].includes(job.state))) throw queueError('Saved receipts must match every started group item.', 409, 'STAGED_GROUP_MISMATCH');
      const delivery = this.sql.exec('SELECT * FROM image_request_deliveries WHERE request_id = ?', batch.requestId).toArray()[0];
      if (delivery && delivery.runner_id !== runner.runner_id) throw queueError('This request belongs to another generator connection.', 403, 'RUNNER_SCOPE_DENIED');
      for (const job of batch.jobs) {
        const image = supplied.get(job.jobId), saved = this.sql.exec('SELECT * FROM image_request_staged_results WHERE job_id = ?', job.jobId).toArray()[0];
        const existing = this.sql.exec('SELECT * FROM image_request_assets WHERE asset_id = ?', job.jobId).toArray()[0];
        if ((saved && ['fingerprint','mime','name','bytes'].some(key => saved[key] !== image[key])) || (existing && ['fingerprint','mime','name','bytes'].some(key => existing[key] !== image[key]))) throw queueError('A different saved result already exists for this image.', 409, 'ASSET_ID_CONFLICT');
        if (!saved) this.sql.exec('INSERT INTO image_request_staged_results (job_id, fingerprint, mime, name, bytes, staged_at) VALUES (?, ?, ?, ?, ?, ?)', job.jobId, image.fingerprint, image.mime, image.name, image.bytes, stamp);
        if (job.state !== 'completed') this.sql.exec("UPDATE image_request_generation SET state = 'staged', message = '', updated_at = ? WHERE job_id = ?", stamp, job.jobId);
      }
      if (!delivery) this.sql.exec("INSERT INTO image_request_deliveries (request_id, runner_id, phase, updated_at) VALUES (?, ?, 'collecting', ?)", batch.requestId, runner.runner_id, stamp);
      const progress = this.runnerRequest(batch.requestId, runner.runner_id);
      if (progress.requestStatus === 'completed') this.sql.exec("UPDATE image_request_deliveries SET phase = 'completed', updated_at = ? WHERE request_id = ?", stamp, batch.requestId);
      else if (progress.readyToUpload && delivery?.phase !== 'uploading') this.sql.exec("UPDATE image_request_deliveries SET phase = 'ready_to_upload', updated_at = ? WHERE request_id = ?", stamp, batch.requestId);
      return { ...this.runnerBatch(payload.batchId, runner.runner_id), requestProgress: this.runnerRequest(batch.requestId, runner.runner_id), staged: true };
    }
    if (operation === 'runner-begin-request-upload') {
      const progress = this.runnerRequest(payload.requestId, runner.runner_id);
      if (progress.requestStatus === 'cancelled') throw queueError('This image request was cancelled.', 409, 'REQUEST_CANCELLED');
      if (progress.uploadPolicy !== 'after_request' || !progress.readyToUpload) throw queueError('Save every image in this request before starting delivery.', 409, 'REQUEST_NOT_READY');
      this.sql.exec("UPDATE image_request_deliveries SET phase = ?, updated_at = ? WHERE request_id = ?", progress.requestStatus === 'completed' ? 'completed' : 'uploading', stamp, payload.requestId);
      return this.runnerRequest(payload.requestId, runner.runner_id);
    }
    if (operation === 'runner-claim-batch') {
      const repeated = this.sql.exec('SELECT * FROM image_request_generation_batches WHERE batch_id = ?', payload.batchId).toArray()[0];
      if (repeated) {
        if (payload.requestId && payload.requestId !== repeated.request_id) throw queueError('The image group belongs to a different request.', 409, 'BATCH_REQUEST_MISMATCH');
        return { ...this.runnerBatch(payload.batchId, runner.runner_id), duplicate: true };
      }
      const delivery = this.sql.exec("SELECT d.* FROM image_request_deliveries d JOIN image_request_records r ON r.id = d.request_id WHERE r.status IN ('queued', 'in_progress') AND d.phase != 'completed' LIMIT 1").toArray()[0];
      if (delivery && (delivery.runner_id !== runner.runner_id || payload.requestId !== delivery.request_id)) throw queueError('Finish the pinned image request before claiming another.', 409, 'REQUEST_PINNED');
      if (this.sql.exec("SELECT j.job_id FROM image_request_generation j JOIN image_request_records r ON r.id = j.request_id WHERE j.state IN ('claimed', 'started') AND r.status != 'cancelled' LIMIT 1").toArray().length) throw queueError('The generator already has an active image group.', 409, 'RUNNER_BUSY');
      if (this.generatorMeta(stamp).needsAttention) return { jobs: [], blocked: 'needs_attention', canGenerate: false };
      const legacy = this.sql.exec("SELECT r.* FROM image_request_records r WHERE r.status IN ('queued', 'in_progress') AND NOT EXISTS (SELECT 1 FROM image_request_generation j WHERE j.request_id = r.id) ORDER BY r.created_at, r.id LIMIT 1").toArray()[0];
      if (legacy) this.ensureGenerationJobs(legacy);
      const first = payload.requestId
        ? this.sql.exec("SELECT j.* FROM image_request_generation j JOIN image_request_records r ON r.id = j.request_id WHERE j.request_id = ? AND j.state = 'pending' AND r.status IN ('queued', 'in_progress') ORDER BY CAST(j.item_id AS INTEGER) LIMIT 1", payload.requestId).toArray()[0]
        : this.sql.exec("SELECT j.* FROM image_request_generation j JOIN image_request_records r ON r.id = j.request_id WHERE j.state = 'pending' AND r.status IN ('queued', 'in_progress') ORDER BY r.created_at, r.id, CAST(j.item_id AS INTEGER) LIMIT 1").toArray()[0];
      if (!first) {
        if (payload.requestId) {
          const record = this.requestRecord(payload.requestId);
          return { jobs: [], requestId: record.id, requestStatus: record.status, itemCount: record.item_count, resultCount: record.result_count, canGenerate: false };
        }
        return { jobs: [], requestId: null, canGenerate: false };
      }
      const pending = this.sql.exec("SELECT * FROM image_request_generation WHERE request_id = ? AND state = 'pending' ORDER BY CAST(item_id AS INTEGER) LIMIT ?", first.request_id, IMAGE_RUNNER_LIMITS.batchSize).toArray();
      for (const job of pending) this.sql.exec("UPDATE image_request_generation SET state = 'claimed', runner_id = ?, claim_id = ?, claimed_at = ?, updated_at = ? WHERE job_id = ?", runner.runner_id, crypto.randomUUID(), stamp, stamp, job.job_id);
      this.sql.exec('INSERT INTO image_request_generation_batches (batch_id, runner_id, request_id, job_ids, claimed_at) VALUES (?, ?, ?, ?, ?)', payload.batchId, runner.runner_id, first.request_id, JSON.stringify(pending.map(job => job.job_id)), stamp);
      const record = this.requestRecord(first.request_id), document = JSON.parse(record.document);
      // Every newly reserved bulk request uses whole-request delivery. Existing
      // batch receipts without a delivery record retain their recovery path.
      if (!delivery) this.sql.exec("INSERT INTO image_request_deliveries (request_id, runner_id, phase, updated_at) VALUES (?, ?, 'collecting', ?)", first.request_id, runner.runner_id, stamp);
      document.status = 'in_progress'; this.saveRequestDocument(record, document, stamp);
      return { ...this.runnerBatch(payload.batchId, runner.runner_id), duplicate: false };
    }
    if (operation === 'runner-start-batch') {
      const batch = this.runnerBatch(payload.batchId, runner.runner_id);
      if (batch.requestStatus === 'cancelled') throw queueError('This image request was cancelled.', 409, 'REQUEST_CANCELLED');
      if (!batch.jobs.length || batch.jobs.some(job => job.state !== 'claimed')) return { ...batch, duplicate: true, canGenerate: false };
      for (const job of batch.jobs) this.sql.exec("UPDATE image_request_generation SET state = 'started', started_at = ?, updated_at = ? WHERE job_id = ?", stamp, stamp, job.jobId);
      this.sql.exec('UPDATE image_request_runner SET heartbeat_at = ? WHERE singleton = 1', stamp);
      return { ...this.runnerBatch(payload.batchId, runner.runner_id), duplicate: false, canGenerate: true };
    }
    if (operation === 'runner-claim') {
      const repeated = this.sql.exec('SELECT * FROM image_request_generation WHERE claim_id = ? AND runner_id = ?', payload.claimId, runner.runner_id).toArray()[0];
      if (repeated) return { job: this.jobBrief(repeated), duplicate: true, generator: this.generatorMeta(stamp) };
      if (this.sql.exec("SELECT d.request_id FROM image_request_deliveries d JOIN image_request_records r ON r.id = d.request_id WHERE d.phase != 'completed' AND r.status IN ('queued', 'in_progress') LIMIT 1").toArray().length) throw queueError('Finish the pinned image request before claiming another.', 409, 'REQUEST_PINNED');
      if (this.sql.exec("SELECT job_id FROM image_request_generation WHERE state IN ('claimed', 'started') LIMIT 1").toArray().length) throw queueError('The generator already has an active image job.', 409, 'RUNNER_BUSY');
      if (this.generatorMeta(stamp).needsAttention) return { job: null, blocked: 'needs_attention', generator: this.generatorMeta(stamp) };
      const legacy = this.sql.exec("SELECT r.* FROM image_request_records r WHERE r.status IN ('queued', 'in_progress') AND NOT EXISTS (SELECT 1 FROM image_request_generation j WHERE j.request_id = r.id) ORDER BY r.created_at LIMIT 1").toArray()[0];
      if (legacy) this.ensureGenerationJobs(legacy);
      const pending = this.sql.exec("SELECT j.* FROM image_request_generation j JOIN image_request_records r ON r.id = j.request_id WHERE j.state = 'pending' AND r.status IN ('queued', 'in_progress') ORDER BY r.created_at, r.id, CAST(j.item_id AS INTEGER) LIMIT 1").toArray()[0];
      if (!pending) return { job: null, generator: this.generatorMeta(stamp) };
      this.sql.exec("UPDATE image_request_generation SET state = 'claimed', runner_id = ?, claim_id = ?, claimed_at = ?, updated_at = ? WHERE job_id = ?", runner.runner_id, payload.claimId, stamp, stamp, pending.job_id);
      const record = this.requestRecord(pending.request_id), document = JSON.parse(record.document);
      document.status = 'in_progress'; this.saveRequestDocument(record, document, stamp);
      return { job: this.jobBrief(this.scopedJob(pending.job_id, runner.runner_id)), duplicate: false, generator: this.generatorMeta(stamp) };
    }
    const job = this.scopedJob(payload.jobId, runner.runner_id);
    if (operation === 'runner-job') return { job: this.jobBrief(job) };
    if (operation === 'runner-start') {
      if (job.state !== 'claimed') return { job: this.jobBrief(job), duplicate: true, canGenerate: false };
      if (this.requestRecord(job.request_id).status === 'cancelled') throw queueError('This image request was cancelled.', 409, 'REQUEST_CANCELLED');
      this.sql.exec("UPDATE image_request_generation SET state = 'started', started_at = ?, updated_at = ? WHERE job_id = ?", stamp, stamp, job.job_id);
      this.sql.exec('UPDATE image_request_runner SET heartbeat_at = ? WHERE singleton = 1', stamp);
      return { job: this.jobBrief(this.scopedJob(job.job_id, runner.runner_id)), duplicate: false, canGenerate: true };
    }
    if (operation === 'runner-report') {
      if (job.state === 'completed') throw queueError('This image already has a completed result.', 409, 'JOB_COMPLETED');
      if (!['claimed', 'started', 'staged', 'needs_attention', 'failed'].includes(job.state)) throw queueError('This image job is not active.', 409, 'JOB_NOT_ACTIVE');
      this.sql.exec('UPDATE image_request_generation SET state = ?, message = ?, updated_at = ? WHERE job_id = ?', payload.state, payload.message, stamp, job.job_id);
      return { job: this.jobBrief(this.scopedJob(job.job_id, runner.runner_id)), generator: this.generatorMeta(stamp) };
    }
    if (operation !== 'runner-complete') throw queueError('Unknown image generator operation.');
    const asset = payload.asset, existing = this.sql.exec('SELECT * FROM image_request_assets WHERE asset_id = ?', job.job_id).toArray()[0];
    if (existing) {
      if (job.state !== 'completed' || existing.request_id !== job.request_id || existing.item_id !== job.item_id || existing.fingerprint !== asset.fingerprint || existing.mime !== asset.mime || existing.name !== asset.name) throw queueError('A different result already exists for this image job.', 409, 'ASSET_ID_CONFLICT');
      return { request: this.requestDetail(this.requestRecord(job.request_id)), job: this.jobBrief(job), duplicate: true };
    }
    const delivery = this.sql.exec('SELECT * FROM image_request_deliveries WHERE request_id = ?', job.request_id).toArray()[0];
    const staged = this.sql.exec('SELECT * FROM image_request_staged_results WHERE job_id = ?', job.job_id).toArray()[0];
    if (delivery && (delivery.runner_id !== runner.runner_id || delivery.phase !== 'uploading' || !staged)) throw queueError('Save the whole request and begin its delivery before uploading.', 409, 'REQUEST_NOT_READY');
    if (staged && ['fingerprint','mime','name','bytes'].some(key => staged[key] !== asset[key])) throw queueError('The uploaded bytes do not match the saved original receipt.', 409, 'ASSET_ID_CONFLICT');
    if (!['started', 'staged', 'needs_attention'].includes(job.state)) throw queueError('Durably start the claimed job before generating and uploading an image.', 409, 'JOB_NOT_STARTED');
    const record = this.requestRecord(job.request_id);
    if (record.result_count >= IMAGE_REQUEST_LIMITS.results) throw queueError('This request has reached its result limit.', 413, 'RESULT_LIMIT');
    this.checkAssetCapacity(record.asset_bytes, asset.bytes);
    this.insertAssets(job.request_id, [asset], stamp);
    this.sql.exec("UPDATE image_request_generation SET state = 'completed', message = '', updated_at = ? WHERE job_id = ?", stamp, job.job_id);
    this.sql.exec('UPDATE image_request_records SET result_count = result_count + 1, asset_bytes = asset_bytes + ? WHERE id = ?', asset.bytes, job.request_id);
    const document = JSON.parse(record.document), ready = new Set(this.sql.exec('SELECT item_id FROM image_request_assets WHERE request_id = ? AND kind = ?', job.request_id, 'result').toArray().map(row => row.item_id));
    if (document.status !== 'cancelled') document.status = document.items.every(item => ready.has(item.id)) ? 'completed' : 'in_progress';
    this.saveRequestDocument(record, document, stamp);
    if (delivery && document.status === 'completed') this.sql.exec("UPDATE image_request_deliveries SET phase = 'completed', updated_at = ? WHERE request_id = ?", stamp, job.request_id);
    return { request: this.requestDetail(this.requestRecord(job.request_id)), job: this.jobBrief(this.scopedJob(job.job_id, runner.runner_id)), duplicate: false };
  }

  insertAssets(requestId, assets, createdAt) {
    for (const asset of assets) {
      const bytes = assetBytes(asset);
      this.sql.exec('INSERT INTO image_request_assets (asset_id, request_id, kind, item_id, name, mime, bytes, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', asset.assetId, requestId, asset.kind, asset.itemId || '', asset.name, asset.mime, bytes.length, asset.fingerprint, createdAt);
      for (let part = 0; part < Math.ceil(bytes.length / CHUNK_BYTES); part++) this.sql.exec('INSERT INTO image_request_asset_chunks (asset_id, part, value) VALUES (?, ?, ?)', asset.assetId, part, bytes.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
    }
  }

  checkAssetCapacity(recordBytes, incomingBytes) {
    if (recordBytes + incomingBytes > IMAGE_REQUEST_LIMITS.requestAssetBytes) throw queueError('This request has reached its 512 MB image storage limit.', 413, 'REQUEST_STORAGE_FULL');
    const total = this.sql.exec('SELECT COALESCE(SUM(asset_bytes), 0) AS bytes FROM image_request_records').toArray()[0].bytes;
    if (total + incomingBytes > IMAGE_REQUEST_LIMITS.queueAssetBytes) throw queueError('The image request queue has reached its image storage limit. Ask the owner to arrange another delivery.', 413, 'QUEUE_STORAGE_FULL');
  }

  ensureCompletion(request, resultItemIds) {
    if (request.status === 'completed' && request.items.some(item => !resultItemIds.has(item.id))) throw queueError('Upload a result for every thumbnail before marking this request completed.', 409, 'RESULTS_INCOMPLETE');
  }

  async imageRequests(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    try {
      const body = await request.json(), { operation, payload } = body;
      let result;
      // Every mutation and its capacity/duplicate checks happen together. Parallel
      // team submissions and owner deliveries cannot overwrite one another.
      this.storage.transactionSync(() => {
        if (operation === 'generator-meta' || operation.startsWith('runner-')) { result = this.runnerOperation(operation, payload); return; }
        if (operation === 'list') {
          const limit = Math.min(100, Math.max(1, Math.floor(Number(payload.limit) || 50))), offset = Math.max(0, Math.floor(Number(payload.offset) || 0));
          const requests = this.sql.exec('SELECT id, title, name, status, item_count AS itemCount, result_count AS resultCount, created_at AS createdAt, updated_at AS updatedAt FROM image_request_records ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', limit, offset).toArray();
          result = { requests, total: this.sql.exec('SELECT COUNT(*) AS total FROM image_request_records').toArray()[0].total, limit, offset };
          return;
        }
        if (operation === 'detail') { result = { request: this.requestDetail(this.requestRecord(payload.id)) }; return; }
        if (operation === 'create') {
          const incoming = payload.request;
          const existing = this.sql.exec('SELECT * FROM image_request_records WHERE id = ?', incoming.id).toArray()[0];
          if (existing) {
            if (existing.fingerprint !== payload.fingerprint) throw queueError('This request ID already belongs to a different brief. Use a new ID for a changed request.', 409, 'IDEMPOTENCY_CONFLICT');
            result = { request: this.requestDetail(existing), duplicate: true }; return;
          }
          if (this.sql.exec('SELECT COUNT(*) AS total FROM image_request_records').toArray()[0].total >= IMAGE_REQUEST_LIMITS.requests) throw queueError('The queue is full. Ask the owner to review saved requests.', 409, 'QUEUE_FULL');
          const assets = payload.assets || [], incomingBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
          this.checkAssetCapacity(0, incomingBytes);
          this.sql.exec('INSERT INTO image_request_records (id, title, name, status, item_count, created_at, updated_at, document, fingerprint, asset_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', incoming.id, incoming.title, incoming.name, incoming.status, incoming.items.length, incoming.createdAt, incoming.updatedAt, JSON.stringify(incoming), payload.fingerprint, incomingBytes);
          this.insertAssets(incoming.id, assets, incoming.createdAt);
          this.ensureGenerationJobs(this.requestRecord(incoming.id));
          result = { request: this.requestDetail(this.requestRecord(incoming.id)), duplicate: false }; return;
        }
        if (operation === 'cancel') {
          const record = this.requestRecord(payload.id), document = JSON.parse(record.document);
          if (document.status === 'completed') throw queueError('This request has already finished.', 409, 'REQUEST_COMPLETED');
          if (document.status !== 'cancelled') {
            document.status = 'cancelled';
            this.saveRequestDocument(record, document, payload.updatedAt);
          }
          result = { request: this.requestDetail(this.requestRecord(payload.id)) }; return;
        }
        if (!['status', 'deliver'].includes(operation)) throw queueError('Unknown image storage operation.');
        const record = this.requestRecord(payload.id), document = JSON.parse(record.document);
        const previousResults = this.sql.exec('SELECT asset_id, item_id FROM image_request_assets WHERE request_id = ? AND kind = ?', payload.id, 'result').toArray();
        const itemIds = new Set(document.items.map(item => item.id));
        let added = [], newBytes = 0;
        if (operation === 'deliver') {
          for (const asset of payload.assets) {
            if (!itemIds.has(asset.itemId)) throw queueError('This result does not match a thumbnail item in the request.');
            const existing = this.sql.exec('SELECT * FROM image_request_assets WHERE asset_id = ?', asset.assetId).toArray()[0];
            if (existing) {
              if (existing.request_id !== payload.id || existing.kind !== asset.kind || existing.item_id !== asset.itemId || existing.mime !== asset.mime || existing.name !== asset.name || existing.fingerprint !== asset.fingerprint) throw queueError('This image ID already belongs to a different image. Retry the original image with the same ID.', 409, 'ASSET_ID_CONFLICT');
              continue;
            }
            added.push(asset); newBytes += asset.bytes;
          }
          if (previousResults.length + added.length > IMAGE_REQUEST_LIMITS.results) throw queueError('This request has reached its 400 result limit.', 413, 'RESULT_LIMIT');
          this.checkAssetCapacity(record.asset_bytes, newBytes);
        }
        if (payload.status !== undefined) document.status = payload.status;
        if (payload.notes !== undefined) document.notes = payload.notes;
        const resultItemIds = new Set([...previousResults.map(asset => asset.item_id), ...added.map(asset => asset.itemId)]);
        this.ensureCompletion(document, resultItemIds);
        this.insertAssets(payload.id, added, payload.updatedAt);
        for (const asset of added) this.sql.exec("UPDATE image_request_generation SET state = 'completed', message = '', updated_at = ? WHERE request_id = ? AND item_id = ?", payload.updatedAt, payload.id, asset.itemId);
        document.updatedAt = payload.updatedAt;
        this.sql.exec('UPDATE image_request_records SET status = ?, result_count = ?, updated_at = ?, document = ?, asset_bytes = ? WHERE id = ?', document.status, previousResults.length + added.length, document.updatedAt, JSON.stringify(document), record.asset_bytes + newBytes, payload.id);
        result = { request: this.requestDetail(this.requestRecord(payload.id)), ...(operation === 'deliver' ? { duplicate: added.length === 0 } : {}) };
      });
      return queueJSON(result);
    } catch (error) {
      return queueJSON({ error: { code: error.code || 'QUEUE_STORAGE_ERROR', message: error.status ? error.message : 'Image request storage could not complete the operation.' } }, error.status || 503);
    }
  }

  imageRequestAsset(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const url = new URL(request.url);
    const asset = this.sql.exec('SELECT * FROM image_request_assets WHERE request_id = ? AND asset_id = ?', url.searchParams.get('id'), url.searchParams.get('assetId')).toArray()[0];
    if (!asset) return queueJSON({ error: { code: 'ASSET_NOT_FOUND', message: 'This image was not found in the request.' } }, 404);
    const chunks = this.sql.exec('SELECT part, value FROM image_request_asset_chunks WHERE asset_id = ? ORDER BY part', asset.asset_id).toArray();
    const bytes = new Uint8Array(asset.bytes); let offset = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = new Uint8Array(chunks[index].value);
      if (chunks[index].part !== index || offset + chunk.length > bytes.length) return queueJSON({ error: { code: 'ASSET_INCOMPLETE', message: 'The saved image is incomplete.' } }, 503);
      bytes.set(chunk, offset); offset += chunk.length;
    }
    if (offset !== bytes.length) return queueJSON({ error: { code: 'ASSET_INCOMPLETE', message: 'The saved image is incomplete.' } }, 503);
    return new Response(bytes, { headers: { 'content-type': asset.mime, 'content-length': String(bytes.length), 'content-disposition': `attachment; filename="${asset.name}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
  }
}

export function cloudflareStore(namespace) {
  if (!namespace?.idFromName || !namespace?.get) throw new Error('Private storage is not bound');
  const object = namespace.get(namespace.idFromName('craftush-v17'));
  const address = key => 'https://private-storage.invalid/?key=' + encodeURIComponent(String(key));
  async function getText(key) {
    const response = await object.fetch(new Request(address(key)));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Private storage read failed');
    return response.text();
  }
  async function setText(key, value) {
    const text = String(value ?? '');
    if (encoder.encode(text).length > MAX_STORE_BYTES) throw new Error('Private record exceeds the upload limit');
    const response = await object.fetch(new Request(address(key), { method: 'PUT', body: text }));
    if (!response.ok) throw new Error('Private storage write failed');
  }
  async function imageRequests(operation, payload) {
    const response = await object.fetch(new Request('https://private-storage.invalid/image-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, payload }) }));
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Image request storage failed.'), { status: response.status, code: data.error?.code || 'QUEUE_STORAGE_ERROR' });
    return data;
  }
  return {
    async get(key, options = {}) {
      const text = await getText(key);
      if (text === null || options.type !== 'json') return text;
      const value = JSON.parse(text);
      if (key === 'settings' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid private settings');
      return value;
    },
    set: setText,
    setJSON: (key, value) => setText(key, JSON.stringify(value)),
    imageRequests,
    async imageRequestAsset(id, assetId) {
      const response = await object.fetch(new Request('https://private-storage.invalid/image-request-asset?id=' + encodeURIComponent(id) + '&assetId=' + encodeURIComponent(assetId)));
      if (!response.ok) {
        const data = await response.json();
        throw Object.assign(new Error(data.error?.message || 'The saved image could not be read.'), { status: response.status, code: data.error?.code || 'ASSET_UNAVAILABLE' });
      }
      return response;
    },
  };
}

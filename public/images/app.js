(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const LIMIT = 50;
  const MAX_BYTES = 5 * 1024 * 1024;
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const STATUS_LABELS = { queued: 'Queued', in_progress: 'Generating', completed: 'Completed', needs_attention: 'Needs attention', cancelled: 'Cancelled' };
  let credential = '';
  let role = 'team';
  let connected = false;
  let metadata = null;
  let offset = 0;
  let total = 0;
  let requests = [];
  let currentRequest = null;
  let pendingSubmission = null;
  let submissionBusy = false;
  let deliveryBusy = false;
  let statusBusy = false;
  let pairingBusy = false;
  let pairingConfig = null;
  let pollTimer = null;
  let deliveryEntries = [];
  let referenceURL = '';
  let assetURLs = [];
  let detailRevision = 0;
  let queueRevision = 0;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function message(id, value, type = '') {
    const node = $(id);
    node.textContent = value;
    node.className = 'message' + (type ? ' ' + type : '');
  }

  function headers() {
    return credential ? { [role === 'owner' ? 'X-Admin-Password' : 'X-Team-Code']: credential } : {};
  }

  async function request(action, payload, parameters = {}) {
    const query = payload ? '' : '?' + new URLSearchParams({ action, ...parameters });
    const options = { cache: 'no-store', redirect: 'error', credentials: 'omit', headers: headers(), signal: AbortSignal.timeout(payload ? 90000 : 20000) };
    if (payload) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({ action, ...payload });
    }
    let response;
    try { response = await fetch('/api/image-requests' + query, options); }
    catch { throw new Error(payload ? 'The connection ended before the save was confirmed.' : 'The shared queue could not be reached. Check the backend connection and try again.'); }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('The image request backend is not deployed at this address yet.'); }
    if (!response.ok) {
      const failure = new Error(data.errors?.map(error => error.message).filter(Boolean).join(' ') || data.error || 'The request could not be completed.');
      failure.status = response.status;
      failure.code = data.errors?.[0]?.code;
      throw failure;
    }
    return data;
  }

  function updateAccess(clearMessage = true) {
    const owner = $('accessRole').value === 'owner';
    $('credentialLabel').textContent = owner ? 'Admin password' : 'Team access code';
    $('credentialHelp').textContent = owner ? 'Use your existing Craftush admin password. It stays in memory until you leave or lock this page.' : 'Ask your studio owner for the code. It stays in memory until you leave or lock this page.';
    $('credential').value = '';
    $('accessButton').disabled = !connected || (!owner && (!metadata?.enabled || !metadata?.teamConfigured));
    if (clearMessage) message('accessMessage', !owner && connected && !metadata?.teamConfigured ? 'The owner must configure a team access code before the team can join.' : !owner && connected && !metadata?.enabled ? 'The Image Generator is currently turned off by the owner.' : '');
  }

  async function connect() {
    try {
      metadata = await request('meta');
      if (typeof metadata.teamConfigured !== 'boolean') throw new Error('The image request backend is not deployed at this address yet.');
      connected = true;
      $('connectionNotice').textContent = !metadata.enabled ? 'The Image Generator is turned off. The owner can still open the queue.' : metadata.teamConfigured ? 'The shared image queue is ready. Submit a prompt and your images will appear here automatically.' : 'The shared queue is ready. The owner must set a team access code in Admin to enable team access.';
      renderGenerator();
    } catch (error) {
      connected = false;
      $('connectionNotice').textContent = 'The shared image queue needs a deployed Craftush backend. ' + (error.code === 'BACKEND_NOT_HOSTED' ? 'Connect the backend in the website deployment settings, then reload this page.' : error.message);
    }
    updateAccess();
  }

  $('accessRole').addEventListener('change', () => updateAccess());
  $('accessForm').addEventListener('submit', async event => {
    event.preventDefault();
    role = $('accessRole').value;
    credential = $('credential').value.trim();
    if (!credential) return message('accessMessage', 'Enter your ' + (role === 'owner' ? 'admin password.' : 'team access code.'), 'error');
    $('accessButton').disabled = true;
    message('accessMessage', 'Opening the shared queue…');
    try {
      offset = 0;
      await loadQueue(true);
      $('credential').value = '';
      $('accessSection').hidden = true;
      $('workspace').hidden = false;
      $('sessionLabel').textContent = role === 'owner' ? 'Studio owner' : 'Team workspace';
      $('requestSection').hidden = !metadata.enabled;
      $('pairingSection').hidden = role !== 'owner';
      renderGenerator();
      message('accessMessage', '');
      $('queueHeading').scrollIntoView({ block: 'start' });
      schedulePoll();
    } catch (error) {
      credential = '';
      message('accessMessage', error.message, 'error');
    } finally { updateAccess(false); }
  });

  $('lockButton').addEventListener('click', () => {
    if (submissionBusy || deliveryBusy || statusBusy || pairingBusy) return message('queueMessage', 'Wait for the current connection, upload or save to finish before locking the page.', 'error');
    stopPoll();
    credential = '';
    pairingConfig = null;
    $('downloadPairing').hidden = true;
    $('pairingSecurity').hidden = true;
    message('pairingMessage', '');
    currentRequest = null;
    requests = [];
    queueRevision++;
    closeDetail();
    clearDelivery();
    $('queueList').replaceChildren();
    $('workspace').hidden = true;
    $('accessSection').hidden = false;
    updateAccess();
    $('credential').focus();
  });

  function renderGenerator() {
    const generator = metadata?.generator || {};
    const online = generator.connected === true;
    const attention = Number(generator.needsAttention || 0);
    $('generatorBadge').className = 'status-badge ' + (attention ? 'needs_attention' : online ? 'completed' : 'queued');
    $('generatorBadge').textContent = attention ? 'Needs attention' : online ? 'Online' : generator.paired ? 'Offline' : 'Not connected';
    $('generatorStatus').textContent = !generator.paired ? 'The owner needs to connect the background generator once.' : !online ? 'The generator is offline. Requests stay queued until the generator computer and Codex are running.' : attention ? 'Generator online. ' + attention + (attention === 1 ? ' image needs' : ' images need') + ' attention; check the affected request for details.' : generator.state === 'busy' ? 'Your generator is creating images. Results appear here as they finish.' : 'Generator online. New requests will run automatically.';
    $('generatorHeartbeat').textContent = generator.lastSeenAt ? 'Last connected: ' + date(generator.lastSeenAt) + '. This page updates automatically.' : 'Waiting for the first connection from your generator computer.';
    if (role === 'owner') $('pairGenerator').textContent = pairingConfig ? 'Replace connection file' : generator.paired ? 'Create replacement connection file' : 'Create connection file';
  }

  function stopPoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }
  function schedulePoll() {
    stopPoll();
    if (!credential || $('workspace').hidden) return;
    pollTimer = setTimeout(pollWorkspace, document.visibilityState === 'hidden' ? 60000 : 15000);
  }
  async function pollWorkspace() {
    pollTimer = null;
    if (!credential || $('workspace').hidden) return;
    if (document.visibilityState === 'hidden' || submissionBusy || deliveryBusy || statusBusy || pairingBusy) return schedulePoll();
    const sessionCredential = credential;
    try {
      const status = await request('meta');
      if (credential !== sessionCredential || $('workspace').hidden) return;
      metadata = status;
      renderGenerator();
      await loadQueue(false, true);
      const opened = currentRequest;
      if (opened && !deliveryBusy && !statusBusy) {
        const data = await request('detail', null, { id: opened.id });
        if (credential === sessionCredential && currentRequest?.id === opened.id && !deliveryBusy && !statusBusy && data.request) {
          const changed = data.request.updatedAt !== opened.updatedAt || data.request.status !== opened.status || data.request.notes !== opened.notes || data.request.results?.length !== opened.results?.length || JSON.stringify(data.request.items?.map(item => item.generation)) !== JSON.stringify(opened.items?.map(item => item.generation));
          if (changed) displayDetail(data.request);
        }
      }
    } catch (error) { if (credential === sessionCredential) message('queueMessage', 'Automatic refresh paused: ' + error.message, 'error'); }
    finally { schedulePoll(); }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden' && credential) schedulePoll(); });

  $('pairGenerator').addEventListener('click', async () => {
    if (role !== 'owner' || pairingBusy || !credential) return;
    if (metadata?.generator?.paired && !window.confirm('Create a replacement connection file? The existing generator connection will be disconnected until the helper uses the new file.')) return;
    pairingBusy = true;
    pairingConfig = null;
    $('downloadPairing').hidden = true;
    $('pairingSecurity').hidden = true;
    $('pairGenerator').disabled = true;
    message('pairingMessage', 'Creating your generator connection…');
    try {
      const data = await request('pair', { name: 'Craftush desktop' });
      if (!/^ir_[a-f0-9]{64}$/.test(data.runnerToken || '') || !data.runnerId || data.apiPath !== '/api/image-requests') throw new Error('The backend did not return a valid generator connection.');
      const backend = new URL(data.backendURL);
      if ((backend.protocol !== 'https:' && !(backend.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(backend.hostname))) || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) throw new Error('The backend returned an invalid generator address.');
      pairingConfig = { version: 1, backendURL: backend.origin, apiPath: data.apiPath, runnerId: data.runnerId, runnerToken: data.runnerToken };
      if (data.generator) metadata.generator = data.generator;
      $('downloadPairing').hidden = false;
      $('pairingSecurity').hidden = false;
      renderGenerator();
      message('pairingMessage', 'Connection file ready. Download it and give it to Codex in your chat for the one-time connection. Then keep this app and computer awake.', 'success');
    } catch (error) { message('pairingMessage', 'The connection could not be confirmed. ' + error.message + ' No automatic retry was made.', 'error'); }
    finally { pairingBusy = false; $('pairGenerator').disabled = false; }
  });
  $('downloadPairing').addEventListener('click', () => {
    if (role === 'owner' && pairingConfig) downloadText(JSON.stringify(pairingConfig, null, 2), 'craftush-generator-connection.json', 'application/json');
  });

  function batchTitles() { return $('batchTitles').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
  function batchMode() { return document.querySelector('input[name="requestMode"]:checked').value === 'batch'; }
  document.querySelectorAll('input[name="requestMode"]').forEach(radio => radio.addEventListener('change', () => {
    $('singleFields').hidden = batchMode();
    $('batchFields').hidden = !batchMode();
    $('batchTitles').required = batchMode();
  }));
  $('batchTitles').addEventListener('input', () => { const count = batchTitles().length; $('batchCount').textContent = count + (count === 1 ? ' title' : ' titles'); });

  function validateImage(file) {
    if (!IMAGE_TYPES.has(file.type)) throw new Error('Use a PNG, JPG or WebP image: ' + file.name);
    if (!file.size || file.size > MAX_BYTES) throw new Error('Each image must be between 1 byte and 5 MB: ' + file.name);
  }

  function clearReference() {
    if (referenceURL) URL.revokeObjectURL(referenceURL);
    referenceURL = '';
    $('referenceFile').value = '';
    $('referencePreviewImage').removeAttribute('src');
    $('referencePreview').hidden = true;
  }
  $('clearReference').addEventListener('click', clearReference);
  $('referenceFile').addEventListener('change', () => {
    if (referenceURL) URL.revokeObjectURL(referenceURL);
    referenceURL = '';
    $('referencePreview').hidden = true;
    const file = $('referenceFile').files[0];
    if (!file) return;
    try {
      validateImage(file);
      referenceURL = URL.createObjectURL(file);
      $('referencePreviewImage').src = referenceURL;
      $('referencePreviewName').textContent = file.name;
      $('referencePreview').hidden = false;
      message('requestMessage', '');
    } catch (error) { clearReference(); message('requestMessage', error.message, 'error'); }
  });

  function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('The image could not be read: ' + file.name));
      reader.readAsDataURL(file);
    });
  }
  function filename(value) { return (String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'image'); }
  function lockSubmissionForm(locked) {
    $('requestForm').querySelectorAll('input,textarea,fieldset,#clearReference,#submitRequest').forEach(control => { control.disabled = locked; });
  }
  function updatePending(messageText) {
    $('pendingSubmission').hidden = !pendingSubmission;
    if (pendingSubmission) $('pendingMessage').textContent = messageText + ' Request ID: ' + pendingSubmission.submissionId + '. Keep this page open. Retrying sends the same request ID so it cannot create a second batch.';
    $('retrySubmission').disabled = submissionBusy;
    $('abandonSubmission').disabled = submissionBusy;
  }

  $('requestForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (submissionBusy || pendingSubmission) return;
    const name = $('requesterName').value.trim();
    const title = $('projectTitle').value.trim();
    const prompt = $('imagePrompt').value.trim();
    const titles = batchMode() ? batchTitles() : [$('singleTitle').value.trim() || title];
    if (!name || !title || !prompt || !titles.length) return message('requestMessage', 'Add your name, project name, image prompt and at least one title.', 'error');
    if (titles.length > 200 || titles.some(itemTitle => itemTitle.length > 160)) return message('requestMessage', 'Use up to 200 titles, each no longer than 160 characters.', 'error');
    const width = Number($('imageWidth').value), height = Number($('imageHeight').value);
    if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 8192)) return message('requestMessage', 'Choose whole-number dimensions between 64 and 8192 pixels.', 'error');
    submissionBusy = true;
    lockSubmissionForm(true);
    message('requestMessage', 'Preparing your request…');
    try {
      const payload = { submissionId: crypto.randomUUID(), name, title, styleNotes: $('styleNotes').value.trim(), width, height, items: titles.map((itemTitle, index) => ({ title: itemTitle, prompt, filename: String(index + 1).padStart(3, '0') + '-' + filename(itemTitle) + '.png' })) };
      if (new TextEncoder().encode(JSON.stringify(payload)).length > 1024 * 1024) throw new Error('This batch brief is too large. Shorten the shared prompt or divide the titles into smaller batches.');
      const file = $('referenceFile').files[0];
      if (file) { validateImage(file); payload.reference = { name: file.name, mime: file.type, base64: await fileBase64(file) }; }
      pendingSubmission = payload;
    } catch (error) {
      submissionBusy = false;
      lockSubmissionForm(false);
      return message('requestMessage', error.message, 'error');
    }
    submissionBusy = false;
    await saveSubmission();
  });

  async function saveSubmission() {
    if (!pendingSubmission || submissionBusy) return;
    submissionBusy = true;
    lockSubmissionForm(true);
    updatePending('Waiting for confirmation.');
    message('requestMessage', 'Saving your request to the shared queue…');
    try {
      const data = await request('create', pendingSubmission);
      if (!data.request?.id) throw new Error('The save did not return a request ID.');
      const saved = data.request;
      const name = $('requesterName').value;
      pendingSubmission = null;
      $('requestForm').reset();
      $('requesterName').value = name;
      $('batchFields').hidden = true;
      $('singleFields').hidden = false;
      $('batchTitles').required = false;
      $('batchCount').textContent = '0 titles';
      clearReference();
      message('requestMessage', (data.duplicate ? 'Your existing request was confirmed.' : 'Request saved.') + ' ' + saved.items.length + (saved.items.length === 1 ? ' image is queued.' : ' images are queued.') + ' Images are generated automatically and will appear here.', 'success');
      offset = 0;
      await loadQueue();
      await showDetail(saved.id);
    } catch (error) {
      if (pendingSubmission && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        pendingSubmission = null;
        message('requestMessage', error.message, 'error');
      } else if (pendingSubmission) {
        message('requestMessage', 'The save has not been confirmed. ' + error.message, 'error');
        updatePending('The request may already be saved. Refresh the queue to check, or retry the same submission.');
      } else message('queueMessage', 'The request is saved, but the queue could not refresh. ' + error.message, 'error');
    } finally {
      submissionBusy = false;
      lockSubmissionForm(Boolean(pendingSubmission));
      if (!pendingSubmission) $('pendingSubmission').hidden = true;
      $('retrySubmission').disabled = false;
      $('abandonSubmission').disabled = false;
    }
  }
  $('retrySubmission').addEventListener('click', saveSubmission);
  $('abandonSubmission').addEventListener('click', () => {
    if (submissionBusy || !pendingSubmission) return;
    if (!window.confirm('Discard the pending submission? It may already be saved. Check the queue before submitting another copy.')) return;
    pendingSubmission = null;
    lockSubmissionForm(false);
    $('pendingSubmission').hidden = true;
    message('requestMessage', 'The pending submission was discarded. Check the shared queue before creating the same request again.');
  });

  function date(value) {
    const stamp = new Date(value);
    return Number.isNaN(stamp.getTime()) ? '' : stamp.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function badge(status) { return element('span', 'status-badge ' + (STATUS_LABELS[status] ? status : ''), STATUS_LABELS[status] || 'Unknown'); }
  function renderQueue() {
    const list = $('queueList');
    list.replaceChildren();
    const filter = $('statusFilter').value;
    const shown = requests.filter(item => filter === 'all' || item.status === filter);
    if (!shown.length) list.append(element('p', 'empty', requests.length ? 'No requests with this status on this page.' : 'Your queue is empty. Submit the first image brief above.'));
    for (const item of shown) {
      const row = element('article', 'queue-entry');
      const copy = element('div');
      copy.append(element('h3', '', item.title), element('p', '', 'By ' + item.name + ' · ' + item.itemCount + ' requested · ' + item.resultCount + ' delivered'), element('p', '', date(item.createdAt)));
      const actions = element('div', 'entry-actions');
      const open = element('button', '', 'View request');
      open.type = 'button';
      open.addEventListener('click', () => showDetail(item.id));
      actions.append(badge(item.status), open);
      row.append(copy, actions);
      list.append(row);
    }
    $('queueTotal').textContent = total + (total === 1 ? ' shared request' : ' shared requests');
    $('pageLabel').textContent = total ? (offset + 1) + '–' + Math.min(offset + requests.length, total) + ' of ' + total : 'No requests yet';
    $('previousPage').disabled = offset === 0;
    $('nextPage').disabled = offset + LIMIT >= total;
  }
  async function loadQueue(throwErrors = false, quiet = false) {
    const revision = ++queueRevision;
    $('refreshQueue').disabled = true;
    if (!quiet) message('queueMessage', 'Loading the shared queue…');
    try {
      const data = await request('list', null, { limit: String(LIMIT), offset: String(offset) });
      if (!Array.isArray(data.requests)) throw new Error('The shared queue returned an invalid response.');
      if (revision !== queueRevision) return;
      const changed = JSON.stringify(requests) !== JSON.stringify(data.requests) || total !== data.total;
      requests = data.requests;
      total = data.total;
      if (!quiet || changed) renderQueue();
      if (!quiet || $('queueMessage').classList.contains('error')) message('queueMessage', '');
    } catch (error) { if (throwErrors) throw error; message('queueMessage', error.message, 'error'); }
    finally { if (revision === queueRevision) $('refreshQueue').disabled = false; }
  }
  $('refreshQueue').addEventListener('click', () => loadQueue());
  $('statusFilter').addEventListener('change', renderQueue);
  $('previousPage').addEventListener('click', () => { offset = Math.max(0, offset - LIMIT); loadQueue(); });
  $('nextPage').addEventListener('click', () => { offset += LIMIT; loadQueue(); });

  function generationPrompt(item, batch = currentRequest) {
    return [
      'Create an image for this Craftush request.',
      'Project: ' + batch.title,
      'Image title: ' + item.title,
      'Requested output: ' + batch.width + ' × ' + batch.height + ' pixels.',
      'Suggested filename: ' + item.filename,
      '', 'IMAGE PROMPT', item.prompt,
      '', 'SHARED STYLE NOTES', batch.styleNotes || 'No additional style notes.',
      ...(batch.references?.length ? ['', 'REFERENCE', 'Use the attached benchmark reference for the requested style: ' + batch.references.map(asset => asset.name).join(', ') + '.'] : []),
      '', 'Follow any exact-text instructions in the prompt. The image title identifies this item; render it in the image only if the prompt asks for title text.'
    ].join('\n');
  }
  function fullBrief(batch = currentRequest) {
    return ['CRAFTUSH IMAGE REQUEST', 'Project: ' + batch.title, 'Requested by: ' + batch.name, 'Request ID: ' + batch.id, 'Images requested: ' + batch.items.length, '', 'The connected background generator processes this brief automatically with native ChatGPT ImageGen. Use the supplied benchmark reference if present.', '', ...batch.items.flatMap((item, index) => ['— IMAGE ' + (index + 1) + ' —', generationPrompt(item, batch), ''])].join('\n');
  }
  function downloadText(text, name, mime = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = element('a');
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); message('detailMessage', 'Request brief copied.', 'success'); }
    catch { message('detailMessage', 'Copy is unavailable in this browser. Download the .txt brief and copy its contents.', 'error'); }
  }
  $('copyBrief').addEventListener('click', () => { if (currentRequest) copyText(fullBrief()); });
  $('downloadBrief').addEventListener('click', () => { if (currentRequest) downloadText(fullBrief(), filename(currentRequest.title) + '-brief.txt'); });

  function clearAssetURLs() {
    assetURLs.forEach(url => URL.revokeObjectURL(url));
    assetURLs = [];
  }
  function closeDetail() {
    if (deliveryBusy || statusBusy) return message('detailMessage', 'Wait for the current upload or save to finish before closing this request.', 'error');
    detailRevision++;
    clearAssetURLs();
    currentRequest = null;
    $('detailSection').hidden = true;
    clearDelivery();
  }
  $('closeDetail').addEventListener('click', closeDetail);

  async function showDetail(id) {
    if (deliveryBusy || statusBusy) return message('queueMessage', 'Wait for the current upload or save to finish before opening another request.', 'error');
    const revision = ++detailRevision;
    message('queueMessage', 'Opening request…');
    try {
      const data = await request('detail', null, { id });
      if (!data.request?.items) throw new Error('This request could not be opened.');
      if (revision !== detailRevision) return;
      clearDelivery();
      displayDetail(data.request, true);
      message('queueMessage', '');
    } catch (error) { message('queueMessage', error.message, 'error'); }
  }

  function displayDetail(batch, focus = false) {
    currentRequest = batch;
    const revision = ++detailRevision;
    clearAssetURLs();
    $('detailSection').hidden = false;
    $('detailHeading').textContent = batch.title;
    $('detailMeta').textContent = 'By ' + batch.name + ' · ' + (STATUS_LABELS[batch.status] || batch.status) + ' · ' + batch.items.length + ' requested · ' + batch.width + ' × ' + batch.height + ' px · ' + date(batch.createdAt);
    $('detailStyle').textContent = batch.styleNotes || 'No shared style notes supplied.';
    $('detailNotes').hidden = !batch.notes;
    $('detailNotes').textContent = batch.notes ? 'Owner’s note: ' + batch.notes : '';
    $('ownerControls').hidden = role !== 'owner';
    $('ownerStatus').value = batch.status;
    $('ownerNotes').value = batch.notes || '';
    message('detailMessage', '');
    $('detailItems').replaceChildren();
    for (const item of batch.items) {
      const card = element('article', 'item-card');
      const details = element('details');
      details.append(element('summary', '', 'View image prompt'), element('pre', '', generationPrompt(item, batch)));
      const actions = element('div', 'actions');
      const copy = element('button', '', 'Copy prompt'); copy.type = 'button';
      copy.addEventListener('click', () => copyText(generationPrompt(item, batch)));
      const save = element('button', '', 'Download prompt .txt'); save.type = 'button';
      save.addEventListener('click', () => downloadText(generationPrompt(item, batch), filename(item.filename.replace(/\.[^.]+$/, '')) + '-prompt.txt'));
      actions.append(copy, save);
      details.append(actions);
      card.append(element('h3', '', item.title));
      const job = item.generation;
      if (job) {
        const labels = { pending: 'Queued', claimed: 'Queued', started: 'Generating', completed: 'Completed', failed: 'Needs attention', needs_attention: 'Needs attention' };
        card.append(element('span', 'status-badge ' + (job.state === 'completed' ? 'completed' : job.state === 'started' ? 'in_progress' : ['failed', 'needs_attention'].includes(job.state) ? 'needs_attention' : 'queued'), labels[job.state] || 'Queued'));
        if (job.message) card.append(element('p', 'help', job.message));
      }
      card.append(details);
      $('detailItems').append(card);
    }
    $('detailReferences').replaceChildren();
    $('detailResults').replaceChildren();
    const references = batch.references || [], results = batch.results || [];
    $('resultsEmpty').hidden = results.length > 0;
    $('resultCount').textContent = results.length + (results.length === 1 ? ' image delivered' : ' images delivered');
    references.forEach(asset => displayAsset(batch, asset, $('detailReferences'), revision, true));
    results.forEach(asset => displayAsset(batch, asset, $('detailResults'), revision, false));
    if (focus) { $('detailSection').scrollIntoView({ block: 'start' }); $('detailHeading').focus({ preventScroll: true }); }
  }

  function displayAsset(batch, asset, container, revision, reference) {
    const card = element('article', 'asset-card');
    const image = element('img');
    image.alt = reference ? 'Benchmark reference: ' + asset.name : 'Finished image: ' + (batch.items.find(item => item.id === asset.itemId)?.title || asset.name);
    image.hidden = true;
    const label = element('p', '', (reference ? 'Reference · ' : '') + asset.name);
    const progress = element('p', '', reference ? 'Loading reference…' : 'Load the image to preview or download it.');
    card.append(image, label, progress); container.append(card);
    const load = element('button', '', reference ? 'Retry reference' : 'Preview & download'); load.type = 'button';
    if (!reference) card.append(load);
    async function loadAsset() {
      load.disabled = true;
      progress.textContent = 'Loading image…';
      progress.className = '';
      try {
        const query = '?' + new URLSearchParams({ action: 'asset', id: batch.id, assetId: asset.assetId });
        const response = await fetch('/api/image-requests' + query, { headers: headers(), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Image unavailable. Try loading it again.');
        const blob = await response.blob();
        if (!IMAGE_TYPES.has(blob.type)) throw new Error('The server did not return a supported image.');
        if (revision !== detailRevision || !credential) return;
        const url = URL.createObjectURL(blob); assetURLs.push(url);
        image.src = url; image.hidden = false;
        const download = element('a', '', reference ? 'Download reference' : 'Download image');
        download.href = url; download.download = asset.name;
        progress.replaceWith(download); load.remove();
        if (!reference) download.focus();
      } catch (error) {
        if (revision === detailRevision) { progress.textContent = error.message; progress.className = 'asset-error'; load.disabled = false; if (!load.isConnected) card.append(load); }
      }
    }
    load.addEventListener('click', loadAsset);
    if (reference) loadAsset();
  }

  $('statusForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentRequest || role !== 'owner' || deliveryBusy || statusBusy) return;
    statusBusy = true;
    $('saveStatus').disabled = true;
    message('statusMessage', 'Saving your update…');
    try {
      const data = await request('status', { id: currentRequest.id, status: $('ownerStatus').value, notes: $('ownerNotes').value.trim() });
      displayDetail(data.request);
      message('statusMessage', 'Status and note saved.', 'success');
      await loadQueue();
    } catch (error) { message('statusMessage', error.message + ' Refresh the request to check whether the update was saved.', 'error'); }
    finally { statusBusy = false; $('saveStatus').disabled = false; }
  });

  function clearDelivery() {
    deliveryEntries = [];
    $('deliveryFiles').value = '';
    $('deliveryMapping').replaceChildren();
    $('deliverButton').disabled = true;
    message('deliveryMessage', '');
  }
  function renderDelivery() {
    $('deliveryMapping').replaceChildren();
    deliveryEntries.forEach((entry, index) => {
      const row = element('div', 'delivery-row');
      const info = element('span', '', entry.file.name + ' · ' + (entry.file.size / (1024 * 1024)).toFixed(2) + ' MB');
      if (entry.saved) info.append(element('span', 'uploaded', ' · Uploaded'));
      const label = element('label', '', 'Requested image');
      const select = element('select'); select.setAttribute('aria-label', 'Requested title for ' + entry.file.name);
      currentRequest.items.forEach(item => {
        const option = element('option', '', item.title); option.value = item.id; select.append(option);
      });
      select.value = entry.itemId;
      select.disabled = entry.saved || entry.uncertain || deliveryBusy;
      select.addEventListener('change', () => { deliveryEntries[index].itemId = select.value; });
      label.append(select); row.append(info, label); $('deliveryMapping').append(row);
    });
    $('deliverButton').disabled = deliveryBusy || !deliveryEntries.some(entry => !entry.saved);
    $('deliveryFiles').disabled = deliveryBusy;
  }
  $('deliveryFiles').addEventListener('change', () => {
    const files = [...$('deliveryFiles').files];
    if (!currentRequest) return;
    if (deliveryEntries.some(entry => entry.uncertain) && !window.confirm('One or more previous uploads were not confirmed. Check the finished images before replacing this selection. Continue?')) { $('deliveryFiles').value = ''; return; }
    try {
      if (files.length > 10) throw new Error('Select no more than 10 images per upload.');
      files.forEach(validateImage);
      deliveryEntries = files.map((file, index) => {
        const matched = currentRequest.items.find(item => item.filename.toLowerCase() === file.name.toLowerCase());
        return { file, assetId: crypto.randomUUID(), itemId: (matched || currentRequest.items[Math.min(index, currentRequest.items.length - 1)]).id, saved: false, uncertain: false };
      });
      renderDelivery(); message('deliveryMessage', '');
    } catch (error) { clearDelivery(); message('deliveryMessage', error.message, 'error'); }
  });

  $('deliveryForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (role !== 'owner' || !currentRequest || deliveryBusy || statusBusy || !deliveryEntries.length) return;
    deliveryBusy = true;
    const batchId = currentRequest.id;
    renderDelivery();
    $('saveStatus').disabled = true;
    let confirmed = deliveryEntries.filter(entry => entry.saved).length;
    try {
      for (const entry of deliveryEntries.filter(item => !item.saved)) {
        message('deliveryMessage', 'Uploading ' + entry.file.name + ' (' + (confirmed + 1) + ' of ' + deliveryEntries.length + ')…');
        const image = { assetId: entry.assetId, itemId: entry.itemId, name: entry.file.name, mime: entry.file.type, base64: await fileBase64(entry.file) };
        entry.uncertain = true;
        const data = await request('deliver', { id: batchId, images: [image] });
        if (!data.request?.id) throw new Error('The upload was not confirmed.');
        entry.saved = true; entry.uncertain = false; confirmed++;
        displayDetail(data.request); renderDelivery();
      }
      message('deliveryMessage', confirmed + (confirmed === 1 ? ' image recovered.' : ' images recovered.') + ' Your team can download the results now.', 'success');
      await loadQueue();
    } catch (error) {
      message('deliveryMessage', confirmed + ' image(s) confirmed. ' + error.message + ' Keep this file selection to retry safely with the same image IDs. Uploaded images stay available.', 'error');
      await loadQueue();
    } finally { deliveryBusy = false; $('saveStatus').disabled = false; renderDelivery(); }
  });

  window.addEventListener('beforeunload', event => {
    if (pendingSubmission || deliveryBusy || deliveryEntries.some(entry => entry.uncertain)) { event.preventDefault(); event.returnValue = ''; }
  });
  connect();
})();

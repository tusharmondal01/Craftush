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
  let teamSubmission = null;
  let submissionBusy = false;
  let deliveryBusy = false;
  let statusBusy = false;
  let pairingBusy = false;
  let bulkDownloadBusy = false;
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
    $('accessButton').firstChild.textContent = owner ? 'Open owner archive ' : 'Open request form ';
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
      $('connectionNotice').textContent = !metadata.enabled ? 'The Image Generator is turned off. The owner can still open the archive.' : metadata.teamConfigured ? 'Ready for thumbnail requests. Images are generated one by one and saved in a folder for the owner in chat.' : 'The owner must set a team access code in Admin to enable requests.';
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
    message('accessMessage', 'Checking access…');
    try {
      offset = 0;
      if (role === 'owner') await loadQueue(true);
      else {
        const access = await request('access');
        if (access.role !== 'team') throw new Error('Team access could not be confirmed.');
      }
      $('credential').value = '';
      $('accessSection').hidden = true;
      $('workspace').hidden = false;
      $('sessionLabel').textContent = role === 'owner' ? 'Studio owner' : 'Team workspace';
      $('requestSection').hidden = !metadata.enabled;
      $('pairingSection').hidden = role !== 'owner';
      $('queueSection').hidden = role !== 'owner';
      $('sessionHelp').textContent = role === 'owner' ? 'Your private request archive. Previous images remain available here.' : 'Submit a brief. The owner receives the finished folder in chat.';
      renderGenerator();
      message('accessMessage', '');
      $(role === 'owner' ? 'queueHeading' : 'requestHeading').scrollIntoView({ block: 'start' });
      schedulePoll();
    } catch (error) {
      credential = '';
      message('accessMessage', error.message, 'error');
    } finally { updateAccess(false); }
  });

  $('lockButton').addEventListener('click', () => {
    if (submissionBusy || deliveryBusy || statusBusy || pairingBusy || bulkDownloadBusy) return message('queueMessage', 'Wait for the current download, connection, upload or save to finish before locking the page.', 'error');
    stopPoll();
    credential = '';
    pairingConfig = null;
    $('downloadPairing').hidden = true;
    $('pairingSecurity').hidden = true;
    message('pairingMessage', '');
    currentRequest = null;
    teamSubmission = null;
    $('teamReceipt').hidden = true;
    $('teamReceiptMessage').textContent = '';
    $('teamStopMessage').textContent = '';
    requests = [];
    queueRevision++;
    closeDetail();
    for (const id of ['detailHeading', 'detailMeta', 'detailDeliveryPolicy', 'detailStyle', 'detailNotes', 'detailItems', 'detailReferences', 'detailResults', 'resultCount']) $(id).replaceChildren();
    $('ownerNotes').value = '';
    $('ownerControls').hidden = true;
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
    $('generatorStatus').textContent = !generator.paired ? 'The owner needs to connect the background generator once.' : !online ? 'The generator is offline. Requests stay queued until the generator computer and Codex are running.' : attention ? 'Generator online. The owner can check requests that need attention.' : generator.state === 'busy' ? 'Your generator is creating images one by one. The finished folder goes to the owner in chat.' : 'Generator online. Requests are generated one by one and saved for the owner in chat.';
    $('generatorHeartbeat').textContent = generator.lastSeenAt ? 'Last connected: ' + date(generator.lastSeenAt) + (role === 'owner' ? '. This archive updates automatically.' : '.') : 'Waiting for the first connection from your generator computer.';
    if (role === 'owner') $('pairGenerator').textContent = pairingConfig ? 'Replace connection file' : generator.paired ? 'Create replacement connection file' : 'Create connection file';
  }

  function stopPoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }
  function schedulePoll() {
    stopPoll();
    if (role !== 'owner' || !credential || $('workspace').hidden) return;
    pollTimer = setTimeout(pollWorkspace, document.visibilityState === 'hidden' ? 60000 : 15000);
  }
  async function pollWorkspace() {
    pollTimer = null;
    if (role !== 'owner' || !credential || $('workspace').hidden) return;
    if (document.visibilityState === 'hidden' || submissionBusy || deliveryBusy || statusBusy || pairingBusy || bulkDownloadBusy) return schedulePoll();
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
        if (credential === sessionCredential && currentRequest?.id === opened.id && !deliveryBusy && !statusBusy && !bulkDownloadBusy && data.request) {
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
    if (submissionBusy || pendingSubmission || statusBusy) return;
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
      const submitted = pendingSubmission;
      const data = await request('create', pendingSubmission);
      const saved = role === 'owner' ? data.request : data.acknowledgement;
      if (!saved?.id || (role !== 'owner' && saved.accepted !== true)) throw new Error('The save did not return a request confirmation.');
      const name = $('requesterName').value;
      pendingSubmission = null;
      $('requestForm').reset();
      $('requesterName').value = name;
      $('batchFields').hidden = true;
      $('singleFields').hidden = false;
      $('batchTitles').required = false;
      $('batchCount').textContent = '0 titles';
      clearReference();
      message('requestMessage', (data.duplicate ? 'Your existing request was confirmed.' : 'Request accepted.') + ' ' + submitted.items.length + (submitted.items.length === 1 ? ' image is queued.' : ' images are queued.') + ' Images are generated one by one. The owner receives a folder named after your project in chat.', 'success');
      if (role === 'owner') {
        offset = 0;
        await loadQueue();
        await showDetail(saved.id);
      } else {
        teamSubmission = { id: saved.id, title: submitted.title };
        $('teamReceipt').hidden = false;
        $('teamReceiptMessage').textContent = 'Accepted: ' + submitted.title + '. Keep this page open if you need to stop this request.';
        $('teamStopControls').hidden = false;
        $('teamStopRequest').hidden = false;
        $('teamStopConfirmation').hidden = true;
        message('teamStopMessage', '');
      }
    } catch (error) {
      if (pendingSubmission && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        pendingSubmission = null;
        message('requestMessage', error.message, 'error');
      } else if (pendingSubmission) {
        message('requestMessage', 'The save has not been confirmed. ' + error.message, 'error');
        updatePending('The request may already be saved. Retry this same submission to confirm it.');
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
    if (!window.confirm('Discard the pending submission? It may already be saved. Retrying the same submission is the best way to confirm it.')) return;
    pendingSubmission = null;
    lockSubmissionForm(false);
    $('pendingSubmission').hidden = true;
    message('requestMessage', 'The pending submission was discarded. Ask the owner to check before submitting the same brief again.');
  });

  function date(value) {
    const stamp = new Date(value);
    return Number.isNaN(stamp.getTime()) ? '' : stamp.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function badge(status) { return element('span', 'status-badge ' + (STATUS_LABELS[status] ? status : ''), STATUS_LABELS[status] || 'Unknown'); }
  function renderQueue() {
    const list = $('queueList');
    list.replaceChildren();
    if (role !== 'owner') return;
    const filter = $('statusFilter').value;
    const shown = requests.filter(item => filter === 'all' || item.status === filter);
    if (!shown.length) list.append(element('p', 'empty', requests.length ? 'No requests with this status on this page.' : 'Your queue is empty. Submit the first image brief above.'));
    for (const item of shown) {
      const row = element('article', 'queue-entry');
      const copy = element('div');
      copy.append(element('h3', '', item.title), element('p', '', 'By ' + item.name + ' · ' + item.itemCount + ' requested' + (item.localDelivery ? ' · ' + (item.localResultCount || item.localDelivery.itemCount || 0) + ' saved in folder' : ' · ' + item.resultCount + ' archived images')), element('p', '', date(item.createdAt)));
      const actions = element('div', 'entry-actions');
      const open = element('button', '', 'View request');
      open.type = 'button';
      open.addEventListener('click', () => showDetail(item.id));
      actions.append(badge(item.status), open);
      row.append(copy, actions);
      list.append(row);
    }
    $('queueTotal').textContent = total + (total === 1 ? ' archived request' : ' archived requests');
    $('pageLabel').textContent = total ? (offset + 1) + '–' + Math.min(offset + requests.length, total) + ' of ' + total : 'No requests yet';
    $('previousPage').disabled = offset === 0;
    $('nextPage').disabled = offset + LIMIT >= total;
  }
  async function loadQueue(throwErrors = false, quiet = false) {
    if (role !== 'owner') return;
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
    downloadBlob(new Blob([text], { type: mime }), name);
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url; link.download = name;
    try { document.body.append(link); link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
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
    if (deliveryBusy || statusBusy || bulkDownloadBusy) return message('detailMessage', 'Wait for the current download, upload or save to finish before closing this request.', 'error');
    detailRevision++;
    clearAssetURLs();
    currentRequest = null;
    $('detailSection').hidden = true;
    clearDelivery();
  }
  $('closeDetail').addEventListener('click', closeDetail);

  async function showDetail(id) {
    if (role !== 'owner') return;
    if (deliveryBusy || statusBusy || bulkDownloadBusy) return message('queueMessage', 'Wait for the current download, upload or save to finish before opening another request.', 'error');
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
    if (role !== 'owner') return;
    currentRequest = batch;
    const revision = ++detailRevision;
    clearAssetURLs();
    $('detailSection').hidden = false;
    $('detailHeading').textContent = batch.title;
    $('stopControls').hidden = ['completed', 'cancelled'].includes(batch.status);
    $('stopRequest').hidden = false;
    $('stopConfirmation').hidden = true;
    message('stopMessage', batch.status === 'cancelled' ? 'Request stopped. Images already generating may finish; finished images remain available.' : '');
    $('detailMeta').textContent = 'By ' + batch.name + ' · ' + (STATUS_LABELS[batch.status] || batch.status) + ' · ' + batch.items.length + ' requested · ' + batch.width + ' × ' + batch.height + ' px · ' + date(batch.createdAt);
    const localFolder = batch.localDelivery;
    const localDelivery = batch.uploadPolicy === 'local_folder' || Boolean(localFolder);
    $('detailDeliveryPolicy').hidden = batch.status === 'cancelled';
    $('detailDeliveryPolicy').textContent = localFolder?.completedAt
      ? 'Folder complete: ' + (localFolder.folderName || batch.title) + '. Open this request’s folder from the owner’s Codex chat.'
      : 'Images are generated one by one and saved in a folder named after this project. The owner receives it in chat. Previous website images remain in this owner archive.';
    $('detailStyle').textContent = batch.styleNotes || 'No shared style notes supplied.';
    $('detailNotes').hidden = !batch.notes;
    $('detailNotes').textContent = batch.notes ? 'Owner’s note: ' + batch.notes : '';
    $('ownerControls').hidden = role !== 'owner';
    $('deliveryForm').hidden = metadata?.uploadPolicy === 'local_folder' || localDelivery;
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
        const labels = { pending: 'Queued', claimed: 'Queued', started: 'Generating', completed: 'Completed', saved_locally: 'Saved in folder', local_saved: 'Saved in folder', failed: 'Needs attention', needs_attention: 'Needs attention' };
        card.append(element('span', 'status-badge ' + (['completed', 'saved_locally', 'local_saved'].includes(job.state) ? 'completed' : job.state === 'started' ? 'in_progress' : ['failed', 'needs_attention'].includes(job.state) ? 'needs_attention' : 'queued'), labels[job.state] || 'Queued'));
        if (job.message) card.append(element('p', 'help', job.message));
      }
      card.append(details);
      $('detailItems').append(card);
    }
    $('detailReferences').replaceChildren();
    $('detailResults').replaceChildren();
    const references = batch.references || [], results = batch.results || [];
    $('resultsEmpty').textContent = localDelivery || metadata?.uploadPolicy === 'local_folder' ? (localFolder?.completedAt ? 'These images are saved in the owner’s folder in chat. They are not uploaded to Craftush.' : 'New images are saved in the owner’s folder in chat. They will not appear here.') : batch.status === 'cancelled' ? 'No archived images for this stopped request.' : 'No archived website images for this request.';
    $('resultsEmpty').hidden = results.length > 0;
    $('resultCount').textContent = results.length + (results.length === 1 ? ' archived website image' : ' archived website images');
    $('bulkDownloadControls').hidden = results.length === 0;
    $('downloadAllResults').disabled = results.length === 0;
    $('downloadAllResults').textContent = 'Download all ' + results.length + ' (.zip)';
    message('bulkDownloadMessage', results.length && results.length < batch.items.length ? 'The ZIP includes the ' + results.length + ' finished images available now. Download again when more are ready.' : '');
    references.forEach(asset => displayAsset(batch, asset, $('detailReferences'), revision, true));
    results.forEach(asset => displayAsset(batch, asset, $('detailResults'), revision, false));
    if (focus) { $('detailSection').scrollIntoView({ block: 'start' }); $('detailHeading').focus({ preventScroll: true }); }
  }

  async function fetchAsset(batch, asset) {
    const query = '?' + new URLSearchParams({ action: 'asset', id: batch.id, assetId: asset.assetId });
    const response = await fetch('/api/image-requests' + query, { headers: headers(), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Image unavailable. Try loading it again.');
    const blob = await response.blob();
    if (!IMAGE_TYPES.has(blob.type)) throw new Error('The server did not return a supported image.');
    if (!blob.size || blob.size > MAX_BYTES) throw new Error('The image is empty or exceeds the 5 MB download limit.');
    return blob;
  }

  // PNG, JPEG and WebP are already compressed. Store their original bytes in a
  // standard ZIP without loading the complete archive into a second byte array.
  const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
  });
  function crc32(bytes) {
    let checksum = 0xffffffff;
    for (const byte of bytes) checksum = CRC_TABLE[(checksum ^ byte) & 255] ^ (checksum >>> 8);
    return (checksum ^ 0xffffffff) >>> 0;
  }
  function zipHeader(length) {
    const bytes = new Uint8Array(length);
    return { bytes, view: new DataView(bytes.buffer) };
  }
  function imageZip(entries) {
    if (!entries.length || entries.length > 65535) throw new Error('The image selection cannot be saved as a ZIP.');
    const files = [], directory = [];
    let offset = 0, directoryBytes = 0;
    for (const entry of entries) {
      const name = new TextEncoder().encode(entry.name);
      if (entry.blob.size > 0xffffffff || offset + 30 + name.length + entry.blob.size > 0xffffffff) throw new Error('This ZIP is too large for the browser.');
      const local = zipHeader(30);
      local.view.setUint32(0, 0x04034b50, true);
      local.view.setUint16(4, 20, true);
      local.view.setUint16(6, 0x0800, true);
      local.view.setUint16(12, 33, true); // 1 January 1980, valid DOS date.
      local.view.setUint32(14, entry.crc, true);
      local.view.setUint32(18, entry.blob.size, true);
      local.view.setUint32(22, entry.blob.size, true);
      local.view.setUint16(26, name.length, true);
      files.push(local.bytes, name, entry.blob);
      const central = zipHeader(46);
      central.view.setUint32(0, 0x02014b50, true);
      central.view.setUint16(4, 20, true);
      central.view.setUint16(6, 20, true);
      central.view.setUint16(8, 0x0800, true);
      central.view.setUint16(14, 33, true);
      central.view.setUint32(16, entry.crc, true);
      central.view.setUint32(20, entry.blob.size, true);
      central.view.setUint32(24, entry.blob.size, true);
      central.view.setUint16(28, name.length, true);
      central.view.setUint32(42, offset, true);
      directory.push(central.bytes, name);
      directoryBytes += 46 + name.length;
      offset += 30 + name.length + entry.blob.size;
    }
    if (offset + directoryBytes + 22 > 0xffffffff) throw new Error('This ZIP is too large for the browser.');
    const end = zipHeader(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, entries.length, true);
    end.view.setUint16(10, entries.length, true);
    end.view.setUint32(12, directoryBytes, true);
    end.view.setUint32(16, offset, true);
    return new Blob([...files, ...directory, end.bytes], { type: 'application/zip' });
  }

  $('downloadAllResults').addEventListener('click', async () => {
    if (!currentRequest || !credential || bulkDownloadBusy || deliveryBusy || statusBusy || !currentRequest.results?.length) return;
    bulkDownloadBusy = true;
    const batch = currentRequest;
    const items = new Map(batch.items.map((item, index) => [item.id, { item, index }]));
    const results = [...batch.results].sort((left, right) => (items.get(left.itemId)?.index ?? batch.items.length) - (items.get(right.itemId)?.index ?? batch.items.length));
    const button = $('downloadAllResults');
    const buttonText = button.textContent;
    button.disabled = true;
    $('bulkDownloadControls').setAttribute('aria-busy', 'true');
    const entries = [];
    try {
      for (const [index, asset] of results.entries()) {
        button.textContent = 'Preparing ' + (index + 1) + ' of ' + results.length + '…';
        message('bulkDownloadMessage', 'Preparing your ZIP. Keep this page open (' + (index + 1) + ' of ' + results.length + ').');
        const blob = await fetchAsset(batch, asset);
        const base = filename(String(asset.name || items.get(asset.itemId)?.item.title || 'image').replace(/\.[^.]*$/, ''));
        const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[blob.type];
        entries.push({ name: String(index + 1).padStart(3, '0') + '-' + base + extension, blob, crc: crc32(new Uint8Array(await blob.arrayBuffer())) });
      }
      downloadBlob(imageZip(entries), filename(batch.title) + '-images.zip');
      message('bulkDownloadMessage', 'ZIP ready: ' + entries.length + (entries.length === 1 ? ' image.' : ' images.') + (entries.length < batch.items.length ? ' More images are still pending.' : ''), 'success');
    } catch (error) {
      message('bulkDownloadMessage', 'No ZIP was downloaded. ' + error.message + ' Try Download all again; individual images remain available.', 'error');
    } finally {
      entries.length = 0;
      bulkDownloadBusy = false;
      button.disabled = false;
      button.textContent = buttonText;
      $('bulkDownloadControls').removeAttribute('aria-busy');
    }
  });

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
        const blob = await fetchAsset(batch, asset);
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

  $('stopRequest').addEventListener('click', () => {
    if (deliveryBusy || statusBusy || bulkDownloadBusy) return;
    $('stopRequest').hidden = true;
    $('stopConfirmation').hidden = false;
    $('confirmStop').focus();
  });

  $('teamStopRequest').addEventListener('click', () => {
    if (role !== 'team' || !teamSubmission || statusBusy) return;
    $('teamStopRequest').hidden = true;
    $('teamStopConfirmation').hidden = false;
    $('teamConfirmStop').focus();
  });
  $('teamKeepRunning').addEventListener('click', () => {
    if (statusBusy) return;
    $('teamStopConfirmation').hidden = true;
    $('teamStopRequest').hidden = false;
  });
  $('teamConfirmStop').addEventListener('click', async () => {
    if (role !== 'team' || !teamSubmission || statusBusy) return;
    const requestId = teamSubmission.id;
    statusBusy = true;
    $('teamConfirmStop').disabled = true;
    $('teamKeepRunning').disabled = true;
    message('teamStopMessage', 'Stopping this request…');
    try {
      const data = await request('cancel', { id: requestId });
      if (data.acknowledgement?.id !== requestId || data.acknowledgement.stopped !== true) throw new Error('The stop was not confirmed.');
      teamSubmission = null;
      $('teamStopControls').hidden = true;
      message('teamStopMessage', 'Request stopped. An image already generating may finish; the owner keeps any saved files.', 'success');
    } catch (error) {
      message('teamStopMessage', error.message + ' You can retry Stop for this same request.', 'error');
    } finally {
      statusBusy = false;
      $('teamConfirmStop').disabled = false;
      $('teamKeepRunning').disabled = false;
    }
  });
  $('keepRunning').addEventListener('click', () => {
    if (statusBusy) return;
    $('stopConfirmation').hidden = true;
    $('stopRequest').hidden = false;
    $('stopRequest').focus();
  });
  $('confirmStop').addEventListener('click', async () => {
    if (!currentRequest || deliveryBusy || statusBusy || bulkDownloadBusy || ['completed', 'cancelled'].includes(currentRequest.status)) return;
    const requestId = currentRequest.id;
    statusBusy = true;
    $('confirmStop').disabled = true;
    $('keepRunning').disabled = true;
    message('stopMessage', 'Stopping this request…');
    try {
      const data = await request('cancel', { id: requestId });
      displayDetail(data.request);
      await loadQueue();
    } catch (error) {
      message('stopMessage', error.message + ' Refresh this request to check whether it stopped.', 'error');
    } finally {
      statusBusy = false;
      $('confirmStop').disabled = false;
      $('keepRunning').disabled = false;
    }
  });

  $('statusForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentRequest || role !== 'owner' || deliveryBusy || statusBusy || bulkDownloadBusy) return;
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
    if (!currentRequest || role !== 'owner' || metadata?.uploadPolicy === 'local_folder' || currentRequest.uploadPolicy === 'local_folder') return;
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
    if (role !== 'owner' || !currentRequest || metadata?.uploadPolicy === 'local_folder' || currentRequest.uploadPolicy === 'local_folder' || deliveryBusy || statusBusy || bulkDownloadBusy || !deliveryEntries.length) return;
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
      message('deliveryMessage', confirmed + (confirmed === 1 ? ' archived image recovered.' : ' archived images recovered.'), 'success');
      await loadQueue();
    } catch (error) {
      message('deliveryMessage', confirmed + ' image(s) confirmed. ' + error.message + ' Keep this file selection to retry safely with the same image IDs. Uploaded images stay available.', 'error');
      await loadQueue();
    } finally { deliveryBusy = false; $('saveStatus').disabled = false; renderDelivery(); }
  });

  window.addEventListener('beforeunload', event => {
    if (pendingSubmission || deliveryBusy || bulkDownloadBusy || deliveryEntries.some(entry => entry.uncertain)) { event.preventDefault(); event.returnValue = ''; }
  });
  connect();
})();
